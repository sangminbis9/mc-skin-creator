/**
 * 공유 화면: 3D 미리보기 이미지 공유 + 토스 공유 링크.
 */

import { useMemo, useState } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { SkinDocument } from "../editor/editorState";
import { savePng } from "../lib/download";
import { sharePreviewImage, shareTossLink } from "../lib/shareSkin";
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
    setMessage(shared ? null : "공유를 사용할 수 없는 환경이에요.");
  };

  const handleShareLink = async () => {
    const shared = await shareTossLink();
    setMessage(shared ? null : "공유를 사용할 수 없는 환경이에요.");
  };

  const handleSaveImage = async () => {
    await savePng(previewImage, "mc-skin-preview.png");
    setMessage("미리보기 이미지를 저장했어요!");
  };

  return (
    <div className="px-screen">
      <div className="px-row">
        <button type="button" className="px-tool" aria-label="뒤로" onClick={onBack}>
          ←
        </button>
        <h1 className="px-title" style={{ fontSize: 19 }}>
          친구에게 자랑하기
        </h1>
      </div>

      <PixelPanel tone="sky" style={{ textAlign: "center", padding: 12 }}>
        <img
          src={previewImage}
          alt="내 마인크래프트 스킨 미리보기"
          className="px-pixelated"
          style={{ maxWidth: "70%", maxHeight: 280 }}
        />
      </PixelPanel>

      <PixelButton onClick={handleShareImage}>이미지 공유하기</PixelButton>
      <PixelButton variant="gold" onClick={handleShareLink}>
        토스 링크로 공유하기
      </PixelButton>
      <PixelButton variant="ghost" onClick={handleSaveImage}>
        이미지 저장하기
      </PixelButton>

      {message && (
        <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
          {message}
        </p>
      )}

      <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
        친구가 링크를 누르면 바로 스킨을 만들 수 있어요
      </p>
    </div>
  );
}
