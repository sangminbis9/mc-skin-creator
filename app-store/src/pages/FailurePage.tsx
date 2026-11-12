/**
 * 생성 실패 화면: 실패 이유를 먼저 안내하고 Try again 버튼 제공.
 */

import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { GenerationFailure } from "./GeneratingPage";

interface FailurePageProps {
  failure: GenerationFailure;
  onRetry: () => void;
  onReselect: () => void;
  canRetry: boolean;
}

const KIND_TITLES: Record<GenerationFailure["kind"], string> = {
  photo: "다른 사진을 선택해 주세요",
  ai: "스킨을 만들지 못했어요",
  network: "연결이 끊겼어요",
};

const KIND_ICONS: Record<GenerationFailure["kind"], string> = {
  photo: "📷",
  ai: "🤖",
  network: "📡",
};

export function FailurePage({ failure, onRetry, onReselect, canRetry }: FailurePageProps) {
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
            얼굴이 잘 보이고 밝기가 고른 사진으로 시도해 보세요.
          </p>
        )}
        {failure.kind !== "photo" && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            {canRetry ? "이 사진으로 다시 시도하거나 다른 사진을 선택할 수 있어요." : "다른 사진을 선택해 다시 시도해 주세요."}
          </p>
        )}
      </PixelPanel>

      {isPhotoProblem ? (
        <>
          <PixelButton onClick={onReselect}>다른 사진 선택</PixelButton>
        </>
      ) : (
        <>
          <PixelButton onClick={onRetry} disabled={!canRetry}>다시 시도</PixelButton>
          <PixelButton variant="ghost" onClick={onReselect}>
            다른 사진 선택
          </PixelButton>
        </>
      )}
    </div>
  );
}
