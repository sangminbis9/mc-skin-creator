import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { StudioIcon } from "../components/StudioIcon";
import { fetchQuotaStatus } from "../lib/cloudflareAI";
import { preparePhotoForUpload, type PreparedPhotoUpload } from "../lib/imageQuality";
import type { QuotaStatus } from "../lib/skinFeatures";
const WebShowcase = lazy(() => import("../components/WebShowcase").then(m => ({ default: m.WebShowcase })));

interface Props {
  onPhotoSelected: (photos: PreparedPhotoUpload[]) => void;
  onQuotaClosed: (quota: QuotaStatus | null) => void;
  onDemo: () => Promise<void>;
}
export function UploadPage({ onPhotoSelected, onQuotaClosed, onDemo }: Props) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState("");
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { void fetchQuotaStatus().then(setQuota); }, []);
  async function receive(files: File[]) {
    if (!agreed || busy || demoBusy) return;
    if (quota?.level === "closed") { onQuotaClosed(quota); return; }
    if (!files.length) return;
    if (files.length > 5 || files.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size > 20 * 1024 * 1024)) {
      setError("Choose up to 5 JPG, PNG or WebP photos, each under 20 MB."); return;
    }
    setBusy(true); setError("");
    try { onPhotoSelected(await Promise.all(files.map(preparePhotoForUpload))); }
    catch { setError("This photo could not be read. Please try a JPG, PNG or WebP image."); }
    finally { setBusy(false); }
  }
  return <div className="web-home">
    <section className="web-hero">
      <div className="web-hero-copy">
        <h1>Your look.<br />Your next <em>world.</em></h1>
        <p className="web-lead">Turn a photo into a Minecraft skin. Keep what makes you, you. Make the rest your own.</p>
        <div className="web-start" onDragOver={e => { e.preventDefault(); if (agreed) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!agreed) setError("Please agree to photo processing before dropping a photo."); else void receive(Array.from(e.dataTransfer.files)); }} data-dragging={dragging}>
          <label className="web-consent"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>I have permission to use these photos and agree to <a href="#/privacy">AI photo processing</a>.</span></label>
          <button className="px-btn" disabled={!agreed || busy || demoBusy} onClick={() => quota?.level === "closed" ? onQuotaClosed(quota) : input.current?.click()}><StudioIcon name="upload" />{busy ? "Preparing your photos…" : quota?.level === "closed" ? "Check generation availability" : "Create from a photo"}<StudioIcon name="arrow" /></button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="Upload reference photos" hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void receive(files); }} />
          <p className="web-upload-note">Or drop up to 5 photos here · JPG, PNG, WebP</p>
          {error && <p role="alert" className="web-error">{error}</p>}
        </div>
        <button className="web-demo-link" disabled={demoBusy || busy} onClick={async () => { setDemoBusy(true); setError(""); try { await onDemo(); } catch { setError("The sample could not load. Please try again."); } finally { setDemoBusy(false); } }}>{demoBusy ? "Opening the studio…" : "Explore with a sample skin"}<StudioIcon name="arrow" size={16} /></button>
        <p className="web-small">No sign-in. No ads. Sample mode uses no AI quota.</p>
      </div>
      <Suspense fallback={<div className="web-showcase web-showcase-loading">Loading the example…</div>}><WebShowcase /></Suspense>
    </section>
    <section className="web-process" aria-label="How Skin Studio works">
      <div><span>01 / CAPTURE</span><h2>Start with you.</h2><p>A clear face photo, an outfit, or multiple angles. The photo is the starting point, not a template to choose from.</p></div>
      <div><span>02 / MAKE IT YOURS</span><h2>Keep the character.</h2><p>Try hair finishes and mix tops and bottoms. Fine-tune individual pixels on the 3D model or the flat texture.</p></div>
      <div><span>03 / TAKE IT WITH YOU</span><h2>Pixels you can play.</h2><p>Export a real 64×64 PNG with base and outer layers. Classic and slim arm layouts are available.</p></div>
    </section>
    <section className="web-product-strip"><div><h2>A shorter path from player to creator.</h2><p>An independent, working product demo for platform and partnership evaluation.</p></div><a href="#/product">Read the product brief <StudioIcon name="arrow" size={18} /></a></section>
  </div>;
}
