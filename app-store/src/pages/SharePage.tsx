/**
 * 공유 화면: 3D 미리보기 이미지 공유 + 토스 공유 링크.
 */

import { useLanguage } from "../i18n/LanguageProvider";
import { useMemo, useState } from "react";
import type { MessageKey } from "../i18n/messages";
import { StudioIcon } from "../components/StudioIcon";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { SkinDocument } from "../editor/editorState";
import { savePng } from "../lib/download";
import { sharePreviewImage, shareStudioLink } from "../lib/shareSkin";
import { portraitDataUrl } from "../lib/skinPortrait";

interface SharePageProps {
  doc: SkinDocument;
  /** 미리보기 화면에서 캡처한 3D 이미지 (없으면 정면 포트레이트로 대체) */
  capturedImage: string | null;
  onBack: () => void;
}

export function SharePage({ doc, capturedImage, onBack }: SharePageProps) {
  const { t, language } = useLanguage();
  const [message, setMessage] = useState<MessageKey | null>(null);
  const previewImage = useMemo(
    () => capturedImage ?? portraitDataUrl(doc.canvas, 10),
    [capturedImage, doc],
  );

  const handleShareImage = async () => {
    const shared = await sharePreviewImage(previewImage, language);
    setMessage(shared ? null : "share.imageUnavailable");
  };

  const handleShareLink = async () => {
    const shared = await shareStudioLink(language);
    setMessage(shared ? "share.linkShared" : "share.unavailable");
  };

  const handleSaveImage = async () => {
    try {
      await savePng(previewImage, "mc-skin-preview.png", language);
      setMessage("export.closed");
    } catch { setMessage("export.failed"); }
  };

  return (
    <div className="px-screen">
      <div className="px-row">
        <button
          type="button"
          className="px-tool"
          aria-label={t("common.back")}
          onClick={onBack}
        >
          <StudioIcon name="back" />
        </button>
        <h1 className="px-title" style={{ fontSize: 19 }}>
          {t("share.title")}
        </h1>
      </div>

      <PixelPanel tone="sky" style={{ textAlign: "center", padding: 12 }}>
        <img
          src={previewImage}
          alt={t("share.alt")}
          className="px-pixelated"
          style={{ maxWidth: "70%", maxHeight: 280 }}
        />
      </PixelPanel>

      <PixelButton onClick={handleShareImage}>{t("share.image")}</PixelButton>
      <PixelButton variant="gold" onClick={handleShareLink}>
        {t("share.link")}
      </PixelButton>
      <PixelButton variant="ghost" onClick={handleSaveImage}>
        {t("share.saveImage")}
      </PixelButton>

      {message && (
        <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
          {t(message)}
        </p>
      )}

      <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
        {t("share.scope")}
      </p>
    </div>
  );
}
