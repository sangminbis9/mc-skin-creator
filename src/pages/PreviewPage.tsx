/**
 * 3D 미리보기 화면: 회전/줌/방향 버튼 + 결과 액션 버튼.
 */

import { useRef } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { StudioIcon } from "../components/StudioIcon";
import type { SkinDocument } from "../editor/editorState";
import { SkinViewer3D } from "../editor/SkinViewer3D";
import type { SkinScene } from "../editor/skinScene";
import type { SkinGeometry } from "../lib/skinAtlas";

interface PreviewPageProps {
  isSample?: boolean;
  doc: SkinDocument;
  skinVersion: number;
  onEdit: () => void;
  onDownload: () => void;
  onShare: (previewImageDataUrl: string | null) => void;
  onApplyGuide: () => void;
  onCreateAnother: () => void;
  geometry: SkinGeometry;
  onGeometryChange: (geometry: SkinGeometry) => void;
}

export function PreviewPage({
  isSample = false,
  doc,
  skinVersion,
  onEdit,
  onDownload,
  onShare,
  onApplyGuide,
  onCreateAnother,
  geometry,
  onGeometryChange,
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
      <h1 className="px-title">
        {isSample ? "스킨을 먼저 경험해보세요." : "나만의 스킨, 완성."}
      </h1>
      <p className="px-subtitle">
        {isSample
          ? "체험용 샘플이에요. 돌려보고 직접 편집해보세요."
          : "돌려보고, 마지막 디테일까지 다듬어보세요."}
      </p>
      <div className="studio-stage">
        <div
          className="studio-segment studio-geometry"
          aria-label="팔 모델 선택"
        >
          {(["classic", "slim"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={geometry === value}
              onClick={() => onGeometryChange(value)}
            >
              {value === "classic" ? "Classic · 4px" : "Slim · 3px"}
            </button>
          ))}
        </div>
        <SkinViewer3D
          skinCanvas={doc.canvas}
          version={skinVersion}
          height={320}
          geometry={geometry}
          onReady={(scene) => {
            sceneRef.current = scene;
          }}
        />
      </div>
      <div className="studio-actions">
        <PixelButton className="studio-primary" onClick={onDownload}>
          <StudioIcon name="download" />
          PNG 다운로드
        </PixelButton>
        <PixelButton variant="ghost" onClick={onEdit}>
          <StudioIcon name="edit" />
          스킨 편집
        </PixelButton>
        <PixelButton variant="ghost" onClick={handleShare}>
          <StudioIcon name="share" />
          공유하기
        </PixelButton>
        <PixelButton
          variant="ghost"
          className="studio-wide"
          onClick={onApplyGuide}
        >
          <StudioIcon name="game" />
          마인크래프트에 적용하기
          <StudioIcon name="arrow" size={16} />
        </PixelButton>
      </div>
      <button
        className="studio-text-btn"
        type="button"
        onClick={onCreateAnother}
      >
        <StudioIcon name="refresh" size={16} />
        {isSample ? "내 사진으로 만들기" : "다른 사진으로 만들기"}
      </button>
    </div>
  );
}
