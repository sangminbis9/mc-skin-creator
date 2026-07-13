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
import { bytesToBase64, decodeImage, encodePng, type RawImage } from "./png";
import {
  DEFAULT_FACE_STYLE,
  packFrontViewToAtlas,
  type FaceStyle,
} from "./skinPack";
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
  renderHints: PhotoAnalysis["renderHints"];
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
  analysisImageDataUrl: string = imageDataUrl,
): Promise<GenerateResult> {
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/") ||
    imageDataUrl.length > MAX_IMAGE_CHARS ||
    typeof analysisImageDataUrl !== "string" ||
    !analysisImageDataUrl.startsWith("data:image/") ||
    analysisImageDataUrl.length > MAX_IMAGE_CHARS
  ) {
    return fail(400, "이미지 형식이 올바르지 않아요", "bad_request", 0);
  }

  // ---------- 1) 사진 분석 ----------
  const analysisResult = await runPhotoAnalysis(env, analysisImageDataUrl);
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
    renderHints: analysis.renderHints,
  };
  const faceStyle = buildFaceStyle(analysis, features);

  // ---------- 2) 이미지 생성 (feature flag) ----------
  let skinPngBase64: string | null = null;
  let generationMode: GenerationMode = "procedural_fallback";
  if (env.IMAGE_GENERATION_ENABLED === "true") {
    const mode: GenerationStrategy =
      env.IMAGE_GEN_STRATEGY === "direct_atlas" ? "direct_atlas" : "front_view";
    // 얼굴 구조적 합성용 특징 (색은 hex로 매핑된 값, 나머지는 분류값 그대로)
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
        generated.outputTiles * NEURONS_IMAGE_OUTPUT_TILE;
      const atlas = await postprocess(generated.imageBytes, attempt, mode, faceStyle);
      if (atlas) {
        skinPngBase64 = atlas;
        generationMode = "image";
      }
    }
  }

  if (skinPngBase64 === null) {
    skinPngBase64 = await buildProceduralFallbackPng(features, faceStyle);
  }

  return {
    status: 200,
    body: {
      ok: true,
      quality: analysis.quality,
      features,
      analysis: summary,
      ...(skinPngBase64 ? { skinPngBase64 } : {}),
      generationMode,
    },
    neuronsSpent: spent,
    success: true,
  };
}

function buildFaceStyle(
  analysis: PhotoAnalysis,
  features: Record<string, unknown>,
): FaceStyle {
  const raw = analysis.fallbackFeatures as unknown as Record<string, unknown>;
  const style: FaceStyle = {
    eyeColor: String(features.eyeColor),
    glassesColor: String(features.glassesColor),
    eyebrowThickness: String(raw.eyebrowThickness ?? DEFAULT_FACE_STYLE.eyebrowThickness),
    expression: String(raw.expression ?? DEFAULT_FACE_STYLE.expression),
    facialHair: String(raw.facialHair ?? DEFAULT_FACE_STYLE.facialHair),
    glasses: String(raw.glasses ?? DEFAULT_FACE_STYLE.glasses),
    hairstyle: String(raw.hairstyle ?? DEFAULT_FACE_STYLE.hairstyle),
    hat: String(raw.hat ?? DEFAULT_FACE_STYLE.hat),
    faceShape: analysis.renderHints.faceShape,
    eyeShape: analysis.renderHints.eyeShape,
    eyeSpacing: analysis.renderHints.eyeSpacing,
    eyebrowShape: analysis.renderHints.eyebrowShape,
    noseShape: analysis.renderHints.noseShape,
    mouthShape: analysis.renderHints.mouthShape,
    jawShape: analysis.renderHints.jawShape,
    bangs: analysis.renderHints.bangs,
    bangsLength: analysis.renderHints.bangsLength,
    bangsDensity: analysis.renderHints.bangsDensity,
    hairTexture: analysis.renderHints.hairTexture,
    hairVolume: analysis.renderHints.hairVolume,
    hairSilhouette: analysis.renderHints.hairSilhouette,
    hairBackShape: analysis.renderHints.hairBackShape,
    hairPart: analysis.renderHints.hairPart,
    sideHairLength: analysis.renderHints.sideHairLength,
    sideHairShape: analysis.renderHints.sideHairShape,
    garmentTexture: analysis.renderHints.garmentTexture,
    outerLayer: analysis.renderHints.outerLayer,
    outerGarment: analysis.renderHints.outerGarment,
    necklace: analysis.renderHints.necklace,
    hairAccessory: analysis.renderHints.hairAccessory,
    hairAccessorySide: analysis.renderHints.hairAccessorySide,
    neckAccessory: analysis.renderHints.neckAccessory,
    bottomPattern: analysis.renderHints.bottomPattern,
    bottomAccent: analysis.renderHints.bottomAccent,
    legwear: analysis.renderHints.legwear,
    legwearAsymmetry: analysis.renderHints.legwearAsymmetry,
    topType: String(raw.topType ?? DEFAULT_FACE_STYLE.topType),
    sleeveLength: String(raw.sleeveLength ?? DEFAULT_FACE_STYLE.sleeveLength),
    bottomType: String(raw.bottomType ?? DEFAULT_FACE_STYLE.bottomType),
  };
  completeVisibleUpperDetails(analysis, style);
  completeVisibleAccessoryDetails(analysis, style);
  completeInferredLowerDetails(analysis, style);
  return style;
}

function featureRgb(
  features: Record<string, unknown>,
  key: string,
  fallback: [number, number, number],
): [number, number, number] {
  const value = features[key];
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function buildProceduralFrontView(
  features: Record<string, unknown>,
  style: FaceStyle,
): RawImage {
  const width = 512;
  const rgba = new Uint8Array(width * width * 4);
  const skin = featureRgb(features, "skinTone", [232, 185, 143]);
  const hair = featureRgb(features, "hairColor", [59, 42, 30]);
  const eye = featureRgb(features, "eyeColor", [74, 55, 40]);
  const top = featureRgb(features, "topColor", [77, 157, 224]);
  const accent = featureRgb(features, "topAccentColor", [242, 242, 242]);
  const bottom = featureRgb(features, "bottomColor", [59, 90, 128]);
  const shoes = featureRgb(features, "shoesColor", [242, 242, 242]);
  const fill = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: [number, number, number],
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = (y * width + x) * 4;
        rgba[d] = color[0];
        rgba[d + 1] = color[1];
        rgba[d + 2] = color[2];
        rgba[d + 3] = 255;
      }
    }
  };

  fill(196, 40, 316, 180, skin);
  fill(196, 40, 316, 104, hair);
  if (style.hairstyle === "long" || style.hairstyle === "twintails") {
    fill(196, 88, 212, 180, hair);
    fill(300, 88, 316, 180, hair);
  }
  fill(220, 120, 240, 140, eye);
  fill(272, 120, 292, 140, eye);

  fill(196, 180, 316, 330, top);
  fill(136, 180, 196, 330, top);
  fill(316, 180, 376, 330, top);
  if (style.outerGarment !== "none" || style.neckAccessory !== "none") {
    fill(224, 180, 288, 238, accent);
  }
  if (style.sleeveLength === "short") {
    fill(136, 244, 196, 330, skin);
    fill(316, 244, 376, 330, skin);
  }

  const shortBottom = style.bottomType === "shorts" || style.bottomType === "skirt";
  if (shortBottom) {
    fill(196, 330, 316, 382, bottom);
    fill(196, 382, 316, 456, skin);
  } else {
    fill(196, 330, 316, 456, bottom);
  }
  fill(196, 456, 316, 480, shoes);
  return { width, height: width, rgba };
}

async function buildProceduralFallbackPng(
  features: Record<string, unknown>,
  style: FaceStyle,
): Promise<string | null> {
  try {
    const packed = packFrontViewToAtlas(buildProceduralFrontView(features, style), style);
    if (!packed) return null;
    const atlas = packed.atlas;
    const verdict = validateAtlas(atlas);
    if (!verdict.ok) {
      console.log("procedural fallback validation failed:", verdict.problems.join(" / "));
      return null;
    }
    applyUvMask(atlas);
    const finalVerdict = validateFinalAtlas(atlas);
    if (!finalVerdict.ok) {
      console.log("procedural fallback final validation failed:", finalVerdict.problems.join(" / "));
      return null;
    }
    return bytesToBase64(await encodePng(atlas));
  } catch (error) {
    console.log(
      "procedural fallback failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** FLUX 출력 → 64x64 atlas. 검증 실패 시 null (재시도 유도) */
async function postprocess(
  imageBytes: Uint8Array,
  attempt: number,
  mode: GenerationStrategy,
  faceStyle: FaceStyle,
): Promise<string | null> {
  try {
    const decoded = await decodeImage(imageBytes);
    let atlas;
    if (mode === "front_view") {
      // 정면 캐릭터 뷰 → 결정적 pack (UV 배치를 코드가 보장)
      const packed = packFrontViewToAtlas(decoded, faceStyle);
      if (!packed) {
        console.log(`attempt ${attempt}: 정면 뷰에서 캐릭터를 분리하지 못함`);
        return null;
      }
      if (!packed.hasBackView) {
        console.log(`attempt ${attempt}: 뒷면 뷰가 없어 정체성 일관성 검증 실패`);
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

function completeInferredLowerDetails(analysis: PhotoAnalysis, style: FaceStyle): void {
  if (analysis.visibleRegions.lowerBody) {
    completeVisibleLowerDetails(analysis, style);
    return;
  }

  const structuredLower = analysis.inferred.lowerBodyDesign;
  if (structuredLower) {
    style.bottomType = structuredLower.bottomType;
    style.bottomPattern = structuredLower.bottomPattern;
    style.bottomAccent = structuredLower.bottomAccent;
    style.legwear = structuredLower.legwear;
    style.legwearAsymmetry = structuredLower.legwearAsymmetry;
    style.shoeStyle = structuredLower.shoeStyle;
  }

  const lowerText = [
    analysis.inferred.lowerBody?.value,
    analysis.inferred.lowerBody?.rationale,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const inferredText = [
    analysis.inferred.lowerBody?.value,
    analysis.inferred.lowerBody?.rationale,
    analysis.inferred.shoes?.value,
    analysis.outfitPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const topType = style.topType ?? "tshirt";
  const smartCasualTop =
    ["shirt", "sweater", "jacket", "dress"].includes(topType) ||
    (style.outerGarment !== undefined && style.outerGarment !== "none") ||
    (style.neckAccessory !== undefined && style.neckAccessory !== "none");
  const preppyTop =
    (style.outerGarment === "cardigan" || style.outerGarment === "vest") &&
    (style.neckAccessory === "bow" || style.neckAccessory === "collar");
  const structuredGenericLower =
    Boolean(structuredLower) &&
    (style.bottomType ?? "pants") === "pants" &&
    (style.bottomPattern ?? "plain") === "plain" &&
    (style.bottomAccent ?? "none") === "none" &&
    (style.legwear ?? "none") === "none" &&
    (style.shoeStyle ?? "sneakers") === "sneakers";

  if (!structuredLower) {
    if (/\b(skort|skorts|culotte skirt|pleated culottes|plaid culottes|pleated shorts|plaid shorts)\b/.test(inferredText)) {
      style.bottomType = "skirt";
    } else if (/\b(skirt|pleated skirt|plaid skirt|tartan skirt)\b/.test(inferredText)) {
      style.bottomType = "skirt";
    } else if (/\b(shorts|short pants|culottes)\b/.test(inferredText)) {
      style.bottomType = "shorts";
    } else if (/\b(jeans|denim)\b/.test(inferredText)) {
      style.bottomType = "jeans";
    } else if (/\b(pants|trousers|slacks|chinos|joggers)\b/.test(inferredText)) {
      style.bottomType = "pants";
    } else if ((style.bottomType ?? "pants") === "pants" && preppyTop) {
      style.bottomType = "skirt";
    }

    if (/\b(plaid|checkered|checked|tartan)\b/.test(inferredText)) {
      style.bottomPattern = "plaid";
    } else if (/\b(pleated|pleats|pleat)\b/.test(inferredText)) {
      style.bottomPattern = "pleated";
    } else if (/\b(striped|stripes)\b/.test(inferredText)) {
      style.bottomPattern = "striped";
    } else if (/\b(lace|lacy)\b/.test(inferredText)) {
      style.bottomPattern = "lace";
    }

    if (/\b(ribbon|bow)\b/.test(lowerText)) {
      style.bottomAccent = "ribbon";
    } else if (/\b(belt|belted)\b/.test(lowerText)) {
      style.bottomAccent = "belt";
    } else if (/\b(cuff|cuffed|cuffs)\b/.test(lowerText)) {
      style.bottomAccent = "cuffs";
    } else if (/\b(side stripe|side stripes)\b/.test(lowerText)) {
      style.bottomAccent = "side_stripe";
    }

    if (/\b(leg warmer|leg warmers)\b/.test(inferredText)) {
      style.legwear = "leg_warmers";
    } else if (/\b(knee high|knee-high|knee highs|knee-highs|over knee|over-knee|over the knee|otk)\b/.test(inferredText)) {
      style.legwear = "thigh_highs";
    } else if (/\b(thigh high|thigh-high|thigh highs|thigh-highs)\b/.test(inferredText)) {
      style.legwear = "thigh_highs";
    } else if (/\b(stockings|stocking|tights)\b/.test(inferredText)) {
      style.legwear = "stockings";
    } else if (/\b(socks|sock)\b/.test(inferredText)) {
      style.legwear = "socks";
    }

    if ((style.legwear ?? "none") !== "none") {
      const oneSided =
        /\b(one|single|only one|asymmetric|asymmetrical|one-sided)\b/.test(inferredText);
      const leftMention =
        /\b(viewer-left|left leg|left-side|left side|left thigh|left sock|left leg warmer)\b/.test(
          inferredText,
        );
      const rightMention =
        /\b(viewer-right|right leg|right-side|right side|right thigh|right sock|right leg warmer)\b/.test(
          inferredText,
        );
      if (leftMention && !rightMention) {
        style.legwearAsymmetry = "left";
      } else if (rightMention && !leftMention) {
        style.legwearAsymmetry = "right";
      } else if (oneSided && (style.legwearAsymmetry ?? "none") === "none") {
        style.legwearAsymmetry = "left";
      } else if (!oneSided && leftMention && rightMention) {
        style.legwearAsymmetry = "both";
      }
    }
  } else if (structuredGenericLower && preppyTop) {
    style.bottomType = "skirt";
    style.bottomPattern = "pleated";
    style.bottomAccent = style.neckAccessory === "bow" ? "ribbon" : "belt";
    style.legwear = "socks";
    style.legwearAsymmetry = "both";
    style.shoeStyle = "dress_shoes";
  }

  const bottomType = style.bottomType ?? "pants";

  if (!structuredLower && (style.bottomAccent ?? "none") === "none") {
    style.bottomAccent = smartCasualTop
      ? "belt"
      : topType === "hoodie"
        ? "cuffs"
        : "side_stripe";
  }

  if (
    (bottomType === "skirt" || bottomType === "shorts") &&
    (style.bottomPattern ?? "plain") === "plain" &&
    smartCasualTop &&
    !structuredLower
  ) {
    style.bottomPattern = style.neckAccessory === "bow" || style.neckAccessory === "collar"
      ? "pleated"
      : "striped";
  }

  if (
    (style.legwear ?? "none") === "none" &&
    (bottomType === "skirt" || bottomType === "shorts") &&
    (style.outerGarment === "cardigan" || style.neckAccessory === "bow") &&
    !structuredLower
  ) {
    style.legwear = "socks";
    style.legwearAsymmetry = "both";
  }
}

function completeVisibleUpperDetails(analysis: PhotoAnalysis, style: FaceStyle): void {
  const upperText = [
    analysis.observed.clothing,
    analysis.observed.accessories,
    analysis.outfitPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/\b(cardigan|open cardigan)\b/.test(upperText)) {
    style.outerGarment = "cardigan";
    style.topType = style.topType === "tshirt" ? "shirt" : style.topType;
    style.outerLayer = style.outerLayer === "none" ? "heavy" : style.outerLayer;
  } else if (/\b(open jacket|unbuttoned jacket|jacket)\b/.test(upperText)) {
    style.outerGarment = "open_jacket";
    style.topType = "jacket";
    style.outerLayer = style.outerLayer === "none" ? "heavy" : style.outerLayer;
  } else if (/\b(coat|long coat|overcoat)\b/.test(upperText)) {
    style.outerGarment = "coat";
    style.topType = "jacket";
    style.outerLayer = "heavy";
  } else if (/\b(vest|waistcoat)\b/.test(upperText)) {
    style.outerGarment = "vest";
    style.topType = style.topType === "tshirt" ? "shirt" : style.topType;
    style.outerLayer = style.outerLayer === "none" ? "light" : style.outerLayer;
  }

  if (/\b(knit|knitted|cable knit|sweater)\b/.test(upperText)) {
    style.garmentTexture = "knit";
    if (style.topType === "tshirt") style.topType = "sweater";
  } else if (/\b(denim)\b/.test(upperText)) {
    style.garmentTexture = "denim";
  } else if (/\b(leather)\b/.test(upperText)) {
    style.garmentTexture = "leather";
  } else if (/\b(striped|stripes)\b/.test(upperText)) {
    style.garmentTexture = "striped";
  } else if (/\b(patterned|floral|plaid|checkered|checked)\b/.test(upperText)) {
    style.garmentTexture = "patterned";
  }

  if (/\b(long sleeve|long-sleeve|long sleeves|sleeved cardigan|sleeved jacket)\b/.test(upperText)) {
    style.sleeveLength = "long";
  }
}

function completeVisibleLowerDetails(analysis: PhotoAnalysis, style: FaceStyle): void {
  const visibleText = [
    analysis.observed.clothing,
    analysis.outfitPrompt,
    analysis.identityPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/\b(skort|skorts|culotte skirt|pleated culottes|plaid culottes|pleated shorts|plaid shorts)\b/.test(visibleText)) {
    style.bottomType = "skirt";
  } else if (/\b(skirt|pleated skirt|plaid skirt|tartan skirt|miniskirt|mini skirt)\b/.test(visibleText)) {
    style.bottomType = "skirt";
  } else if (/\b(shorts|short pants|culottes)\b/.test(visibleText)) {
    style.bottomType = "shorts";
  } else if (/\b(jeans|denim)\b/.test(visibleText)) {
    style.bottomType = "jeans";
  } else if (/\b(pants|trousers|slacks|chinos|joggers)\b/.test(visibleText)) {
    style.bottomType = "pants";
  } else if (
    (style.bottomType ?? "pants") === "pants" &&
    (analysis.renderHints.bottomPattern === "pleated" ||
      analysis.renderHints.bottomAccent === "ribbon") &&
    (analysis.renderHints.neckAccessory === "bow" ||
      analysis.renderHints.outerGarment === "cardigan")
  ) {
    style.bottomType = "skirt";
  }

  if (/\b(plaid|checkered|checked|tartan)\b/.test(visibleText)) {
    style.bottomPattern = "plaid";
  } else if (/\b(pleated|pleats|pleat)\b/.test(visibleText)) {
    style.bottomPattern = "pleated";
  } else if (/\b(striped|stripes)\b/.test(visibleText)) {
    style.bottomPattern = "striped";
  } else if (/\b(lace|lacy)\b/.test(visibleText)) {
    style.bottomPattern = "lace";
  }

  if (/\b(ribbon|bow)\b/.test(visibleText) && (style.bottomAccent ?? "none") === "none") {
    style.bottomAccent = "ribbon";
  } else if (/\b(belt|belted)\b/.test(visibleText)) {
    style.bottomAccent = "belt";
  } else if (/\b(cuff|cuffed|cuffs)\b/.test(visibleText)) {
    style.bottomAccent = "cuffs";
  } else if (/\b(side stripe|side stripes)\b/.test(visibleText)) {
    style.bottomAccent = "side_stripe";
  }

  if (/\b(leg warmer|leg warmers)\b/.test(visibleText)) {
    style.legwear = "leg_warmers";
  } else if (/\b(knee high|knee-high|knee highs|knee-highs|over knee|over-knee|over the knee|otk)\b/.test(visibleText)) {
    style.legwear = "thigh_highs";
  } else if (/\b(thigh high|thigh-high|thigh highs|thigh-highs)\b/.test(visibleText)) {
    style.legwear = "thigh_highs";
  } else if (/\b(stockings|stocking|tights)\b/.test(visibleText)) {
    style.legwear = "stockings";
  } else if (/\b(socks|sock)\b/.test(visibleText)) {
    style.legwear = "socks";
  }

  const legwearSideText = relevantClauses(
    [analysis.observed.clothing, analysis.outfitPrompt, analysis.identityPrompt],
    /\b(leg warmer|leg warmers|knee[- ]?high|over[- ]?knee|otk|thigh[- ]?high|stocking|stockings|tights|sock|socks)\b/,
  );
  if ((style.legwear ?? "none") !== "none" && legwearSideText) {
    const leftMention = /\b(viewer(?:'s)?[- ]left|left)\b/.test(legwearSideText);
    const rightMention = /\b(viewer(?:'s)?[- ]right|right)\b/.test(legwearSideText);
    if (leftMention && !rightMention) {
      style.legwearAsymmetry = "left";
    } else if (rightMention && !leftMention) {
      style.legwearAsymmetry = "right";
    } else if (leftMention && rightMention) {
      style.legwearAsymmetry = "both";
    } else if (/\b(one|single|asymmetric|asymmetrical|one-sided)\b/.test(legwearSideText)) {
      style.legwearAsymmetry = style.legwearAsymmetry === "none" ? "left" : style.legwearAsymmetry;
    }
  }

  if (/\b(dress shoes|mary jane|mary janes|loafers)\b/.test(visibleText)) {
    style.shoeStyle = "dress_shoes";
  } else if (/\b(boots|boot)\b/.test(visibleText)) {
    style.shoeStyle = "boots";
  } else if (/\b(sandals|sandal)\b/.test(visibleText)) {
    style.shoeStyle = "sandals";
  } else if (/\b(sneakers|sneaker|trainers)\b/.test(visibleText)) {
    style.shoeStyle = "sneakers";
  }
}

function completeVisibleAccessoryDetails(analysis: PhotoAnalysis, style: FaceStyle): void {
  const accessoryText = [
    analysis.observed.accessories,
    analysis.observed.hair,
    analysis.observed.clothing,
    analysis.outfitPrompt,
    analysis.identityPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const hairAccessoryText = [
    analysis.observed.accessories,
    analysis.observed.hair,
    analysis.identityPrompt,
    analysis.outfitPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const hairAccessorySideText = relevantClauses(
    [
      analysis.observed.accessories,
      analysis.observed.hair,
      analysis.identityPrompt,
      analysis.outfitPrompt,
    ],
    /\b(flower|flowers|floral|hair bow|bow in hair|head bow|hair ribbon|ribbon in hair|head ribbon|hair clip|barrette|hairpin|pin in hair)\b/,
  );

  if ((style.hairAccessory ?? "none") === "none") {
    if (
      /\b(flower|floral)\b/.test(hairAccessoryText) &&
      /\b(hair|head|clip|accessory|viewer-left|viewer-right|left|right)\b/.test(hairAccessoryText)
    ) {
      style.hairAccessory = "flower";
    } else if (/\b(hair bow|bow in hair|head bow)\b/.test(hairAccessoryText)) {
      style.hairAccessory = "bow";
    } else if (/\b(hair ribbon|ribbon in hair|head ribbon)\b/.test(hairAccessoryText)) {
      style.hairAccessory = "ribbon";
    } else if (/\b(hair clip|barrette|hairpin|pin in hair)\b/.test(hairAccessoryText)) {
      style.hairAccessory = "clip";
    }
  }

  if ((style.hairAccessory ?? "none") !== "none") {
    const sideText = hairAccessorySideText || hairAccessoryText;
    const leftMention = /\b(viewer(?:'s)?[- ]left|left side|left hair|left temple)\b/.test(sideText);
    const rightMention = /\b(viewer(?:'s)?[- ]right|right side|right hair|right temple)\b/.test(sideText);
    if (rightMention && !leftMention) {
      style.hairAccessorySide = "right";
    } else if (leftMention && !rightMention) {
      style.hairAccessorySide = "left";
    } else if (/\b(center|middle|top center)\b/.test(sideText)) {
      style.hairAccessorySide = "center";
    }
  }

  if ((style.neckAccessory ?? "none") === "none") {
    if (/\b(bow collar|neck bow|bow at the neck|bow tie)\b/.test(accessoryText)) {
      style.neckAccessory = "bow";
    } else if (/\b(necktie|tie)\b/.test(accessoryText)) {
      style.neckAccessory = "tie";
    } else if (/\b(scarf)\b/.test(accessoryText)) {
      style.neckAccessory = "scarf";
    } else if (/\b(distinct collar|large collar|white collar|collared shirt)\b/.test(accessoryText)) {
      style.neckAccessory = "collar";
    }
  }

  if ((style.necklace ?? "none") === "none") {
    if (/\b(silver necklace|silver chain|silver pendant)\b/.test(accessoryText)) {
      style.necklace = "silver";
    } else if (/\b(gold necklace|gold chain|gold pendant)\b/.test(accessoryText)) {
      style.necklace = "gold";
    } else if (/\b(black necklace|dark necklace|dark chain)\b/.test(accessoryText)) {
      style.necklace = "dark";
    }
  }
}

function relevantClauses(
  values: Array<string | null | undefined>,
  relevant: RegExp,
): string {
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.toLowerCase().split(/[.!?;,\n]+/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && relevant.test(clause))
    .join(" ");
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
