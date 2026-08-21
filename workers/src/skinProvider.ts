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
import {
  base64ToBytes,
  decodeImage,
  encodePng,
  sniffImageSize,
} from "./png";
import { imageGenerationNeurons } from "./quota";
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
      provider?: "gemini" | "workers_ai";
      /** Exact local-meter estimate when the provider has a different cost model. */
      neuronsSpent?: number;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      quotaExceeded?: boolean;
      /** True when inference ran far enough that account capacity may be used. */
      capacityConsumed?: boolean;
      retryAfterMs?: number;
      /** Capacity consumed across hidden primary/fallback provider attempts. */
      neuronsSpent?: number;
    };

export interface SkinGenerationProvider {
  generate(request: SkinGenerationRequest): Promise<SkinGenerationResult>;
}

const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const DEFAULT_GEMINI_IMAGE_FALLBACK_MODEL =
  "gemini-3.1-flash-lite-image";
const DEFAULT_WORKERS_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MIN_INPUT_EDGE = 64;
const WORKERS_IMAGE_MAX_EDGE = 448;

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

async function fitWorkersImage(
  image: { bytes: Uint8Array; mime: string },
): Promise<{ bytes: Uint8Array; mime: string }> {
  const size = sniffImageSize(image.bytes);
  if (!size) throw new Error("참조 이미지 크기를 판별하지 못함");
  if (
    size.width <= WORKERS_IMAGE_MAX_EDGE &&
    size.height <= WORKERS_IMAGE_MAX_EDGE
  ) {
    return image;
  }

  const source = await decodeImage(image.bytes);
  const scale = Math.min(
    WORKERS_IMAGE_MAX_EDGE / source.width,
    WORKERS_IMAGE_MAX_EDGE / source.height,
  );
  const width = Math.max(MIN_INPUT_EDGE, Math.round(source.width * scale));
  const height = Math.max(MIN_INPUT_EDGE, Math.round(source.height * scale));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor(((y + 0.5) * source.height) / height),
    );
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor(((x + 0.5) * source.width) / width),
      );
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = source.rgba[sourceOffset];
      rgba[targetOffset + 1] = source.rgba[sourceOffset + 1];
      rgba[targetOffset + 2] = source.rgba[sourceOffset + 2];
      rgba[targetOffset + 3] = source.rgba[sourceOffset + 3];
    }
  }
  return {
    bytes: await encodePng({ width, height, rgba }),
    mime: "image/png",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkersQuotaError(error: unknown): boolean {
  return /(?:\b3036\b|account limited|daily free allocation|quota exceeded)/i.test(
    errorText(error),
  );
}

function isWorkersTemporaryError(error: unknown): boolean {
  return /(?:\b3040\b|out of capacity|rate limit|too many requests|\b429\b|temporar|timeout)/i.test(
    errorText(error),
  );
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
          provider: "gemini",
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

/**
 * Cloudflare-native image-editing fallback. FLUX.2 receives the same person
 * references and deterministic pose guide as Gemini; the server still owns
 * UV packing, seam repair and six-view validation.
 */
export class WorkersAiImageProvider implements SkinGenerationProvider {
  constructor(private readonly env: Env) {}

  async generate(
    request: SkinGenerationRequest,
  ): Promise<SkinGenerationResult> {
    if (!this.env.AI) {
      return {
        ok: false,
        error: "Workers AI binding이 설정되지 않음",
        retryable: false,
      };
    }
    const photo = dataUrlToBytes(request.photoDataUrl);
    if (!photo) {
      return {
        ok: false,
        error: "사진 data URL을 해석하지 못함",
        retryable: false,
      };
    }
    const size = sniffImageSize(photo.bytes);
    if (!size || size.width < MIN_INPUT_EDGE || size.height < MIN_INPUT_EDGE) {
      return {
        ok: false,
        error: size
          ? `사진이 너무 작음 (${size.width}x${size.height})`
          : "사진 크기를 판별하지 못함 (PNG/JPEG 아님)",
        retryable: false,
      };
    }

    let submitted = false;
    let attemptedInputTiles = 0;
    try {
      // FLUX.2 supports at most four inputs. Keep the primary photo first and
      // the pose guide last, leaving two slots for compatible identity refs.
      const referencePhotos = (request.referencePhotoDataUrls || [])
        .slice(0, 2)
        .map(dataUrlToBytes)
        .filter(
          (image): image is { bytes: Uint8Array; mime: string } =>
            image !== null,
        );
      const guide =
        request.mode === "front_view"
          ? await buildFrontBackGuidePng()
          : await buildFourViewGuidePng();
      const images = await Promise.all([
        fitWorkersImage(photo),
        ...referencePhotos.map(fitWorkersImage),
        fitWorkersImage({ bytes: guide, mime: "image/png" }),
      ]);
      attemptedInputTiles = images.length;
      let prompt =
        request.mode === "front_view"
          ? buildFrontViewPrompt(
              request.analysis,
              referencePhotos.length,
              request.skinPlan,
            )
          : buildFourViewPrompt(
              request.analysis,
              referencePhotos.length,
              request.skinPlan,
            );
      if (request.correctionPrompt?.trim()) {
        prompt += `\n\nTARGETED CORRECTION PASS: Keep all correct identity and outfit decisions unchanged. Fix only these verified defects: ${request.correctionPrompt.trim()}`;
      }

      const form = new FormData();
      form.append("prompt", prompt);
      form.append("width", request.mode === "four_view" ? "1024" : "768");
      form.append("height", request.mode === "four_view" ? "256" : "432");
      form.append("guidance", "4");
      form.append("seed", String(request.seed));
      images.forEach((image, index) => {
        const extension = image.mime === "image/jpeg" ? "jpg" : "png";
        form.append(
          `input_image_${index}`,
          new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
          `reference-${index}.${extension}`,
        );
      });
      const serialized = new Response(form);
      const contentType = serialized.headers.get("content-type");
      if (!serialized.body || !contentType) {
        throw new Error("Workers AI multipart 요청을 직렬화하지 못함");
      }
      const model =
        this.env.WORKERS_IMAGE_MODEL?.trim() || DEFAULT_WORKERS_IMAGE_MODEL;
      submitted = true;
      const response = (await this.env.AI.run(model as never, {
        multipart: {
          body: serialized.body,
          contentType,
        },
      } as never)) as { image?: unknown };
      if (typeof response.image !== "string" || !response.image.trim()) {
        throw new Error("Workers AI가 이미지 데이터를 반환하지 않음");
      }
      const imageBytes = base64ToBytes(response.image);
      if (!sniffImageSize(imageBytes)) {
        throw new Error("Workers AI가 PNG/JPEG가 아닌 출력을 반환함");
      }
      const inputTiles = images.length;
      const outputTiles = 2;
      return {
        ok: true,
        imageBytes,
        inputTiles,
        outputTiles,
        provider: "workers_ai",
        neuronsSpent: imageGenerationNeurons(
          this.env,
          inputTiles,
          outputTiles,
          "balanced",
        ),
      };
    } catch (error) {
      const quotaExceeded = isWorkersQuotaError(error);
      const retryable = !quotaExceeded && isWorkersTemporaryError(error);
      const capacityConsumed = submitted && !quotaExceeded;
      return {
        ok: false,
        error: `Workers AI image generation failed: ${errorText(error)}`,
        retryable,
        ...(quotaExceeded ? { quotaExceeded: true } : {}),
        ...(capacityConsumed ? { capacityConsumed: true } : {}),
        ...(capacityConsumed
          ? {
              neuronsSpent: imageGenerationNeurons(
                this.env,
                Math.max(1, attemptedInputTiles),
                2,
                "balanced",
              ),
            }
          : {}),
      };
    }
  }
}

/** Gemini remains primary; the dedicated Workers AI account recovers it. */
export class ResilientImageProvider implements SkinGenerationProvider {
  private readonly gemini: GeminiImageProvider;
  private readonly workers: WorkersAiImageProvider;
  private geminiQuotaExhausted = false;

  constructor(private readonly env: Env) {
    this.gemini = new GeminiImageProvider(env);
    this.workers = new WorkersAiImageProvider(env);
  }

  async generate(
    request: SkinGenerationRequest,
  ): Promise<SkinGenerationResult> {
    const fallbackEnabled =
      this.env.WORKERS_IMAGE_FALLBACK_ENABLED !== "false" && Boolean(this.env.AI);
    if (this.geminiQuotaExhausted && fallbackEnabled) {
      return this.workers.generate(request);
    }

    const primary = await this.gemini.generate(request);
    if (primary.ok) return primary;
    if (primary.quotaExceeded) this.geminiQuotaExhausted = true;
    const validButProviderFailed =
      primary.retryable ||
      primary.quotaExceeded === true ||
      primary.capacityConsumed === true;
    if (!fallbackEnabled || !validButProviderFailed) return primary;

    const tier =
      request.modelTier ??
      (this.env.IMAGE_MODEL_TIER === "quality" ? "quality" : "balanced");
    const primaryNeurons = primary.capacityConsumed
      ? imageGenerationNeurons(this.env, 2, 2, tier)
      : 0;
    const fallback = await this.workers.generate(request);
    const totalNeurons = primaryNeurons + (fallback.neuronsSpent ?? 0);
    if (fallback.ok) {
      return {
        ...fallback,
        neuronsSpent: totalNeurons,
      };
    }
    return {
      ...fallback,
      error: `${primary.error}; ${fallback.error}`,
      // The chain is exhausted only when the final Workers AI provider is.
      // A Gemini-only quota error must not cancel a retryable Workers call.
      quotaExceeded: fallback.quotaExceeded === true,
      capacityConsumed:
        primary.capacityConsumed === true || fallback.capacityConsumed === true,
      neuronsSpent: totalNeurons,
    };
  }
}
