import { useLanguage } from "../i18n/LanguageProvider";
import { useEffect, useRef, useState } from "react";
import { createSkinScene, type SkinScene } from "../editor/skinScene";
import { loadDemoSkin } from "../lib/demoSkin";
import { portraitDataUrl } from "../lib/skinPortrait";

export function WebShowcase() {
  const { t } = useLanguage();
  const container = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkinScene | null>(null);
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState(false);
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
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; scene?.dispose(); sceneRef.current = null; };
  }, []);
  return <figure className="web-showcase">
    <div className="web-showcase-top"><span>{t("showcase.tag")}</span><span>64 × 64</span></div>
    <div className="web-showcase-pair">
      <div className="web-source"><img src="/images/woman-lace-photo.png" alt={t("showcase.photoAlt")} width="1024" height="1536" /><span>{t("showcase.photo")}</span></div>
      <div className="web-result">
        <div ref={container} className="web-model" aria-label={t("showcase.interactive")}>{fallback && <img src={fallback} alt={t("showcase.front")} />}{error && <p role="status">{t("showcase.unavailable")}</p>}</div>
        <span>{t("showcase.result")}</span>
      </div>
    </div>
    <div className="web-showcase-bottom"><span>{fallback ? t("showcase.2d") : t("showcase.drag")}</span><div aria-label={t("showcase.angle")}>{(["front", "back", "left", "right"] as const).map(direction => <button key={direction} type="button" disabled={!!fallback || !!error} aria-pressed={view === direction} onClick={() => { sceneRef.current?.setView(direction); setView(direction); }}>{t(`view.${direction}`)}</button>)}</div></div>
    <figcaption>{t("showcase.caption")}</figcaption>
  </figure>;
}
