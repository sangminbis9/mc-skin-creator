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

  it("maps skort-like lower-body wording to skirt-style plaid hem details", async () => {
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
            value:
              "beige plaid skort with pleated shorts construction and one viewer-left leg warmer",
            rationale: "the visible cardigan and bow collar create a soft preppy outfit",
          },
          lowerBodyDesign: null,
          shoes: {
            value: "cream Mary Jane dress shoes",
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
          "Visible cardigan with bow collar. Complete with a beige plaid skort, pleated shorts-like front, one viewer-left leg warmer and cream Mary Jane shoes.",
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
    const legTop = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftWarmer =
      ((leftLegFront.y + 4) * ATLAS_SIZE + leftLegFront.x + 1) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[bodyHem + 3]).toBe(255);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[legTop + 3]).toBe(255);
    expect(decoded.rgba[bodyHem]).toBeLessThan(decoded.rgba[legTop]);
    expect(decoded.rgba[leftWarmer + 3]).toBe(255);
  });

  it("recovers one-sided inferred leg warmer asymmetry from lower-body text", async () => {
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
            value:
              "plaid skirt with a single viewer-left leg warmer and a small ribbon on the viewer-right thigh",
            rationale: "the visible bow collar supports an asymmetric preppy lower outfit",
          },
          lowerBodyDesign: null,
          shoes: {
            value: "cream Mary Jane dress shoes",
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
          "Visible cardigan with bow collar. Complete with a plaid skirt, one viewer-left leg warmer, a small viewer-right thigh ribbon and cream Mary Jane shoes.",
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
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftWarmer =
      ((leftLegFront.y + 4) * ATLAS_SIZE + leftLegFront.x + 1) * 4;
    const rightThighBow =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightBareLowerLeg =
      ((rightLegFront.y + 5) * ATLAS_SIZE + rightLegFront.x + 3) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[leftWarmer + 3]).toBe(255);
    expect(decoded.rgba[rightThighBow + 3]).toBe(255);
    expect(decoded.rgba[rightThighBow]).toBeGreaterThan(220);
    expect(decoded.rgba[rightBareLowerLeg + 3]).toBe(0);
  });

  it("treats one-sided over-knee socks as long legwear instead of short socks", async () => {
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
            value:
              "pleated skirt with one viewer-left over-knee sock and a small viewer-right thigh bow",
            rationale: "the visible bow collar supports a detailed asymmetric preppy outfit",
          },
          lowerBodyDesign: null,
          shoes: {
            value: "cream Mary Jane dress shoes",
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
          "Visible cardigan with bow collar. Complete with a pleated skirt, one viewer-left OTK sock, a viewer-right thigh bow and cream Mary Jane shoes.",
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
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftHighSockTop =
      (leftLegFront.y * ATLAS_SIZE + leftLegFront.x + 1) * 4;
    const leftHighSockMid =
      ((leftLegFront.y + 4) * ATLAS_SIZE + leftLegFront.x + 1) * 4;
    const rightThighBow =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightBareLowerLeg =
      ((rightLegFront.y + 5) * ATLAS_SIZE + rightLegFront.x + 3) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[leftHighSockTop + 3]).toBe(255);
    expect(decoded.rgba[leftHighSockMid + 3]).toBe(255);
    expect(decoded.rgba[rightThighBow + 3]).toBe(255);
    expect(decoded.rgba[rightThighBow]).toBeGreaterThan(220);
    expect(decoded.rgba[rightBareLowerLeg + 3]).toBe(0);
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

  it("upgrades generic structured lower-body design when the visible top is strongly preppy", async () => {
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
        observed: {
          ...base.observed,
          clothing: "pink cardigan over a white bow collar",
          accessories: "white bow collar",
        },
        inferred: {
          ...base.inferred,
          lowerBody: {
            value: "matching simple lower-body clothing",
            rationale: "the lower body is not visible",
          },
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "none",
            legwear: "none",
            legwearAsymmetry: "none",
            shoeStyle: "sneakers",
            rationale: "generic structured output that underuses the visible cardigan and bow",
          },
          shoes: {
            value: "simple sneakers",
            rationale: "generic fallback",
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
          "Visible pink cardigan with a white bow collar. Complete the hidden lower body coherently.",
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
    const legTop = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const sockPixel =
      ((rightLegFront.y + rightLegFront.h - 4) * ATLAS_SIZE + rightLegFront.x + 1) *
      4;
    const thighRibbon =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x) * 4;
    const shoeBow =
      ((rightLegFront.y + rightLegFront.h - 3) * ATLAS_SIZE + rightLegFront.x + 1) *
      4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[bodyHem + 3]).toBe(255);
    expect(decoded.rgba[legTop + 3]).toBe(255);
    expect(decoded.rgba[sockPixel + 3]).toBe(255);
    expect(decoded.rgba[thighRibbon + 3]).toBe(255);
    expect(decoded.rgba[shoeBow + 3]).toBe(255);
  });
});
