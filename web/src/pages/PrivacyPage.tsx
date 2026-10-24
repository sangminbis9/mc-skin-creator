import { useState } from "react";

export function PrivacyPage() {
  const [cleared, setCleared] = useState(false);
  return <article className="web-document">
    <a href="#/">← Back to the studio</a><h1>Your photos.<br />Your choice.</h1>
    <p className="web-lead">Photo processing in this demonstration</p>
    <h2>What is sent</h2><p>Only photos you select and submit for generation (up to five). Your browser resizes and compresses them before sending them to the connected Cloudflare skin-generation service. Only upload photos you have permission to use.</p>
    <h2>How generation works</h2><p>The currently connected service uses Cloudflare Workers AI to analyze visible features. The rendering engine constructs a skin texture. Unseen clothing and angles are inferred and may not match reality. This is not an identity verification service.</p>
    <h2>Storage and service diagnostics</h2><p>The application does not intentionally persist uploaded photos or generated skins on its server. Photos are processed in request memory. Operational usage counters and failure diagnostics may be retained by the service; Cloudflare also processes request metadata to operate its infrastructure.</p>
    <h2>On this device</h2><p>Completed skins, editor feature metadata, and hashes of submitted images may be cached in this browser for up to 24 hours to avoid duplicate generation. Original photos are not included in this cache. Expired entries are ignored and removed on the next generation request; browser storage is not a timed secure-erasure system.</p>
    <button className="px-btn px-btn--ghost" onClick={() => { localStorage.removeItem("skin-studio-web:completed:headwear-20261019-v1"); setCleared(true); }}>Clear saved generation cache</button>
    {cleared && <p role="status">Saved cache cleared. Reload this page to clear the current in-memory session.</p>}
    <h2>No advertising</h2><p>This web edition has no advertising SDK or ad placements. Sharing and PNG downloads use browser features. Shared links open the studio; they do not publish your photos or your skin.</p>
    <h2>Your choice</h2><p>Without agreeing to photo processing, you can still explore the curated sample and use the editor. Photo generation requires the checkbox and an explicit generate action.</p>
    <a href="#/">Return to Skin Studio →</a>
  </article>;
}
