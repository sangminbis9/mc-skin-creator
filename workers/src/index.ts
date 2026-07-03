/**
 * mc-skin-creator API Worker.
 *
 * POST /api/generate  사진 분석 → 인물 특징 JSON (quota 확인/차감 포함)
 * GET  /api/quota     오늘 생성 가능 상태
 * GET  /api/stats     공개 현황판 데이터 (조회 전용)
 * POST /api/track     이벤트 카운트 (광고 노출/공유/다운로드)
 */

import { bumpMetric, getMetric, METRICS, type Metric } from "./analytics";
import { analyzePhoto } from "./generate";
import { commitGenerationCost, dayKey, getQuotaStatus } from "./quota";
import type { Env } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/quota" && request.method === "GET") {
        return json(await getQuotaStatus(env));
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        return json(await getStats(env));
      }

      if (url.pathname === "/api/track" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          event?: string;
        };
        const event = trackableMetric(body.event);
        if (event) {
          await bumpMetric(env, event);
        }
        return json({ ok: true });
      }

      if (url.pathname === "/api/generate" && request.method === "POST") {
        return handleGenerate(request, env);
      }
    } catch {
      // 내부 에러 상세는 노출하지 않는다
      return json(
        { ok: false, error: "서버 오류가 발생했어요", errorCode: "ai_failed" },
        500,
      );
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  await bumpMetric(env, "attempts");

  // 1) quota 확인 — 소진이면 AI 호출 전에 차단
  const quota = await getQuotaStatus(env);
  if (quota.level === "closed") {
    await bumpMetric(env, "failures");
    return json(
      {
        ok: false,
        error: "오늘의 생성 수량이 마감됐어요",
        errorCode: "quota_exceeded",
        quota,
      },
      429,
    );
  }

  // 2) 요청 파싱
  const body = (await request.json().catch(() => null)) as {
    image?: string;
  } | null;
  if (!body?.image) {
    await bumpMetric(env, "failures");
    return json(
      { ok: false, error: "이미지가 없어요", errorCode: "bad_request" },
      400,
    );
  }

  // 3) AI 분석 (사진은 이 요청 스코프 안에서만 사용, 저장하지 않음)
  const result = await analyzePhoto(env, body.image);

  // 4) 성공한 생성만 quota 차감
  if (result.charge) {
    await commitGenerationCost(env);
  }
  await bumpMetric(env, result.success ? "successes" : "failures");

  return json({ ...result.body, quota: await getQuotaStatus(env) }, result.status);
}

function trackableMetric(event: string | undefined): Metric | null {
  // 클라이언트가 직접 올릴 수 있는 이벤트만 허용
  const allowed: Metric[] = ["ad_impression", "share_click", "share_link", "download"];
  return allowed.includes(event as Metric) ? (event as Metric) : null;
}

async function getStats(env: Env) {
  const values = await Promise.all(METRICS.map((metric) => getMetric(env, metric)));
  const byMetric = Object.fromEntries(
    METRICS.map((metric, i) => [metric, values[i]]),
  ) as Record<Metric, number>;

  return {
    date: dayKey(),
    attempts: byMetric.attempts,
    successes: byMetric.successes,
    failures: byMetric.failures,
    adImpressions: byMetric.ad_impression,
    shareClicks: byMetric.share_click,
    shareLinks: byMetric.share_link,
    downloads: byMetric.download,
    quota: await getQuotaStatus(env),
  };
}
