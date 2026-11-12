/**
 * 3D skin preview: 회전/Zoom inZoom out + 앞/뒤/왼쪽/오른쪽 보기 버튼.
 */

import { useEffect, useRef, useState } from "react";
import type { SkinGeometry } from "../lib/skinAtlas";
import type { SkinScene, ViewDirection } from "./skinScene";
import { createSkinScene } from "./skinScene";

interface SkinViewer3DProps {
  skinCanvas: HTMLCanvasElement;
  /** 스킨 캔버스 내용이 바뀔 때 증가시키면 텍스처가 갱신된다 */
  version?: number;
  height?: number;
  compact?: boolean;
  geometry?: SkinGeometry;
  /** 공유 이미지 캡처용 — scene 핸들 전달 */
  onReady?: (scene: SkinScene) => void;
}

const VIEWS: { key: ViewDirection; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
];

export function SkinViewer3D({
  skinCanvas,
  version = 0,
  height = 320,
  compact = false,
  geometry = "classic",
  onReady,
}: SkinViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkinScene | null>(null);
  const [view, setView] = useState<ViewDirection | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const scene = createSkinScene(container, skinCanvas, geometry);
    setView(null);
    sceneRef.current = scene;
    const onRotate = () => setView(null);
    scene.controls.addEventListener("start", onRotate);
    onReady?.(scene);
    return () => {
      sceneRef.current = null;
      scene.controls.removeEventListener("start", onRotate);
      scene.dispose();
    };
    // skinCanvas 인스턴스가 바뀌면 장면을 다시 만든다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinCanvas, geometry]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.model.refresh();
      scene.render();
    }
  }, [version]);

  return (
    <div
      className={`px-col${compact ? " skin-viewer--compact" : ""}`}
      style={{ gap: compact ? 4 : 10 }}
    >
      <div
        ref={containerRef}
        style={{ height, position: "relative" }}
        aria-label="3D skin preview"
      />
      {!compact && (
        <p className="studio-view-hint">Drag to rotate · Scroll or pinch to zoom</p>
      )}
      <div className="studio-segment" aria-label="Viewing angle">
        {VIEWS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => {
              sceneRef.current?.setView(key);
              setView(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
