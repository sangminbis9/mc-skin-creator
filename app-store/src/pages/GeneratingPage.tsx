import { useEffect, useState } from "react";
import { ApiError } from "../lib/cloudflareAI";
import { generateEditableSkin, type GeneratedSkin } from "../lib/skinGeneration";

export interface GenerationFailure {
  kind: "photo" | "ai" | "network";
  message: string;
  retryable?: boolean;
}
interface Props {
  photoDataUrl: string;
  analysisPhotoDataUrl: string;
  referencePhotoDataUrls?: string[];
  onDone: (result: GeneratedSkin) => void;
  onFail: (failure: GenerationFailure) => void;
}
export function GeneratingPage({ photoDataUrl, analysisPhotoDataUrl, referencePhotoDataUrls = [], onDone, onFail }: Props) {
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
        if (error instanceof ApiError && (error.code === "photo_rejected" || error.code === "bad_request")) {
          onFail({ kind: "photo", retryable: false, message: error.code === "photo_rejected"
            ? "사진에서 인물을 인식하기 어려워요. 얼굴이 잘 보이는 사진을 선택해 주세요."
            : "사진을 읽을 수 없어요. JPG, PNG 또는 WebP 사진을 선택해 주세요." });
          return;
        }
        const isNetwork = error instanceof ApiError && error.code === "network";
        const reference = error instanceof ApiError ? error.response?.requestId?.slice(0, 8) : null;
        onFail({ kind: isNetwork ? "network" : "ai", retryable: true,
          message: (isNetwork ? "연결이 끊겼어요. 다시 시도해 주세요." : "이 사진으로 스킨을 만들지 못했어요. 다시 시도하거나 다른 사진을 선택해 주세요.") + (reference ? " 오류 번호 " + reference : "") });
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
    <p className="px-caption" style={{ textAlign: "center" }}>{seconds}초 경과 · 서버 응답이 늦으면 기기에서 기본 스킨을 만들어요.</p>
    <p className="px-caption">Once your skin is ready, explore every angle and make it your own with hair and outfit combinations.</p>
  </div>;
}
