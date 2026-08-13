import { base64ToBytes } from "./png";
import type { Env } from "./types";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_STRUCTURED_TIMEOUT_MS = 45_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

interface GeminiErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      retryDelay?: string;
      violations?: Array<{
        quotaId?: string;
        quotaValue?: string;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
  };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiImageBlock {
  type?: string;
  data?: string;
  mime_type?: string;
  mimeType?: string;
}

interface GeminiInteractionResponse {
  output_image?: GeminiImageBlock;
  steps?: Array<{ type?: string; content?: GeminiImageBlock[] }>;
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerStatus?: string,
    readonly retryAfterMs?: number,
    readonly quotaIds: string[] = [],
    readonly hasZeroQuota = false,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

export interface GeminiStructuredRequest {
  model: string;
  imageDataUrls: string[];
  /** Optional per-image roles. Defaults to ordered same-person references. */
  imageLabels?: string[];
  prompt: string;
  responseSchema: unknown;
  maxOutputTokens: number;
  /** Lets existing unit tests inject a provider without network I/O. */
  legacyWorkersAiInput?: Record<string, unknown>;
}

function parseImageDataUrl(
  dataUrl: string,
): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(
    dataUrl,
  );
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function requireApiKey(env: Env): string {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new GeminiApiError("GEMINI_API_KEY is not configured", 500);
  }
  return key;
}

function requestTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(180_000, Math.max(10, Math.round(parsed)))
    : fallback;
}

async function fetchGemini(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GeminiApiError(
        `${operation} timed out after ${timeoutMs}ms`,
        504,
        "DEADLINE_EXCEEDED",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseGeminiResponse<T>(response: Response): Promise<T> {
  const payload = (await response
    .json()
    .catch(() => ({}))) as GeminiErrorPayload;
  if (!response.ok) {
    const message =
      payload.error?.message || `Gemini API HTTP ${response.status}`;
    const retryDelay = payload.error?.details
      ?.map((detail) => detail.retryDelay)
      .find((value): value is string => typeof value === "string");
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = parseRetryDelay(
      retryDelay || retryAfterHeader || message,
    );
    const quotaIds = (payload.error?.details || [])
      .flatMap((detail) => detail.violations || [])
      .map((violation) => violation.quotaId)
      .filter((value): value is string => typeof value === "string");
    const hasZeroQuota = (payload.error?.details || [])
      .flatMap((detail) => detail.violations || [])
      .some((violation) => violation.quotaValue === "0");
    throw new GeminiApiError(
      message,
      response.status,
      payload.error?.status,
      retryAfterMs,
      quotaIds,
      hasZeroQuota,
    );
  }
  return payload as T;
}

function parseRetryDelay(value: string): number | undefined {
  const seconds = /(?:retry(?:\s+in)?\s*)?(\d+(?:\.\d+)?)s\b/i.exec(value);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.ceil(numeric * 1000)
    : undefined;
}

export async function generateGeminiStructuredJson(
  env: Env,
  request: GeminiStructuredRequest,
): Promise<unknown> {
  // Production has no AI binding. This branch is only a local test seam.
  if (!env.GEMINI_API_KEY && env.AI && request.legacyWorkersAiInput) {
    return env.AI.run(
      request.model as never,
      request.legacyWorkersAiInput as never,
    );
  }

  // The app accepts up to five same-person source photos. Structured review
  // adds one rendered inspection montage, so this shared wrapper must retain
  // all six inputs. This is an application bound, not a Gemini API limit.
  if (request.imageDataUrls.length < 1 || request.imageDataUrls.length > 6) {
    throw new GeminiApiError("Gemini requires 1 to 6 input images", 400);
  }
  if (
    request.imageLabels !== undefined &&
    request.imageLabels.length !== request.imageDataUrls.length
  ) {
    throw new GeminiApiError(
      "Gemini imageLabels must match imageDataUrls length",
      400,
    );
  }
  const images = request.imageDataUrls.map(parseImageDataUrl);
  if (images.some((image) => image === null)) {
    throw new GeminiApiError("Invalid image data URL", 400);
  }
  const imageParts = images.flatMap((image, index) => [
    {
      text:
        request.imageLabels?.[index]?.trim() ||
        `Reference image ${index} of the same person:`,
    },
    {
      inlineData: {
        mimeType: image!.mimeType,
        data: image!.data,
      },
    },
  ]);
  const response = await fetchGemini(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(request.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": requireApiKey(env),
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [...imageParts, { text: request.prompt }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens,
          // Gemini 3 defaults to medium thinking. Low is sufficient for
          // extraction and leaves the output budget for the large schema.
          thinkingConfig: { thinkingLevel: "LOW" },
          responseMimeType: "application/json",
          responseJsonSchema: request.responseSchema,
        },
      }),
    },
    requestTimeoutMs(
      env.GEMINI_STRUCTURED_TIMEOUT_MS,
      DEFAULT_STRUCTURED_TIMEOUT_MS,
    ),
    `Gemini structured request (${request.model})`,
  );
  const payload =
    await parseGeminiResponse<GeminiGenerateContentResponse>(response);
  const output = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!output) {
    const blocked = payload.promptFeedback?.blockReason;
    throw new GeminiApiError(
      blocked
        ? `Gemini blocked the prompt: ${blocked}`
        : "Gemini returned no JSON",
      502,
    );
  }
  return {
    response: output,
    ...(payload.candidates?.[0]?.finishReason
      ? { finishReason: payload.candidates[0].finishReason }
      : {}),
    usage: {
      prompt_tokens: payload.usageMetadata?.promptTokenCount,
      completion_tokens: payload.usageMetadata?.candidatesTokenCount,
      total_tokens: payload.usageMetadata?.totalTokenCount,
    },
  };
}

export interface GeminiImageRequest {
  model: string;
  prompt: string;
  images: Array<{ mimeType: string; bytes: Uint8Array }>;
  seed: number;
  aspectRatio: "16:9" | "4:1";
}

function imageAspectRatio(request: GeminiImageRequest): string {
  // Flash Lite supports 21:9 as its widest output, while Flash supports the
  // 4:1 sheet used by the four-view packer. Preserve the four-view layout on
  // Lite by selecting its widest legal ratio instead of sending an invalid
  // response_format.
  return request.model === "gemini-3.1-flash-lite-image" &&
    request.aspectRatio === "4:1"
    ? "21:9"
    : request.aspectRatio;
}

export async function generateGeminiImage(
  env: Env,
  request: GeminiImageRequest,
): Promise<Uint8Array> {
  const input: Array<Record<string, string>> = request.images.map((image) => ({
    type: "image",
    mime_type: image.mimeType,
    data: bytesToBase64(image.bytes),
  }));
  input.push({ type: "text", text: request.prompt });

  const response = await fetchGemini(
    `${GEMINI_API_BASE}/interactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": requireApiKey(env),
      },
      body: JSON.stringify({
        model: request.model,
        input,
        response_format: {
          type: "image",
          // gemini-3.1-flash-image currently exposes JPEG output through the
          // Interactions API. The deterministic packer decodes JPEG before it
          // creates the final lossless 64x64 PNG atlas.
          mime_type: "image/jpeg",
          aspect_ratio: imageAspectRatio(request),
          image_size: "1K",
        },
        generation_config: { seed: request.seed },
      }),
    },
    requestTimeoutMs(env.GEMINI_IMAGE_TIMEOUT_MS, DEFAULT_IMAGE_TIMEOUT_MS),
    `Gemini image request (${request.model})`,
  );
  const payload =
    await parseGeminiResponse<GeminiInteractionResponse>(response);
  const stepImages = (payload.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter(
      (block) =>
        block.type === "image" ||
        block.mime_type?.startsWith("image/") ||
        block.mimeType?.startsWith("image/"),
    )
    .map((block) => block.data)
    .filter((data): data is string => Boolean(data));
  const imageData = payload.output_image?.data || stepImages.at(-1);
  if (!imageData) {
    throw new GeminiApiError("Gemini returned no generated image", 502);
  }
  return base64ToBytes(imageData);
}

export function isGeminiQuotaError(error: unknown): boolean {
  if (error instanceof GeminiApiError) {
    return (
      error.status === 429 || error.providerStatus === "RESOURCE_EXHAUSTED"
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return /(?:resource_exhausted|quota|rate limit|too many requests)/i.test(
    detail,
  );
}

export function isGeminiModelUnavailable(error: unknown): boolean {
  if (!(error instanceof GeminiApiError)) return false;
  if (error.status === 404 || error.providerStatus === "NOT_FOUND") return true;
  return (
    error.status === 400 &&
    /(?:model).*(?:not found|not supported|not available|deprecated)|(?:not found|not supported|not available|deprecated).*(?:model)/i.test(
      error.message,
    )
  );
}

export function geminiRetryAfterMs(error: unknown): number | undefined {
  return error instanceof GeminiApiError ? error.retryAfterMs : undefined;
}

export function isGeminiTemporaryRateLimit(error: unknown): boolean {
  const retryAfter = geminiRetryAfterMs(error);
  return (
    error instanceof GeminiApiError &&
    error.status === 429 &&
    retryAfter !== undefined &&
    !error.hasZeroQuota &&
    !/\b(?:limit|quota(?:value)?)\s*[:=]\s*0\b/i.test(error.message) &&
    !error.quotaIds.some((quotaId) => /perday|requestsperday/i.test(quotaId)) &&
    retryAfter <= 120_000
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}
