import { GeminiApiError, isGeminiQuotaError } from "./gemini";

export type EvaluatorQuotaCategory =
  | "rate_limit"
  | "daily_quota"
  | "token_quota"
  | "model_quota"
  | "billing"
  | "temporary_capacity"
  | "unknown";

export interface EvaluatorQuotaFailure {
  category: EvaluatorQuotaCategory;
  retryable: boolean;
  retryAfterSeconds?: number;
  httpStatus?: number;
  providerCode?: string;
  quotaIds: string[];
  quotaMetric?: string;
  quotaLimit?: number;
  model?: string;
  modelSpecific: boolean;
  projectSpecific: boolean | "unknown";
  sanitizedMessage: string;
}

const SECRET_PATTERNS = [
  /data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=\r\n]+/gi,
  /\bAIza[a-z0-9_-]{20,}\b/gi,
  /\bAQ\.[a-z0-9._-]{20,}\b/gi,
  /([?&](?:key|api_key|token)=)[^&\s]+/gi,
  /((?:x-goog-api-key|authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
] as const;

export function sanitizeEvaluatorErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (_match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return sanitized.slice(0, 2_000);
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRetryAfterSeconds(message: string): number | undefined {
  const match = /retry(?:\s+in)?\s+(\d+(?:\.\d+)?)s\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function parseQuotaMetric(message: string): string | undefined {
  return /Quota exceeded for metric:\s*([^,\r\n]+)/i.exec(message)?.[1]?.trim();
}

function parseQuotaLimit(message: string): number | undefined {
  const value = /\blimit:\s*(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  return value === undefined ? undefined : Number(value);
}

function parseModel(message: string): string | undefined {
  return /\bmodel:\s*([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/i.exec(message)?.[1];
}

export function classifyEvaluatorQuotaFailure(
  error: unknown,
): EvaluatorQuotaFailure | null {
  const rawMessage = detailOf(error);
  const sanitizedMessage = sanitizeEvaluatorErrorMessage(rawMessage);
  const apiError = error instanceof GeminiApiError ? error : undefined;
  const httpStatus = apiError?.status;
  const providerCode = apiError?.providerStatus;
  const quotaIds = apiError?.quotaIds ?? [];
  const retryAfterSeconds = apiError?.retryAfterMs !== undefined
    ? apiError.retryAfterMs / 1_000
    : parseRetryAfterSeconds(rawMessage);
  const quotaMetric = parseQuotaMetric(rawMessage);
  const quotaLimit = parseQuotaLimit(rawMessage);
  const model = parseModel(rawMessage);
  const combined = `${rawMessage} ${quotaIds.join(" ")}`.toLowerCase();

  const strongBillingSignal =
    /(?:billing (?:account )?(?:is )?(?:required|disabled|not enabled)|enable billing|payment required|paid plan required)/i;
  if (
    !isGeminiQuotaError(error) &&
    !strongBillingSignal.test(rawMessage) &&
    !/(?:capacity|overload|temporarily unavailable)/i.test(rawMessage)
  ) return null;

  let category: EvaluatorQuotaCategory = "unknown";
  if (/capacity|overload|temporarily unavailable|unavailable/.test(combined)) {
    category = "temporary_capacity";
  } else if (/token|tpm|tokensperminute|tokensperday/.test(combined)) {
    category = "token_quota";
  } else if (/perday|requestsperday|daily|rpd/.test(combined)) {
    category = "daily_quota";
  } else if (
    apiError?.hasZeroQuota ||
    quotaLimit === 0 ||
    /(?:quota(?:value)?|limit)\s*[:=]\s*0/.test(combined)
  ) {
    category = "model_quota";
  } else if (
    httpStatus === 429 ||
    providerCode === "RESOURCE_EXHAUSTED" ||
    retryAfterSeconds !== undefined ||
    /rate limit|too many requests|requestsperminute|rpm|free_tier_requests/.test(combined)
  ) {
    category = "rate_limit";
  } else if (strongBillingSignal.test(combined)) {
    category = "billing";
  }

  return {
    category,
    retryable:
      category === "rate_limit" ||
      category === "daily_quota" ||
      category === "token_quota" ||
      category === "temporary_capacity",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode ? { providerCode } : {}),
    quotaIds,
    ...(quotaMetric ? { quotaMetric } : {}),
    ...(quotaLimit !== undefined ? { quotaLimit } : {}),
    ...(model ? { model } : {}),
    modelSpecific: Boolean(model) || /model/.test(combined),
    projectSpecific: /project|consumer|project_number/.test(combined) ? true : "unknown",
    sanitizedMessage,
  };
}
