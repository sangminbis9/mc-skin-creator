import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageProvider";
import type { MessageKey } from "../i18n/messages";
import { ApiError } from "../lib/cloudflareAI";
import { generateEditableSkin, type GeneratedSkin } from "../lib/skinGeneration";

export interface GenerationFailure {
  kind: "photo" | "ai" | "network" | "quota";
  message: MessageKey;
  reference?: string;
  retryable?: boolean;
  resetAtIso?: string;
}
interface Props {
  photoDataUrl: string;
  analysisPhotoDataUrl: string;
  referencePhotoDataUrls?: string[];
  onDone: (result: GeneratedSkin) => void;
  onFail: (failure: GenerationFailure) => void;
}
export function GeneratingPage({ photoDataUrl, analysisPhotoDataUrl, referencePhotoDataUrls = [], onDone, onFail }: Props) {
  const { t } = useLanguage();
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
        const result = await generateEditableSkin(photoDataUrl, analysisPhotoDataUrl, JSON.parse(referenceKey));
        if (!cancelled) onDone(result);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === "quota_exceeded") {
          onFail({ kind: "quota", retryable: false, message: "failure.quotaMessage",
            resetAtIso: error.response?.quota?.level === "closed" ? error.response.quota.resetAtIso : undefined });
          return;
        }
        if (error instanceof ApiError && (error.code === "photo_rejected" || error.code === "bad_request")) {
          onFail({ kind: "photo", retryable: false, message: error.code === "photo_rejected"
            ? "generation.photoRejected"
            : "generation.badPhoto" });
          return;
        }
        const isNetwork = error instanceof ApiError && error.code === "network";
        const reference = error instanceof ApiError ? error.response?.requestId?.slice(0, 8) : null;
        onFail({ kind: isNetwork ? "network" : "ai", retryable: true,
          message: isNetwork ? "generation.networkMessage" : "generation.failedMessage", reference: reference ?? undefined });
      }
    })();
    return () => { cancelled = true; };
    // callbacks are controlled by the parent flow; don't resubmit on a parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoDataUrl, analysisPhotoDataUrl, referenceKey]);
  return <div className="px-screen px-screen--center">
    <h1 className="px-title">{t("generation.title")}<br />{t("generation.titleAccent")}</h1>
    <p className="px-subtitle">{t("generation.subtitle")}</p>
    <div className="studio-status" role="status">
      <div className="px-jump-blocks" aria-hidden="true"><span /><span /><span /></div>
      <p>{seconds >= 30 ? t("generation.waiting") : t("generation.working")}</p>
    </div>
    <p className="px-caption" style={{ textAlign: "center" }}>{t("generation.elapsed", { seconds })}</p>
    <p className="px-caption">{t("generation.next")}</p>
  </div>;
}
