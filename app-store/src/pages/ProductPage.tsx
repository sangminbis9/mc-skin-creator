export function ProductPage() {
  return <article className="web-document">
    <a href="#/">← Open the live studio</a>
    <h1>Less friction.<br />More player identity.</h1>
    <p className="web-lead">Skin Studio connects a familiar starting point—a photo—to one of Minecraft's most personal creative surfaces.</p>
    <h2>The product</h2><p>A working photo-to-skin experience with source-aware hair adjustments, modular outfits, 3D and 2D editing, and downloadable 64×64 skin textures. The web edition removes app installation, sign-in, and advertising from the evaluation flow.</p>
    <h2>Evaluate it in three minutes</h2>
    <ol><li>Open the sample to rotate a real skin, compare hair finishes, and mix an outfit.</li><li>Paint a few pixels in 3D or in the texture editor. Undo and redo changes.</li><li>Export the PNG. For the full pipeline, consent to photo processing, upload a clear photo, and generate a new skin.</li></ol>
    <h2>What is working today</h2>
    <dl className="web-specs"><div><dt>Input</dt><dd>One to five reference photos; local resizing and quality checks.</dd></div><div><dt>Generation</dt><dd>AI feature analysis followed by a structured skin renderer.</dd></div><div><dt>Personalization</dt><dd>Source-derived hair finishes, tops and bottoms, plus pixel-level editing.</dd></div><div><dt>Output</dt><dd>64×64 PNG, classic/slim arm conversion, base and outer layers.</dd></div><div><dt>Delivery</dt><dd>Browser-based React/Three.js client and Cloudflare-hosted API.</dd></div></dl>
    <h2>A platform conversation, not a platform claim</h2><p>This demonstration is prepared for product, licensing, integration, or acquisition discussions with Mojang Studios / Microsoft Gaming teams. No partnership, endorsement, Marketplace approval, or Xbox console integration is claimed.</p>
    <h2>What needs further evaluation</h2><p>Likeness is interpretive at this pixel resolution. Hair, headwear, occlusion, lighting, and unseen angles still need broader evaluation. Unseen outfits are inferred; players can replace them. Live generation depends on AI availability and the shared free-tier budget.</p><p>A commercial integration would require platform review, a production capacity plan, privacy and safety review, asset/IP diligence, and an agreed integration surface. This demo does not establish those approvals or rights.</p>
    <a className="px-btn" href="#/">Try Skin Studio →</a>
  </article>;
}
