import { describe, expect, it, vi } from "vitest";
import { generateSkin } from "../src/generate";
import { bytesToBase64, decodePng, encodePng } from "../src/png";
import type {
  SkinGenerationProvider,
  SkinGenerationResult,
} from "../src/skinProvider";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";
import {
  makeAnalysis,
  makeFourViewSheet,
  makeFrontBackView,
  makeSyntheticAtlas,
  upscale,
} from "./helpers";

function makeEnv(
  analysis: unknown,
  imageGen = true,
  strategy = "direct_atlas",
): Env {
  return {
    AI: {
      run: vi.fn(async () => ({ response: analysis })),
    } as unknown as Env["AI"],
    MCSKIN_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as Env["MCSKIN_KV"],
    IMAGE_GENERATION_ENABLED: imageGen ? "true" : "false",
    IMAGE_GEN_STRATEGY: strategy,
  };
}

async function photoDataUrl(): Promise<string> {
  const bytes = await encodePng(makeSyntheticAtlas());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

function providerOf(
  results: SkinGenerationResult[],
): SkinGenerationProvider & { calls: number } {
  const provider = {
    calls: 0,
    async generate(): Promise<SkinGenerationResult> {
      return results[Math.min(provider.calls++, results.length - 1)];
    },
  };
  return provider;
}

async function goodFluxOutput(): Promise<SkinGenerationResult> {
  const png = await encodePng(upscale(makeSyntheticAtlas(), 8));
  return { ok: true, imageBytes: png, inputTiles: 3, outputTiles: 1 };
}

describe("generateSkin", () => {
  it("uses the high-resolution photo for analysis and the 448px photo for image generation", async () => {
    const env = makeEnv(makeAnalysis(), true, "front_view");
    const generationPhoto = await photoDataUrl();
    const analysisPhoto = "data:image/jpeg;base64,aGlnaC1yZXM=";
    const frontPng = await encodePng(makeFrontBackView());
    let providerPhoto = "";
    const provider: SkinGenerationProvider = {
      async generate(request) {
        providerPhoto = request.photoDataUrl;
        return {
          ok: true,
          imageBytes: frontPng,
          inputTiles: 2,
          outputTiles: 2,
        };
      },
    };

    const result = await generateSkin(
      env,
      generationPhoto,
      provider,
      analysisPhoto,
    );
    const calls = (
      env.AI.run as unknown as { mock: { calls: Array<[unknown, unknown]> } }
    ).mock.calls;
    const input = calls[0][1] as {
      messages: Array<{
        content: Array<{ image_url?: { url?: string } }>;
      }>;
    };

    expect(result.status).toBe(200);
    expect(input.messages[0].content[0].image_url?.url).toBe(analysisPhoto);
    expect(providerPhoto).toBe(generationPhoto);
  });

  it("front_view 전략(기본): 정면 뷰를 pack해 64x64 atlas를 반환한다", async () => {
    const env = makeEnv(makeAnalysis(), true, "front_view");
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf([
      { ok: true, imageBytes: frontPng, inputTiles: 2, outputTiles: 2 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.analysis?.renderHints).toEqual(
      makeAnalysis().renderHints,
    );
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    // 분석 170 + (사진+포즈가이드 2타일 x 6 + 출력 2타일 x 27) = 236
    expect(result.neuronsSpent).toBe(236);
  });

  it("four_view strategy packs front, back and both profiles into a valid atlas", async () => {
    const env = makeEnv(makeAnalysis(), true, "four_view");
    const sheetPng = await encodePng(makeFourViewSheet());
    const provider = providerOf([
      { ok: true, imageBytes: sheetPng, inputTiles: 2, outputTiles: 2 },
    ]);

    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(provider.calls).toBe(1);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (character) =>
        character.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(result.neuronsSpent).toBe(236);
  });

  it("front_view preserves visible cardigan, hair flower and neck bow from observed text when render hints miss them", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair with a large pink flower on viewer-left hair",
          accessories:
            "large pink flower on viewer-left hair and a white bow collar",
          clothing: "long-sleeve pink cardigan over a white bow collar",
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "none",
          outerLayer: "none",
          garmentTexture: "plain",
          hairAccessory: "none",
          hairAccessorySide: "center",
          neckAccessory: "none",
        },
        identityPrompt:
          "A person with long wavy brown hair and a large pink flower on viewer-left hair.",
        outfitPrompt:
          "Long-sleeve pink cardigan over a white bow collar, with the viewer-left hair flower preserved.",
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairstyle: "long",
          topType: "tshirt",
          sleeveLength: "short",
        },
      }),
      true,
      "front_view",
    );
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf([
      { ok: true, imageBytes: frontPng, inputTiles: 2, outputTiles: 2 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const bodySide = CLASSIC_LAYOUT.body.overlay.right;
    const armFront = CLASSIC_LAYOUT.rightArm.overlay.front;
    const flowerPetal = ((head.y + 2) * ATLAS_SIZE + head.x + 1) * 4;
    const flowerLeaf = ((head.y + 1) * ATLAS_SIZE + head.x + 2) * 4;
    const bowWing = ((body.y + 1) * ATLAS_SIZE + body.x + 2) * 4;
    const bowKnot = ((body.y + 1) * ATLAS_SIZE + body.x + 3) * 4;
    const cardiganPanel = ((body.y + 5) * ATLAS_SIZE + body.x + 1) * 4;
    const cardiganTrim = ((body.y + 5) * ATLAS_SIZE + body.x + 2) * 4;
    const cardiganOpenCenter = ((body.y + 5) * ATLAS_SIZE + body.x + 3) * 4;
    const cardiganSidePanel = ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x) * 4;
    const sleeve = ((armFront.y + 4) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveFold = ((armFront.y + 3) * ATLAS_SIZE + armFront.x + 1) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[flowerPetal + 3]).toBe(255);
    expect(decoded.rgba[flowerPetal]).toBeGreaterThan(
      decoded.rgba[flowerPetal + 1],
    );
    expect(decoded.rgba[flowerLeaf + 1]).toBeGreaterThan(
      decoded.rgba[flowerLeaf],
    );
    expect(decoded.rgba[bowWing + 3]).toBe(255);
    expect(decoded.rgba[bowKnot + 3]).toBe(255);
    expect(decoded.rgba[bowWing]).toBeGreaterThan(decoded.rgba[bowKnot]);
    expect(decoded.rgba[cardiganPanel + 3]).toBe(255);
    expect(decoded.rgba[cardiganTrim + 3]).toBe(255);
    expect(decoded.rgba[cardiganOpenCenter + 3]).toBe(0);
    expect(decoded.rgba[cardiganTrim]).toBeLessThan(
      decoded.rgba[cardiganPanel],
    );
    expect(decoded.rgba[cardiganSidePanel + 3]).toBe(255);
    expect(decoded.rgba[sleeve + 3]).toBe(255);
    expect(decoded.rgba[sleeveFold + 3]).toBe(255);
    expect(decoded.rgba[sleeve]).toBeGreaterThan(decoded.rgba[sleeveFold]);
  });

  it("direct_atlas 전략: 이미지 생성 성공 → 64x64 유효 atlas + 비용 215 Neurons", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.skinPngBase64).toBeTruthy();
    expect(result.body.features).toBeTruthy();
    expect(result.body.analysis?.framing).toBe("upper_body");
    expect(provider.calls).toBe(1);
    // 분석 170 + (입력 3타일 x 6 + 출력 27) = 215
    expect(result.neuronsSpent).toBe(215);

    // 반환된 PNG가 실제로 유효한 64x64 atlas인지
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    expect(validateFinalAtlas(decoded).ok).toBe(true);
  });

  it("direct_atlas restores transparent cutouts from an opaque generated overlay", async () => {
    const atlas = makeSyntheticAtlas();
    const base = CLASSIC_LAYOUT.body.base.front;
    const overlay = CLASSIC_LAYOUT.body.overlay.front;
    for (let y = 0; y < overlay.h; y++) {
      for (let x = 0; x < overlay.w; x++) {
        const source = ((base.y + y) * ATLAS_SIZE + base.x + x) * 4;
        const target = ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
        atlas.rgba.set(atlas.rgba.slice(source, source + 4), target);
        atlas.rgba[target + 3] = 255;
      }
    }
    const accent = ((overlay.y + 5) * ATLAS_SIZE + overlay.x + 3) * 4;
    atlas.rgba.set([238, 72, 118, 255], accent);
    const generated = await encodePng(upscale(atlas, 8));
    const provider = providerOf([
      { ok: true, imageBytes: generated, inputTiles: 3, outputTiles: 1 },
    ]);

    const result = await generateSkin(
      makeEnv(makeAnalysis()),
      await photoDataUrl(),
      provider,
    );
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (character) =>
        character.charCodeAt(0),
      ),
    );
    const duplicate = ((overlay.y + 1) * ATLAS_SIZE + overlay.x + 1) * 4;
    expect(decoded.rgba[duplicate + 3]).toBe(0);
    expect(decoded.rgba[accent + 3]).toBe(255);
  });

  it("생성 결과가 atlas 검증에 실패하면 seed를 바꿔 1회 재시도한다", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: true, imageBytes: flat, inputTiles: 3, outputTiles: 1 },
      await goodFluxOutput(),
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(2);
    expect(result.body.generationMode).toBe("image");
    expect(result.neuronsSpent).toBe(170 + 45 + 45);
  });

  it("두 번 모두 실패하면 분석 기반 절차적 atlas를 내려보낸다", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: true, imageBytes: flat, inputTiles: 3, outputTiles: 1 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(provider.calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.body.skinPngBase64).toBeTruthy();
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    // fallback features는 hex로 변환돼 있다 (yellow → #e3c14d)
    expect((result.body.features as Record<string, string>).topColor).toBe(
      "#e3c14d",
    );
  });

  it("procedural fallback preserves rich hair, cardigan, plaid and asymmetric legwear hints", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        framing: "full_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: true,
          feet: true,
        },
        observed: {
          ...base.observed,
          hair: "long wavy light-brown hair with curtain bangs and a large pink flower on viewer-left",
          accessories:
            "pink flower on viewer-left hair and a white ribbon on viewer-right thigh",
          clothing:
            "dusty-pink long cardigan, beige plaid pleated shorts, one viewer-left thigh-high sock and cream Mary Jane shoes",
          colorPalette: ["dusty pink", "beige", "cream", "light brown"],
        },
        renderHints: {
          ...base.renderHints,
          bangs: "curtain",
          bangsLength: "brow",
          hairTexture: "wavy",
          hairVolume: "full",
          hairBackShape: "long",
          sideHairLength: "shoulder",
          outerLayer: "light",
          outerGarment: "cardigan",
          hairAccessory: "flower",
          hairAccessorySide: "left",
          neckAccessory: "collar",
          bottomPattern: "plaid",
          bottomAccent: "belt",
          legwear: "thigh_highs",
          legwearAsymmetry: "left",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairColor: "light-brown",
          hairstyle: "long",
          topType: "sweater",
          topColor: "pink",
          topAccentColor: "white",
          sleeveLength: "long",
          bottomType: "shorts",
          bottomColor: "beige",
          shoesColor: "white",
          glasses: "none",
        },
      }),
      true,
      "front_view",
    );
    const provider = providerOf([
      {
        ok: false,
        error: "temporary image generation failure",
        retryable: false,
      },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const flower = ((head.y + 2) * ATLAS_SIZE + head.x + 1) * 4;
    const leftEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 2) * 4;
    const rightEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 5) * 4;
    const cardiganPanel = ((body.y + 5) * ATLAS_SIZE + body.x + 1) * 4;
    const cardiganCenter = ((body.y + 5) * ATLAS_SIZE + body.x + 3) * 4;
    const plaidDark = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const plaidLight = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 2) * 4;
    const leftThighHigh = ((leftLeg.y + 4) * ATLAS_SIZE + leftLeg.x + 1) * 4;

    expect(provider.calls).toBe(1);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(decoded.rgba[flower + 3]).toBe(255);
    expect(decoded.rgba[flower]).toBeGreaterThan(decoded.rgba[flower + 1]);
    expect(decoded.rgba[leftEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[rightEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[cardiganPanel + 3]).toBe(255);
    expect(decoded.rgba[cardiganCenter + 3]).toBe(0);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[leftThighHigh + 3]).toBe(255);
  });

  it("upper-body knit portraits keep a pendant and receive structured pants and dress shoes", async () => {
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
          ...base.observed,
          face: "oval face, almond dark-brown eyes, straight eyebrows, small mouth",
          hair: "short straight black two-block hair with brow-length curtain fringe",
          accessories:
            "thin silver chain necklace with a small round silver pendant",
          clothing: "black cable-knit long-sleeve crewneck sweater",
          colorPalette: ["black", "charcoal", "silver", "warm skin"],
        },
        inferred: {
          ...base.inferred,
          hairBack: {
            value: "short tapered black hair at the back",
            rationale:
              "the visible short sides imply a neat tapered rear shape",
          },
          lowerBody: {
            value: "charcoal tailored trousers with a subtle black belt",
            rationale:
              "structured dark trousers match the polished cable-knit sweater and pendant",
          },
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "belt",
            legwear: "none",
            legwearAsymmetry: "none",
            shoeStyle: "dress_shoes",
            rationale:
              "dark tailored trousers and dress shoes complete the smart-casual upper body",
          },
          shoes: {
            value: "black leather dress shoes",
            rationale: "dress shoes preserve the refined monochrome outfit",
          },
        },
        renderHints: {
          ...base.renderHints,
          faceShape: "oval",
          eyeShape: "almond",
          eyebrowShape: "straight",
          mouthShape: "small",
          bangs: "curtain",
          bangsLength: "brow",
          hairTexture: "straight",
          hairVolume: "normal",
          hairSilhouette: "rounded",
          hairBackShape: "tapered",
          hairPart: "center",
          sideHairLength: "short",
          garmentTexture: "knit",
          outerLayer: "light",
          outerGarment: "none",
          necklace: "silver",
          neckAccessory: "none",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairColor: "black",
          hairstyle: "short",
          glasses: "none",
          topType: "sweater",
          topColor: "black",
          topAccentColor: "gray",
          sleeveLength: "long",
          bottomType: "pants",
          bottomColor: "gray",
          shoesColor: "black",
        },
        outfitPrompt:
          "Black cable-knit sweater and silver pendant; complete the hidden lower body with charcoal tailored trousers, a black belt and black leather dress shoes.",
      }),
      true,
      "front_view",
    );
    const provider = providerOf([
      {
        ok: false,
        error: "temporary image generation failure",
        retryable: false,
      },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const arm = CLASSIC_LAYOUT.rightArm.overlay.front;
    const leg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 2) * 4;
    const rightEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 5) * 4;
    const pendant = ((body.y + 4) * ATLAS_SIZE + body.x + 3) * 4;
    const belt = ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 3) * 4;
    const cuff = ((arm.y + arm.h - 2) * ATLAS_SIZE + arm.x) * 4;
    const kneeFold = ((leg.y + 4) * ATLAS_SIZE + leg.x + 1) * 4;
    const shoeStrap = ((leg.y + leg.h - 3) * ATLAS_SIZE + leg.x + 1) * 4;

    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(decoded.rgba[leftEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[rightEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[pendant + 3]).toBe(255);
    expect(decoded.rgba[pendant]).toBeGreaterThan(170);
    expect(decoded.rgba[pendant + 2]).toBeGreaterThan(170);
    expect(decoded.rgba[belt + 3]).toBe(255);
    expect(decoded.rgba[cuff + 3]).toBe(255);
    expect(decoded.rgba[kneeFold + 3]).toBe(255);
    expect(decoded.rgba[shoeStrap + 3]).toBe(255);
  });

  it("재시도 불가 오류(입력 크기 등)는 즉시 fallback한다", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: false, error: "사진이 FLUX 입력 제한 초과", retryable: false },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(1);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.neuronsSpent).toBe(170);
  });

  it("재시도 가능 오류(moderation flag 등)는 seed를 바꿔 1회 더 시도한다", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: false, error: "FLUX 호출 실패: 3030: flagged", retryable: true },
      await goodFluxOutput(),
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(2);
    expect(result.body.generationMode).toBe("image");
    // 실패한 1회차는 과금 집계에서 제외(성공 응답을 받지 못함), 성공 1회차만 45
    expect(result.neuronsSpent).toBe(215);
  });

  it("feature flag가 꺼져 있으면 provider를 호출하지 않는다", async () => {
    const env = makeEnv(makeAnalysis(), false);
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(0);
    expect(result.body.generationMode).toBe("procedural_fallback");
  });

  it("얼굴만 있는 사진(framing=face)도 실패 처리하지 않는다", async () => {
    const env = makeEnv(
      makeAnalysis({
        framing: "face",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: false,
          lowerBody: false,
          feet: false,
        },
      }),
    );
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("quality=fail은 422 photo_rejected", async () => {
    const env = makeEnv({ quality: "fail", failReason: "no_face" });
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe("photo_rejected");
    expect(provider.calls).toBe(0);
  });

  it("스키마 검증 실패는 502 (조용한 기본값 대체 없음)", async () => {
    const env = makeEnv({ quality: "pass", framing: "??" });
    const result = await generateSkin(env, await photoDataUrl());
    expect(result.status).toBe(502);
    expect(result.body.errorCode).toBe("ai_failed");
    expect(result.neuronsSpent).toBe(4 * 170);
    expect(env.MCSKIN_KV.put).toHaveBeenCalledWith(
      "diagnostic:last-analysis-failure",
      expect.stringContaining('"attempts":4'),
      { expirationTtl: 60 * 60 * 24 },
    );
  });

  it("Workers AI shared quota exhaustion returns quota_exceeded without fallback calls", async () => {
    const env = makeEnv(makeAnalysis());
    env.AI.run = vi.fn(async () => {
      throw new Error(
        "4006: you have used up your daily free allocation of 10,000 neurons",
      );
    }) as unknown as Env["AI"]["run"];

    const result = await generateSkin(env, await photoDataUrl());

    expect(result.status).toBe(429);
    expect(result.body.errorCode).toBe("quota_exceeded");
    expect(result.neuronsSpent).toBe(170);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("data URL이 아니면 400", async () => {
    const env = makeEnv(makeAnalysis());
    const result = await generateSkin(env, "http://example.com/x.png");
    expect(result.status).toBe(400);
    expect(result.neuronsSpent).toBe(0);
  });
});
