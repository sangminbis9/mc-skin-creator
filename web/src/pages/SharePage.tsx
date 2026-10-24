/**
 * 공유 화면: 3D 미리보기 이미지 공유 + 토스 공유 링크.
 */

import { useMemo, useState } from "react";
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
  const [message, setMessage] = useState<string | null>(null);
  const previewImage = useMemo(
    () => capturedImage ?? portraitDataUrl(doc.canvas, 10),
    [capturedImage, doc],
  );

  const handleShareImage = async () => {
    const shared = await sharePreviewImage(previewImage);
    setMessage(shared ? null : "Native image sharing is unavailable or cancelled. Save the image instead.");
  };

  const handleShareLink = async () => {
    const shared = await shareStudioLink();
    setMessage(shared ? "Studio link shared or copied to your clipboard." : "Sharing unavailable. Copy the URL from your address bar.");
  };

  const handleSaveImage = async () => {
    await savePng(previewImage, "mc-skin-preview.png");
    setMessage("Preview download started.");
  };

  return (
    <div className="px-screen">
      <div className="px-row">
        <button
          type="button"
          className="px-tool"
          aria-label="Back"
          onClick={onBack}
        >
          <StudioIcon name="back" />
        </button>
        <h1 className="px-title" style={{ fontSize: 19 }}>
          Share your creation
        </h1>
      </div>

      <PixelPanel tone="sky" style={{ textAlign: "center", padding: 12 }}>
        <img
          src={previewImage}
          alt="Your Minecraft skin preview"
          className="px-pixelated"
          style={{ maxWidth: "70%", maxHeight: 280 }}
        />
      </PixelPanel>

      <PixelButton onClick={handleShareImage}>Share image</PixelButton>
      <PixelButton variant="gold" onClick={handleShareLink}>
        Share / copy studio link
      </PixelButton>
      <PixelButton variant="ghost" onClick={handleSaveImage}>
        Save preview image
      </PixelButton>

      {message && (
        <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
          {message}
        </p>
      )}

      <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
        Shared links open the studio, not your private skin.
      </p>
    </div>
  );
}
