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

    expect(decoded.rgba[leftFlower]).toBeGreaterThan(
      decoded.rgba[leftFlower + 1],
    );
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(
      decoded.rgba[wrongRightFlower],
    );
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
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(
      decoded.rgba[leftFlower + 1],
    );
    expect(decoded.rgba[leftFlower]).toBeGreaterThan(
      decoded.rgba[oldRightFlower],
    );
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
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
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
    const leaf = (front.y * ATLAS_SIZE + front.x + 2) * 4;

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      hairAccessoryScale: "large",
    });
    expect(decoded.rgba[petal]).toBeGreaterThan(decoded.rgba[petal + 1]);
    expect(decoded.rgba[leaf + 1]).toBeGreaterThan(decoded.rgba[leaf]);
  });

  it("preserves a high-detail portrait across face, hair, outfit and inferred lower-body layers", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        framing: "upper_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        observed: {
          face: "oval face with large almond dark-brown eyes, soft brows, a small rounded nose and small full lips",
          hair: "waist-length full wavy medium-brown hair, viewer-left part, eye-length curtain bangs and face-framing side locks",
          accessories:
            "Large viewer-left pale-pink flower cluster with green leaves in the hair, plus a broad white neck bow.",
          clothing:
            "Dusty pink knit cardigan over a white blouse with a broad bow at the throat.",
          colorPalette: [
            "medium brown",
            "pale pink",
            "dusty pink",
            "cream",
            "beige",
          ],
        },
        inferred: {
          hairBack: {
            value: "full wavy waist-length hair flowing down the back",
            rationale:
              "the visible long side locks continue below the shoulders",
          },
          upperBody: null,
          lowerBody: {
            value:
              "beige pleated plaid skort with a dark belt, one viewer-left cream leg warmer and a viewer-right thigh bow",
            rationale:
              "the cardigan and broad neck bow support a detailed soft preppy lower outfit",
          },
          lowerBodyDesign: {
            bottomType: "skirt",
            bottomPattern: "plaid",
            bottomAccent: "belt",
            legwear: "leg_warmers",
            legwearAsymmetry: "left",
            thighAccessory: "bow",
            thighAccessorySide: "right",
            shoeStyle: "dress_shoes",
            rationale:
              "the cardigan and neck bow support a layered asymmetric preppy outfit",
          },
          shoes: {
            value: "cream Mary Jane dress shoes",
            rationale: "cream dress shoes repeat the white bow and leg warmer",
          },
        },
        renderHints: {
          ...base.renderHints,
          faceShape: "oval",
          eyeShape: "almond",
          eyeSize: "large",
          eyeTilt: "downturned",
          eyebrowShape: "soft",
          noseShape: "rounded",
          mouthShape: "small",
          lipFullness: "full",
          jawShape: "soft",
          bangs: "curtain",
          bangsLength: "eye",
          bangsDensity: "balanced",
          fringeEdge: "wispy",
          fringeOpening: "center",
          hairTexture: "wavy",
          hairVolume: "full",
          hairSilhouette: "tousled",
          hairBackShape: "long",
          overallHairLength: "waist",
          hairPart: "left",
          sideHairLength: "shoulder",
          sideHairShape: "face_framing",
          sideHairAsymmetry: "none",
          earExposure: "covered",
          garmentTexture: "knit",
          outerLayer: "heavy",
          outerGarment: "cardigan",
          hairAccessory: "flower",
          hairAccessoryScale: "large",
          hairAccessorySide: "left",
          hairAccessoryColor: "pink",
          neckAccessory: "bow",
          bottomPattern: "plaid",
          bottomAccent: "belt",
          legwear: "leg_warmers",
          legwearColor: "beige",
          legwearAsymmetry: "left",
          thighAccessory: "bow",
          thighAccessorySide: "right",
        },
        identityPrompt:
          "An oval-faced person with large almond dark-brown eyes and small full lips. Full waist-length wavy medium-brown hair has a viewer-left part, eye-length curtain bangs, face-framing side locks and a large pale-pink flower cluster with green leaves on viewer-left.",
        outfitPrompt:
          "Preserve the dusty pink knit cardigan and broad white neck bow. Complete it with a beige pleated plaid skort and dark belt, one viewer-left cream leg warmer, a viewer-right thigh bow and cream Mary Jane dress shoes.",
        fallbackFeatures: {
          ...base.fallbackFeatures,
          skinTone: "light",
          hairColor: "brown",
          hairstyle: "long",
          eyeColor: "dark-brown",
          glasses: "none",
          topType: "sweater",
          topColor: "pink",
          topAccentColor: "white",
          sleeveLength: "long",
          bottomType: "pants",
          bottomColor: "beige",
          shoesColor: "white",
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
    const head = CLASSIC_LAYOUT.head;
    const body = CLASSIC_LAYOUT.body;
    const rightArmOuter = CLASSIC_LAYOUT.rightArm.overlay.left;
    const leftArmOuter = CLASSIC_LAYOUT.leftArm.overlay.right;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const offset = (rect: { x: number; y: number }, x: number, y: number) =>
      ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.analysis?.renderHints).toMatchObject({
      bangs: "curtain",
      bangsLength: "eye",
      hairPart: "left",
      hairTexture: "wavy",
      overallHairLength: "waist",
      sideHairShape: "face_framing",
      hairAccessory: "flower",
      hairAccessoryScale: "large",
      hairAccessorySide: "left",
      outerGarment: "cardigan",
      neckAccessory: "bow",
      bottomPattern: "plaid",
      bottomAccent: "belt",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
      thighAccessory: "bow",
      thighAccessorySide: "right",
    });

    const flowerPetal = offset(head.overlay.front, 0, 2);
    const flowerLeaf = offset(head.overlay.front, 2, 0);
    const templeLeaf = offset(head.overlay.front, 0, 4);
    const curtainCorner = offset(head.overlay.front, 1, 4);
    expect(decoded.rgba[flowerPetal]).toBeGreaterThan(
      decoded.rgba[flowerPetal + 1],
    );
    expect(decoded.rgba[flowerLeaf + 1]).toBeGreaterThan(
      decoded.rgba[flowerLeaf],
    );
    expect(decoded.rgba[templeLeaf + 1]).toBeGreaterThan(
      decoded.rgba[templeLeaf],
    );
    expect(decoded.rgba[curtainCorner]).toBeGreaterThan(
      decoded.rgba[curtainCorner + 1],
    );
    for (const irisX of [2, 5]) {
      expect(decoded.rgba[offset(head.overlay.front, irisX, 4) + 3]).toBe(0);
      expect(decoded.rgba[offset(head.base.front, irisX, 4) + 3]).toBe(255);
    }

    const bowWing = offset(body.overlay.front, 1, 2);
    const bowTail = offset(body.overlay.front, 3, 6);
    const cardiganFabric = offset(body.base.front, 3, 7);
    expect(decoded.rgba[bowWing + 3]).toBe(255);
    expect(decoded.rgba[bowTail + 3]).toBe(255);
    expect(decoded.rgba[cardiganFabric]).toBeGreaterThan(
      decoded.rgba[cardiganFabric + 1] + 20,
    );

    const plaidDark = offset(body.overlay.front, 1, body.overlay.front.h - 3);
    const plaidLight = offset(body.overlay.front, 2, body.overlay.front.h - 3);
    const leftWarmer = offset(leftLeg, 1, 4);
    const rightThighBow = offset(rightLeg, 0, 2);
    const rightBareLowerLeg = offset(rightLeg, 3, 5);
    const maryJaneBow = offset(rightLeg, 1, rightLeg.h - 3);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[leftWarmer + 3]).toBe(255);
    expect(decoded.rgba[rightThighBow + 3]).toBe(255);
    expect(decoded.rgba[rightBareLowerLeg + 3]).toBe(0);
    expect(decoded.rgba[maryJaneBow + 3]).toBe(255);

    for (const [sideIndex, side] of [rightArmOuter, leftArmOuter].entries()) {
      const path = Array.from({ length: 11 }, (_, y) =>
        (Math.floor(y / 3) + sideIndex) % 2 === 0 ? 1 : 2,
      );
      for (let y = 0; y < path.length; y++) {
        expect(decoded.rgba[offset(side, path[y], y) + 3]).toBe(255);
      }
      const turns = path
        .slice(1)
        .filter((x, index) => x !== path[index]).length;
      expect(turns).toBeLessThanOrEqual(3);
    }
  });
});
