import { base64ToBytes } from "./png";
import { withinDeadline } from "./deadline";
import type { Env } from "./types";
import { inspectGeminiResponseSchema, type GeminiSchemaPreflight } from "./geminiStructuredSchema";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_GATEWAY_ID = "default";
const LLAMA_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const GEMMA_VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const LLAMA_JSON_OUTPUT_SUFFIX = `OUTPUT FORMAT REQUIREMENT FOR THIS RESPONSE:
Return exactly one JSON object.
Do not use Markdown or a code fence.
Do not explain the answer.
The first output character must be { and the last must be }.
Include every required field in the Compact contract.
Use only the listed enum values.`;
const DEFAULT_WORKERS_VISION_MODEL =
  GEMMA_VISION_MODEL;
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
  /**
   * Optional provider-specific strict wire contract for Workers AI. Gemini's
   * provider schema may deliberately omit nested constraints for transport
   * compatibility; the native fallback must not inherit that relaxation.
   */
  workersAiResponseSchema?: unknown;
  /** Provider-only representation instructions; Gemini always uses prompt above. */
  workersAiPrompt?: string;
  maxOutputTokens: number;
  /** Lets existing unit tests inject a provider without network I/O. */
  legacyWorkersAiInput?: Record<string, unknown>;
  /** Defaults to true; identity geometry disables it to guarantee one call. */
  allowWorkersAiFallback?: boolean;
  /** Receives sanitized shape-only diagnostics; never includes image data. */
  onRequestShape?: (shape: GeminiStructuredRequestShape) => void;
  /** Caller budget cap; not part of the provider wire. */
  timeoutCapMs?: number;
  onProviderAttempt?: (attempt: StructuredProviderAttempt) => void;
}

export interface StructuredProviderAttempt {
  provider: "gemini" | "workers_ai";
  model: string;
  outcome: "started" | "completed" | "failed";
  responseFormatMode?: "gemini_response_json_schema" | "workers_response_format" | "workers_response_format_strict" | "workers_guided_json_strict" | "workers_prompt_json_strict" | "workers_named_json_schema_strict";
  providerSchemaValidation?: "passed" | "failed";
  strictValidation?: "passed" | "failed";
  status?: number;
  providerStatus?: string;
  message?: string;
  fallbackEligible?: boolean;
  fallbackReason?: string;
  dailyQuotaExhausted?: boolean;
  outputDiagnostic?: StructuredProviderOutputDiagnostic;
}

export interface StructuredProviderOutputDiagnostic {
  resultType: string;
  resultNull: boolean;
  resultArray: boolean;
  topLevelKeys: string[];
  responsePresent: boolean;
  responseType: string;
  responseArray: boolean;
  responseObjectKeys: string[];
  responseString?: {
    characterLength: number;
    trimmedLength: number;
    startsWithObject: boolean;
    startsWithArray: boolean;
    containsOpenBrace: boolean;
    containsCloseBrace: boolean;
    fencedJson: boolean;
    extractJsonSucceeded: boolean;
  };
  choicesPresent: boolean;
  choicesType: string;
  extractedType: string;
  extractedNull: boolean;
  extractedObjectKeys: string[];
}

export function isDailyProviderQuota(error: unknown): boolean {
  if (error instanceof GeminiApiError) return error.status === 429 && (
    error.hasZeroQuota || error.quotaIds.some(id => /perday|requestsperday/i.test(id))
    || /daily|per.day/i.test(error.message));
  return /4006|3036|daily free allocation|account limited/i.test(error instanceof Error ? error.message : "");
}

/** One model policy shared by production and diagnostic envelope builders. */
export function structuredModelPolicy(model: string): { temperature: 0 | null } {
  return { temperature: /^gemini-3\.8-flash(?:$|-)/.test(model) ? null : 0 };
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
 * subrequest only when using gateway.run(), not by obtaining a public URL.
 * This URL helper is retained for the inactive image-generation path.
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

export function workersAiStructuredInput(
  request: GeminiStructuredRequest,
  model: string,
): Record<string, unknown> {
  if (request.legacyWorkersAiInput) return request.legacyWorkersAiInput;
  const schema = request.workersAiResponseSchema ?? request.responseSchema;
  if (model === LLAMA_VISION_MODEL) {
    if (request.imageDataUrls.length > 1) {
      throw new GeminiApiError(
        "Llama Vision fallback supports one image per structured analysis request",
        400,
        "WORKERS_SINGLE_IMAGE_ONLY",
      );
    }
    return {
      prompt: `${request.prompt}\n\n${LLAMA_JSON_OUTPUT_SUFFIX}`,
      ...(request.imageDataUrls[0] ? { image: request.imageDataUrls[0] } : {}),
      max_tokens: request.maxOutputTokens,
    };
  }
  if (model === GEMMA_VISION_MODEL) {
    return {
      messages: [
        {
          role: "user",
          content: [
            ...request.imageDataUrls.map((url) => ({
              type: "image_url",
              image_url: { url },
            })),
            { type: "text", text: request.workersAiPrompt ?? request.prompt },
          ],
        },
      ],
      max_completion_tokens: request.maxOutputTokens,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "minecraft_skin_photo_analysis",
          description: "Strict observed portrait analysis for deterministic Minecraft skin rendering",
          schema,
          strict: true,
        },
      },
    };
  }
  const input: Record<string, unknown> = {
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
  };
  if (model === "@cf/moonshotai/kimi-k2.6") {
    input.response_format = {
      type: "json_schema",
      json_schema: {
        name: "minecraft_skin_photo_analysis",
        description: "Strict observed portrait analysis for deterministic Minecraft skin rendering",
        schema,
        strict: true,
      },
    };
  } else if (request.workersAiResponseSchema !== undefined) {
    input.guided_json = request.workersAiResponseSchema;
  } else {
    input.response_format = {
      type: "json_schema",
      json_schema: request.responseSchema,
    };
  }
  return input;
}

export function workersAiFallbackDecision(error: unknown): {
  eligible: boolean;
  reason: string;
} {
  // A dedicated Workers AI account is the structured-analysis safety net,
  // not only an authentication workaround. Preserve deterministic skin
  // generation when Gemini's free request bucket, gateway, or network is
  // temporarily unavailable. Invalid payload/schema errors remain with
  // Gemini so a malformed application request is never hidden by a fallback.
  if (!(error instanceof GeminiApiError)) {
    const eligible = (
      error instanceof TypeError ||
      /(?:fetch failed|network|connection|socket|econnreset)/i.test(
        error instanceof Error ? error.message : String(error),
      )
    );
    return { eligible, reason: eligible ? "network_error" : "non_provider_error" };
  }
  const providerStatus = error.providerStatus?.toUpperCase();
  if (providerStatus === "CLIENT_SCHEMA_PREFLIGHT") {
    return { eligible: false, reason: "client_schema_preflight" };
  }
  if (providerStatus === "INVALID_ARGUMENT") {
    return { eligible: false, reason: "invalid_argument" };
  }
  if (providerStatus === "FAILED_PRECONDITION") {
    return { eligible: true, reason: "provider_failed_precondition" };
  }
  if (error.status === 400) {
    return { eligible: false, reason: "http_400_request_error" };
  }
  if (error.status === 401 || error.status === 403) {
    return { eligible: true, reason: "authentication_or_permission" };
  }
  if (error.status === 404) {
    return { eligible: true, reason: "model_unavailable" };
  }
  if (error.status === 408) {
    return { eligible: true, reason: "request_timeout" };
  }
  if (error.status === 429) {
    return { eligible: true, reason: "rate_limited" };
  }
  if (error.status >= 500) {
    return { eligible: true, reason: "provider_failure" };
  }
  if (/user location is not supported|unauthorized/i.test(error.message)) {
    return { eligible: true, reason: "provider_location_or_account" };
  }
  return { eligible: false, reason: "not_eligible" };
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
  const responseFormatMode = model === LLAMA_VISION_MODEL
    ? "workers_prompt_json_strict" as const
    : model === GEMMA_VISION_MODEL
    ? "workers_named_json_schema_strict" as const
    : model === "@cf/moonshotai/kimi-k2.6"
    ? "workers_response_format_strict" as const
    : request.workersAiResponseSchema !== undefined
      ? "workers_guided_json_strict" as const
      : "workers_response_format" as const;
  request.onProviderAttempt?.({ provider: "workers_ai", model, outcome: "started", responseFormatMode });
  try {
    // AI.run has no cancellation API. Stop awaiting at the deadline; never
    // launch another provider after it. The binding may finish independently.
    const result = await withinDeadline(
      () => env.AI!.run(model as never, workersAiStructuredInput(request, model) as never),
      Math.min(request.timeoutCapMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS, DEFAULT_STRUCTURED_TIMEOUT_MS),
      () => new GeminiApiError("Workers AI analysis deadline exceeded", 504, "DEADLINE_EXCEEDED"),
    );
    request.onProviderAttempt?.({ provider: "workers_ai", model, outcome: "completed", responseFormatMode });
    return result;
  } catch (error) {
    const diagnostic = geminiProviderErrorDiagnostic(error);
    request.onProviderAttempt?.({
      provider: "workers_ai", model, outcome: "failed", responseFormatMode,
      dailyQuotaExhausted: isDailyProviderQuota(error),
      ...(diagnostic.httpStatus !== null ? { status: diagnostic.httpStatus } : {}),
      ...(diagnostic.providerStatus !== null ? { providerStatus: diagnostic.providerStatus } : {}),
      message: diagnostic.message,
    });
    throw error;
  }
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
  const policy = structuredModelPolicy(request.model);
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
          ...(policy.temperature === null ? {} : { temperature: policy.temperature }),
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
    temperature: apiFamily === "interactions" ? null : policy.temperature,
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
  if (!env.GEMINI_API_KEY && env.AI) {
    return runWorkersAiStructuredFallback(env, request);
  }

  // The app accepts up to five same-person source photos. Structured review
  // adds one rendered inspection montage, so this shared wrapper retains all
  // six inputs. The same envelope builder is used by preflight tests and the
  // actual request to prevent serialization drift.
  try {
    request.onProviderAttempt?.({ provider: "gemini", model: request.model, outcome: "started", responseFormatMode: "gemini_response_json_schema" });
    const timeoutMs = Math.min(request.timeoutCapMs ?? Infinity,
      requestTimeoutMs(env.GEMINI_STRUCTURED_TIMEOUT_MS, DEFAULT_STRUCTURED_TIMEOUT_MS));
    const controller = new AbortController();
    const payload = await withinDeadline(async () => {
      const endpoint = request.apiFamily === "interactions"
        ? "v1beta/interactions"
        : `v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
      const headers = { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(env) };
      // getUrl() returns a URL; fetch(getUrl()) is NOT binding-authenticated.
      // A single universal request preserves the provider body without any
      // Gateway fallback/retry list. Never log/cache source photos or output.
      const response = env.AI && typeof env.AI.gateway === "function"
        ? await env.AI.gateway(GEMINI_GATEWAY_ID).run({
          provider: "google-ai-studio", endpoint, headers, query: envelope.body,
        }, { signal: controller.signal, gateway: {
          id: GEMINI_GATEWAY_ID, skipCache: true, collectLog: false,
          retries: { maxAttempts: 1 }, requestTimeoutMs: timeoutMs,
        } })
        : await fetch(`${GEMINI_API_BASE.replace(/\/v1beta$/, "")}/${endpoint}`, {
          method: "POST", headers, body: JSON.stringify(envelope.body), signal: controller.signal,
        });
      return parseGeminiResponse<GeminiGenerateContentResponse & GeminiInteractionResponse>(response);
    }, timeoutMs, () => new GeminiApiError("Gemini structured deadline exceeded", 504, "DEADLINE_EXCEEDED"), () => controller.abort());
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
    request.onProviderAttempt?.({ provider: "gemini", model: request.model, outcome: "completed", status: 200, responseFormatMode: "gemini_response_json_schema" });
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
    const diagnostic = geminiProviderErrorDiagnostic(error);
    const fallbackDecision = workersAiFallbackDecision(error);
    const fallbackEligible = request.allowWorkersAiFallback !== false && Boolean(env.AI) && fallbackDecision.eligible;
    const fallbackReason = request.allowWorkersAiFallback === false
      ? "fallback_disabled"
      : !env.AI
        ? "workers_ai_unconfigured"
        : fallbackDecision.reason;
    request.onProviderAttempt?.({
      provider: "gemini", model: request.model, outcome: "failed",
      responseFormatMode: "gemini_response_json_schema",
      dailyQuotaExhausted: isDailyProviderQuota(error),
      fallbackEligible, fallbackReason,
      ...(diagnostic.httpStatus !== null ? { status: diagnostic.httpStatus } : {}),
      ...(diagnostic.providerStatus !== null ? { providerStatus: diagnostic.providerStatus } : {}),
      message: diagnostic.message,
    });
    if (error instanceof GeminiApiError && !error.requestShape) error.requestShape = envelope.shape;
    if (fallbackEligible) {
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
