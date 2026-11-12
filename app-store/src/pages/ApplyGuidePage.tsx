export function ApplyGuidePage({ onBack, onDownload }: { onBack: () => void; onDownload: () => void }) {
  return <article className="web-document">
    <button className="studio-text-btn" onClick={onBack}>← Back to your skin</button>
    <h1>Take your skin<br />into the game.</h1>
    <h2>Java Edition</h2>
    <ol><li>Download your Classic or Slim PNG.</li><li>Open the official Minecraft Launcher and choose Java Edition → Skins → New skin.</li><li>Select the matching arm model, upload the PNG, then save and use it.</li></ol>
    <h2>Bedrock · Windows and mobile</h2>
    <ol><li>Download the Bedrock PNG.</li><li>In Minecraft, open Dressing Room → Edit Character → Classic Skins.</li><li>Under Owned, choose Import and select the PNG. Choose the matching model.</li></ol>
    <p>Menus can vary by game version. Console editions, including Xbox, do not offer the same custom PNG import flow. This demo does not connect to a Microsoft account, install skins automatically, or publish to the Marketplace.</p>
    <button className="px-btn" onClick={onDownload}>Download a skin PNG</button>
  </article>;
}
