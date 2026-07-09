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
  it("front_view 전략(기본): 정면 뷰를 pack해 64x64 atlas를 반환한다", async () => {
    const env = makeEnv(makeAnalysis(), true, "front_view");
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf([
      { ok: true, imageBytes: frontPng, inputTiles: 2, outputTiles: 2 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    // 분석 170 + (사진+포즈가이드 2타일 x 6 + 출력 2타일 x 27) = 236
    expect(result.neuronsSpent).toBe(236);
  });

  it("front_view preserves visible hair flower and neck bow from observed text when render hints miss them", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair with a large pink flower on viewer-left hair",
          accessories: "large pink flower on viewer-left hair and a white bow collar",
          clothing: "pink cardigan over a white bow collar",
        },
        renderHints: {
          ...base.renderHints,
          hairAccessory: "none",
          hairAccessorySide: "center",
          neckAccessory: "none",
        },
        identityPrompt:
          "A person with long wavy brown hair and a large pink flower on viewer-left hair.",
        outfitPrompt:
          "Pink cardigan over a white bow collar, with the viewer-left hair flower preserved.",
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairstyle: "long",
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
    const flowerPetal = ((head.y + 2) * ATLAS_SIZE + head.x + 1) * 4;
    const flowerLeaf = ((head.y + 1) * ATLAS_SIZE + head.x + 2) * 4;
    const bowWing = ((body.y + 1) * ATLAS_SIZE + body.x + 2) * 4;
    const bowKnot = ((body.y + 1) * ATLAS_SIZE + body.x + 3) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[flowerPetal + 3]).toBe(255);
    expect(decoded.rgba[flowerPetal]).toBeGreaterThan(decoded.rgba[flowerPetal + 1]);
    expect(decoded.rgba[flowerLeaf + 1]).toBeGreaterThan(decoded.rgba[flowerLeaf]);
    expect(decoded.rgba[bowWing + 3]).toBe(255);
    expect(decoded.rgba[bowKnot + 3]).toBe(255);
    expect(decoded.rgba[bowWing]).toBeGreaterThan(decoded.rgba[bowKnot]);
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

  it("두 번 모두 실패하면 절차적 fallback으로 features만 내려보낸다", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([{ ok: true, imageBytes: flat, inputTiles: 3, outputTiles: 1 }]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(provider.calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.body.skinPngBase64).toBeUndefined();
    // fallback features는 hex로 변환돼 있다 (yellow → #e3c14d)
    expect((result.body.features as Record<string, string>).topColor).toBe("#e3c14d");
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
  });

  it("data URL이 아니면 400", async () => {
    const env = makeEnv(makeAnalysis());
    const result = await generateSkin(env, "http://example.com/x.png");
    expect(result.status).toBe(400);
    expect(result.neuronsSpent).toBe(0);
  });
});
