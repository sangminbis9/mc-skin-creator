/**
 * 프로젝트 자체 quota (Neurons/day).
 * Cloudflare 무료 한도(10,000 Neurons/day) 중 DAILY_BUDGET_RATIO(기본 0.5)만 사용한다.
 * 리셋은 Cloudflare와 동일한 00:00 UTC = 한국시간 오전 9시.
 *
 * KV 카운터는 완전한 원자성이 없지만(동시 요청 시 소량 오차 가능),
 * 한도에 여유분을 둔 소프트 리밋 용도로는 충분하다.
 */

import type { Env, QuotaStatus } from "./types";

export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000;
const DEFAULT_BUDGET_RATIO = 0.5;

/**
 * 단계별 예상 Neurons (달러 단가 ÷ $0.011/1,000 Neurons 환산, 올림).
 *
 * 사진 분석 — llama-4-scout ($0.27/M in, $0.85/M out):
 *   입력(이미지 토큰 + 프롬프트) ~4k tok ≈ 98 + 출력(분석 JSON) ~900 tok ≈ 70
 * 이미지 생성 — flux-2-klein-4b ($0.000059/입력 타일, $0.000287/출력 타일, 512x512 기준):
 *   입력 타일 ≈ 5.4 → 6, 출력 타일(512x512 1장) ≈ 26.1 → 27
 */
export const NEURONS_VISION_ANALYSIS = 170;
export const NEURONS_IMAGE_INPUT_TILE = 6;
export const NEURONS_IMAGE_OUTPUT_TILE = 27;
/** 이미지 생성 1회 호출 — front_view 전략(사진 1장 입력 + 1024x512 정면·뒷면 출력 = 타일 2개) 기준 */
export const NEURONS_IMAGE_GEN_CALL =
  NEURONS_IMAGE_INPUT_TILE + 2 * NEURONS_IMAGE_OUTPUT_TILE;

/** quota 남은 횟수 표시용 — 분석 1회 + 이미지 생성 1회 (재시도 없는 정상 경로) */
export const NEURONS_PER_GENERATION_ESTIMATE =
  NEURONS_VISION_ANALYSIS + NEURONS_IMAGE_GEN_CALL;

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

async function getUsedNeurons(env: Env): Promise<number> {
  const raw = await env.MCSKIN_KV.get(`quota:${dayKey()}`);
  const used = raw === null ? 0 : parseInt(raw, 10);
  return Number.isFinite(used) ? used : 0;
}

export async function getQuotaStatus(env: Env): Promise<QuotaStatus> {
  const limit = dailyLimitNeurons(env);
  const used = await getUsedNeurons(env);
  const remaining = Math.max(0, limit - used);
  const usedRatio = Math.min(1, used / limit);
  const remainingGenerations = Math.floor(
    remaining / NEURONS_PER_GENERATION_ESTIMATE,
  );
  return {
    level:
      remaining < NEURONS_PER_GENERATION_ESTIMATE
        ? "closed"
        : usedRatio >= ALMOST_THRESHOLD
          ? "almost"
          : "available",
    remainingGenerations,
    resetAtIso: nextResetIso(),
    usedRatio,
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
