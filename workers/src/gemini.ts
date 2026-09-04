import { base64ToBytes } from "./png";
import type { Env } from "./types";
import { inspectGeminiResponseSchema, type GeminiSchemaPreflight } from "./geminiStructuredSchema";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_GATEWAY_ID = "default";
const DEFAULT_WORKERS_VISION_MODEL =
  "@cf/meta/llama-4-scout-17b-16e-instruct";
const DEFAULT_STRUCTURED_TIMEOUT_MS = 45_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

interface GeminiErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      retryDelay?: string;
      fieldViolations?: Array<{
        field?: string;
        description?: string;
      }>;
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
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<GeminiImageBlock & { text?: string }> }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
  };
}

export type GeminiStructuredApiFamily = "generateContent" | "interactions";

export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerStatus?: string,
    readonly retryAfterMs?: number,
    readonly quotaIds: string[] = [],
    readonly hasZeroQuota = false,
    readonly providerCode?: number,
    readonly fieldViolations: GeminiFieldViolation[] = [],
    public requestShape?: GeminiStructuredRequestShape,
  ) {
    super(sanitizeProviderText(message));
    this.name = "GeminiApiError";
  }
}

export interface GeminiFieldViolation {
  field: string;
  description: string;
}

export interface GeminiStructuredRequestShape {
  model: string;
  apiFamily: GeminiStructuredApiFamily;
  apiVersion: "v1beta";
  endpointMethod: "models.generateContent" | "interactions.create";
  structuredConfigKey: "generationConfig.responseJsonSchema" | "response_format.schema";
  systemInstruction: false;
  imageParts: number;
  imageMimeTypes: string[];
  imageRawBytes: number[];
  imageBase64Chars: number[];
  imageMagicMatchesMime: boolean[];
  promptChars: number;
  promptBytes: number;
  responseMimeType: "application/json";
  responseSchemaEnabled: true;
  schema: GeminiSchemaPreflight;
  maxOutputTokens: number;
  temperature: 0 | null;
  serializedBytes: number;
}

export interface GeminiProviderErrorDiagnostic {
  httpStatus: number | null;
  providerCode: number | null;
  providerStatus: string | null;
  message: string;
  fieldViolations: GeminiFieldViolation[];
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=\r\n]+/gi, "[redacted-image]")
    .replace(/\b(?:AIza|AQ\.)[a-z0-9._-]{16,}\b/gi, "[redacted-secret]")
    .slice(0, 1_000);
}

export function geminiProviderErrorDiagnostic(error: unknown): GeminiProviderErrorDiagnostic {
  if (error instanceof GeminiApiError) {
    return {
      httpStatus: error.status,
      providerCode: error.providerCode ?? null,
      providerStatus: error.providerStatus ?? null,
      message: sanitizeProviderText(error.message),
      fieldViolations: error.fieldViolations.map((violation) => ({
        field: sanitizeProviderText(violation.field),
        description: sanitizeProviderText(violation.description),
      })),
    };
  }
  return {
    httpStatus: null,
    providerCode: null,
    providerStatus: null,
    message: sanitizeProviderText(error instanceof Error ? error.message : String(error)),
    fieldViolations: [],
  };
}

export interface GeminiStructuredRequest {
  model: string;
  /** Defaults to the existing generateContent transport. */
  apiFamily?: GeminiStructuredApiFamily;
  imageDataUrls: string[];
  /** Optional per-image roles. Defaults to ordered same-person references. */
  imageLabels?: string[];
  prompt: string;
  responseSchema: unknown;
  maxOutputTokens: number;
  /** Lets existing unit tests inject a provider without network I/O. */
  legacyWorkersAiInput?: Record<string, unknown>;
  /** Defaults to true; identity geometry disables it to guarantee one call. */
  allowWorkersAiFallback?: boolean;
  /** Receives sanitized shape-only diagnostics; never includes image data. */
  onRequestShape?: (shape: GeminiStructuredRequestShape) => void;
}

function parseImageDataUrl(
  dataUrl: string,
): { mimeType: string; data: string; rawBytes: number; magicMatchesMime: boolean } | null {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(
    dataUrl,
  );
  if (!match) return null;
  const bytes = base64ToBytes(match[2]);
  const mimeType = match[1].toLowerCase();
  const magicMatchesMime = mimeType === "image/png"
    ? bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    : mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : true;
  return { mimeType, data: match[2], rawBytes: bytes.length, magicMatchesMime };
}

function requireApiKey(env: Env): string {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new GeminiApiError("GEMINI_API_KEY is not configured", 500);
  }
  return key;
}

/**
 * Route production Gemini calls through the account-bound AI Gateway. Direct
 * Google AI Studio calls from a Cloudflare egress POP can be rejected as an
 * unsupported user location. The Worker AI binding authenticates the gateway
 * subrequest without storing a second Cloudflare token, while the provider
 * still receives the user's encrypted Google API key.
 */
async function geminiApiBase(env: Env): Promise<string> {
  if (env.AI && typeof env.AI.gateway === "function") {
    const providerBase = await env.AI
      .gateway(GEMINI_GATEWAY_ID)
      .getUrl("google-ai-studio");
    return `${providerBase.replace(/\/$/, "")}/v1beta`;
  }
  return GEMINI_API_BASE;
}

function workersAiStructuredInput(
  request: GeminiStructuredRequest,
): Record<string, unknown> {
  if (request.legacyWorkersAiInput) return request.legacyWorkersAiInput;
  return {
    messages: [
      {
        role: "user",
        content: [
          ...request.imageDataUrls.map((url, index) => ({
            type: "image_url",
            image_url: { url },
            ...(request.imageLabels?.[index]
              ? { label: request.imageLabels[index] }
              : {}),
          })),
          { type: "text", text: request.prompt },
        ],
      },
    ],
    max_tokens: request.maxOutputTokens,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "minecraft_skin_structured_fallback",
        description:
          "Structured portrait analysis or rendered-skin critique for a Minecraft skin",
        schema: request.responseSchema,
      },
    },
  };
}

function shouldUseWorkersAiFallback(error: unknown): boolean {
  // A dedicated Workers AI account is the structured-analysis safety net,
  // not only an authentication workaround. Preserve deterministic skin
  // generation when Gemini's free request bucket, gateway, or network is
  // temporarily unavailable. Invalid payload/schema errors remain with
  // Gemini so a malformed application request is never hidden by a fallback.
  if (!(error instanceof GeminiApiError)) {
    return (
      error instanceof TypeError ||
      /(?:fetch failed|network|connection|socket|econnreset)/i.test(
        error instanceof Error ? error.message : String(error),
      )
    );
  }
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500 ||
    /user location is not supported|unauthorized/i.test(error.message)
  );
}

async function runWorkersAiStructuredFallback(
  env: Env,
  request: GeminiStructuredRequest,
): Promise<unknown> {
  if (!env.AI) {
    throw new GeminiApiError("Workers AI binding is not configured", 500);
  }
  const model =
    env.WORKERS_VISION_MODEL?.trim() || DEFAULT_WORKERS_VISION_MODEL;
  return env.AI.run(
    model as never,
    workersAiStructuredInput(request) as never,
  );
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
    const fieldViolations = (payload.error?.details || [])
      .flatMap((detail) => detail.fieldViolations || [])
      .map((violation) => ({
        field: typeof violation.field === "string" ? sanitizeProviderText(violation.field) : "unknown",
        description: typeof violation.description === "string" ? sanitizeProviderText(violation.description) : "",
      }));
    throw new GeminiApiError(
      message,
      response.status,
      payload.error?.status,
      retryAfterMs,
      quotaIds,
      hasZeroQuota,
      payload.error?.code,
      fieldViolations,
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

export function buildGeminiStructuredRequestEnvelope(request: GeminiStructuredRequest): {
  body: Record<string, unknown>;
  shape: GeminiStructuredRequestShape;
} {
  if (request.imageDataUrls.length > 6) {
    throw new GeminiApiError("Gemini accepts at most 6 input images", 400);
  }
  if (request.imageLabels !== undefined && request.imageLabels.length !== request.imageDataUrls.length) {
    throw new GeminiApiError("Gemini imageLabels must match imageDataUrls length", 400);
  }
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    throw new GeminiApiError("Gemini maxOutputTokens must be a positive integer", 400);
  }
  const images = request.imageDataUrls.map(parseImageDataUrl);
  if (images.some((image) => image === null)) throw new GeminiApiError("Invalid image data URL", 400);
  const generateContentImageParts = images.flatMap((image, index) => [
    { text: request.imageLabels?.[index]?.trim() || `Reference image ${index} of the same person:` },
    { inlineData: { mimeType: image!.mimeType, data: image!.data } },
  ]);
  const interactionsImageParts = images.flatMap((image, index) => [
    { type: "text", text: request.imageLabels?.[index]?.trim() || `Reference image ${index} of the same person:` },
    { type: "image", mime_type: image!.mimeType, data: image!.data },
  ]);
  const schema = inspectGeminiResponseSchema(request.responseSchema);
  const apiFamily = request.apiFamily ?? "generateContent";
  const body: Record<string, unknown> = apiFamily === "interactions"
    ? {
        model: request.model,
        store: false,
        input: [...interactionsImageParts, { type: "text", text: request.prompt }],
        response_format: { type: "text", mime_type: "application/json", schema: request.responseSchema },
        generation_config: { max_output_tokens: request.maxOutputTokens, thinking_level: "low" },
      }
    : {
        contents: [{ role: "user", parts: [...generateContentImageParts, { text: request.prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens,
          thinkingConfig: { thinkingLevel: "LOW" },
          responseMimeType: "application/json",
          responseJsonSchema: request.responseSchema,
        },
      };
  const serializedBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const shape: GeminiStructuredRequestShape = {
    model: request.model,
    apiFamily,
    apiVersion: "v1beta",
    endpointMethod: apiFamily === "interactions" ? "interactions.create" : "models.generateContent",
    structuredConfigKey: apiFamily === "interactions" ? "response_format.schema" : "generationConfig.responseJsonSchema",
    systemInstruction: false,
    imageParts: images.length,
    imageMimeTypes: images.map((image) => image!.mimeType),
    imageRawBytes: images.map((image) => image!.rawBytes),
    imageBase64Chars: images.map((image) => image!.data.length),
    imageMagicMatchesMime: images.map((image) => image!.magicMatchesMime),
    promptChars: request.prompt.length,
    promptBytes: new TextEncoder().encode(request.prompt).byteLength,
    responseMimeType: "application/json",
    responseSchemaEnabled: true,
    schema,
    maxOutputTokens: request.maxOutputTokens,
    temperature: apiFamily === "interactions" ? null : 0,
    serializedBytes,
  };
  if (!schema.valid) {
    const error = new GeminiApiError("Gemini response schema failed local supported-subset preflight", 400, "CLIENT_SCHEMA_PREFLIGHT");
    error.requestShape = shape;
    throw error;
  }
  return { body, shape };
}

export async function generateGeminiStructuredJson(
  env: Env,
  request: GeminiStructuredRequest,
): Promise<unknown> {
  // Preserve the original no-key test/local seam. Production has both the
  // encrypted Gemini key and an account-internal Workers AI fallback.
  if (!env.GEMINI_API_KEY && env.AI && request.legacyWorkersAiInput) {
    return env.AI.run(
      request.model as never,
      request.legacyWorkersAiInput as never,
    );
  }
  // Build and validate the exact wire envelope for production and for the
  // single-provider geometry seam. Legacy injected fixtures above predate
  // data URLs and intentionally retain their original test-only path.
  const envelope = buildGeminiStructuredRequestEnvelope(request);
  request.onRequestShape?.(envelope.shape);
  // A stage that forbids provider fallback may still use the configured
  // Workers AI binding as its sole provider when no Gemini key exists. This
  // remains exactly one call rather than Gemini followed by a recovery call.
  if (!env.GEMINI_API_KEY && env.AI && request.allowWorkersAiFallback === false) {
    return runWorkersAiStructuredFallback(env, request);
  }

  // The app accepts up to five same-person source photos. Structured review
  // adds one rendered inspection montage, so this shared wrapper retains all
  // six inputs. The same envelope builder is used by preflight tests and the
  // actual request to prevent serialization drift.
  try {
    const apiBase = await geminiApiBase(env);
    const response = await fetchGemini(
      request.apiFamily === "interactions"
        ? `${apiBase}/interactions`
        : `${apiBase}/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": requireApiKey(env),
        },
        body: JSON.stringify(envelope.body),
      },
      requestTimeoutMs(
        env.GEMINI_STRUCTURED_TIMEOUT_MS,
        DEFAULT_STRUCTURED_TIMEOUT_MS,
      ),
      `Gemini structured request (${request.model})`,
    );
    const payload = await parseGeminiResponse<GeminiGenerateContentResponse & GeminiInteractionResponse>(response);
    const interactionOutput = payload.output_text || payload.steps
      ?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content || [])
      .map((part) => part.text || "")
      .join("");
    const output = (request.apiFamily === "interactions"
      ? interactionOutput
      : payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(""))
      ?.trim();
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
        prompt_tokens: payload.usageMetadata?.promptTokenCount ?? payload.usage?.total_input_tokens,
        completion_tokens: payload.usageMetadata?.candidatesTokenCount ?? payload.usage?.total_output_tokens,
        total_tokens: payload.usageMetadata?.totalTokenCount ?? payload.usage?.total_tokens,
      },
    };
  } catch (error) {
    if (error instanceof GeminiApiError && !error.requestShape) error.requestShape = envelope.shape;
    if (request.allowWorkersAiFallback !== false && env.AI && shouldUseWorkersAiFallback(error)) {
      return runWorkersAiStructuredFallback(env, request);
    }
    throw error;
  }
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

  const apiBase = await geminiApiBase(env);
  const response = await fetchGemini(
    `${apiBase}/interactions`,
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
