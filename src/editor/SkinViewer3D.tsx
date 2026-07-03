/**
 * 3D 스킨 미리보기: 회전/확대축소 + 앞/뒤/왼쪽/오른쪽 보기 버튼.
 */

import { useEffect, useRef } from "react";
import type { SkinScene, ViewDirection } from "./skinScene";
import { createSkinScene } from "./skinScene";

interface SkinViewer3DProps {
  skinCanvas: HTMLCanvasElement;
  /** 스킨 캔버스 내용이 바뀔 때 증가시키면 텍스처가 갱신된다 */
  version?: number;
  height?: number;
  /** 공유 이미지 캡처용 — scene 핸들 전달 */
  onReady?: (scene: SkinScene) => void;
}

const VIEWS: { key: ViewDirection; label: string }[] = [
  { key: "front", label: "앞" },
  { key: "back", label: "뒤" },
  { key: "left", label: "왼쪽" },
  { key: "right", label: "오른쪽" },
];

export function SkinViewer3D({
  skinCanvas,
  version = 0,
  height = 320,
  onReady,
}: SkinViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkinScene | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const scene = createSkinScene(container, skinCanvas);
    sceneRef.current = scene;
    onReady?.(scene);
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
    // skinCanvas 인스턴스가 바뀌면 장면을 다시 만든다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinCanvas]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.model.refresh();
      scene.render();
    }
  }, [version]);

  return (
    <div className="px-col" style={{ gap: 10 }}>
      <div
        ref={containerRef}
        style={{ height, position: "relative" }}
        aria-label="3D 스킨 미리보기"
      />
      <div className="px-row" style={{ justifyContent: "center" }}>
        {VIEWS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="px-btn px-btn--ghost px-btn--small"
            onClick={() => sceneRef.current?.setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
