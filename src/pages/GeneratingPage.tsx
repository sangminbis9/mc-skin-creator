/**
 * AI 생성 중 화면: 광고 + 단계별 메시지 + 진행도 바.
 * 서버에 특징 추출을 요청하고, 받은 특징으로 스킨을 만든 뒤 완료 콜백을 부른다.
 */

import { useEffect, useState } from "react";
import { AdLoadingPanel } from "../components/AdLoadingPanel";
import { PixelProgress } from "../components/pixel/PixelProgress";
import { ApiError, requestSkinGeneration } from "../lib/cloudflareAI";
import type {
  GenerateResponse,
  GenerationMode,
  QuotaStatus,
  SkinFeatures,
} from "../lib/skinFeatures";

export interface GenerationFailure {
  kind: "photo" | "ai" | "network";
  message: string;
}

export interface GenerationSuccess {
  features: SkinFeatures;
  /** 있으면 AI가 직접 생성한 스킨 — 없거나 디코딩 실패 시 features로 절차 생성 */
  skinPngBase64?: string;
  generationMode: GenerationMode;
}

interface GeneratingPageProps {
  photoDataUrl: string;
  analysisPhotoDataUrl: string;
  onDone: (result: GenerationSuccess) => void;
  onFail: (failure: GenerationFailure) => void;
  onQuotaClosed: (quota: QuotaStatus | null) => void;
}

const STAGES = [
  "사진을 분석하고 있어요",
  "얼굴 특징을 찾고 있어요",
  "머리 스타일을 반영하고 있어요",
  "마인크래프트 스킨으로 변환하고 있어요",
  "3D 미리보기를 준비하고 있어요",
  "거의 완성됐어요",
];

const PHOTO_FAIL_MESSAGES: Record<string, string> = {
  no_face: "사진에서 얼굴을 찾기 어려워요.",
  blurry: "사진이 너무 흐려요.",
  too_small: "사진 속 사람이 너무 작게 나왔어요.",
  unknown: "사진을 인식하지 못했어요.",
};

export function GeneratingPage({
  photoDataUrl,
  analysisPhotoDataUrl,
  onDone,
  onFail,
  onQuotaClosed,
}: GeneratingPageProps) {
  const [progress, setProgress] = useState(4);
  const [stageIndex, setStageIndex] = useState(0);

  // 진행도/단계 연출: API 응답 전까지 90%까지 서서히 진행
  useEffect(() => {
    const progressTimer = setInterval(() => {
      setProgress((p) => Math.min(90, p + Math.max(0.5, (90 - p) * 0.04)));
    }, 350);
    const stageTimer = setInterval(() => {
      setStageIndex((i) => Math.min(STAGES.length - 1, i + 1));
    }, 2800);
    return () => {
      clearInterval(progressTimer);
      clearInterval(stageTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await requestSkinGeneration(
          photoDataUrl,
          analysisPhotoDataUrl,
        );
        if (cancelled) {
          return;
        }
        if (import.meta.env.DEV) {
          // Keep only derived, non-image QA data in memory so local visual
          // checks can compare the model's classifications with the rendered
          // skin. Never retain either uploaded image or the generated PNG.
          Reflect.set(window, "__MC_SKIN_LAST_RESULT__", {
            analysis: response.analysis ?? null,
            features: response.features ?? null,
            generationMode: response.generationMode ?? "procedural_fallback",
          });
        }
        if (!response.features) {
          onFail({ kind: "ai", message: "AI가 스킨을 만드는 데 실패했어요." });
          return;
        }
        setProgress(100);
        setStageIndex(STAGES.length - 1);
        const result: GenerationSuccess = {
          features: response.features,
          skinPngBase64: response.skinPngBase64,
          generationMode: response.generationMode ?? "procedural_fallback",
        };
        setTimeout(() => {
          if (!cancelled) {
            onDone(result);
          }
        }, 600);
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError) {
          if (error.code === "quota_exceeded") {
            onQuotaClosed(error.response?.quota ?? null);
            return;
          }
          if (error.code === "photo_rejected") {
            const reason = error.response?.failReason ?? "unknown";
            onFail({
              kind: "photo",
              message: PHOTO_FAIL_MESSAGES[reason] ?? PHOTO_FAIL_MESSAGES.unknown,
            });
            return;
          }
          if (error.code === "network") {
            onFail({
              kind: "network",
              message: "연결이 불안정해요. 잠시 후 다시 시도해주세요.",
            });
            return;
          }
        }
        onFail({ kind: "ai", message: "AI가 스킨을 만드는 데 실패했어요." });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoDataUrl, analysisPhotoDataUrl]);

  return (
    <div className="px-screen">
      <AdLoadingPanel />

      <div className="px-spacer" />

      <div className="px-col" style={{ alignItems: "center", gap: 18 }}>
        <div className="px-jump-blocks" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
          {STAGES[stageIndex]}
        </p>
      </div>

      <PixelProgress value={progress} />
      <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
        {Math.round(progress)}%
      </p>

      <div className="px-spacer" />
    </div>
  );
}

export type { GenerateResponse };
