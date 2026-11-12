import { useEffect, useState } from "react";
import { ApiError, requestSkinGeneration } from "../lib/cloudflareAI";
import { normalizeFeatures } from "../lib/skinFeatures";
import type { GenerationMode, QuotaStatus, SkinFeatures } from "../lib/skinFeatures";

export interface GenerationFailure {
  kind: "photo" | "ai" | "network";
  message: string;
  retryable?: boolean;
}
export interface GenerationSuccess {
  features: SkinFeatures;
  skinPngBase64?: string;
  generationMode: GenerationMode;
}
interface Props {
  photoDataUrl: string;
  analysisPhotoDataUrl: string;
  referencePhotoDataUrls?: string[];
  onDone: (result: GenerationSuccess) => void | Promise<void>;
  onFail: (failure: GenerationFailure) => void;
  onQuotaClosed: (quota: QuotaStatus | null) => void;
}
export function GeneratingPage({ photoDataUrl, analysisPhotoDataUrl, referencePhotoDataUrls = [], onDone, onFail, onQuotaClosed }: Props) {
  const [seconds, setSeconds] = useState(0);
  const referenceKey = JSON.stringify(referencePhotoDataUrls);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(s => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await requestSkinGeneration(photoDataUrl, analysisPhotoDataUrl, JSON.parse(referenceKey));
        if (!cancelled) await onDone({
          features: normalizeFeatures(result.features ?? {}),
          skinPngBase64: result.skinPngBase64,
          generationMode: result.generationMode ?? "procedural_fallback",
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === "quota_exceeded") {
          onQuotaClosed(error.response?.quota ?? null); return;
        }
        if (error instanceof ApiError && error.code === "photo_rejected") {
          onFail({ kind: "photo", retryable: false, message: "We couldn't confidently read the person in this photo. Try a clear face photo with even lighting." }); return;
        }
        const isNetwork = error instanceof ApiError && error.code === "network";
        const reference = error instanceof ApiError ? error.response?.requestId?.slice(0, 8) : null;
        onFail({ kind: isNetwork ? "network" : "ai", retryable: true,
          message: (isNetwork ? "The request timed out or the connection was interrupted. Please check your connection." : "The AI service could not complete this request. Please try again shortly.") + (reference ? " Reference: " + reference : "") });
      }
    })();
    return () => { cancelled = true; };
    // callbacks are controlled by the parent flow; don't resubmit on a parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoDataUrl, analysisPhotoDataUrl, referenceKey]);
  return <div className="px-screen px-screen--center">
    <h1 className="px-title">A new world.<br />Still you.</h1>
    <p className="px-subtitle">The AI is analyzing your photos and the renderer is building your skin.</p>
    <div className="studio-status" role="status">
      <div className="px-jump-blocks" aria-hidden="true"><span /><span /><span /></div>
      <p>{seconds >= 30 ? "Still working. Please keep this tab open." : "Generating your 64×64 skin…"}</p>
    </div>
    <p className="px-caption" style={{ textAlign: "center" }}>{seconds}s elapsed · This may take up to 150 seconds.</p>
    <p className="px-caption">Once your skin is ready, explore every angle and make it your own with hair and outfit combinations.</p>
  </div>;
}
