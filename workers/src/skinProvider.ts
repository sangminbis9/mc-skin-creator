/**
 * Image-generation provider abstraction.
 * Gemini creates character-view sheets; server code still owns UV placement.
 */

import type { PhotoAnalysis } from "./analysis";
import { buildFrontBackGuidePng } from "./assets/frontBackGuide";
import { buildFourViewGuidePng } from "./assets/fourViewGuide";
import {
  geminiRetryAfterMs,
  generateGeminiImage,
  isGeminiModelUnavailable,
  isGeminiQuotaError,
  isGeminiTemporaryRateLimit,
} from "./gemini";
import { base64ToBytes, sniffImageSize } from "./png";
import { buildFourViewPrompt, buildFrontViewPrompt } from "./skinPrompt";
import type { SkinPlan } from "./skinPlan";
import type { Env } from "./types";

export type GenerationStrategy = "front_view" | "four_view";
export type ImageModelTier = "balanced" | "quality";

export interface SkinGenerationRequest {
  analysis: PhotoAnalysis;
  skinPlan: SkinPlan;
  photoDataUrl: string;
  /** Optional alternate photos of the same person, ordered by usefulness. */
  referencePhotoDataUrls?: string[];
  seed: number;
  mode: GenerationStrategy;
  modelTier?: ImageModelTier;
  /** A bounded, evidence-backed correction from the previous rendered atlas. */
  correctionPrompt?: string;
}

export type SkinGenerationResult =
  | {
      ok: true;
      imageBytes: Uint8Array;
      inputTiles: number;
      outputTiles: number;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      quotaExceeded?: boolean;
      /** True when inference ran far enough that account capacity may be used. */
      capacityConsumed?: boolean;
      retryAfterMs?: number;
    };

export interface SkinGenerationProvider {
  generate(request: SkinGenerationRequest): Promise<SkinGenerationResult>;
}

const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const DEFAULT_GEMINI_IMAGE_FALLBACK_MODEL =
  "gemini-3.1-flash-lite-image";
const MIN_INPUT_EDGE = 64;

function uniqueModels(models: Array<string | undefined>): string[] {
  return [...new Set(models.map((model) => model?.trim()).filter(Boolean))] as string[];
}

function imageModels(env: Env, tier: ImageModelTier): string[] {
  const balanced = env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
  const quality = env.GEMINI_IMAGE_QUALITY_MODEL?.trim() || balanced;
  const fallback =
    env.GEMINI_IMAGE_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_IMAGE_FALLBACK_MODEL;
  return uniqueModels(
    tier === "quality"
      ? [quality, balanced, fallback]
      : [balanced, fallback],
  );
}

function canTryFallbackModel(error: unknown): boolean {
  return (
    (isGeminiQuotaError(error) && !isGeminiTemporaryRateLimit(error)) ||
    isGeminiModelUnavailable(error)
  );
}

function dataUrlToBytes(
  dataUrl: string,
): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    return { bytes: base64ToBytes(match[2]), mime: match[1] };
  } catch {
    return null;
  }
}

export class GeminiImageProvider implements SkinGenerationProvider {
  constructor(private readonly env: Env) {}

  async generate(
    request: SkinGenerationRequest,
  ): Promise<SkinGenerationResult> {
    const photo = dataUrlToBytes(request.photoDataUrl);
    if (!photo) {
      return {
        ok: false,
        error: "사진 data URL을 해석하지 못함",
        retryable: false,
      };
    }
    const size = sniffImageSize(photo.bytes);
    if (!size) {
      return {
        ok: false,
        error: "사진 크기를 판별하지 못함 (PNG/JPEG 아님)",
        retryable: false,
      };
    }
    if (size.width < MIN_INPUT_EDGE || size.height < MIN_INPUT_EDGE) {
      return {
        ok: false,
        error: `사진이 너무 작음 (${size.width}x${size.height})`,
        retryable: false,
      };
    }
    const references = (request.referencePhotoDataUrls || [])
      .slice(0, 4)
      .map(dataUrlToBytes)
      .filter(
        (image): image is { bytes: Uint8Array; mime: string } => image !== null,
      )
      .filter((image) => {
        const imageSize = sniffImageSize(image.bytes);
        return Boolean(
          imageSize &&
            imageSize.width >= MIN_INPUT_EDGE &&
            imageSize.height >= MIN_INPUT_EDGE,
        );
      });

    let prompt =
      request.mode === "front_view"
        ? buildFrontViewPrompt(
            request.analysis,
            references.length,
            request.skinPlan,
          )
        : buildFourViewPrompt(
            request.analysis,
            references.length,
            request.skinPlan,
          );
    if (request.correctionPrompt?.trim()) {
      prompt += `\n\nTARGETED CORRECTION PASS: Keep all correct identity and outfit decisions unchanged. Fix only these verified defects: ${request.correctionPrompt.trim()}`;
    }
    const guide =
      request.mode === "front_view"
        ? await buildFrontBackGuidePng()
        : await buildFourViewGuidePng();
    const modelTier =
      request.modelTier ??
      (this.env.IMAGE_MODEL_TIER === "quality" ? "quality" : "balanced");
    const models = imageModels(this.env, modelTier);
    let lastError: unknown;
    const attemptedModels: string[] = [];
    for (const model of models) {
      attemptedModels.push(model);
      try {
        const imageBytes = await generateGeminiImage(this.env, {
          model,
          prompt,
          images: [
            { bytes: photo.bytes, mimeType: photo.mime },
            ...references.map((image) => ({
              bytes: image.bytes,
              mimeType: image.mime,
            })),
            { bytes: guide, mimeType: "image/png" },
          ],
          seed: request.seed,
          // Four isolated views need a wide sheet. The two-view mode uses 16:9.
          aspectRatio: request.mode === "four_view" ? "4:1" : "16:9",
        });
        return {
          ok: true,
          imageBytes,
          inputTiles: 2 + references.length,
          outputTiles: 2,
        };
      } catch (error) {
        lastError = error;
        if (
          attemptedModels.length < models.length &&
          canTryFallbackModel(error)
        ) {
          continue;
        }
        break;
      }
    }

    const detail =
      lastError instanceof Error ? lastError.message : String(lastError);
    const temporaryRateLimit = isGeminiTemporaryRateLimit(lastError);
    const quotaExceeded =
      isGeminiQuotaError(lastError) && !temporaryRateLimit;
    const attempts =
      attemptedModels.length > 1
        ? ` (models tried: ${attemptedModels.join(" -> ")})`
        : "";
    return {
      ok: false,
      error: `Gemini image generation failed${attempts}: ${detail}`,
      retryable: temporaryRateLimit || !quotaExceeded,
      ...(quotaExceeded ? { quotaExceeded: true } : {}),
      ...(temporaryRateLimit
        ? { retryAfterMs: geminiRetryAfterMs(lastError) }
        : {}),
      ...(!quotaExceeded && !temporaryRateLimit
        ? { capacityConsumed: true }
        : {}),
    };
  }
}
