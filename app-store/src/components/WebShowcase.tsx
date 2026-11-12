import { useEffect, useRef, useState } from "react";
import { createSkinScene, type SkinScene } from "../editor/skinScene";
import { loadDemoSkin } from "../lib/demoSkin";
import { portraitDataUrl } from "../lib/skinPortrait";

export function WebShowcase() {
  const container = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkinScene | null>(null);
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState("three-quarter");
  useEffect(() => {
    let disposed = false;
    let scene: SkinScene | undefined;
    void loadDemoSkin().then(canvas => {
      if (disposed || !container.current) return;
      try {
        scene = createSkinScene(container.current, canvas, "slim");
        sceneRef.current = scene;
      } catch { setFallback(portraitDataUrl(canvas, 12)); }
    }).catch(() => { if (!disposed) setError("Preview unavailable. You can still open the studio."); });
    return () => { disposed = true; scene?.dispose(); sceneRef.current = null; };
  }, []);
  return <figure className="web-showcase">
    <div className="web-showcase-top"><span>THE SAME CHARACTER. A NEW WORLD.</span><span>64 × 64</span></div>
    <div className="web-showcase-pair">
      <div className="web-source"><img src="/images/woman-lace-photo.png" alt="AI-created reference portrait in an ivory lace outfit" width="1024" height="1536" /><span>REFERENCE PORTRAIT</span></div>
      <div className="web-result">
        <div ref={container} className="web-model" aria-label="Interactive sample skin — drag to rotate">{fallback && <img src={fallback} alt="Sample skin front view" />}{error && <p role="status">{error}</p>}</div>
        <span>REAL SKIN · LIVE 3D</span>
      </div>
    </div>
    <div className="web-showcase-bottom"><span>{fallback ? "2D preview" : "Drag to explore"}</span><div aria-label="Sample viewing angle">{(["front", "back", "left", "right"] as const).map(direction => <button key={direction} type="button" disabled={!!fallback || !!error} aria-pressed={view === direction} onClick={() => { sceneRef.current?.setView(direction); setView(direction); }}>{direction}</button>)}</div></div>
    <figcaption>Handcrafted 64×64 sample based on the reference. Open the sample to edit and download it. Live generation may differ.</figcaption>
  </figure>;
}
