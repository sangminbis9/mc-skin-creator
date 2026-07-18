import { describe, expect, it, vi } from "vitest";
import { generateSkin } from "../src/generate";
import { bytesToBase64, decodePng, encodePng } from "../src/png";
import type {
  SkinGenerationProvider,
  SkinGenerationResult,
} from "../src/skinProvider";
import type { Env } from "../src/types";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeFrontBackView, makeSyntheticAtlas } from "./helpers";

function makeEnv(analysis: unknown): Env {
  return {
    AI: {
      run: vi.fn(async () => ({ response: analysis })),
    } as unknown as Env["AI"],
    MCSKIN_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as Env["MCSKIN_KV"],
    IMAGE_GENERATION_ENABLED: "true",
    IMAGE_GEN_STRATEGY: "front_view",
  };
}

function providerOf(result: SkinGenerationResult): SkinGenerationProvider {
  return {
    async generate(): Promise<SkinGenerationResult> {
      return result;
    },
  };
}

async function photoDataUrl(): Promise<string> {
  const bytes = await encodePng(makeSyntheticAtlas());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

describe("hair accessory recovery", () => {
  it("does not let a thigh-side detail flip a hair flower to the other side", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair",
          accessories:
            "Viewer-left side: pink flower cluster in hair. Viewer-right thigh: white ribbon bow.",
          clothing:
            "pink cardigan, viewer-left leg warmer, and a viewer-right thigh ribbon",
        },
        renderHints: {
          ...base.renderHints,
          hairAccessory: "flower",
          hairAccessorySide: "right",
        },
      }),
    );
    const provider = providerOf({
      ok: true,
      imageBytes: await encodePng(makeFrontBackView()),
      inputTiles: 2,
      outputTiles: 2,
    });
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const leftFlower = ((front.y + 2) * ATLAS_SIZE + front.x + 1) * 4;
    const wrongRightFlower = ((front.y + 2) * ATLAS_SIZE + front.x + 6) * 4;

    expect(decoded.rgba[leftFlower]).toBeGreaterThan(decoded.rgba[leftFlower + 1]);
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(decoded.rgba[wrongRightFlower]);
  });

  it("recovers a side-specific hair flower when only outfitPrompt preserves it", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair",
          accessories: "white bow collar",
          clothing: "pink cardigan over a white bow collar",
        },
        renderHints: {
          ...base.renderHints,
          hairAccessory: "none",
          hairAccessorySide: "center",
          neckAccessory: "none",
        },
        identityPrompt: "A person with long wavy brown hair.",
        outfitPrompt:
          "Pink cardigan and white bow collar, with a large pink flower on viewer-left hair preserved.",
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairstyle: "long",
        },
      }),
    );
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf({
      ok: true,
      imageBytes: frontPng,
      inputTiles: 2,
      outputTiles: 2,
    });
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const leftFlower = ((front.y + 2) * ATLAS_SIZE + front.x + 1) * 4;
    const oldRightFlower = ((front.y + 2) * ATLAS_SIZE + front.x + 6) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[leftFlower + 3]).toBe(255);
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(decoded.rgba[leftFlower + 1]);
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(decoded.rgba[oldRightFlower]);
  });

  it("recovers a blue flower color from the relevant accessory clause", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair",
          accessories: "large blue flower on viewer-left hair",
          clothing: "pink cardigan over a white blouse",
        },
        renderHints: {
          ...base.renderHints,
          hairAccessory: "flower",
          hairAccessorySide: "left",
          hairAccessoryColor: "pink",
        },
        identityPrompt:
          "A person with long wavy brown hair and a large blue flower on viewer-left hair.",
      }),
    );
    const provider = providerOf({
      ok: true,
      imageBytes: await encodePng(makeFrontBackView()),
      inputTiles: 2,
      outputTiles: 2,
    });
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) => c.charCodeAt(0)),
    );
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const petal = ((front.y + 2) * ATLAS_SIZE + front.x) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[petal + 2]).toBeGreaterThan(decoded.rgba[petal]);
    expect(decoded.rgba[petal + 3]).toBe(255);
  });

  it("keeps pink petals when a pink flower description also mentions green leaves", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy light-brown hair with a viewer-left flower cluster",
          accessories:
            "Viewer-left cluster of pink and pale pink artificial flowers with green leaves as a hair accessory.",
        },
        renderHints: {
          ...base.renderHints,
          hairAccessory: "flower",
          hairAccessorySide: "left",
          hairAccessoryColor: "pink",
        },
        identityPrompt:
          "Long wavy light-brown hair with a pink flower cluster and green leaves on viewer-left.",
      }),
    );
    const provider = providerOf({
      ok: true,
      imageBytes: await encodePng(makeFrontBackView()),
      inputTiles: 2,
      outputTiles: 2,
    });
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const petal = ((front.y + 2) * ATLAS_SIZE + front.x) * 4;
    const leaf = ((front.y + 1) * ATLAS_SIZE + front.x + 2) * 4;

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      hairAccessoryScale: "large",
    });
    expect(decoded.rgba[petal]).toBeGreaterThan(decoded.rgba[petal + 1]);
    expect(decoded.rgba[leaf + 1]).toBeGreaterThan(decoded.rgba[leaf]);
  });
});
