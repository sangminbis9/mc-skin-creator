/**
 * Cloudflare Worker API 클라이언트.
 * 스킨 생성 요청과 기기 내 결과 캐시.
 */

import { decodeSkinPng } from "./skinDecode";
import { normalizeFeatures, type GenerateResponse } from "./skinFeatures";

export const DEFAULT_API_BASE_URL = "";
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
).replace(/\/$/, "");
const GENERATION_TIMEOUT_MS = 150_000;
const inFlightGenerations = new Map<string, Promise<GenerateResponse>>();
// Device-local reuse: only input hashes + generated skin/editor metadata.
// Never persist photographs, requests, or analysis. Bump revision with a new
// presentation release; expiry also bounds reuse across Worker-only releases.
const completedGenerations = new Map<string, { expires: number; result: GenerateResponse }>();
const REUSE_KEY = "skin-studio-ios:completed:v3";
let reuseLoaded = false;

export function clearGenerationCache(): void {
  localStorage.removeItem(REUSE_KEY);
  localStorage.removeItem("skin-studio-ios:completed:v1");
  localStorage.removeItem("skin-studio-ios:completed:v2");
  completedGenerations.clear();
  reuseLoaded = true;
}

function loadCompletedGenerations(): void {
  if (reuseLoaded) return;
  reuseLoaded = true;
  try {
    const raw = localStorage.getItem(REUSE_KEY);
    if (!raw || raw.length > 1_000_000) return;
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 8) return;
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const { key, expires, png, features, mode } = item;
      if (typeof key !== "string" || !/^[a-f0-9]{64}(?::[a-f0-9]{64}){1,5}$/.test(key)
        || typeof expires !== "number" || expires <= Date.now() || expires > Date.now() + 86_400_000
        || typeof png !== "string" || !isSkinPngHeader(png)
        || (mode !== "procedural_fallback" && mode !== "image")) continue;
      completedGenerations.set(key, { expires, result: { ok: true, skinPngBase64: png,
        features: normalizeFeatures(features && typeof features === "object" ? features : {}), generationMode: mode } });
    }
  } catch { /* Storage can be unavailable in a restricted WebView. */ }
}

function persistCompletedGenerations(): void {
  try {
    localStorage.setItem(REUSE_KEY, JSON.stringify([...completedGenerations].map(([key, entry]) => ({
      key, expires: entry.expires, png: entry.result.skinPngBase64,
      features: entry.result.features, mode: entry.result.generationMode,
    }))));
  } catch { /* A storage failure must never discard a successfully rendered skin. */ }
}

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
export async function requestSkinGeneration(
  imageDataUrl: string,
  analysisImageDataUrl?: string,
  referenceImageDataUrls: string[] = [],
): Promise<GenerateResponse> {
  // React StrictMode remounts effects during local development. Share the same
  // in-flight request without retaining the full private photo in a Map key.
  const values = [imageDataUrl, analysisImageDataUrl ?? "", ...referenceImageDataUrls];
  if (referenceImageDataUrls.length > 4 || values.some(v => v.length > 1_500_000))
    throw new ApiError("사진 크기나 개수를 확인해 주세요", "bad_request");
  const requestKey = await generationKey(values);
  if (!requestKey) return performSkinGeneration(imageDataUrl, analysisImageDataUrl, referenceImageDataUrls);
  loadCompletedGenerations();
  for (const [key, entry] of completedGenerations) if (entry.expires <= Date.now()) completedGenerations.delete(key);
  const completed = completedGenerations.get(requestKey);
  if (completed) {
    const png = completed.result.skinPngBase64;
    if (png && await decodeSkinPng(png)) return copyResponse(completed.result);
    // Older releases could cache a PNG whose header was valid but whose data was not.
    if (completedGenerations.get(requestKey) === completed) {
      completedGenerations.delete(requestKey);
      persistCompletedGenerations();
    }
  }
  const existing = inFlightGenerations.get(requestKey);
  if (existing) {
    return copyResponse(await existing);
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
  try {
    const result = await request;
    // A truncated PNG can have a valid header. Keep it out of the reuse cache.
    if (result.skinPngBase64 && await decodeSkinPng(result.skinPngBase64)) {
      const saved = copyResponse(result);
      delete saved.quota;
      delete saved.analysis;
      if (completedGenerations.size >= 8) completedGenerations.delete(completedGenerations.keys().next().value!);
      completedGenerations.set(requestKey, { expires: Date.now() + 24 * 60 * 60 * 1000, result: saved });
      persistCompletedGenerations();
    }
    return copyResponse(result);
  } finally { clearRequest(); }
}

function copyResponse(response: GenerateResponse): GenerateResponse {
  // Responses are JSON. Older iOS WebViews may lack structuredClone.
  return JSON.parse(JSON.stringify(response)) as GenerateResponse;
}

async function generationKey(values: string[]): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const hashes = await Promise.all(values.map(async value => {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
    }));
    return hashes.join(":");
  } catch {
    return null;
  }
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
        cache: "no-store",
        body: JSON.stringify({
          image: imageDataUrl,
          ...(analysisImageDataUrl ? { analysisImage: analysisImageDataUrl } : {}),
          ...(referenceImageDataUrls.length ? { referenceImages: referenceImageDataUrls } : {}),
        }),
      });
    } catch (error) {
      throw new ApiError(
        error instanceof DOMException && error.name === "AbortError"
          ? "AI 응답이 너무 오래 걸렸어요"
          : "네트워크 연결이 끊겼어요",
        "network",
      );
    }

    let body: GenerateResponse;
    try {
      body = (await res.json()) as GenerateResponse;
    } catch {
      throw new ApiError("서버 응답을 읽지 못했어요", res.status === 429 ? "rate_limited" : "provider_unavailable");
    }

    if (!body || typeof body !== "object") throw new ApiError("잘못된 서버 응답이에요", "ai_failed");
    if (!res.ok || body.ok !== true) {
      throw new ApiError(body.error ?? "서버에서 스킨을 만들지 못했어요", body.errorCode ?? "ai_failed", body);
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
