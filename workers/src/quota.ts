/**
 * 프로젝트 자체 quota (Neurons/day).
 * Cloudflare 무료 한도(10,000 Neurons/day) 중 DAILY_BUDGET_RATIO(기본 0.5)만 사용한다.
 * 리셋은 Cloudflare와 동일한 00:00 UTC = 한국시간 오전 9시.
 *
 * KV 카운터는 완전한 원자성이 없지만(동시 요청 시 소량 오차 가능),
 * 한도에 여유분을 둔 소프트 리밋 용도로는 충분하다.
 */

import type { Env, QuotaStatus } from "./types";
import type { ImageModelTier } from "./skinProvider";

export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000;
const DEFAULT_BUDGET_RATIO = 0.5;

/**
 * 단계별 예상 Neurons (달러 단가 ÷ $0.011/1,000 Neurons 환산, 올림).
 *
 * 사진 분석 — llama-4-scout (24,545/M input, 77,273/M output Neurons):
 *   운영 응답의 실제 prompt/completion token usage를 아래에서 환산한다.
 * 이미지 생성 — flux-2-klein-4b ($0.000059/입력 타일, $0.000287/출력 타일, 512x512 기준):
 *   입력 타일 ≈ 5.4 → 6, 출력 타일(512x512 1장) ≈ 26.1 → 27
 */
/** Fallback accounting only when Workers AI omits token usage metadata. */
export const NEURONS_VISION_ANALYSIS = 170;
/**
 * Capacity planning uses the full 20k-character prompt, JSON schema, image
 * tokens and a potentially large structured response rather than the old
 * 4k-input/900-output assumption.
 */
export const NEURONS_VISION_ANALYSIS_ESTIMATE = 470;
export const NEURONS_VISION_DETAIL_ESTIMATE = 100;
export const NEURONS_LLAMA4_INPUT_PER_MILLION = 24_545;
export const NEURONS_LLAMA4_OUTPUT_PER_MILLION = 77_273;
export const NEURONS_IMAGE_INPUT_TILE = 6;
export const NEURONS_IMAGE_OUTPUT_TILE = 27;
/**
 * FLUX.2 Klein 9B: first output MP 1,363.64 neurons + up to roughly 0.52 MP
 * across the portrait and pose guide at 181.82 neurons/MP. Round upward so
 * the app does not promise capacity it cannot safely provide.
 */
export const NEURONS_IMAGE_GEN_QUALITY_CALL = 1_460;
/** 이미지 생성 1회 호출 — front_view 전략(사진 1장 입력 + 1024x512 정면·뒷면 출력 = 타일 2개) 기준 */
export const NEURONS_IMAGE_GEN_CALL =
  2 * NEURONS_IMAGE_INPUT_TILE + 2 * NEURONS_IMAGE_OUTPUT_TILE;

/**
 * Conservative capacity shown in the app: main photo analysis + the focused
 * upper-body detail pass used by tall full/three-quarter portraits + the
 * primary image call + one balanced recovery call. Square/close portraits or
 * first-pass image success may cost less, but promising that cheaper path
 * would overstate capacity for the requests that need recovery.
 */
export const NEURONS_PER_GENERATION_ESTIMATE =
  NEURONS_VISION_ANALYSIS_ESTIMATE +
  NEURONS_VISION_DETAIL_ESTIMATE +
  2 * NEURONS_IMAGE_GEN_CALL;

/**
 * Workers AI text responses include token usage. Convert that authoritative
 * usage to Neurons using Cloudflare's Llama 4 Scout rates. A caller-specific
 * fallback keeps mocks and provider errors accountable when metadata is
 * unavailable.
 */
export function visionNeuronsFromUsage(
  result: unknown,
  fallback: number,
): number {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return fallback;
  }
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return fallback;
  }
  const promptTokens = Number(
    (usage as { prompt_tokens?: unknown }).prompt_tokens,
  );
  const completionTokens = Number(
    (usage as { completion_tokens?: unknown }).completion_tokens,
  );
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens < 0 ||
    promptTokens + completionTokens <= 0
  ) {
    return fallback;
  }
  return Math.max(
    1,
    Math.ceil(
      (promptTokens * NEURONS_LLAMA4_INPUT_PER_MILLION +
        completionTokens * NEURONS_LLAMA4_OUTPUT_PER_MILLION) /
        1_000_000,
    ),
  );
}

export function imageGenerationNeurons(
  env: Env,
  inputTiles = 2,
  outputTiles = 2,
  modelTier: ImageModelTier =
    env.IMAGE_MODEL_TIER === "quality" ? "quality" : "balanced",
): number {
  if (modelTier === "quality") {
    return NEURONS_IMAGE_GEN_QUALITY_CALL;
  }
  return (
    inputTiles * NEURONS_IMAGE_INPUT_TILE +
    outputTiles * NEURONS_IMAGE_OUTPUT_TILE
  );
}

export function estimatedNeuronsPerGeneration(env: Env): number {
  return (
    NEURONS_VISION_ANALYSIS_ESTIMATE +
    NEURONS_VISION_DETAIL_ESTIMATE +
    imageGenerationNeurons(env) +
    NEURONS_IMAGE_GEN_CALL
  );
}

const ALMOST_THRESHOLD = 0.85;

export function dailyLimitNeurons(env: Env): number {
  const ratio = Number(env.DAILY_BUDGET_RATIO);
  const safe =
    Number.isFinite(ratio) && ratio > 0 && ratio <= 1
      ? ratio
      : DEFAULT_BUDGET_RATIO;
  return Math.floor(CLOUDFLARE_FREE_NEURONS_PER_DAY * safe);
}

/** 오늘 날짜 키 (UTC 기준 = KST 오전 9시 리셋) */
export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextResetIso(now = new Date()): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

async function getUsedNeurons(env: Env, now = new Date()): Promise<number> {
  const raw = await env.MCSKIN_KV.get(`quota:${dayKey(now)}`);
  const used = raw === null ? 0 : parseInt(raw, 10);
  return Number.isFinite(used) ? used : 0;
}

function providerClosedKey(now = new Date()): string {
  return `quota:provider-closed:${dayKey(now)}`;
}

export async function getQuotaStatus(
  env: Env,
  now = new Date(),
): Promise<QuotaStatus> {
  const limit = dailyLimitNeurons(env);
  const [used, providerClosed] = await Promise.all([
    getUsedNeurons(env, now),
    env.MCSKIN_KV.get(providerClosedKey(now)),
  ]);
  if (providerClosed !== null) {
    return {
      level: "closed",
      remainingGenerations: 0,
      resetAtIso: nextResetIso(now),
      usedRatio: 1,
      capacityBasis: "provider_reported_closed",
    };
  }
  const remaining = Math.max(0, limit - used);
  const usedRatio = Math.min(1, used / limit);
  const estimatedGenerationCost = estimatedNeuronsPerGeneration(env);
  const remainingGenerations = Math.floor(
    remaining / estimatedGenerationCost,
  );
  return {
    level:
      remaining < estimatedGenerationCost
        ? "closed"
        : usedRatio >= ALMOST_THRESHOLD
          ? "almost"
          : "available",
    remainingGenerations,
    resetAtIso: nextResetIso(now),
    usedRatio,
    capacityBasis: "local_estimate",
  };
}

/** 실제 발생한 비용(Neurons)을 커밋한다. 성공/실패와 무관하게 AI 호출이 있었으면 기록한다. */
export async function commitNeurons(env: Env, neurons: number): Promise<void> {
  if (neurons <= 0) {
    return;
  }
  const key = `quota:${dayKey()}`;
  const used = await getUsedNeurons(env);
  // 이틀치 TTL — 자정 넘어간 키는 자연 소멸
  await env.MCSKIN_KV.put(key, String(used + neurons), {
    expirationTtl: 60 * 60 * 48,
  });
}

/**
 * Cloudflare's allocation is shared outside this Worker's local estimate. If
 * the provider reports exhaustion, close the current UTC day so the app does
 * not keep accepting requests that are guaranteed to fail.
 */
export async function markProviderQuotaExhausted(
  env: Env,
  now = new Date(),
): Promise<void> {
  const resetAt = new Date(nextResetIso(now)).getTime();
  const ttlSeconds = Math.max(
    60,
    Math.ceil((resetAt - now.getTime()) / 1000) + 60,
  );
  await env.MCSKIN_KV.put(providerClosedKey(now), "1", {
    expirationTtl: ttlSeconds,
  });
}
