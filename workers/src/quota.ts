/**
 * 프로젝트 자체 quota: 5,000 Neurons/day.
 * Cloudflare 무료 한도(10,000 Neurons/day)와 겹치지 않도록 절반만 사용한다.
 * 리셋은 Cloudflare와 동일한 00:00 UTC = 한국시간 오전 9시.
 *
 * KV 카운터는 완전한 원자성이 없지만(동시 요청 시 소량 오차 가능),
 * 한도에 여유분을 둔 소프트 리밋 용도로는 충분하다.
 */

import type { Env, QuotaStatus } from "./types";

export const DAILY_LIMIT_NEURONS = 5000;
/** 생성 1회당 예상 Neurons (llama-4-scout 1회 호출, 보수적 추정치: 입력 ~2.5k 토큰 + 출력 ~300 토큰) */
export const COST_PER_GENERATION = 75;

const ALMOST_THRESHOLD = 0.85;

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
  const used = await getUsedNeurons(env);
  const remaining = Math.max(0, DAILY_LIMIT_NEURONS - used);
  const usedRatio = Math.min(1, used / DAILY_LIMIT_NEURONS);
  const remainingGenerations = Math.floor(remaining / COST_PER_GENERATION);
  return {
    level:
      remaining < COST_PER_GENERATION
        ? "closed"
        : usedRatio >= ALMOST_THRESHOLD
          ? "almost"
          : "available",
    remainingGenerations,
    resetAtIso: nextResetIso(),
    usedRatio,
  };
}

/** 생성 성공 후 사용량 커밋 (실패한 요청은 차감하지 않는다) */
export async function commitGenerationCost(env: Env): Promise<void> {
  const key = `quota:${dayKey()}`;
  const used = await getUsedNeurons(env);
  // 이틀치 TTL — 자정 넘어간 키는 자연 소멸
  await env.MCSKIN_KV.put(key, String(used + COST_PER_GENERATION), {
    expirationTtl: 60 * 60 * 48,
  });
}
