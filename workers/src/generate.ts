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
  runPortraitDetailAnalysis,
  runPhotoAnalysis,
  type FallbackFeatures,
  type NeckDetailAnalysis,
  type PhotoAnalysis,
  type PortraitDetailAnalysis,
} from "./analysis";
import {
  base64ToBytes,
  bytesToBase64,
  decodeImage,
  encodePng,
  type RawImage,
} from "./png";
import {
  DEFAULT_FACE_STYLE,
  packFrontViewToAtlas,
  type FaceStyle,
} from "./skinPack";
import {
  applyUvMask,
  validateAtlas,
  validateAtlasCraft,
  validateFinalAtlas,
} from "./skinPost";
import {
  FluxKleinProvider,
  type GenerationStrategy,
  type ImageModelTier,
  type SkinGenerationProvider,
} from "./skinProvider";
import { imageGenerationNeurons } from "./quota";
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
  /** Workers AI rejected an image-model call because the shared account quota is closed. */
  providerQuotaExhausted?: boolean;
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
  // Every provider invocation consumes Workers AI capacity, including schema
  // retries and fallback-model attempts. Count all of them so the app quota
  // cannot claim capacity remains after the Cloudflare allocation is spent.
  let spent = analysisResult.neuronsSpent;
  if (!analysisResult.ok) {
    console.log(
      "analysis failed:",
      analysisResult.reason,
      analysisResult.detail,
    );
    // Persist only provider/schema diagnostics, never the uploaded image or
    // model response. This makes production failures inspectable even when a
    // sampled tail misses the request.
    await env.MCSKIN_KV.put(
      "diagnostic:last-analysis-failure",
      JSON.stringify({
        at: new Date().toISOString(),
        reason: analysisResult.reason,
        detail: analysisResult.detail.slice(0, 1500),
        attempts: analysisResult.attempts,
      }),
      { expirationTtl: 60 * 60 * 48 },
    ).catch(() => undefined);
    if (analysisResult.reason === "quota_exceeded") {
      return fail(
        429,
        "오늘의 AI 생성 수량이 마감됐어요",
        "quota_exceeded",
        spent,
      );
    }
    return fail(
      502,
      analysisResult.reason === "invalid_response"
        ? "결과 형식이 올바르지 않아요"
        : "AI가 스킨을 만드는 데 실패했어요",
      "ai_failed",
      spent,
    );
  }
  let analysis = analysisResult.analysis;

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

  // The full-frame pass has to divide its attention between the face, hair,
  // outfit and missing-body inference. On tall photos, enlarge the visible
  // portrait once and let one cheap structured pass re-check the face, hair
  // and throat construction that become a handful of pixels in the original
  // frame. Keeping these in one pass avoids spending free-tier capacity on a
  // second request over the exact same crop.
  const upperBodyDetailCrop =
    await createUpperBodyDetailCrop(analysisImageDataUrl);
  if (
    upperBodyDetailCrop &&
    (analysis.visibleRegions.face || analysis.visibleRegions.hair)
  ) {
    const portraitResult = await runPortraitDetailAnalysis(
      env,
      upperBodyDetailCrop,
    );
    spent += portraitResult.neuronsSpent;
    if (!portraitResult.ok) {
      console.log(
        "focused portrait analysis failed:",
        portraitResult.reason,
        portraitResult.detail,
      );
      if (portraitResult.reason === "quota_exceeded") {
        return fail(
          429,
          "오늘의 AI 생성 할당량이 소진되었어요.",
          "quota_exceeded",
          spent,
        );
      }
    } else {
      analysis = applyFocusedPortraitDetail(analysis, portraitResult.detail);
      if (
        analysis.framing === "full_body" ||
        analysis.framing === "three_quarter"
      ) {
        analysis = applyFocusedNeckDetail(analysis, {
          neckAccessory: portraitResult.detail.neckAccessory,
          confidence: portraitResult.detail.neckConfidence,
          evidence: portraitResult.detail.neckEvidence,
        });
      }
    }
  }

  const renderAnalysis = normalizeAnalysisForRendering(analysis);
  const features = refineFeatureColorsFromAnalysis(
    renderAnalysis,
    fallbackFeaturesToHex(
      renderAnalysis.fallbackFeatures,
      renderAnalysis.renderHints.skinUndertone,
    ),
  );
  const summary: AnalysisSummary = {
    framing: renderAnalysis.framing,
    visibleRegions: renderAnalysis.visibleRegions,
    observed: renderAnalysis.observed,
    inferred: renderAnalysis.inferred,
    renderHints: renderAnalysis.renderHints,
  };
  const faceStyle = buildFaceStyle(renderAnalysis, features);

  // ---------- 2) 이미지 생성 (feature flag) ----------
  let skinPngBase64: string | null = null;
  let generationMode: GenerationMode = "procedural_fallback";
  let providerQuotaExhausted = false;
  if (env.IMAGE_GENERATION_ENABLED === "true") {
    const mode: GenerationStrategy =
      env.IMAGE_GEN_STRATEGY === "four_view" ? "four_view" : "front_view";
    // 얼굴 구조적 합성용 특징 (색은 hex로 매핑된 값, 나머지는 분류값 그대로)
    const baseSeed = (Math.random() * 0xffffffff) >>> 0;
    // Start with Klein 9B for detail. If that sheet fails structural
    // post-processing, spend only a cheap 4B call on the recovery attempt.
    // Repeating the same expensive model tended to reproduce the same layout
    // defect while exhausting the daily account allocation.
    const configuredTier: ImageModelTier =
      env.IMAGE_MODEL_TIER === "quality" ? "quality" : "balanced";
    const attemptPlan: ImageModelTier[] =
      configuredTier === "quality"
        ? ["quality", "balanced"]
        : ["balanced", "balanced"];
    let generationReferenceDataUrl = imageDataUrl;
    for (
      let attempt = 0;
      attempt < attemptPlan.length && skinPngBase64 === null;
      attempt++
    ) {
      const modelTier = attemptPlan[attempt];
      const generated = await provider.generate({
        analysis: renderAnalysis,
        photoDataUrl: generationReferenceDataUrl,
        seed: (baseSeed + attempt * 7919) >>> 0,
        mode,
        modelTier,
      });
      if (!generated.ok) {
        if (generated.capacityConsumed) {
          spent += imageGenerationNeurons(env, 2, 2, modelTier);
        }
        if (generated.quotaExceeded) {
          providerQuotaExhausted = true;
        }
        console.log(`image gen attempt ${attempt} failed:`, generated.error);
        await env.MCSKIN_KV.put(
          "diagnostic:last-image-failure",
          JSON.stringify({
            at: new Date().toISOString(),
            attempt: attempt + 1,
            detail: generated.error.slice(0, 1500),
            retryable: generated.retryable,
            referenceMode:
              generationReferenceDataUrl === imageDataUrl
                ? "source_photo"
                : "procedural_identity",
          }),
          { expirationTtl: 60 * 60 * 48 },
        ).catch(() => undefined);
        if (
          generated.retryable &&
          generationReferenceDataUrl === imageDataUrl &&
          /(?:3030|flagged|moderation)/i.test(generated.error)
        ) {
          // A benign portrait can still trip output moderation after the
          // model begins rendering. Repeating the same private photograph
          // often reproduces the rejection. Recover with an anonymized
          // pixel-character reference built from the already validated
          // analysis, retaining identity colours and geometry without
          // sending the original portrait again.
          generationReferenceDataUrl =
            (await buildProceduralGenerationReference(features, faceStyle)) ??
            generationReferenceDataUrl;
        }
        if (!generated.retryable) {
          // 사진 크기/형식 문제는 재시도해도 동일하므로 즉시 fallback
          break;
        }
        if (
          configuredTier === "quality" &&
          modelTier === "quality" &&
          generated.capacityConsumed &&
          attempt === 0
        ) {
          // Moderation/transient provider failures returned no image to
          // inspect. Give 9B one new seed before the existing balanced
          // recovery. Structural post-process failures still go directly to
          // 4B because repeating 9B tends to reproduce the same layout.
          attemptPlan.splice(attempt + 1, 0, "quality");
        }
        continue;
      }
      spent += imageGenerationNeurons(
        env,
        generated.inputTiles,
        generated.outputTiles,
        modelTier,
      );
      const processed = await postprocess(
        generated.imageBytes,
        attempt,
        mode,
        faceStyle,
      );
      if (processed.atlasBase64) {
        skinPngBase64 = processed.atlasBase64;
        generationMode = "image";
      } else if (processed.failure) {
        await env.MCSKIN_KV.put(
          "diagnostic:last-image-postprocess-failure",
          JSON.stringify({
            at: new Date().toISOString(),
            attempt: attempt + 1,
            mode,
            detail: processed.failure.slice(0, 1500),
          }),
          { expirationTtl: 60 * 60 * 48 },
        ).catch(() => undefined);
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
    ...(providerQuotaExhausted ? { providerQuotaExhausted: true } : {}),
  };
}

/**
 * Build a centered head-to-waist crop from a tall portrait. Keeping the crop
 * as PNG avoids introducing another lossy JPEG generation before the focused
 * vision pass. Landscape and nearly-square photos already dedicate enough
 * pixels to the upper body, so they skip the extra paid call.
 */
export async function createUpperBodyDetailCrop(
  imageDataUrl: string,
): Promise<string | null> {
  const match = /^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\r\n]+)$/i.exec(
    imageDataUrl,
  );
  if (!match) {
    return null;
  }
  try {
    const source = await decodeImage(base64ToBytes(match[1]));
    if (
      source.width < 32 ||
      source.height < 48 ||
      source.height <= source.width * 1.15
    ) {
      return null;
    }

    const cropWidth = Math.max(32, Math.round(source.width * 0.82));
    const cropHeight = Math.max(48, Math.round(source.height * 0.56));
    const startX = Math.max(0, Math.floor((source.width - cropWidth) / 2));
    const startY = 0;
    const rgba = new Uint8Array(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y++) {
      const sourceStart = ((startY + y) * source.width + startX) * 4;
      const targetStart = y * cropWidth * 4;
      rgba.set(
        source.rgba.subarray(sourceStart, sourceStart + cropWidth * 4),
        targetStart,
      );
    }
    const encoded = await encodePng({
      width: cropWidth,
      height: cropHeight,
      rgba,
    });
    const dataUrl = `data:image/png;base64,${bytesToBase64(encoded)}`;
    return dataUrl.length <= MAX_IMAGE_CHARS ? dataUrl : null;
  } catch (error) {
    console.log(
      "upper-body detail crop failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Merge only the portrait properties supported by the enlarged crop. The
 * crop cannot reliably establish long-hair endpoints, back construction, or
 * clothing, so those main-pass decisions remain untouched.
 */
export function applyFocusedPortraitDetail(
  analysis: PhotoAnalysis,
  detail: PortraitDetailAnalysis,
): PhotoAnalysis {
  const faceReliable = detail.faceConfidence !== "low";
  const hairReliable = detail.hairConfidence !== "low";
  if (!faceReliable && !hairReliable) {
    return analysis;
  }

  const renderHints = { ...analysis.renderHints };
  let fallbackFeatures = analysis.fallbackFeatures;
  let observed = analysis.observed;
  let identityPrompt = analysis.identityPrompt;

  if (faceReliable) {
    Object.assign(renderHints, {
      skinUndertone: detail.skinUndertone,
      faceShape: detail.faceShape,
      eyeShape: detail.eyeShape,
      eyeSize: detail.eyeSize,
      irisLightness: detail.irisLightness,
      eyeSpacing: detail.eyeSpacing,
      eyeTilt: detail.eyeTilt,
      eyebrowShape: detail.eyebrowShape,
      noseShape: detail.noseShape,
      mouthShape: detail.mouthShape,
      lipFullness: detail.lipFullness,
      lipColor: detail.lipColor,
      jawShape: detail.jawShape,
    });
    fallbackFeatures = {
      ...fallbackFeatures,
      skinTone: detail.skinTone,
      eyeColor: detail.eyeColor,
      eyebrowThickness: detail.eyebrowThickness,
    };
    const skinDescription = `${detail.skinUndertone} ${detail.skinTone} skin`;
    const eyeDescription = `${detail.eyeColor.replace("-", " ")} eyes`;
    observed = {
      ...observed,
      face: `${observed.face} Focused portrait crop confirms ${skinDescription}, ${eyeDescription}; ${detail.faceEvidence}.`.trim(),
      colorPalette: observed.colorPalette.some(
        (value) => value.toLowerCase() === skinDescription,
      )
        ? observed.colorPalette
        : [...observed.colorPalette, skinDescription],
    };
    identityPrompt =
      `${identityPrompt} Preserve the focused facial proportions, ${skinDescription}, and ${eyeDescription}: ${detail.faceEvidence}.`.trim();
  }

  if (hairReliable) {
    Object.assign(renderHints, {
      bangs: detail.bangs,
      bangsLength: detail.bangsLength,
      hairSilhouette: detail.hairSilhouette,
      bangsDensity: detail.bangsDensity,
      fringeEdge: detail.fringeEdge,
      fringeOpening: detail.fringeOpening,
      hairTexture: detail.hairTexture,
      hairVolume: detail.hairVolume,
      hairPart: detail.hairPart,
      sideHairLength: detail.sideHairLength,
      sideHairShape: detail.sideHairShape,
      sideHairAsymmetry: detail.sideHairAsymmetry,
      earExposure: detail.earExposure,
    });
    fallbackFeatures = {
      ...fallbackFeatures,
      hairColor: detail.hairColor,
    };
    const hairDescription = `${detail.hairColor.replace("-", " ")} hair`;
    observed = {
      ...observed,
      hair: `${observed.hair} Focused portrait crop confirms ${hairDescription}; ${detail.hairEvidence}.`.trim(),
      colorPalette: observed.colorPalette.some(
        (value) => value.toLowerCase() === hairDescription,
      )
        ? observed.colorPalette
        : [...observed.colorPalette, hairDescription],
    };
    identityPrompt =
      `${identityPrompt} Preserve the focused ${hairDescription}, crown-to-temple, side-length and fringe geometry: ${detail.hairEvidence}.`.trim();
  }

  return {
    ...analysis,
    observed,
    renderHints,
    fallbackFeatures,
    identityPrompt,
  };
}

/**
 * A focused result is allowed to resolve only the ambiguity it was designed
 * for. Geometry words are required even at high confidence, preventing a
 * generic "white shirt" crop from replacing the main analysis.
 */
export function applyFocusedNeckDetail(
  analysis: PhotoAnalysis,
  detail: NeckDetailAnalysis,
): PhotoAnalysis {
  if (
    !["none", "collar"].includes(analysis.renderHints.neckAccessory) ||
    detail.neckAccessory === "none" ||
    detail.confidence === "low" ||
    detail.neckAccessory === analysis.renderHints.neckAccessory
  ) {
    return analysis;
  }
  const evidence = detail.evidence.trim();
  const geometryByType: Record<
    Exclude<NeckDetailAnalysis["neckAccessory"], "none">,
    RegExp
  > = {
    bow: /\b(?:knot|loop|loops|wing|wings|tail|tails|bow)\b/i,
    scarf: /\b(?:wrap|wrapped|drape|draped|fold|folded|tail|tails|scarf)\b/i,
    tie: /\b(?:knot|blade|narrow|vertical|tie)\b/i,
    collar: /\b(?:collar|flap|flaps|lapel|lapels)\b/i,
  };
  if (!geometryByType[detail.neckAccessory].test(evidence)) {
    return analysis;
  }

  const labels: Record<
    Exclude<NeckDetailAnalysis["neckAccessory"], "none">,
    string
  > = {
    bow: "prominent neck bow",
    scarf: "draped neck scarf",
    tie: "narrow neck tie",
    collar: "short shirt collar",
  };
  const label = labels[detail.neckAccessory];
  return {
    ...analysis,
    observed: {
      ...analysis.observed,
      accessories:
        `${analysis.observed.accessories} Focused upper-body crop confirms a ${label}: ${evidence}.`.trim(),
    },
    renderHints: {
      ...analysis.renderHints,
      neckAccessory: detail.neckAccessory,
    },
    outfitPrompt:
      `${analysis.outfitPrompt} The dominant throat detail is a ${label}; preserve its visible construction (${evidence}) as a bold readable 64x64 identity cue.`.trim(),
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
    eyebrowThickness: String(
      raw.eyebrowThickness ?? DEFAULT_FACE_STYLE.eyebrowThickness,
    ),
    expression: String(raw.expression ?? DEFAULT_FACE_STYLE.expression),
    facialHair: String(raw.facialHair ?? DEFAULT_FACE_STYLE.facialHair),
    glasses: String(raw.glasses ?? DEFAULT_FACE_STYLE.glasses),
    hairstyle: String(raw.hairstyle ?? DEFAULT_FACE_STYLE.hairstyle),
    hat: String(raw.hat ?? DEFAULT_FACE_STYLE.hat),
    skinTone: String(features.skinTone),
    hairColor: String(features.hairColor),
    hatColor: String(features.hatColor),
    faceShape: analysis.renderHints.faceShape,
    eyeShape: analysis.renderHints.eyeShape,
    eyeSize: analysis.renderHints.eyeSize,
    irisLightness: analysis.renderHints.irisLightness,
    eyeSpacing: analysis.renderHints.eyeSpacing,
    eyeTilt: analysis.renderHints.eyeTilt,
    eyebrowShape: analysis.renderHints.eyebrowShape,
    noseShape: analysis.renderHints.noseShape,
    mouthShape: analysis.renderHints.mouthShape,
    lipFullness: analysis.renderHints.lipFullness,
    lipColor: analysis.renderHints.lipColor,
    jawShape: analysis.renderHints.jawShape,
    bangs: analysis.renderHints.bangs,
    bangsLength: analysis.renderHints.bangsLength,
    bangsDensity: analysis.renderHints.bangsDensity,
    fringeEdge: analysis.renderHints.fringeEdge,
    fringeOpening: analysis.renderHints.fringeOpening,
    hairTexture: analysis.renderHints.hairTexture,
    hairVolume: analysis.renderHints.hairVolume,
    hairSilhouette: analysis.renderHints.hairSilhouette,
    hairBackShape: analysis.renderHints.hairBackShape,
    overallHairLength: analysis.renderHints.overallHairLength,
    hairPart: analysis.renderHints.hairPart,
    sideHairLength: analysis.renderHints.sideHairLength,
    sideHairShape: analysis.renderHints.sideHairShape,
    sideHairAsymmetry: analysis.renderHints.sideHairAsymmetry,
    earExposure: analysis.renderHints.earExposure,
    garmentTexture: analysis.renderHints.garmentTexture,
    outerLayer: analysis.renderHints.outerLayer,
    outerGarment: analysis.renderHints.outerGarment,
    necklace: analysis.renderHints.necklace,
    hairAccessory: analysis.renderHints.hairAccessory,
    hairAccessoryScale: analysis.renderHints.hairAccessoryScale,
    hairAccessorySide: analysis.renderHints.hairAccessorySide,
    hairAccessoryColor: analysis.renderHints.hairAccessoryColor,
    neckAccessory: analysis.renderHints.neckAccessory,
    bottomPattern: analysis.renderHints.bottomPattern,
    bottomAccent: analysis.renderHints.bottomAccent,
    legwear: analysis.renderHints.legwear,
    legwearColor: paletteHex(
      analysis.renderHints.legwearColor,
      CLOTHING_COLORS,
      String(features.topAccentColor ?? CLOTHING_COLORS.white),
    ),
    legwearAsymmetry: analysis.renderHints.legwearAsymmetry,
    thighAccessory: analysis.renderHints.thighAccessory,
    thighAccessorySide: analysis.renderHints.thighAccessorySide,
    topColor: String(features.topColor),
    topAccentColor: String(features.topAccentColor),
    bottomColor: String(features.bottomColor),
    shoesColor: String(features.shoesColor),
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
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    return fallback;
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

  const shortBottom =
    style.bottomType === "shorts" || style.bottomType === "skirt";
  if (shortBottom) {
    fill(196, 330, 316, 382, bottom);
    fill(196, 382, 316, 456, skin);
  } else {
    fill(196, 330, 316, 456, bottom);
  }
  fill(196, 456, 316, 480, shoes);
  return { width, height: width, rgba };
}

/**
 * Build a privacy-preserving retry reference after FLUX output moderation.
 * It carries the analysed palette and body/hair proportions, but contains no
 * source-photo pixels. The 448px edge stays below the provider's 512px input
 * limit and the opaque neutral background makes the silhouette unambiguous.
 */
export async function buildProceduralGenerationReference(
  features: Record<string, unknown>,
  style: FaceStyle,
): Promise<string | null> {
  try {
    const source = buildProceduralFrontView(features, style);
    const width = 448;
    const height = 448;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sourceY = Math.min(
        source.height - 1,
        Math.floor((y * source.height) / height),
      );
      for (let x = 0; x < width; x++) {
        const sourceX = Math.min(
          source.width - 1,
          Math.floor((x * source.width) / width),
        );
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = (y * width + x) * 4;
        if (source.rgba[sourceOffset + 3] === 0) {
          rgba[targetOffset] = 238;
          rgba[targetOffset + 1] = 240;
          rgba[targetOffset + 2] = 244;
          rgba[targetOffset + 3] = 255;
        } else {
          rgba[targetOffset] = source.rgba[sourceOffset];
          rgba[targetOffset + 1] = source.rgba[sourceOffset + 1];
          rgba[targetOffset + 2] = source.rgba[sourceOffset + 2];
          rgba[targetOffset + 3] = 255;
        }
      }
    }
    return `data:image/png;base64,${bytesToBase64(
      await encodePng({ width, height, rgba }),
    )}`;
  } catch (error) {
    console.log(
      "procedural generation reference failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function buildProceduralFallbackPng(
  features: Record<string, unknown>,
  style: FaceStyle,
): Promise<string | null> {
  try {
    const packed = packFrontViewToAtlas(
      buildProceduralFrontView(features, style),
      style,
    );
    if (!packed) return null;
    const atlas = packed.atlas;
    const verdict = validateAtlas(atlas);
    if (!verdict.ok) {
      console.log(
        "procedural fallback validation failed:",
        verdict.problems.join(" / "),
      );
      return null;
    }
    applyUvMask(atlas);
    const finalVerdict = validateFinalAtlas(atlas);
    if (!finalVerdict.ok) {
      console.log(
        "procedural fallback final validation failed:",
        finalVerdict.problems.join(" / "),
      );
      return null;
    }
    const craftVerdict = validateAtlasCraft(atlas, style);
    if (!craftVerdict.ok) {
      console.log(
        "procedural fallback craft quality validation failed:",
        craftVerdict.problems.join(" / "),
      );
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
): Promise<{ atlasBase64: string | null; failure?: string }> {
  try {
    const decoded = await decodeImage(imageBytes);
    const packed = packFrontViewToAtlas(
      decoded,
      faceStyle,
      mode === "four_view" ? 4 : 2,
    );
    if (!packed) {
      console.log(
        `attempt ${attempt}: could not isolate generated character views`,
      );
      return {
        atlasBase64: null,
        failure: "could not isolate generated character views",
      };
    }
    if (!packed.hasBackView) {
      console.log(
        `attempt ${attempt}: generated sheet has no usable back view`,
      );
      return {
        atlasBase64: null,
        failure: "generated sheet has no usable back view",
      };
    }
    if (mode === "four_view" && !packed.hasSideViews) {
      console.log(
        `attempt ${attempt}: four-view sheet is missing a usable left or right profile`,
      );
      return {
        atlasBase64: null,
        failure: "four-view sheet is missing a usable left or right profile",
      };
    }
    const atlas = packed.atlas;
    const verdict = validateAtlas(atlas);
    if (!verdict.ok) {
      console.log(
        `attempt ${attempt}: atlas 검증 실패 —`,
        verdict.problems.join(" / "),
      );
      return {
        atlasBase64: null,
        failure: `atlas validation failed: ${verdict.problems.join(" / ")}`,
      };
    }
    applyUvMask(atlas);
    const finalVerdict = validateFinalAtlas(atlas);
    if (!finalVerdict.ok) {
      console.log(
        `attempt ${attempt}: 최종 검증 실패 —`,
        finalVerdict.problems.join(" / "),
      );
      return {
        atlasBase64: null,
        failure: `final atlas validation failed: ${finalVerdict.problems.join(" / ")}`,
      };
    }
    const craftVerdict = validateAtlasCraft(atlas, faceStyle);
    if (!craftVerdict.ok) {
      console.log(
        `attempt ${attempt}: craft quality validation failed`,
        craftVerdict.problems.join(" / "),
      );
      return {
        atlasBase64: null,
        failure: `craft quality validation failed: ${craftVerdict.problems.join(" / ")}`,
      };
    }
    return { atlasBase64: bytesToBase64(await encodePng(atlas)) };
  } catch (error) {
    console.log(
      `attempt ${attempt}: 후처리 오류 —`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      atlasBase64: null,
      failure: `postprocess error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
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

type SkinUndertone = PhotoAnalysis["renderHints"]["skinUndertone"];

// Preserve lightness while shifting only enough chroma to make undertone
// readable across the three-to-five shade ramp of an 8x8 Minecraft face.
// Neutral intentionally retains the historical palette for compatibility.
const SKIN_TONES_BY_UNDERTONE: Record<
  SkinUndertone,
  Record<string, string>
> = {
  neutral: SKIN_TONES,
  warm: {
    pale: "#f3d2b9",
    light: "#ecb78c",
    medium: "#d69a68",
    tan: "#bd7d4d",
    brown: "#925938",
    dark: "#633a23",
  },
  cool: {
    pale: "#efd0c7",
    light: "#e5b5a6",
    medium: "#ce9580",
    tan: "#b37b67",
    brown: "#895749",
    dark: "#5d3930",
  },
};

function skinToneHex(value: unknown, undertone: SkinUndertone): string {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (
    SKIN_TONES_BY_UNDERTONE[undertone][key] ??
    SKIN_TONES_BY_UNDERTONE[undertone].light
  );
}

const HAIR_COLORS: Record<string, string> = {
  black: "#1b1b1b",
  "dark-brown": "#3b2a1e",
  brown: "#5a3d28",
  // A neutral brown is a safer low-resolution base than the previous orange
  // swatch. Warm/copper hair is still represented by auburn and red.
  "light-brown": "#806052",
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

function joinedAnalysisText(
  values: Array<string | string[] | null | undefined>,
): string {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[–—]/g, "-");
}

function mentionsColorNearItem(
  text: string,
  colorPattern: string,
  itemPattern: string,
  maxWords = 6,
): boolean {
  const bridge = `(?:\\s+[a-z0-9/-]+){0,${maxWords}}\\s+`;
  return new RegExp(
    `(?:${colorPattern})${bridge}(?:${itemPattern})\\b|\\b(?:${itemPattern})${bridge}(?:${colorPattern})`,
    "i",
  ).test(text);
}

function viewerSidesNearRelevantPhrase(
  text: string,
  relevant: RegExp,
  maxDistance = 40,
): Set<"left" | "right"> {
  const phraseMatches = Array.from(
    text.matchAll(
      new RegExp(relevant.source, `${relevant.flags.replace("g", "")}g`),
    ),
  );
  const sideMatches = Array.from(
    text.matchAll(/\bviewer(?:'s)?[- ](left|right)\b/gi),
  );
  const sides = new Set<"left" | "right">();

  for (const phrase of phraseMatches) {
    const phraseStart = phrase.index;
    const phraseEnd = phraseStart + phrase[0].length;
    const distances = sideMatches.map((side) => {
      const sideStart = side.index;
      const sideEnd = sideStart + side[0].length;
      const distance =
        sideEnd < phraseStart
          ? phraseStart - sideEnd
          : sideStart > phraseEnd
            ? sideStart - phraseEnd
            : 0;
      return {
        distance,
        side: side[1].toLowerCase() as "left" | "right",
      };
    });
    const nearest = Math.min(...distances.map(({ distance }) => distance));
    if (!Number.isFinite(nearest) || nearest > maxDistance) continue;
    for (const match of distances) {
      if (match.distance === nearest) sides.add(match.side);
    }
  }

  return sides;
}

/**
 * Resolve contradictions between the free-form visual description and the
 * compact render enums. The prose carries details such as "curtain bangs"
 * that can be lost when the vision model picks a nearby enum on another run.
 */
export function normalizeAnalysisForRendering(
  analysis: PhotoAnalysis,
): PhotoAnalysis {
  const renderHints = { ...analysis.renderHints };
  let inferred = analysis.inferred;
  let outfitPrompt = analysis.outfitPrompt;
  const faceText = joinedAnalysisText([
    analysis.observed.face,
    analysis.identityPrompt,
  ]);
  const hairText = joinedAnalysisText([
    analysis.observed.hair,
    analysis.observed.accessories,
    analysis.identityPrompt,
    analysis.inferred.hairBack?.value,
    analysis.inferred.hairBack?.rationale,
  ]);
  const hairDescriptionClauses = [
    analysis.observed.hair,
    analysis.identityPrompt,
    analysis.inferred.hairBack?.value,
    analysis.inferred.hairBack?.rationale,
  ]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.toLowerCase().split(/[.!?;,\n]+/))
    .map((clause) => clause.trim())
    .filter(Boolean);
  const hairClauseMatches = (pattern: RegExp) =>
    hairDescriptionClauses.some((clause) => pattern.test(clause));
  const hairEndpointDescriptionClauses = hairDescriptionClauses.map((clause) =>
    clause.replace(
      /\b(?:relative|compared)\s+to\b|\bin\s+relation\s+to\b/g,
      "compared against",
    ),
  );
  const hairEndpointClauseMatches = (pattern: RegExp) =>
    hairEndpointDescriptionClauses.some((clause) => pattern.test(clause));
  const hairEndpointText = hairText.replace(
    /\b(?:relative|compared)\s+to\b|\bin\s+relation\s+to\b/g,
    "compared against",
  );
  const thighAccessoryClauses = relevantClauseList(
    [
      analysis.observed.clothing,
      analysis.observed.accessories,
      analysis.outfitPrompt,
      analysis.inferred.lowerBody?.value,
      analysis.inferred.lowerBody?.rationale,
    ],
    /\b(?:thigh|upper[- ]leg|garter)\b[\s\S]{0,48}\b(?:bow|ribbon|garter)\b|\b(?:bow|ribbon|garter)\b[\s\S]{0,48}\b(?:thigh|upper[- ]leg|garter)\b/,
  ).filter(
    (clause) =>
      !/\b(?:no|without|missing|absent)\b[\s\S]{0,40}\b(?:thigh|upper[- ]leg|bow|ribbon|garter)\b/.test(
        clause,
      ),
  );
  const thighAccessoryText = thighAccessoryClauses.join(" ");
  const explicitlyLargeHairAccessory =
    /\b(?:large|big|oversized|prominent|statement)\b.{0,36}\b(?:flower|flowers|floral|bow|ribbon|accessory)\b/.test(
      hairText,
    ) ||
    /\b(?:flower|floral)[-\s]+(?:cluster|arrangement|bouquet|crown)\b/.test(
      hairText,
    ) ||
    /\b(?:cluster|arrangement|bouquet|crown)\b.{0,40}\b(?:flowers?|blooms?|floral)\b/.test(
      hairText,
    ) ||
    /\b(?:multiple|several|two|three)\b.{0,24}\bflowers?\b/.test(hairText);
  const explicitlySmallHairAccessory =
    /\b(?:small|tiny|delicate|subtle|miniature)\b.{0,28}\b(?:flower|bow|ribbon|clip|barrette|hairpin|accessory)\b/.test(
      hairText,
    );
  const explicitlyLargeEyes =
    /\b(?:large|big|prominent)(?:[-\s]+(?:slightly|open|bright|dark|light|brown|black|blue|green|gray|grey|hazel|almond|round|upturned|downturned)){0,4}[-\s]+eyes?\b/.test(
      faceText,
    ) ||
    /\beyes?\s+(?:are|appear|look)\s+(?:visibly\s+)?(?:large|big|prominent)\b/.test(
      faceText,
    );
  const explicitlySmallEyes =
    /\b(?:small|compact|narrow)(?:[-\s]+(?:slightly|open|dark|light|brown|black|blue|green|gray|grey|hazel|almond|round|upturned|downturned)){0,4}[-\s]+eyes?\b/.test(
      faceText,
    ) ||
    /\beyes?\s+(?:are|appear|look)\s+(?:visibly\s+)?(?:small|compact|narrow)\b/.test(
      faceText,
    );
  const explicitlyDownturnedEyes =
    /\b(?:slightly[-\s]+)?downturned(?:[-\s]+[a-z]+){0,3}[-\s]+eyes?\b|\beyes?\b.{0,42}\b(?:downturn|downturned|downward[-\s]+tilt)\b|\b(?:downturn|lower|drop)\b.{0,24}\bouter[-\s]+corners?\b/.test(
      faceText,
    );
  const explicitlyUpturnedEyes =
    /\b(?:slightly[-\s]+)?upturned(?:[-\s]+[a-z]+){0,3}[-\s]+eyes?\b|\beyes?\b.{0,42}\b(?:upturn|upturned|upward[-\s]+tilt)\b|\b(?:upturn|raise|lift)\b.{0,24}\bouter[-\s]+corners?\b/.test(
      faceText,
    );
  const explicitlyFullLips =
    /\b(?:full|plump|pillowy|defined)(?:[-\s]+(?:soft|rosy|pink|red|coral|neutral)){0,2}[-\s]+lips?\b/.test(
      faceText,
    ) ||
    /\blips?\s+(?:are|appear|look)\s+(?:visibly\s+)?(?:full|plump|pillowy)\b/.test(
      faceText,
    );
  const explicitlyThinLips =
    /\b(?:thin|fine|subtle)(?:[-\s]+(?:soft|pale|neutral)){0,2}[-\s]+lips?\b/.test(
      faceText,
    ) ||
    /\blips?\s+(?:are|appear|look)\s+(?:visibly\s+)?(?:thin|fine)\b/.test(
      faceText,
    );

  const explicitCenterPart =
    /\b(center|centre|middle)[-\s]+part(?:ed|ing)?\b/.test(hairText) ||
    /\bpart(?:ed|ing)?\s+(?:down\s+)?the\s+middle\b/.test(hairText);
  const explicitCurtainBangs =
    /\bcurtain[-\s]+bangs?\b/.test(hairText) ||
    /\bcenter[-\s]+split[-\s]+bangs?\b/.test(hairText);
  const explicitCenterOpening =
    /\b(?:center|centre|middle)[-\s]+(?:fringe[-\s]+)?(?:gap|opening)\b/.test(
      hairText,
    ) ||
    /\b(?:slight|small|subtle|visible|clear)?[-\s]*(?:center|centre|middle)[-\s]+separation\b/.test(
      hairText,
    ) ||
    /\bseparation\s+(?:between|in)\s+(?:the\s+)?(?:center|centre|middle)?[-\s]*(?:fringe|bang|bangs|clusters?)\b/.test(
      hairText,
    );
  const faceFraming =
    /\bface[-\s]+framing\b/.test(hairText) ||
    /\b(?:locks?|strands?|pieces?|bangs?)\s+(?:that\s+)?frame(?:s|d)?\s+(?:the\s+)?face\b/.test(
      hairText,
    ) ||
    explicitCurtainBangs;
  const longHair =
    hairClauseMatches(
      /\blong\b(?:(?!\b(?:face|jaw|nose|neck)\b)[\s\S]){0,48}\b(?:hair|locks?|strands?|tresses)\b|\b(?:hair|locks?|strands?|tresses)\b.{0,32}\b(?:long|past[-\s]+the[-\s]+shoulders?)\b|\b(?:chest|waist|hip)[-\s]+length\b|\bmid[-\s]+back\b/,
    ) || renderHints.hairBackShape === "long";
  const explicitlyCompactHair = hairClauseMatches(
    /\b(?:short|cropped|buzz(?:ed)?|close[-\s]+cut)\b.{0,28}\b(?:hair|cut|style)\b|\b(?:hair|cut|style)\b.{0,24}\b(?:short|cropped|buzzed|close[-\s]+cut)\b/,
  );
  const explicitlyFlatCrown = hairClauseMatches(
    /\b(?:flat|boxy|square|sleek|close[-\s]+cropped)[-\s]+(?:top|crown|silhouette|hair|haircut|cut)\b|\b(?:top|crown|silhouette|hair)\b.{0,24}\b(?:flat|boxy|squared|sleek|close[-\s]+cropped)\b/,
  );
  const explicitlyLowHairVolume = hairClauseMatches(
    /\b(?:sleek|low[-\s]+volume|flat[-\s]+volume|flat[-\s]+lying)\b.{0,32}\b(?:hair|crown|roots?|volume|silhouette)\b|\b(?:hair|crown|roots?)\b.{0,36}\b(?:lies?[-\s]+flat|close[-\s]+to[-\s]+(?:the[-\s]+)?(?:head|scalp)|low[-\s]+volume|sleek)\b/,
  );
  const explicitlyFullHairVolume = hairClauseMatches(
    /\b(?:voluminous|high[-\s]+volume|full[-\s]+volume|very[-\s]+full|thick[-\s]+bodied|puffy|bouffant)\b.{0,32}\b(?:hair|crown|roots?|volume|silhouette)\b|\b(?:hair|crown|roots?)\b.{0,36}\b(?:voluminous|high[-\s]+volume|full[-\s]+volume|very[-\s]+full|puffy|expanded)\b|\bfull[-\s]+crown\b/,
  );
  const explicitOverallHairLength:
    "cropped" | "ear" | "jaw" | "shoulder" | "chest" | "waist" | "hip" | null =
    hairEndpointClauseMatches(
      /\b(?:hip|hips|upper[-\s]+thigh|seat)[-\s]+(?:length|level)\b|\b(?:to|at|past|reaches?|falls?|down[-\s]+to)\s+(?:the\s+)?(?:hips?|upper[-\s]+thighs?|seat)\b/,
    )
      ? "hip"
      : hairEndpointClauseMatches(
            /\bwaist[-\s]+(?:length|level)\b|\b(?:to|at|past|reaches?|falls?|down[-\s]+to|approach(?:es|ing)?|toward(?:s)?)\s+(?:the\s+)?(?:natural\s+)?waist(?:band|line)?\b|\b(?:near|just[-\s]+above)\s+(?:the\s+)?(?:natural\s+)?waist(?:band|line)?\b|\blower[-\s]+back\b/,
          )
        ? "waist"
        : hairEndpointClauseMatches(
              /\b(?:chest|bust|mid[-\s]+back)[-\s]+(?:length|level)\b|\b(?:to|at|past|reaches?|falls?|down[-\s]+to)\s+(?:the\s+)?(?:chest|bust|mid[-\s]+back)\b|\bpast[-\s]+the[-\s]+shoulders?\b/,
            )
          ? "chest"
          : hairEndpointClauseMatches(
                /\bshoulder[-\s]+(?:length|level)\b|\b(?:to|at|reaches?|falls?|down[-\s]+to)\s+(?:the\s+)?shoulders?\b/,
              )
            ? "shoulder"
            : hairEndpointClauseMatches(
                  /\b(?:jaw|chin)[-\s]+(?:length|level)\b|\b(?:to|at|around)\s+(?:the\s+)?(?:jaw|chin)\b/,
                )
              ? "jaw"
              : hairEndpointClauseMatches(
                    /\bear[-\s]+(?:length|level)\b|\b(?:to|at|around)\s+(?:the\s+)?ears?\b/,
                  )
                ? "ear"
                : hairEndpointClauseMatches(
                      /\b(?:cropped|buzz(?:ed)?|shaved|close[-\s]+cut)\b/,
                    )
                  ? "cropped"
                  : null;
  const shoulderSideHair =
    /\b(?:shoulder[-\s]+length|to[-\s]+the[-\s]+shoulders?|over[-\s]+the[-\s]+shoulders?|past[-\s]+the[-\s]+shoulders?)\b/.test(
      hairEndpointText,
    );
  const explicitlyShortSideHair =
    /\b(?:cheek|chin|jaw)[-\s]+(?:length|level)\b/.test(hairText) ||
    /\b(?:to|at|around)\s+(?:the\s+)?(?:cheeks?|chin|jaw)\b/.test(hairText);
  const explicitSideAsymmetry =
    /\b(?:viewer[-\s]+)?(?:left|right)\b.{0,48}\b(?:longer|shorter|fuller|thicker|asymmetric|asymmetrical)\b/.test(
      hairText,
    ) ||
    /\b(?:longer|shorter|fuller|thicker|asymmetric|asymmetrical)\b.{0,48}\b(?:viewer[-\s]+)?(?:left|right)\b/.test(
      hairText,
    );

  if (explicitCenterPart) {
    renderHints.hairPart = "center";
  }
  if (explicitlyLargeEyes) {
    renderHints.eyeSize = "large";
  } else if (explicitlySmallEyes) {
    renderHints.eyeSize = "small";
  }
  if (explicitlyDownturnedEyes) {
    renderHints.eyeTilt = "downturned";
  } else if (explicitlyUpturnedEyes) {
    renderHints.eyeTilt = "upturned";
  }
  if (explicitlyFullLips) {
    renderHints.lipFullness = "full";
  } else if (explicitlyThinLips) {
    renderHints.lipFullness = "thin";
  } else if (renderHints.mouthShape === "full") {
    renderHints.lipFullness = "full";
  } else if (renderHints.mouthShape === "thin") {
    renderHints.lipFullness = "thin";
  }
  if (renderHints.hairAccessory !== "none") {
    if (explicitlyLargeHairAccessory) {
      renderHints.hairAccessoryScale = "large";
    } else if (explicitlySmallHairAccessory) {
      renderHints.hairAccessoryScale = "small";
    }
  }
  if (explicitCurtainBangs) {
    renderHints.bangs = "curtain";
    renderHints.fringeOpening = "center";
    renderHints.sideHairShape = "face_framing";
    if (
      renderHints.bangsLength === "none" ||
      renderHints.bangsLength === "short"
    ) {
      renderHints.bangsLength = "brow";
    }
  } else if (explicitCenterOpening && renderHints.bangs !== "none") {
    renderHints.fringeOpening = "center";
    if (
      renderHints.hairTexture !== "straight" &&
      renderHints.bangsDensity !== "dense"
    ) {
      renderHints.bangs = "curtain";
      renderHints.sideHairShape = "face_framing";
    }
  }
  if (faceFraming) {
    renderHints.sideHairShape = "face_framing";
    if (longHair && !explicitlyShortSideHair) {
      // "Long hair with face-framing strands" normally continues past the
      // jaw even when a slightly turned portrait hides one shoulder. Only
      // retain a cheek/jaw enum when the prose explicitly describes that
      // shorter layer; otherwise the compact enum under-represents the
      // visible long silhouette.
      renderHints.sideHairLength = "shoulder";
    } else if (
      longHair &&
      (renderHints.sideHairLength === "none" ||
        renderHints.sideHairLength === "short")
    ) {
      renderHints.sideHairLength = shoulderSideHair ? "shoulder" : "jaw";
    }
  }
  if (longHair) {
    renderHints.hairBackShape = "long";
    if (
      !explicitOverallHairLength &&
      ["cropped", "ear", "jaw"].includes(renderHints.overallHairLength)
    ) {
      // A prose description of genuinely long hair is stronger than a
      // contradictory compact enum. Chest is a conservative fallback when
      // the crop hides the exact endpoint.
      renderHints.overallHairLength = "chest";
    }
  }
  if (explicitOverallHairLength) {
    renderHints.overallHairLength = explicitOverallHairLength;
  }
  const compactEnums =
    (renderHints.hairBackShape === "tapered" ||
      renderHints.hairBackShape === "undercut") &&
    (renderHints.sideHairShape === "tapered" ||
      renderHints.sideHairShape === "ear_hugging" ||
      renderHints.sideHairShape === "undercut");
  if (explicitlyCompactHair && !longHair && !faceFraming && compactEnums) {
    // Landmark-comparison prose and the compact enum occasionally disagree.
    // A clearly short tapered/undercut cut is an ear-level construction;
    // retaining a longer enum creates shoulder drapes absent from the photo.
    renderHints.overallHairLength =
      renderHints.hairBackShape === "undercut" ||
      renderHints.sideHairShape === "undercut"
        ? "cropped"
        : "ear";
  }
  const compactSideConstruction =
    !longHair &&
    (renderHints.overallHairLength === "cropped" ||
      renderHints.overallHairLength === "ear") &&
    compactEnums;
  if (
    compactSideConstruction &&
    (renderHints.sideHairLength === "cheek" ||
      renderHints.sideHairLength === "jaw" ||
      renderHints.sideHairLength === "shoulder")
  ) {
    // A compact cut cannot also form a long rectangular side panel. This
    // contradiction is especially damaging on the Minecraft head overlay,
    // where one bad enum becomes a solid cheek-to-neck slab on both sides.
    // Preserve genuine bobs and face-framing locks: their overall/back/side
    // construction does not satisfy this compact combination.
    renderHints.sideHairLength =
      renderHints.hairBackShape === "undercut" ||
      renderHints.sideHairShape === "undercut"
        ? "none"
        : "short";
  }
  if (renderHints.sideHairAsymmetry !== "none" && !explicitSideAsymmetry) {
    // A head turn, occlusion, or an accessory on one side must not be
    // converted into a structurally one-sided haircut. The analysis contract
    // requires a real asymmetry to be repeated in the prose, so discard an
    // unsupported enum hint.
    renderHints.sideHairAsymmetry = "none";
  }
  if (explicitlyLowHairVolume && !explicitlyFullHairVolume) {
    renderHints.hairVolume = "flat";
  } else if (explicitlyFullHairVolume && !explicitlyLowHairVolume) {
    renderHints.hairVolume = "full";
  }
  const roundedCompactFringe =
    renderHints.hairSilhouette === "flat" &&
    !explicitlyFlatCrown &&
    !longHair &&
    renderHints.overallHairLength === "ear" &&
    renderHints.hairVolume !== "flat" &&
    renderHints.bangs !== "none" &&
    (renderHints.hairBackShape === "tapered" ||
      renderHints.hairBackShape === "rounded") &&
    (renderHints.sideHairShape === "tapered" ||
      renderHints.sideHairShape === "ear_hugging");
  if (roundedCompactFringe) {
    // Vision models sometimes copy the word "straight" from the fringe into
    // the crown silhouette. A compact two-block/bowl construction is still a
    // rounded outer volume unless the prose explicitly describes a flat top.
    // Activating the rounded mask reveals the inner cube through irregular
    // crown cut-outs and tapers both side layers around the ears.
    renderHints.hairSilhouette = "rounded";
  }

  if (thighAccessoryText) {
    renderHints.thighAccessory = /\bbow\b/.test(thighAccessoryText)
      ? "bow"
      : /\bgarter\b/.test(thighAccessoryText)
        ? "garter"
        : "ribbon";
    const nearbySides = viewerSidesNearRelevantPhrase(
      thighAccessoryText,
      /\b(?:thigh|upper[- ]leg|garter)\b[\s\S]{0,24}\b(?:bow|ribbon|garter)\b|\b(?:bow|ribbon|garter)\b[\s\S]{0,24}\b(?:thigh|upper[- ]leg|garter)\b/i,
    );
    const leftMention = nearbySides.has("left");
    const rightMention = nearbySides.has("right");
    if (leftMention && !rightMention) {
      renderHints.thighAccessorySide = "left";
    } else if (rightMention && !leftMention) {
      renderHints.thighAccessorySide = "right";
    } else if (leftMention && rightMention) {
      renderHints.thighAccessorySide = "both";
    } else if (renderHints.thighAccessorySide === "none") {
      renderHints.thighAccessorySide = "both";
    }
  } else if (renderHints.thighAccessory === "none") {
    renderHints.thighAccessorySide = "none";
  } else if (renderHints.thighAccessorySide === "none") {
    renderHints.thighAccessorySide = "both";
  }

  if (analysis.visibleRegions.lowerBody) {
    const visibleLowerText = joinedAnalysisText([
      analysis.observed.clothing,
      analysis.observed.accessories,
      analysis.outfitPrompt,
    ]);
    // Construction is more identifying than height: "over-knee leg warmer"
    // must remain a slouchy leg warmer rather than collapse into a smooth
    // thigh-high sock merely because it extends above the knee.
    if (/\b(?:leg[-\s]*warmer|leg[-\s]*warmers)\b/.test(visibleLowerText)) {
      renderHints.legwear = "leg_warmers";
    } else if (
      /\b(?:thigh[-\s]*highs?|over[-\s]*(?:the[-\s]*)?knees?|otk)\b/.test(
        visibleLowerText,
      )
    ) {
      renderHints.legwear = "thigh_highs";
    } else if (/\b(?:stockings?|tights)\b/.test(visibleLowerText)) {
      renderHints.legwear = "stockings";
    } else if (/\bsocks?\b/.test(visibleLowerText)) {
      renderHints.legwear = "socks";
    }
  } else {
    const lowerDesign = analysis.inferred.lowerBodyDesign;
    const completelyGenericLower =
      lowerDesign !== null &&
      lowerDesign !== undefined &&
      lowerDesign.bottomType === "pants" &&
      lowerDesign.bottomPattern === "plain" &&
      lowerDesign.bottomAccent === "none" &&
      lowerDesign.legwear === "none" &&
      lowerDesign.thighAccessory === "none" &&
      lowerDesign.shoeStyle === "sneakers" &&
      renderHints.bottomPattern === "plain" &&
      renderHints.bottomAccent === "none" &&
      renderHints.legwear === "none" &&
      renderHints.thighAccessory === "none";

    if (completelyGenericLower) {
      const topType = analysis.fallbackFeatures.topType.toLowerCase();
      const smartCasualTop =
        ["shirt", "jacket", "dress"].includes(topType) ||
        renderHints.outerGarment !== "none" ||
        renderHints.neckAccessory !== "none";
      const preppyTop =
        (renderHints.outerGarment === "cardigan" ||
          renderHints.outerGarment === "vest") &&
        (renderHints.neckAccessory === "bow" ||
          renderHints.neckAccessory === "collar");
      const tailoredTop =
        topType === "shirt" ||
        topType === "jacket" ||
        renderHints.neckAccessory === "tie" ||
        renderHints.outerGarment === "open_jacket" ||
        renderHints.outerGarment === "coat";

      if (preppyTop) {
        // A cardigan/vest plus a visible bow or collar supplies substantially
        // more style evidence than the model's safe pants+sneakers fallback.
        // Complete all lower-body layers together so the result reads as one
        // authored outfit rather than generic pants with a token accent.
        const outerCue =
          renderHints.outerGarment === "vest" ? "vest" : "cardigan";
        const neckCue =
          renderHints.neckAccessory === "bow" ? "neck bow" : "collar";
        const waistCue =
          renderHints.neckAccessory === "bow"
            ? "a ribbon waistband"
            : "a readable belt";
        const completionSentence = `Complete the unseen lower body as a coordinated pleated skirt with ${waistCue}, paired socks and polished strap dress shoes, grounded in the visible ${outerCue} and ${neckCue}.`;
        renderHints.bottomPattern = "pleated";
        renderHints.bottomAccent =
          renderHints.neckAccessory === "bow" ? "ribbon" : "belt";
        renderHints.legwear = "socks";
        renderHints.legwearAsymmetry = "both";
        inferred = {
          ...analysis.inferred,
          lowerBody: {
            value: `a coordinated pleated skirt with ${waistCue} and paired socks`,
            rationale: `${analysis.inferred.lowerBody?.rationale ?? lowerDesign.rationale} ${completionSentence}`,
          },
          lowerBodyDesign: {
            ...lowerDesign,
            bottomType: "skirt",
            bottomPattern: "pleated",
            bottomAccent:
              renderHints.neckAccessory === "bow" ? "ribbon" : "belt",
            legwear: "socks",
            legwearAsymmetry: "both",
            shoeStyle: "dress_shoes",
            rationale: `${lowerDesign.rationale} ${completionSentence}`,
          },
          shoes: {
            value: "polished strap dress shoes",
            rationale: `${analysis.inferred.shoes?.rationale ?? "The structured upper outfit calls for a refined shoe."} ${completionSentence}`,
          },
        };
        outfitPrompt = `${analysis.outfitPrompt} ${completionSentence}`;
        return { ...analysis, inferred, renderHints, outfitPrompt };
      }

      if (tailoredTop) {
        const completionSentence =
          "Complete the unseen lower body with tailored trousers, a readable belt and polished leather dress shoes, grounded in the visible structured shirt, jacket or tie.";
        renderHints.bottomAccent = "belt";
        inferred = {
          ...analysis.inferred,
          lowerBody: {
            value: "coordinated tailored trousers with a readable belt",
            rationale: `${analysis.inferred.lowerBody?.rationale ?? lowerDesign.rationale} ${completionSentence}`,
          },
          lowerBodyDesign: {
            ...lowerDesign,
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "belt",
            legwear: "none",
            legwearAsymmetry: "none",
            shoeStyle: "dress_shoes",
            rationale: `${lowerDesign.rationale} ${completionSentence}`,
          },
          shoes: {
            value: "polished leather dress shoes",
            rationale: `${analysis.inferred.shoes?.rationale ?? "The structured upper outfit calls for formal footwear."} ${completionSentence}`,
          },
        };
        outfitPrompt = `${analysis.outfitPrompt} ${completionSentence}`;
        return { ...analysis, inferred, renderHints, outfitPrompt };
      }

      const groundedAccent =
        topType === "sweater" ||
        topType === "hoodie" ||
        renderHints.garmentTexture === "knit" ||
        renderHints.garmentTexture === "denim"
          ? "cuffs"
          : smartCasualTop
            ? "belt"
            : "side_stripe";
      const accentLabel =
        groundedAccent === "cuffs"
          ? "cuffed hems"
          : groundedAccent === "belt"
            ? "a belt"
            : "a side stripe";
      const completionSentence = `Complete the unseen lower garment with ${accentLabel} as a readable low-resolution construction cue grounded in the visible top.`;

      renderHints.bottomAccent = groundedAccent;
      inferred = {
        ...analysis.inferred,
        lowerBody: analysis.inferred.lowerBody
          ? {
              ...analysis.inferred.lowerBody,
              value: `${analysis.inferred.lowerBody.value} with ${accentLabel}`,
              rationale: `${analysis.inferred.lowerBody.rationale} ${completionSentence}`,
            }
          : null,
        lowerBodyDesign: {
          ...lowerDesign,
          bottomAccent: groundedAccent,
          rationale: `${lowerDesign.rationale} ${completionSentence}`,
        },
      };
      outfitPrompt = `${analysis.outfitPrompt} ${completionSentence}`;
    }
  }

  return { ...analysis, inferred, renderHints, outfitPrompt };
}

/**
 * Preserve nuanced colour words from the analysis instead of collapsing them
 * into the nearest vivid enum swatch. These colours also guide chroma
 * alignment in the deterministic packer, so correcting them here affects all
 * generated UV faces consistently.
 */
export function refineFeatureColorsFromAnalysis(
  analysis: PhotoAnalysis,
  features: Record<string, unknown>,
): Record<string, unknown> {
  const refined = { ...features };
  const faceText = joinedAnalysisText([
    analysis.observed.face,
    analysis.identityPrompt,
  ]);
  const hairText = joinedAnalysisText([
    analysis.observed.hair,
    analysis.identityPrompt,
    analysis.observed.colorPalette,
  ]);
  const topText = joinedAnalysisText([
    analysis.observed.clothing,
    analysis.outfitPrompt,
  ]);
  const bottomText = joinedAnalysisText([
    analysis.observed.clothing,
    analysis.outfitPrompt,
    analysis.inferred.lowerBody?.value,
    analysis.inferred.lowerBody?.rationale,
  ]);
  const shoesText = joinedAnalysisText([
    analysis.observed.clothing,
    analysis.outfitPrompt,
    analysis.inferred.shoes?.value,
    analysis.inferred.shoes?.rationale,
  ]);

  if (
    /\b(?:very[-\s]+)?(?:pale|fair|porcelain)(?:[-\s]+skin(?:tone)?)?\b/.test(
      faceText,
    )
  ) {
    refined.skinTone = skinToneHex(
      "pale",
      analysis.renderHints.skinUndertone,
    );
  } else if (
    /\blight(?:[-\s]+(?:warm|cool|neutral|pink|peach|golden|beige|olive))*[-\s]+skin(?:[-\s]*tone)?\b/.test(
      faceText,
    ) &&
    !/\blight[-\s]+(?:to[-\s]+)?medium[-\s]+skin\b/.test(faceText)
  ) {
    // The coarse fallback palette can occasionally classify a softly lit
    // fair portrait as medium. Explicit visual prose is the stronger signal;
    // use a neutral peach light tone instead of the more orange enum swatch.
    refined.skinTone =
      analysis.renderHints.skinUndertone === "neutral"
        ? "#edc8b4"
        : skinToneHex("light", analysis.renderHints.skinUndertone);
  }

  if (
    /\b(?:ash(?:y)?|taupe|mushroom|cool[-\s]+toned|muted|rose)[-\s]+brown\b|\bbronde\b/.test(
      hairText,
    )
  ) {
    refined.hairColor = "#765b57";
  }

  const mutedPinkPattern =
    "(?:(?:dusty|muted|desaturated|smoky|soft|pale|pastel)[-\\s]+(?:rose|pink)|dusty[-\\s]+rose|mauve|old[-\\s]+rose|rose[-\\s]+beige|pink[-\\s]+beige|light[-\\s]+pink(?:\\s*\\/\\s*mauve)?)";
  const topGarmentPattern =
    "(?:top|shirt|blouse|sweater|cardigan|jacket|coat|vest|hoodie|dress|tunic|camisole|jersey)";
  if (mentionsColorNearItem(topText, mutedPinkPattern, topGarmentPattern, 7)) {
    refined.topColor = "#b7929d";
  }

  const softBeigePattern =
    "(?:(?:light|soft|muted|pale|cream)[-\\s]+(?:beige|tan)|taupe[-\\s]+beige|beige\\s*\\/\\s*tan|tan\\s*\\/\\s*beige|beige[-\\s]+tan|tan[-\\s]+beige|beige|tan)";
  const lowerGarmentPattern =
    "(?:bottoms?|skirt|skort|shorts|pants|trousers|jeans|culottes)";
  const beigePatternedLower =
    mentionsColorNearItem(
      bottomText,
      softBeigePattern,
      lowerGarmentPattern,
      7,
    ) &&
    /\b(?:plaid|check(?:ed|ered)?|tartan|light|soft|muted|pale)\b/.test(
      bottomText,
    );
  if (beigePatternedLower) {
    refined.bottomColor = "#cbb8a3";
  }

  const creamPattern = "(?:cream|off[-\\s]+white|ivory)";
  const shoePattern =
    "(?:shoes?|boots?|loafers?|sneakers?|sandals?|mary[-\\s]+janes?)";
  if (mentionsColorNearItem(shoesText, creamPattern, shoePattern, 5)) {
    refined.shoesColor = "#e8dfd1";
  }

  return refined;
}

function completeInferredLowerDetails(
  analysis: PhotoAnalysis,
  style: FaceStyle,
): void {
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
    style.thighAccessory = structuredLower.thighAccessory;
    style.thighAccessorySide = structuredLower.thighAccessorySide;
    style.shoeStyle = structuredLower.shoeStyle;
  }

  const inferredBottomAccentText = relevantClauseList(
    [
      analysis.inferred.lowerBody?.value,
      analysis.inferred.lowerBody?.rationale,
      analysis.outfitPrompt,
    ],
    /\b(?:bottom|bottoms|pants|trousers|jeans|shorts|skirt|skort|culottes|waist|waistband|belt|hem|cuff|side[- ]stripe|ribbon|bow)\b/,
  )
    .filter(
      (clause) =>
        !/\b(?:thigh|upper[- ]leg|garter)\b[\s\S]{0,48}\b(?:bow|ribbon|garter)\b|\b(?:bow|ribbon|garter)\b[\s\S]{0,48}\b(?:thigh|upper[- ]leg|garter)\b/.test(
          clause,
        ),
    )
    .join(" ");
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
    (style.thighAccessory ?? "none") === "none" &&
    (style.shoeStyle ?? "sneakers") === "sneakers";

  if (!structuredLower) {
    if (
      /\b(skort|skorts|culotte skirt|pleated culottes|plaid culottes|pleated shorts|plaid shorts)\b/.test(
        inferredText,
      )
    ) {
      style.bottomType = "skirt";
    } else if (
      /\b(skirt|pleated skirt|plaid skirt|tartan skirt)\b/.test(inferredText)
    ) {
      style.bottomType = "skirt";
    } else if (/\b(shorts|short pants|culottes)\b/.test(inferredText)) {
      style.bottomType = "shorts";
    } else if (/\b(jeans|denim)\b/.test(inferredText)) {
      style.bottomType = "jeans";
    } else if (
      /\b(pants|trousers|slacks|chinos|joggers)\b/.test(inferredText)
    ) {
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

    if (/\b(ribbon|bow)\b/.test(inferredBottomAccentText)) {
      style.bottomAccent = "ribbon";
    } else if (/\b(belt|belted)\b/.test(inferredBottomAccentText)) {
      style.bottomAccent = "belt";
    } else if (/\b(cuff|cuffed|cuffs)\b/.test(inferredBottomAccentText)) {
      style.bottomAccent = "cuffs";
    } else if (
      /\b(side stripe|side stripes)\b/.test(inferredBottomAccentText)
    ) {
      style.bottomAccent = "side_stripe";
    }

    if (/\b(leg warmer|leg warmers)\b/.test(inferredText)) {
      style.legwear = "leg_warmers";
    } else if (
      /\b(knee high|knee-high|knee highs|knee-highs|over knee|over-knee|over the knee|otk)\b/.test(
        inferredText,
      )
    ) {
      style.legwear = "thigh_highs";
    } else if (
      /\b(thigh high|thigh-high|thigh highs|thigh-highs)\b/.test(inferredText)
    ) {
      style.legwear = "thigh_highs";
    } else if (/\b(stockings|stocking|tights)\b/.test(inferredText)) {
      style.legwear = "stockings";
    } else if (/\b(socks|sock)\b/.test(inferredText)) {
      style.legwear = "socks";
    }

    if ((style.legwear ?? "none") !== "none") {
      const oneSided =
        /\b(one|single|only one|asymmetric|asymmetrical|one-sided)\b/.test(
          inferredText,
        );
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
  } else if (structuredGenericLower) {
    // Structured analysis can still collapse an unseen lower half into the most
    // generic possible answer. Preserve its garment and shoe choices, but add a
    // small construction cue grounded in the visible top so the 64x64 result
    // does not read as an undifferentiated rectangle.
    style.bottomAccent =
      topType === "sweater" ||
      topType === "hoodie" ||
      style.bottomType === "jeans"
        ? "cuffs"
        : smartCasualTop
          ? "belt"
          : "side_stripe";
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
    style.bottomPattern =
      style.neckAccessory === "bow" || style.neckAccessory === "collar"
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

function completeVisibleUpperDetails(
  analysis: PhotoAnalysis,
  style: FaceStyle,
): void {
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

  if (
    /\b(long sleeve|long-sleeve|long sleeves|sleeved cardigan|sleeved jacket)\b/.test(
      upperText,
    )
  ) {
    style.sleeveLength = "long";
  }
}

function completeVisibleLowerDetails(
  analysis: PhotoAnalysis,
  style: FaceStyle,
): void {
  const visibleText = [
    analysis.observed.clothing,
    analysis.outfitPrompt,
    analysis.identityPrompt,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (
    /\b(skort|skorts|culotte skirt|pleated culottes|plaid culottes|pleated shorts|plaid shorts)\b/.test(
      visibleText,
    )
  ) {
    style.bottomType = "skirt";
  } else if (
    /\b(skirt|pleated skirt|plaid skirt|tartan skirt|miniskirt|mini skirt)\b/.test(
      visibleText,
    )
  ) {
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

  const lowerAccentText = relevantClauseList(
    [
      analysis.observed.clothing,
      analysis.outfitPrompt,
      analysis.identityPrompt,
    ],
    /\b(?:bottom|bottoms|pants|trousers|jeans|shorts|skirt|skort|culottes|waist|waistband|belt|hem|cuff|side[- ]stripe|ribbon|bow)\b/,
  )
    .filter(
      (clause) =>
        !/\b(?:thigh|upper[- ]leg|garter)\b[\s\S]{0,48}\b(?:bow|ribbon|garter)\b|\b(?:bow|ribbon|garter)\b[\s\S]{0,48}\b(?:thigh|upper[- ]leg|garter)\b/.test(
          clause,
        ),
    )
    .join(" ");
  if (
    /\b(ribbon|bow)\b/.test(lowerAccentText) &&
    (style.bottomAccent ?? "none") === "none"
  ) {
    style.bottomAccent = "ribbon";
  } else if (/\b(belt|belted)\b/.test(lowerAccentText)) {
    style.bottomAccent = "belt";
  } else if (/\b(cuff|cuffed|cuffs)\b/.test(lowerAccentText)) {
    style.bottomAccent = "cuffs";
  } else if (/\b(side stripe|side stripes)\b/.test(lowerAccentText)) {
    style.bottomAccent = "side_stripe";
  }

  if (/\b(leg warmer|leg warmers)\b/.test(visibleText)) {
    style.legwear = "leg_warmers";
  } else if (
    /\b(knee high|knee-high|knee highs|knee-highs|over knee|over-knee|over the knee|otk)\b/.test(
      visibleText,
    )
  ) {
    style.legwear = "thigh_highs";
  } else if (
    /\b(thigh high|thigh-high|thigh highs|thigh-highs)\b/.test(visibleText)
  ) {
    style.legwear = "thigh_highs";
  } else if (/\b(stockings|stocking|tights)\b/.test(visibleText)) {
    style.legwear = "stockings";
  } else if (/\b(socks|sock)\b/.test(visibleText)) {
    style.legwear = "socks";
  }

  const legwearSideClauses = relevantClauseList(
    [
      analysis.observed.clothing,
      analysis.outfitPrompt,
      analysis.identityPrompt,
    ],
    /\b(leg warmer|leg warmers|knee[- ]?high|over[- ]?knee|otk|thigh[- ]?high|stocking|stockings|tights|sock|socks)\b/,
  );
  const legwearSideText = legwearSideClauses
    .filter(
      (clause) =>
        !/\b(?:no|without|bare|uncovered)\b[\s\S]{0,40}\b(?:leg warmer|leg warmers|knee[- ]?high|over[- ]?knee|otk|thigh[- ]?high|stocking|stockings|tights|sock|socks)\b/.test(
          clause,
        ),
    )
    .join(" ");
  if ((style.legwear ?? "none") !== "none" && legwearSideText) {
    const leftMention = /\b(viewer(?:'s)?[- ]left|left)\b/.test(
      legwearSideText,
    );
    const rightMention = /\b(viewer(?:'s)?[- ]right|right)\b/.test(
      legwearSideText,
    );
    if (leftMention && !rightMention) {
      style.legwearAsymmetry = "left";
    } else if (rightMention && !leftMention) {
      style.legwearAsymmetry = "right";
    } else if (leftMention && rightMention) {
      style.legwearAsymmetry = "both";
    } else if (
      /\b(one|single|asymmetric|asymmetrical|one-sided)\b/.test(legwearSideText)
    ) {
      style.legwearAsymmetry =
        style.legwearAsymmetry === "none" ? "left" : style.legwearAsymmetry;
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

function completeVisibleAccessoryDetails(
  analysis: PhotoAnalysis,
  style: FaceStyle,
): void {
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
      /\b(hair|head|clip|accessory|viewer-left|viewer-right|left|right)\b/.test(
        hairAccessoryText,
      )
    ) {
      style.hairAccessory = "flower";
    } else if (/\b(hair bow|bow in hair|head bow)\b/.test(hairAccessoryText)) {
      style.hairAccessory = "bow";
    } else if (
      /\b(hair ribbon|ribbon in hair|head ribbon)\b/.test(hairAccessoryText)
    ) {
      style.hairAccessory = "ribbon";
    } else if (
      /\b(hair clip|barrette|hairpin|pin in hair)\b/.test(hairAccessoryText)
    ) {
      style.hairAccessory = "clip";
    }
  }

  if ((style.hairAccessory ?? "none") !== "none") {
    const sideText = hairAccessorySideText || hairAccessoryText;
    const leftMention =
      /\b(viewer(?:'s)?[- ]left|left side|left hair|left temple)\b/.test(
        sideText,
      );
    const rightMention =
      /\b(viewer(?:'s)?[- ]right|right side|right hair|right temple)\b/.test(
        sideText,
      );
    if (rightMention && !leftMention) {
      style.hairAccessorySide = "right";
    } else if (leftMention && !rightMention) {
      style.hairAccessorySide = "left";
    } else if (/\b(center|middle|top center)\b/.test(sideText)) {
      style.hairAccessorySide = "center";
    }

    const accessoryNames =
      "flower|flowers|floral|hair bow|bow in hair|head bow|hair ribbon|ribbon in hair|head ribbon|hair clip|barrette|hairpin";
    const accessoryColors = [
      "black",
      "brown",
      "white",
      "gray",
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
    ] as const;
    type AccessoryColor = (typeof accessoryColors)[number];
    const closestColor = (
      direction: "before" | "after",
    ): AccessoryColor | null => {
      let best: {
        color: AccessoryColor;
        distance: number;
        index: number;
      } | null = null;
      for (const color of accessoryColors) {
        const pattern =
          direction === "before"
            ? new RegExp(
                `\\b${color}\\b((?:\\s+[a-z-]+){0,3})\\s+(?:${accessoryNames})\\b`,
                "g",
              )
            : new RegExp(
                `\\b(?:${accessoryNames})\\b((?:\\s+[a-z-]+){0,3})\\s+${color}\\b`,
                "g",
              );
        for (const match of sideText.matchAll(pattern)) {
          const end = (match.index ?? 0) + match[0].length;
          if (
            direction === "after" &&
            /^\s+(?:leaf|leaves|foliage|stem|stems)\b/.test(sideText.slice(end))
          ) {
            continue;
          }
          const distance = match[1].trim()
            ? match[1].trim().split(/\s+/).length
            : 0;
          const candidate = { color, distance, index: match.index ?? 0 };
          if (
            best === null ||
            candidate.distance < best.distance ||
            (candidate.distance === best.distance &&
              candidate.index < best.index)
          ) {
            best = candidate;
          }
        }
      }
      return best?.color ?? null;
    };
    // In descriptions such as "pink flowers with green leaves", the petal
    // colour precedes the accessory while the foliage colour follows it.
    // Prefer the closest colour before the accessory and only fall back to a
    // trailing colour when no such petal/bow/clip colour exists.
    const recoveredAccessoryColor =
      closestColor("before") ?? closestColor("after");
    if (recoveredAccessoryColor) {
      style.hairAccessoryColor = recoveredAccessoryColor;
    }
  }

  if ((style.neckAccessory ?? "none") === "none") {
    if (
      /\b(bow collar|neck bow|bow at the neck|bow tie)\b/.test(accessoryText)
    ) {
      style.neckAccessory = "bow";
    } else if (/\b(necktie|tie)\b/.test(accessoryText)) {
      style.neckAccessory = "tie";
    } else if (/\b(scarf)\b/.test(accessoryText)) {
      style.neckAccessory = "scarf";
    } else if (
      /\b(distinct collar|large collar|white collar|collared shirt)\b/.test(
        accessoryText,
      )
    ) {
      style.neckAccessory = "collar";
    }
  }

  if ((style.necklace ?? "none") === "none") {
    if (
      /\b(silver necklace|silver chain|silver pendant)\b/.test(accessoryText)
    ) {
      style.necklace = "silver";
    } else if (
      /\b(gold necklace|gold chain|gold pendant)\b/.test(accessoryText)
    ) {
      style.necklace = "gold";
    } else if (
      /\b(black necklace|dark necklace|dark chain)\b/.test(accessoryText)
    ) {
      style.necklace = "dark";
    }
  }
}

function relevantClauses(
  values: Array<string | null | undefined>,
  relevant: RegExp,
): string {
  return relevantClauseList(values, relevant).join(" ");
}

function relevantClauseList(
  values: Array<string | null | undefined>,
  relevant: RegExp,
): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.toLowerCase().split(/[.!?;,\n]+/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && relevant.test(clause));
}

export function fallbackFeaturesToHex(
  raw: FallbackFeatures,
  skinUndertone: SkinUndertone = "neutral",
): Record<string, unknown> {
  const source = raw as unknown as Record<string, unknown>;
  return {
    ...source,
    skinTone: skinToneHex(source.skinTone, skinUndertone),
    hairColor: paletteHex(
      source.hairColor,
      HAIR_COLORS,
      HAIR_COLORS["dark-brown"],
    ),
    eyeColor: paletteHex(source.eyeColor, EYE_COLORS, EYE_COLORS["dark-brown"]),
    glassesColor: paletteHex(
      source.glassesColor,
      CLOTHING_COLORS,
      CLOTHING_COLORS.black,
    ),
    hatColor: paletteHex(source.hatColor, CLOTHING_COLORS, CLOTHING_COLORS.red),
    topColor: paletteHex(
      source.topColor,
      CLOTHING_COLORS,
      CLOTHING_COLORS.blue,
    ),
    topAccentColor: paletteHex(
      source.topAccentColor,
      CLOTHING_COLORS,
      CLOTHING_COLORS.white,
    ),
    bottomColor: paletteHex(
      source.bottomColor,
      CLOTHING_COLORS,
      CLOTHING_COLORS.denim,
    ),
    shoesColor: paletteHex(
      source.shoesColor,
      CLOTHING_COLORS,
      CLOTHING_COLORS.white,
    ),
  };
}
