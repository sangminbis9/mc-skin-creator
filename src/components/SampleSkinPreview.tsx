import { useEffect, useRef, useState } from "react";
import { createSkinScene } from "../editor/skinScene";
import { createSampleSkin } from "../lib/sampleSkin";
import { portraitDataUrl } from "../lib/skinPortrait";

export function SampleSkinPreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const skin = createSampleSkin();
    // The source preview remains available on devices without WebGL.
    try {
      const scene = createSkinScene(containerRef.current, skin);
      return () => scene.dispose();
    } catch {
      setFallback(portraitDataUrl(skin));
    }
  }, []);
  return (
    <figure className="sample-skin">
      <div
        className="inventory-viewport"
        ref={containerRef}
        aria-label="회전할 수 있는 예시 스킨"
      >
        {fallback && (
          <img
            src={fallback}
            className="sample-skin-fallback"
            alt="예시 스킨 정면"
          />
        )}
      </div>
      <figcaption>
        {fallback ? "편집 가능한 예시 스킨" : "직접 돌려볼 수 있는 예시 스킨"}
      </figcaption>
    </figure>
  );
}
