import { describe, expect, it } from "vitest";
import { GeminiApiError } from "../src/gemini";
import {
  classifyEvaluatorQuotaFailure,
  sanitizeEvaluatorErrorMessage,
} from "../src/evaluatorQuota";

describe("evaluator quota failure classification", () => {
  it("classifies a retry-after free-tier request fixture as a model-specific rate limit", () => {
    const failure = classifyEvaluatorQuotaFailure(new GeminiApiError(
      "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash. Please retry in 22.5s.",
      429,
      "RESOURCE_EXHAUSTED",
      22_500,
      ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"],
    ));
    expect(failure).toMatchObject({
      category: "rate_limit",
      retryable: true,
      retryAfterSeconds: 22.5,
      httpStatus: 429,
      providerCode: "RESOURCE_EXHAUSTED",
      quotaLimit: 20,
      model: "gemini-3.6-flash",
      modelSpecific: true,
    });
  });

  it("distinguishes daily and token quota fixtures", () => {
    expect(classifyEvaluatorQuotaFailure(new GeminiApiError(
      "Quota exceeded",
      429,
      "RESOURCE_EXHAUSTED",
      undefined,
      ["GenerateRequestsPerDayPerProjectPerModel-FreeTier"],
    ))).toMatchObject({ category: "daily_quota", retryable: true });
    expect(classifyEvaluatorQuotaFailure(new GeminiApiError(
      "Tokens per minute quota exceeded; retry in 8s",
      429,
      "RESOURCE_EXHAUSTED",
      8_000,
      ["GenerateContentTokensPerMinutePerProjectPerModel"],
    ))).toMatchObject({ category: "token_quota", retryable: true });
  });

  it("distinguishes a zero model quota from an unknown quota", () => {
    expect(classifyEvaluatorQuotaFailure(new GeminiApiError(
      "Quota exceeded for model: gemini-example, limit: 0",
      429,
      "RESOURCE_EXHAUSTED",
      undefined,
      ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"],
      true,
    ))).toMatchObject({ category: "model_quota", retryable: false });
    expect(classifyEvaluatorQuotaFailure(
      new Error("quota denied for an unspecified provider reason"),
    )).toMatchObject({ category: "unknown", retryable: false });
  });

  it("redacts credentials, auth headers, query keys, and source data", () => {
    const message = "x-goog-api-key: AIza123456789012345678901234567890 key=AQ.secret-value-that-must-not-leak data:image/png;base64,AAAA";
    const sanitized = sanitizeEvaluatorErrorMessage(message);
    expect(sanitized).not.toContain("AIza");
    expect(sanitized).not.toContain("AQ.secret");
    expect(sanitized).not.toContain("base64,AAAA");
    expect(sanitized).toContain("[REDACTED]");
  });
});
