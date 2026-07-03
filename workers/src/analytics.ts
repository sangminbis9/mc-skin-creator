/**
 * 일별 운영 지표 카운터 (KV).
 * 공개 대시보드(/api/stats)에 노출되는 값만 저장한다 —
 * IP, 이미지, 에러 스택 같은 민감 정보는 절대 저장하지 않는다.
 */

import { dayKey } from "./quota";
import type { Env } from "./types";

export const METRICS = [
  "attempts",
  "successes",
  "failures",
  "ad_impression",
  "share_click",
  "share_link",
  "download",
] as const;

export type Metric = (typeof METRICS)[number];

export async function bumpMetric(env: Env, metric: Metric): Promise<void> {
  const key = `stats:${dayKey()}:${metric}`;
  const raw = await env.MCSKIN_KV.get(key);
  const current = raw === null ? 0 : parseInt(raw, 10) || 0;
  await env.MCSKIN_KV.put(key, String(current + 1), {
    expirationTtl: 60 * 60 * 48,
  });
}

export async function getMetric(env: Env, metric: Metric): Promise<number> {
  const raw = await env.MCSKIN_KV.get(`stats:${dayKey()}:${metric}`);
  return raw === null ? 0 : parseInt(raw, 10) || 0;
}
