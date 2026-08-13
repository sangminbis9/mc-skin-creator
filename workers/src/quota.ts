/**
 * Gemini quota의 보수적 로컬 관측치.
 * 기존 API/저장 키 호환성을 위해 단위 이름은 Neurons를 유지하지만, 현재 값은
 * Gemini 토큰 및 이미지 호출을 비교 가능한 상대 사용량으로 환산한 추정치다.
 * DAILY_BUDGET_RATIO는 사용률 표시용 분모이며 생성 요청을 미리 차단하지 않는다.
 * Gemini 일일 요청 한도는 공식 정책대로 미국 Pacific 자정에 리셋된다.
 *
 * KV 카운터는 실제 Google 프로젝트 한도와 다를 수 있다. 따라서 Gemini가
 * 필수 분석 모델의 실제 quota exhaustion을 반환한 뒤에만 당일 회로를 닫는다.
 */

import type { Env, QuotaStatus } from "./types";
import type { ImageModelTier } from "./skinProvider";

export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000;
const DEFAULT_BUDGET_RATIO = 0.5;

/**
 * 단계별 상대 사용량 상수. 공급자별 quota는 모델·프로젝트·결제 상태에 따라
 * 달라지므로 이 값들은 UI 추정 전용이며 요청 허용 여부를 결정하지 않는다.
 */
/** Gemini 응답에 토큰 사용량이 없을 때의 보수적 폴백 추정치. */
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
 * Quality-tier Gemini image call weight. It is deliberately larger than a
 * balanced call so the advisory meter reserves room for expensive retries.
 */
export const NEURONS_IMAGE_GEN_QUALITY_CALL = 1_460;
/** 균형형 이미지 생성 1회 호출의 상대 사용량(입력/출력 이미지 단위 기준). */
export const NEURONS_IMAGE_GEN_CALL =
  2 * NEURONS_IMAGE_INPUT_TILE + 2 * NEURONS_IMAGE_OUTPUT_TILE;

/**
 * Conservative capacity shown in the app: main photo analysis + the combined
 * portrait/hair/neck detail pass used by tall photos + the
 * primary image call + one balanced recovery call. Quality mode also reserves
 * one same-tier retry for a moderation/provider failure that may already have
 * consumed inference capacity. Square/close portraits or first-pass success
 * may cost less, but promising that cheaper path would overstate capacity.
 */
export const NEURONS_PER_GENERATION_ESTIMATE =
  NEURONS_VISION_ANALYSIS_ESTIMATE +
  NEURONS_VISION_DETAIL_ESTIMATE +
  2 * NEURONS_IMAGE_GEN_CALL;

/**
 * Gemini text 응답의 토큰 사용량을 기존 로컬 계량 단위로 환산한다. 이 값은
 * Google 청구 단위가 아니며, 호출 간 상대 비용과 UI 사용률을 위한 추정치다.
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
  modelTier: ImageModelTier = env.IMAGE_MODEL_TIER === "quality"
    ? "quality"
    : "balanced",
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
  const configuredTier: ImageModelTier =
    env.IMAGE_MODEL_TIER === "quality" ? "quality" : "balanced";
  return (
    NEURONS_VISION_ANALYSIS_ESTIMATE +
    NEURONS_VISION_DETAIL_ESTIMATE +
    imageGenerationNeurons(env, 2, 2, configuredTier) +
    (configuredTier === "quality" ? NEURONS_IMAGE_GEN_QUALITY_CALL : 0) +
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

const PROVIDER_TIME_ZONE = "America/Los_Angeles";

function providerDateParts(now: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PROVIDER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** 오늘 날짜 키 (Gemini 제공자 기준: America/Los_Angeles). */
export function dayKey(now = new Date()): string {
  const { year, month, day } = providerDateParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextResetIso(now = new Date()): string {
  const current = providerDateParts(now);
  const nextCalendar = new Date(
    Date.UTC(current.year, current.month - 1, current.day + 1),
  );
  const desired = Date.UTC(
    nextCalendar.getUTCFullYear(),
    nextCalendar.getUTCMonth(),
    nextCalendar.getUTCDate(),
  );
  // Pacific midnight is 07:00Z or 08:00Z. Iterate against Intl so DST
  // transitions are handled without hard-coding either offset.
  let guess = desired + 8 * 60 * 60 * 1000;
  for (let iteration = 0; iteration < 3; iteration++) {
    const seen = providerDateParts(new Date(guess));
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    guess += desired - seenAsUtc;
  }
  return new Date(guess).toISOString();
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
  // Local accounting is deliberately advisory. On a dedicated free account,
  // rejecting a request merely because the pessimistic worst-case retry cost
  // does not fit wastes usable provider capacity. Keep offering one attempt
  // until Gemini itself reports project-level quota exhaustion.
  const remainingGenerations = Math.max(
    1,
    Math.floor(remaining / estimatedGenerationCost),
  );
  return {
    level: usedRatio >= ALMOST_THRESHOLD ? "almost" : "available",
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
 * Gemini project allocation is external to this Worker's local estimate. If
 * the provider reports daily exhaustion for required analysis, close the
 * current provider day so the app does not accept guaranteed-to-fail requests.
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
