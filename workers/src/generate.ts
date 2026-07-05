/**
 * 사진 → 마인크래프트 스킨 생성 파이프라인.
 * 원본 사진은 이 요청 처리 동안만 메모리에 존재하며 어디에도 저장하지 않는다.
 *
 * 1) llama-4-scout 사진 분석 (품질 검사 + observed/inferred + 생성 프롬프트)
 * 2) FLUX.2 [klein]으로 스킨 atlas 직접 생성 (스타일 참고 + 사용자 사진 + UV 가이드)
 * 3) 512→64 셀 축소 + UV 마스크 + 검증, 실패 시 seed를 바꿔 1회 재생성
 * 4) 두 번 실패하면 팔레트 특징만 내려보내 클라이언트의 절차적 생성기로 fallback
 */

import {
  runPhotoAnalysis,
  type FallbackFeatures,
  type PhotoAnalysis,
} from "./analysis";
import { bytesToBase64, decodeImage, encodePng } from "./png";
import { packFrontViewToAtlas } from "./skinPack";
import { applyUvMask, downscaleToAtlas, validateAtlas, validateFinalAtlas } from "./skinPost";
import {
  FluxKleinProvider,
  type GenerationStrategy,
  type SkinGenerationProvider,
} from "./skinProvider";
import {
  NEURONS_IMAGE_INPUT_TILE,
  NEURONS_IMAGE_OUTPUT_TILE,
  NEURONS_VISION_ANALYSIS,
} from "./quota";
import type { Env } from "./types";

/** 업로드 허용 최대 크기 (base64 data URL 문자 수, 약 1.1MB 이미지) */
const MAX_IMAGE_CHARS = 1_500_000;

export type GenerationMode = "image" | "procedural_fallback";

/** 클라이언트에 내려보내는 분석 요약 (원본 사진 관련 정보는 포함하지 않는다) */
export interface AnalysisSummary {
  framing: PhotoAnalysis["framing"];
  visibleRegions: PhotoAnalysis["visibleRegions"];
  observed: PhotoAnalysis["observed"];
  inferred: PhotoAnalysis["inferred"];
}

export interface GenerateResult {
  status: number;
  body: {
    ok: boolean;
    quality?: string;
    failReason?: string;
    features?: Record<string, unknown>;
    analysis?: AnalysisSummary;
    skinPngBase64?: string;
    generationMode?: GenerationMode;
    error?: string;
    errorCode?: string;
  };
  /** 이 요청이 실제로 소비한 Neurons (실패 포함, KV에 커밋된다) */
  neuronsSpent: number;
  success: boolean;
}

export async function generateSkin(
  env: Env,
  imageDataUrl: string,
  provider: SkinGenerationProvider = new FluxKleinProvider(env),
): Promise<GenerateResult> {
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/") ||
    imageDataUrl.length > MAX_IMAGE_CHARS
  ) {
    return fail(400, "이미지 형식이 올바르지 않아요", "bad_request", 0);
  }

  // ---------- 1) 사진 분석 ----------
  const analysisResult = await runPhotoAnalysis(env, imageDataUrl);
  let spent = NEURONS_VISION_ANALYSIS;
  if (!analysisResult.ok) {
    console.log("analysis failed:", analysisResult.reason, analysisResult.detail);
    // ai_error는 호출 자체가 실패했을 수 있어 보수적으로 분석 1회 비용만 계상
    return fail(
      502,
      analysisResult.reason === "invalid_response"
        ? "결과 형식이 올바르지 않아요"
        : "AI가 스킨을 만드는 데 실패했어요",
      "ai_failed",
      spent,
    );
  }
  const analysis = analysisResult.analysis;

  if (analysis.quality === "fail") {
    return {
      status: 422,
      body: {
        ok: false,
        quality: analysis.quality,
        failReason: analysis.failReason ?? "unknown",
        error: "사진에서 인물을 인식하지 못했어요",
        errorCode: "photo_rejected",
      },
      neuronsSpent: spent,
      success: false,
    };
  }

  const features = fallbackFeaturesToHex(analysis.fallbackFeatures);
  const summary: AnalysisSummary = {
    framing: analysis.framing,
    visibleRegions: analysis.visibleRegions,
    observed: analysis.observed,
    inferred: analysis.inferred,
  };

  // ---------- 2) 이미지 생성 (feature flag) ----------
  let skinPngBase64: string | null = null;
  if (env.IMAGE_GENERATION_ENABLED === "true") {
    const mode: GenerationStrategy =
      env.IMAGE_GEN_STRATEGY === "direct_atlas" ? "direct_atlas" : "front_view";
    const baseSeed = (Math.random() * 0xffffffff) >>> 0;
    for (let attempt = 0; attempt < 2 && skinPngBase64 === null; attempt++) {
      const generated = await provider.generate({
        analysis,
        photoDataUrl: imageDataUrl,
        seed: (baseSeed + attempt * 7919) >>> 0,
        mode,
      });
      if (!generated.ok) {
        console.log(`image gen attempt ${attempt} failed:`, generated.error);
        if (!generated.retryable) {
          // 사진 크기/형식 문제는 재시도해도 동일하므로 즉시 fallback
          break;
        }
        continue;
      }
      spent +=
        generated.inputTiles * NEURONS_IMAGE_INPUT_TILE +
        NEURONS_IMAGE_OUTPUT_TILE;
      const atlas = await postprocess(generated.imageBytes, attempt, mode);
      if (atlas) {
        skinPngBase64 = atlas;
      }
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      quality: analysis.quality,
      features,
      analysis: summary,
      ...(skinPngBase64
        ? { skinPngBase64, generationMode: "image" as const }
        : { generationMode: "procedural_fallback" as const }),
    },
    neuronsSpent: spent,
    success: true,
  };
}

/** FLUX 출력 → 64x64 atlas. 검증 실패 시 null (재시도 유도) */
async function postprocess(
  imageBytes: Uint8Array,
  attempt: number,
  mode: GenerationStrategy,
): Promise<string | null> {
  try {
    const decoded = await decodeImage(imageBytes);
    let atlas;
    if (mode === "front_view") {
      // 정면 캐릭터 뷰 → 결정적 pack (UV 배치를 코드가 보장)
      const packed = packFrontViewToAtlas(decoded);
      if (!packed) {
        console.log(`attempt ${attempt}: 정면 뷰에서 캐릭터를 분리하지 못함`);
        return null;
      }
      atlas = packed.atlas;
    } else {
      if (decoded.width !== decoded.height || decoded.width < 64) {
        console.log(`attempt ${attempt}: 비정사각 출력 ${decoded.width}x${decoded.height}`);
        return null;
      }
      atlas = downscaleToAtlas(decoded);
    }
    const verdict = validateAtlas(atlas);
    if (!verdict.ok) {
      console.log(`attempt ${attempt}: atlas 검증 실패 —`, verdict.problems.join(" / "));
      return null;
    }
    applyUvMask(atlas);
    const finalVerdict = validateFinalAtlas(atlas);
    if (!finalVerdict.ok) {
      console.log(`attempt ${attempt}: 최종 검증 실패 —`, finalVerdict.problems.join(" / "));
      return null;
    }
    return bytesToBase64(await encodePng(atlas));
  } catch (error) {
    console.log(
      `attempt ${attempt}: 후처리 오류 —`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function fail(
  status: number,
  error: string,
  errorCode: string,
  neuronsSpent: number,
): GenerateResult {
  return {
    status,
    body: { ok: false, error, errorCode },
    neuronsSpent,
    success: false,
  };
}

// ---------- 팔레트 이름 → hex (절차적 fallback 생성기 계약 유지) ----------

const SKIN_TONES: Record<string, string> = {
  pale: "#f2d6c0",
  light: "#e8b98f",
  medium: "#d29b6e",
  tan: "#b97f52",
  brown: "#8d5a3a",
  dark: "#5f3a24",
};

const HAIR_COLORS: Record<string, string> = {
  black: "#1b1b1b",
  "dark-brown": "#3b2a1e",
  brown: "#5a3d28",
  "light-brown": "#8a6240",
  blonde: "#d8b569",
  platinum: "#e9dcc0",
  red: "#a53c22",
  auburn: "#7a3b22",
  gray: "#9a9a9a",
  white: "#e8e8e8",
  "dyed-blue": "#4d9de0",
  "dyed-pink": "#e58bb6",
  "dyed-purple": "#8560b0",
  "dyed-green": "#4fa05a",
};

const EYE_COLORS: Record<string, string> = {
  black: "#241f1c",
  "dark-brown": "#4a3728",
  brown: "#6b4a2f",
  hazel: "#8a6a3b",
  green: "#4f7a46",
  blue: "#4a7fae",
  gray: "#7d8a92",
};

const CLOTHING_COLORS: Record<string, string> = {
  black: "#22201e",
  white: "#f2f2f2",
  gray: "#8c8c8c",
  "light-gray": "#c9c9c9",
  red: "#c0392b",
  orange: "#e07b2a",
  yellow: "#e3c14d",
  green: "#4fa05a",
  "dark-green": "#2e5e3a",
  blue: "#4d9de0",
  navy: "#2c3e63",
  "sky-blue": "#7fc3e8",
  purple: "#8560b0",
  pink: "#e58bb6",
  brown: "#7a543a",
  beige: "#d9c4a3",
  denim: "#3b5a80",
  khaki: "#9a8f6a",
};

/** 팔레트 이름 → hex. 모델이 hex를 직접 준 경우도 허용, 그 외엔 fallback. */
function paletteHex(
  value: unknown,
  table: Record<string, string>,
  fallback: string,
): string {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (table[key]) {
      return table[key];
    }
    if (/^#[0-9a-f]{6}$/.test(key)) {
      return key;
    }
  }
  return fallback;
}

export function fallbackFeaturesToHex(
  raw: FallbackFeatures,
): Record<string, unknown> {
  const source = raw as unknown as Record<string, unknown>;
  return {
    ...source,
    skinTone: paletteHex(source.skinTone, SKIN_TONES, SKIN_TONES.light),
    hairColor: paletteHex(source.hairColor, HAIR_COLORS, HAIR_COLORS["dark-brown"]),
    eyeColor: paletteHex(source.eyeColor, EYE_COLORS, EYE_COLORS["dark-brown"]),
    glassesColor: paletteHex(source.glassesColor, CLOTHING_COLORS, CLOTHING_COLORS.black),
    hatColor: paletteHex(source.hatColor, CLOTHING_COLORS, CLOTHING_COLORS.red),
    topColor: paletteHex(source.topColor, CLOTHING_COLORS, CLOTHING_COLORS.blue),
    topAccentColor: paletteHex(source.topAccentColor, CLOTHING_COLORS, CLOTHING_COLORS.white),
    bottomColor: paletteHex(source.bottomColor, CLOTHING_COLORS, CLOTHING_COLORS.denim),
    shoesColor: paletteHex(source.shoesColor, CLOTHING_COLORS, CLOTHING_COLORS.white),
  };
}
