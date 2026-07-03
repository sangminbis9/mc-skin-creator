/**
 * 3D 미리보기 화면: 회전/줌/방향 버튼 + 결과 액션 버튼.
 */

import { useRef } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { SkinDocument } from "../editor/editorState";
import { SkinViewer3D } from "../editor/SkinViewer3D";
import type { SkinScene } from "../editor/skinScene";

interface PreviewPageProps {
  doc: SkinDocument;
  skinVersion: number;
  onEdit: () => void;
  onDownload: () => void;
  onShare: (previewImageDataUrl: string | null) => void;
  onApplyGuide: () => void;
}

export function PreviewPage({
  doc,
  skinVersion,
  onEdit,
  onDownload,
  onShare,
  onApplyGuide,
}: PreviewPageProps) {
  const sceneRef = useRef<SkinScene | null>(null);

  const handleShare = () => {
    let capture: string | null = null;
    const scene = sceneRef.current;
    if (scene) {
      try {
        scene.render();
        capture = scene.renderer.domElement.toDataURL("image/png");
      } catch {
        capture = null;
      }
    }
    onShare(capture);
  };

  return (
    <div className="px-screen">
      <h1 className="px-title" style={{ textAlign: "center" }}>
        내 스킨 완성! 🎉
      </h1>
      <p className="px-subtitle" style={{ textAlign: "center" }}>
        돌려보고, 마음에 안 드는 부분은 직접 고칠 수 있어요
      </p>

      <PixelPanel tone="sky" style={{ padding: 8 }}>
        <SkinViewer3D
          skinCanvas={doc.canvas}
          version={skinVersion}
          height={300}
          onReady={(scene) => {
            sceneRef.current = scene;
          }}
        />
      </PixelPanel>

      <PixelButton onClick={onEdit}>✏️ 편집하기</PixelButton>
      <PixelButton variant="gold" onClick={onDownload}>
        ⬇️ PNG 다운로드
      </PixelButton>
      <PixelButton variant="ghost" onClick={handleShare}>
        📤 공유하기
      </PixelButton>
      <PixelButton variant="stone" onClick={onApplyGuide}>
        🎮 마크에 적용하기
      </PixelButton>
    </div>
  );
}
