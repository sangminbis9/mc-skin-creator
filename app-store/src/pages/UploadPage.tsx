import { lazy, Suspense, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageProvider";
import { StudioIcon } from "../components/StudioIcon";
import { preparePhotoForUpload, type PreparedPhotoUpload } from "../lib/imageQuality";
const WebShowcase = lazy(() => import("../components/WebShowcase").then(m => ({ default: m.WebShowcase })));

interface Props {
  onPhotoSelected: (photos: PreparedPhotoUpload[]) => void;
  onDemo: () => Promise<void>;
}
export function UploadPage({ onPhotoSelected, onDemo }: Props) {
  const { t } = useLanguage();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState<"upload.invalid" | "upload.unreadable" | "upload.consentNeeded" | "upload.sampleError" | "">("");
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  async function receive(files: File[]) {
    if (!agreed || busy || demoBusy) return;
    if (!files.length) return;
    if (files.length > 5 || files.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size > 20 * 1024 * 1024)) {
      setError("upload.invalid"); return;
    }
    setBusy(true); setError("");
    try { onPhotoSelected(await Promise.all(files.map(preparePhotoForUpload))); }
    catch { setError("upload.unreadable"); }
    finally { setBusy(false); }
  }
  return <div className="web-home">
    <section className="web-hero">
      <div className="web-hero-copy">
        <h1>{t("upload.heroLine")}<br /><em>{t("upload.heroAccent")}</em></h1>
        <p className="web-lead">{t("upload.lead")}</p>
        <div className="web-start" onDragOver={e => { e.preventDefault(); if (agreed) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!agreed) setError("upload.consentNeeded"); else void receive(Array.from(e.dataTransfer.files)); }} data-dragging={dragging}>
          <label className="web-consent"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>{t("upload.consent")}{" "}<a href="#/privacy">{t("upload.privacy")}</a></span></label>
          <button className="px-btn" disabled={!agreed || busy || demoBusy} onClick={() => input.current?.click()}><StudioIcon name="upload" />{busy ? t("upload.preparing") : t("upload.start")}<StudioIcon name="arrow" /></button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label={t("upload.input")} hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void receive(files); }} />
          <p className="web-upload-note">{t("upload.formats")}</p>
          {error && <p role="alert" className="web-error">{t(error)}</p>}
        </div>
        <button className="web-demo-link" disabled={demoBusy || busy} onClick={async () => { setDemoBusy(true); setError(""); try { await onDemo(); } catch { setError("upload.sampleError"); } finally { setDemoBusy(false); } }}>{demoBusy ? t("upload.sampleLoading") : t("upload.sample")}<StudioIcon name="arrow" size={16} /></button>
        <p className="web-small">{t("upload.offline")}</p>
      </div>
      <Suspense fallback={<div className="web-showcase web-showcase-loading">{t("upload.loadingExample")}</div>}><WebShowcase /></Suspense>
    </section>
    <section className="web-process" aria-label={t("upload.how")}>
      <div><span>{t("upload.capture")}</span><h2>{t("upload.captureTitle")}</h2><p>{t("upload.captureText")}</p></div>
      <div><span>{t("upload.customize")}</span><h2>{t("upload.customizeTitle")}</h2><p>{t("upload.customizeText")}</p></div>
      <div><span>{t("upload.export")}</span><h2>{t("upload.exportTitle")}</h2><p>{t("upload.exportText")}</p></div>
    </section>
    <section className="web-product-strip"><div><h2>{t("upload.libraryTitle")}</h2><p>{t("upload.libraryText")}</p></div><a href="#/library">{t("library.title")} <StudioIcon name="arrow" size={18} /></a></section>
  </div>;
}
