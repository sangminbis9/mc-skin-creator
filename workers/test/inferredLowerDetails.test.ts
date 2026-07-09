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

function providerOf(
  result: SkinGenerationResult,
): SkinGenerationProvider & { calls: number } {
  const provider = {
    calls: 0,
    async generate(): Promise<SkinGenerationResult> {
      provider.calls += 1;
      return result;
    },
  };
  return provider;
}

async function photoDataUrl(): Promise<string> {
  const bytes = await encodePng(makeSyntheticAtlas());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

describe("inferred lower-body completion", () => {
  it("corrects visible lower-body style from observed outfit text when fallback says pants", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: true,
          feet: true,
        },
        observed: {
          ...base.observed,
          clothing:
            "pink cardigan with a bow collar, dark pleated plaid skirt, one left leg warmer and white Mary Jane dress shoes",
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "cardigan",
          neckAccessory: "bow",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          bottomType: "pants",
        },
        outfitPrompt:
          "Preserve the visible pink cardigan, bow collar, dark pleated plaid skirt, one left leg warmer and white Mary Jane dress shoes.",
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
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const rightShoe = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const bodyHem =
      ((bodyFront.y + bodyFront.h - 1) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const plaidDark =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const plaidLight =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const leftWarmer =
      ((leftLegFront.y + 4) * ATLAS_SIZE + leftLegFront.x + 1) * 4;
    const oppositeBow =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x) * 4;
    const shoeBow =
      ((rightShoe.y + rightShoe.h - 3) * ATLAS_SIZE + rightShoe.x + 1) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[bodyHem + 3]).toBe(255);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[leftWarmer + 3]).toBe(255);
    expect(decoded.rgba[oppositeBow + 3]).toBe(255);
    expect(decoded.rgba[shoeBow + 3]).toBe(255);
    expect(decoded.rgba[shoeBow]).toBeGreaterThan(220);
  });

  it("renders inferred skirt, plaid pattern and socks even when fallback bottomType is pants", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        inferred: {
          ...base.inferred,
          lowerBody: {
            value: "dark pleated plaid skirt with small ribbon detail and white socks",
            rationale: "the visible cardigan and bow collar create a preppy outfit",
          },
          shoes: {
            value: "dark dress shoes",
            rationale: "dress shoes match the preppy outfit",
          },
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "cardigan",
          neckAccessory: "bow",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          bottomType: "pants",
        },
        outfitPrompt:
          "Visible cardigan with a bow collar. Complete the outfit with a dark pleated plaid skirt, white socks and dark dress shoes.",
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
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const bodyHem =
      ((bodyFront.y + bodyFront.h - 1) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const plaidDark =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const plaidLight =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const legTop = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const sockPixel =
      ((rightLegFront.y + rightLegFront.h - 4) * ATLAS_SIZE + rightLegFront.x + 1) *
      4;

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(decoded.rgba[bodyHem + 3]).toBe(255);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[legTop + 3]).toBe(255);
    expect(decoded.rgba[sockPixel + 3]).toBe(255);
    expect(decoded.rgba[bodyHem]).toBeLessThan(decoded.rgba[legTop]);
  });

  it("uses structured lowerBodyDesign before vague inferred text", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        inferred: {
          ...base.inferred,
          lowerBody: {
            value: "simple dark pants",
            rationale: "generic fallback wording that should not win",
          },
          lowerBodyDesign: {
            bottomType: "skirt",
            bottomPattern: "plaid",
            bottomAccent: "ribbon",
            legwear: "leg_warmers",
            legwearAsymmetry: "left",
            shoeStyle: "dress_shoes",
            rationale: "the visible bow and cardigan call for a dressy detailed lower half",
          },
          shoes: {
            value: "dark dress shoes",
            rationale: "dress shoes match the structured lower-body design",
          },
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "cardigan",
          neckAccessory: "bow",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          bottomType: "pants",
        },
        outfitPrompt:
          "Visible cardigan with a bow collar. Complete the outfit with coherent lower-body clothing.",
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
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const bodyHem =
      ((bodyFront.y + bodyFront.h - 1) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const plaidDark =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const plaidLight =
      ((bodyFront.y + bodyFront.h - 3) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const leftWarmer =
      ((leftLegFront.y + 4) * ATLAS_SIZE + leftLegFront.x + 1) * 4;
    const rightBow =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[bodyHem + 3]).toBe(255);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[leftWarmer + 3]).toBe(255);
    expect(decoded.rgba[rightBow + 3]).toBe(255);
    expect(decoded.rgba[rightBow]).toBeGreaterThan(220);
  });
});
