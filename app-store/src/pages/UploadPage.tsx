import { lazy, Suspense, useRef, useState } from "react";
import { StudioIcon } from "../components/StudioIcon";
import { preparePhotoForUpload, type PreparedPhotoUpload } from "../lib/imageQuality";
const WebShowcase = lazy(() => import("../components/WebShowcase").then(m => ({ default: m.WebShowcase })));

interface Props {
  onPhotoSelected: (photos: PreparedPhotoUpload[]) => void;
  onDemo: () => Promise<void>;
}
export function UploadPage({ onPhotoSelected, onDemo }: Props) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  async function receive(files: File[]) {
    if (!agreed || busy || demoBusy) return;
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
        <h1>사진 한 장으로<br /><em>나만의 스킨.</em></h1>
        <p className="web-lead">내 사진을 마인크래프트 스킨으로 만들고, 3D로 확인하고, 직접 꾸며 보세요.</p>
        <div className="web-start" onDragOver={e => { e.preventDefault(); if (agreed) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!agreed) setError("Please agree to photo processing before dropping a photo."); else void receive(Array.from(e.dataTransfer.files)); }} data-dragging={dragging}>
          <label className="web-consent"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>사진 사용 권한이 있으며, 선택한 사진을 Cloudflare 및 Cloudflare Workers AI에 보내 스킨 생성에 사용하는 것에 동의합니다. <a href="#/privacy">개인정보 안내</a></span></label>
          <button className="px-btn" disabled={!agreed || busy || demoBusy} onClick={() => input.current?.click()}><StudioIcon name="upload" />{busy ? "사진 준비 중…" : "사진으로 스킨 만들기"}<StudioIcon name="arrow" /></button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="Upload reference photos" hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void receive(files); }} />
          <p className="web-upload-note">사진 최대 5장 · JPG, PNG, WebP · iPhone 사진은 JPEG로 선택해 주세요.</p>
          {error && <p role="alert" className="web-error">{error}</p>}
        </div>
        <button className="web-demo-link" disabled={demoBusy || busy} onClick={async () => { setDemoBusy(true); setError(""); try { await onDemo(); } catch { setError("The sample could not load. Please try again."); } finally { setDemoBusy(false); } }}>{demoBusy ? "스킨을 여는 중…" : "샘플 스킨으로 시작하기"}<StudioIcon name="arrow" size={16} /></button>
        <p className="web-small">로그인 없이, 광고 없이. 샘플 편집은 인터넷 없이도 사용할 수 있어요.</p>
      </div>
      <Suspense fallback={<div className="web-showcase web-showcase-loading">Loading the example…</div>}><WebShowcase /></Suspense>
    </section>
    <section className="web-process" aria-label="How Skin Studio works">
      <div><span>01 / CAPTURE</span><h2>Start with you.</h2><p>A clear face photo, an outfit, or multiple angles. The photo is the starting point, not a template to choose from.</p></div>
      <div><span>02 / MAKE IT YOURS</span><h2>Keep the character.</h2><p>Try hair finishes and mix tops and bottoms. Fine-tune individual pixels on the 3D model or the flat texture.</p></div>
      <div><span>03 / TAKE IT WITH YOU</span><h2>Pixels you can play.</h2><p>Export a real 64×64 PNG with base and outer layers. Classic and slim arm layouts are available.</p></div>
    </section>
    <section className="web-product-strip"><div><h2>A shorter path from player to creator.</h2><p>마음에 드는 스킨을 기기에 보관하고 언제든 다시 편집하세요.</p></div><a href="#/library">내 스킨 보관함 <StudioIcon name="arrow" size={18} /></a></section>
  </div>;
}
