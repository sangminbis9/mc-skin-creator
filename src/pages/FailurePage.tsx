/**
 * 생성 실패 화면: 실패 이유를 먼저 안내하고 다시 시도 버튼 제공.
 */

import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { GenerationFailure } from "./GeneratingPage";

interface FailurePageProps {
  failure: GenerationFailure;
  onRetry: () => void;
  onReselect: () => void;
}

const KIND_TITLES: Record<GenerationFailure["kind"], string> = {
  photo: "사진에 문제가 있어요",
  ai: "생성에 실패했어요",
  network: "연결이 불안정해요",
};

const KIND_ICONS: Record<GenerationFailure["kind"], string> = {
  photo: "📷",
  ai: "🤖",
  network: "📡",
};

export function FailurePage({ failure, onRetry, onReselect }: FailurePageProps) {
  const isPhotoProblem = failure.kind === "photo";

  return (
    <div className="px-screen px-screen--center">
      <div style={{ textAlign: "center", fontSize: 44 }} aria-hidden="true">
        {KIND_ICONS[failure.kind]}
      </div>
      <h1 className="px-title" style={{ textAlign: "center" }}>
        {KIND_TITLES[failure.kind]}
      </h1>

      <PixelPanel>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.8 }}>
          {failure.message}
        </p>
        {isPhotoProblem && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            얼굴이 크고 선명하게 나온 사진일수록 결과가 좋아요.
          </p>
        )}
        {failure.kind !== "photo" && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            같은 사진으로 다시 시도하거나 다른 사진을 선택할 수 있어요.
          </p>
        )}
      </PixelPanel>

      {isPhotoProblem ? (
        <>
          <PixelButton onClick={onReselect}>다른 사진 올리기</PixelButton>
          <PixelButton variant="ghost" onClick={onRetry}>
            같은 사진으로 다시 시도
          </PixelButton>
        </>
      ) : (
        <>
          <PixelButton onClick={onRetry}>다시 시도</PixelButton>
          <PixelButton variant="ghost" onClick={onReselect}>
            다른 사진 올리기
          </PixelButton>
        </>
      )}
    </div>
  );
}
