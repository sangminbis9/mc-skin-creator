/**
 * 생성 실패 화면: 실패 이유를 먼저 안내하고 Try again 버튼 제공.
 */

import { useLanguage } from "../i18n/LanguageProvider";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { MessageKey } from "../i18n/messages";
import type { GenerationFailure } from "./GeneratingPage";

interface FailurePageProps {
  failure: GenerationFailure;
  onRetry: () => void;
  onReselect: () => void;
  canRetry: boolean;
}

const KIND_TITLES: Record<GenerationFailure["kind"], MessageKey> = {
  photo: "failure.photo",
  ai: "failure.ai",
  network: "failure.network",
};

const KIND_ICONS: Record<GenerationFailure["kind"], string> = {
  photo: "📷",
  ai: "🤖",
  network: "📡",
};

export function FailurePage({ failure, onRetry, onReselect, canRetry }: FailurePageProps) {
  const { t } = useLanguage();
  const isPhotoProblem = failure.kind === "photo";

  return (
    <div className="px-screen px-screen--center">
      <div style={{ textAlign: "center", fontSize: 44 }} aria-hidden="true">
        {KIND_ICONS[failure.kind]}
      </div>
      <h1 className="px-title" style={{ textAlign: "center" }}>
        {t(KIND_TITLES[failure.kind])}
      </h1>

      <PixelPanel>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.8 }}>
          {t(failure.message)}{failure.reference && " " + t("failure.reference", { id: failure.reference })}
        </p>
        {isPhotoProblem && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            {t("failure.photoHint")}
          </p>
        )}
        {failure.kind !== "photo" && (
          <p className="px-caption" style={{ marginTop: 8 }}>
            {canRetry ? t("failure.tryPhoto") : t("failure.different")}
          </p>
        )}
      </PixelPanel>

      {isPhotoProblem ? (
        <>
          <PixelButton onClick={onReselect}>{t("common.anotherPhoto")}</PixelButton>
        </>
      ) : (
        <>
          <PixelButton onClick={onRetry} disabled={!canRetry}>{t("common.retry")}</PixelButton>
          <PixelButton variant="ghost" onClick={onReselect}>
            {t("common.anotherPhoto")}
          </PixelButton>
        </>
      )}
    </div>
  );
}
