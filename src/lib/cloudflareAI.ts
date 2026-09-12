/**
 * Cloudflare Worker API 클라이언트.
 * AI 생성 / quota 조회 / 현황 조회 / 이벤트 트래킹.
 */

import type { GenerateResponse, QuotaStatus } from "./skinFeatures";

export const DEFAULT_API_BASE_URL =
  "https://mc-skin-creator-api.mc-skin-creator-server.workers.dev";
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
).replace(/\/$/, "");
const GENERATION_TIMEOUT_MS = 150_000;
const inFlightGenerations = new Map<string, Promise<GenerateResponse>>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: NonNullable<GenerateResponse["errorCode"]> | "network" = "network",
    readonly response?: GenerateResponse,
  ) {
    super(message);
  }
}

/** 사진 → 인물 특징 추출 (Worker가 quota 확인 + AI 호출) */
export function requestSkinGeneration(
  imageDataUrl: string,
  analysisImageDataUrl?: string,
  referenceImageDataUrls: string[] = [],
): Promise<GenerateResponse> {
  // React StrictMode remounts effects during local development. Share the same
  // in-flight request without retaining the full private photo in a Map key.
  const requestKey = `${dataFingerprint(imageDataUrl)}:${dataFingerprint(
    analysisImageDataUrl ?? "",
  )}:${referenceImageDataUrls.map(dataFingerprint).join(":")}`;
  const existing = inFlightGenerations.get(requestKey);
  if (existing) {
    return existing;
  }

  const request = performSkinGeneration(
    imageDataUrl,
    analysisImageDataUrl,
    referenceImageDataUrls,
  );
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
  referenceImageDataUrls: string[] = [],
): Promise<GenerateResponse> {
  const images = [imageDataUrl, ...(analysisImageDataUrl ? [analysisImageDataUrl] : []), ...referenceImageDataUrls];
  if (referenceImageDataUrls.length > 4 || images.some(image => !image.startsWith("data:image/") || image.length > 1_500_000)) {
    throw new ApiError("사진 크기나 개수를 확인해 주세요", "bad_request");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([readResponse(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ApiError("AI 응답이 너무 오래 걸렸어요", "network"));
      }, GENERATION_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timeout); }

  async function readResponse(): Promise<GenerateResponse> {
    let res: Response;
    try {
    res = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        image: imageDataUrl,
        ...(analysisImageDataUrl ? { analysisImage: analysisImageDataUrl } : {}),
        ...(referenceImageDataUrls.length > 0
          ? { referenceImages: referenceImageDataUrls.slice(0, 4) }
          : {}),
      }),
    });
  } catch (error) {
    throw new ApiError(
      error instanceof DOMException && error.name === "AbortError"
        ? "AI 응답이 너무 오래 걸렸어요"
        : "네트워크 연결이 불안정해요",
      "network",
    );
  }

  let body: GenerateResponse;
  try {
    body = (await res.json()) as GenerateResponse;
  } catch {
    throw new ApiError("서버 응답을 읽지 못했어요", "ai_failed");
  }

  if (!body || typeof body !== "object") throw new ApiError("잘못된 서버 응답이에요", "ai_failed");
  if (!res.ok || !body.ok) {
    throw new ApiError(
      body.error ?? "스킨 생성에 실패했어요",
      body.errorCode ?? "ai_failed",
      body,
    );
  }
  if (typeof body.skinPngBase64 !== "string" || !isSkinPngHeader(body.skinPngBase64)) {
    throw new ApiError("서버에서 유효한 스킨을 받지 못했어요", "SKIN_RENDER_FAILED", body);
  }
  return body;
  }
}

/** The preview still decodes the complete PNG; this rejects missing/wrong-size successes early. */
export function isSkinPngHeader(base64: string): boolean {
  try {
    if (base64.length > 100_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return bytes.length >= 33 && view.getUint32(0) === 0x89504e47
      && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452
      && view.getUint32(16) === 64 && view.getUint32(20) === 64;
  } catch { return false; }
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
