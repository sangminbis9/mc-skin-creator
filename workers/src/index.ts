/**
 * mc-skin-creator API Worker.
 *
 * POST /api/generate  사진 분석 → 인물 특징 JSON (quota 확인/차감 포함)
 * GET  /api/quota     오늘 생성 가능 상태
 * GET  /api/stats     공개 현황판 데이터 (조회 전용)
 * POST /api/track     이벤트 카운트 (광고 노출/공유/다운로드)
 */

import { bumpMetric, getMetric, METRICS, type Metric } from "./analytics";
import { generateSkin, MAX_IMAGE_CHARS } from "./generate";
import { withinDeadline } from "./deadline";
import {
  commitNeurons,
  dayKey,
  getQuotaStatus,
  markProviderQuotaExhausted,
} from "./quota";
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
    const requestId = crypto.randomUUID();
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
        return await handleGenerate(request, env, requestId);
      }
    } catch (error) {
      await persistFailureDiagnostic(env, {
        requestId,
        phase: "route",
        detail: errorDetail(error),
      });
      // 내부 에러 상세는 노출하지 않는다
      return json(
        {
          ok: false,
          error: "서버 오류가 발생했어요",
          errorCode: "ai_failed",
          requestId,
        },
        500,
      );
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleGenerate(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  await advisory(() => bumpMetric(env, "attempts"));

  // 1) quota 확인 — 소진이면 AI 호출 전에 차단
  // Fail closed if the required quota check is unavailable, but bound it.
  // Accounting AFTER a completed render is advisory and cannot discard it.
  const quota = await withinDeadline(() => getQuotaStatus(env), 2000,
    () => new Error("Quota check deadline"));
  if (quota.level === "closed") {
    await advisory(() => bumpMetric(env, "failures"));
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
  const body = (await readGenerationBody(request).catch(() => null)) as {
    image?: string;
    analysisImage?: string;
    referenceImages?: string[];
  } | null;
  if (!body || typeof body.image !== "string"
    || (body.analysisImage !== undefined && typeof body.analysisImage !== "string")
    || (body.referenceImages !== undefined && (!Array.isArray(body.referenceImages)
      || body.referenceImages.length > 4 || body.referenceImages.some(item => typeof item !== "string")))) {
    await advisory(() => bumpMetric(env, "failures"));
    return json(
      { ok: false, error: "이미지가 없어요", errorCode: "bad_request" },
      400,
    );
  }

  // 3) 분석 + 스킨 생성 (사진은 이 요청 스코프 안에서만 사용, 저장하지 않음)
  let result;
  try {
    result = await generateSkin(
      { ...env, SYNCHRONOUS_ENHANCEMENTS_ENABLED: "false" },
      body.image,
      undefined,
      body.analysisImage,
      body.referenceImages,
    );
  } catch (error) {
    await advisory(() => bumpMetric(env, "failures"));
    await persistFailureDiagnostic(env, {
      requestId,
      phase: "generation",
      detail: errorDetail(error),
    });
    return json(
      {
        ok: false,
        error: "AI가 스킨을 만드는 데 실패했어요",
        errorCode: "ai_failed",
        requestId,
      },
      500,
    );
  }

  // 4) 실제 소비한 Neurons를 커밋 (실패한 호출의 비용도 실제로 발생하므로 기록)
  await advisory(async () => {
  await commitNeurons(env, result.neuronsSpent);
  // Only close the whole app when the required analysis model is exhausted.
  // Image generation and critique are optional enhancement stages; if either
  // has no quota, the validated procedural fallback must remain available.
  if (result.body.errorCode === "quota_exceeded") {
    await markProviderQuotaExhausted(env);
  }
  await bumpMetric(env, result.success ? "successes" : "failures");
  if (result.success && result.body.generationMode) {
    await bumpMetric(
      env,
      result.body.generationMode === "image" ? "gen_image" : "gen_fallback",
    );
  }
  });

  return json(
    { ...result.body, quota: await advisory(() => getQuotaStatus(env)) ?? quota, requestId },
    result.status,
  );
}

function errorDetail(error: unknown): string {
  // Arbitrary provider errors may echo a request or credential. Persist only
  // the error class here; primary analysis has its own allowlisted diagnostics.
  return error instanceof Error && /^(Error|TypeError|GeminiApiError)$/.test(error.name)
    ? error.name : "Operation failed";
}

async function advisory<T>(operation: () => Promise<T>): Promise<T | undefined> {
  return withinDeadline(operation, 1000, () => new Error("Advisory deadline")).catch(() => undefined);
}

/** Six data URLs: primary 448px + primary 896px + four references (<9.01MB). */
async function readGenerationBody(request: Request): Promise<unknown> {
  const limit = 6 * MAX_IMAGE_CHARS + 1024;
  if (Number(request.headers.get("content-length")) > limit || !request.body) return null;
  const reader = request.body.getReader();
  return withinDeadline(async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) return null;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { void reader.cancel().catch(() => undefined); }
  }, 10_000, () => new Error("Upload deadline"), () => { void reader.cancel().catch(() => undefined); });
}

async function persistFailureDiagnostic(
  env: Env,
  diagnostic: { requestId: string; phase: string; detail: string },
): Promise<void> {
  await advisory(() => env.MCSKIN_KV.put(
    "diagnostic:last-generation-failure",
    JSON.stringify({ at: new Date().toISOString(), ...diagnostic }),
    { expirationTtl: 60 * 60 * 48 },
  ));
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
    genImage: byMetric.gen_image,
    genFallback: byMetric.gen_fallback,
    adImpressions: byMetric.ad_impression,
    shareClicks: byMetric.share_click,
    shareLinks: byMetric.share_link,
    downloads: byMetric.download,
    quota: await getQuotaStatus(env),
  };
}
