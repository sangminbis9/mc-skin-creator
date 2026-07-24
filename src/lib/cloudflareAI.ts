/**
 * Cloudflare Worker API 클라이언트.
 * AI 생성 / quota 조회 / 현황 조회 / 이벤트 트래킹.
 */

import type { GenerateResponse, QuotaStatus } from "./skinFeatures";

export const DEFAULT_API_BASE_URL =
  "https://mc-skin-creator-api.parkingnav.workers.dev";
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
).replace(/\/$/, "");
const GENERATION_TIMEOUT_MS = 150_000;
const inFlightGenerations = new Map<string, Promise<GenerateResponse>>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code:
      | "quota_exceeded"
      | "photo_rejected"
      | "ai_failed"
      | "network"
      | "bad_request" = "network",
    readonly response?: GenerateResponse,
  ) {
    super(message);
  }
}

/** 사진 → 인물 특징 추출 (Worker가 quota 확인 + AI 호출) */
export function requestSkinGeneration(
  imageDataUrl: string,
  analysisImageDataUrl?: string,
): Promise<GenerateResponse> {
  // React StrictMode remounts effects during local development. Share the same
  // in-flight request without retaining the full private photo in a Map key.
  const requestKey = `${dataFingerprint(imageDataUrl)}:${dataFingerprint(
    analysisImageDataUrl ?? "",
  )}`;
  const existing = inFlightGenerations.get(requestKey);
  if (existing) {
    return existing;
  }

  const request = performSkinGeneration(imageDataUrl, analysisImageDataUrl);
  inFlightGenerations.set(requestKey, request);
  const clearRequest = () => {
    if (inFlightGenerations.get(requestKey) === request) {
      inFlightGenerations.delete(requestKey);
    }
  };
  request.then(clearRequest, clearRequest);
  return request;
}

function dataFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  }
  return `${value.length}-${(hash >>> 0).toString(16)}`;
}

async function performSkinGeneration(
  imageDataUrl: string,
  analysisImageDataUrl?: string,
): Promise<GenerateResponse> {
  let res: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    GENERATION_TIMEOUT_MS,
  );
  try {
    res = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        image: imageDataUrl,
        ...(analysisImageDataUrl ? { analysisImage: analysisImageDataUrl } : {}),
      }),
    });
  } catch (error) {
    throw new ApiError(
      error instanceof DOMException && error.name === "AbortError"
        ? "AI 응답이 너무 오래 걸렸어요"
        : "네트워크 연결이 불안정해요",
      "network",
    );
  } finally {
    window.clearTimeout(timeout);
  }

  let body: GenerateResponse;
  try {
    body = (await res.json()) as GenerateResponse;
  } catch {
    throw new ApiError("서버 응답을 읽지 못했어요", "ai_failed");
  }

  if (!res.ok || !body.ok) {
    throw new ApiError(
      body.error ?? "스킨 생성에 실패했어요",
      body.errorCode ?? "ai_failed",
      body,
    );
  }
  return body;
}

export async function fetchQuotaStatus(): Promise<QuotaStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/quota`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as QuotaStatus;
  } catch {
    return null;
  }
}

export interface DailyStats {
  date: string;
  attempts: number;
  successes: number;
  failures: number;
  adImpressions: number;
  shareClicks: number;
  shareLinks: number;
  downloads: number;
  quota: QuotaStatus;
}

export async function fetchDailyStats(): Promise<DailyStats | null> {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as DailyStats;
  } catch {
    return null;
  }
}

export type TrackEvent =
  | "ad_impression"
  | "share_click"
  | "share_link"
  | "download";

/** fire-and-forget 이벤트 카운트 */
export function trackEvent(event: TrackEvent): void {
  fetch(`${API_BASE}/api/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => {
    // 트래킹 실패는 무시
  });
}
