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
  photo: "Let's try another photo",
  ai: "Generation could not finish",
  network: "Connection interrupted",
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
            Use a clear photo where the face is easy to see.
          </p>
        )}
        {failure.kind !== "photo" && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            {canRetry ? "Try again shortly, or choose another photo." : "Automatic retries have stopped. Please try again later."}
          </p>
        )}
      </PixelPanel>

      {isPhotoProblem ? (
        <>
          <PixelButton onClick={onReselect}>Choose another photo</PixelButton>
          <PixelButton variant="ghost" onClick={onRetry} disabled={!canRetry}>
            Retry this photo
          </PixelButton>
        </>
      ) : (
        <>
          <PixelButton onClick={onRetry} disabled={!canRetry}>Try again</PixelButton>
          <PixelButton variant="ghost" onClick={onReselect}>
            Choose another photo
          </PixelButton>
        </>
      )}
    </div>
  );
}
