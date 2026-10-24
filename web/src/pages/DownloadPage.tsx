import { useMemo, useState } from "react";
import type { SkinDocument } from "../editor/editorState";
import type { SkinGeometry } from "../lib/skinAtlas";
import { EXPORT_FILENAMES, exportSkinPng, type ExportFormat } from "../lib/javaBedrockExport";

export function DownloadPage({ doc, onBack, onApplyGuide, preferredGeometry }: {
  doc: SkinDocument; onBack: () => void; onApplyGuide: () => void; preferredGeometry: SkinGeometry;
}) {
  const [message, setMessage] = useState("");
  const exports = useMemo(() => Object.fromEntries(
    (["java-classic", "java-slim", "bedrock"] as const).map(format => [format, exportSkinPng(doc.canvas, format)]),
  ) as Record<ExportFormat, string>, [doc]);
  const preferred: ExportFormat = preferredGeometry === "slim" ? "java-slim" : "java-classic";
  const alternate: ExportFormat = preferredGeometry === "slim" ? "java-classic" : "java-slim";
  const started = () => setMessage("Download requested. Check your browser's downloads.");
  return <div className="px-screen">
    <button className="studio-text-btn" onClick={onBack}>← Back to your skin</button>
    <h1 className="px-title">Ready for your next world.</h1>
    <p className="px-subtitle">A real 64×64 PNG texture, with base and outer layers.</p>
    <figure className="web-export-preview"><img src={exports[preferred]} alt="Your export-ready 64 by 64 skin texture" width="128" height="128" /><figcaption>Actual downloadable texture · {preferredGeometry}</figcaption></figure>
    <div className="px-panel"><p>Choose the arm layout that matches your character. Your current preview uses <b>{preferredGeometry}</b> arms.</p></div>
    <a className="px-btn" href={exports[preferred]} download={EXPORT_FILENAMES[preferred]} onClick={started}>Download {preferredGeometry === "slim" ? "Slim · 3px" : "Classic · 4px"} PNG</a>
    <a className="px-btn px-btn--ghost" href={exports[alternate]} download={EXPORT_FILENAMES[alternate]} onClick={started}>Download {preferredGeometry === "slim" ? "Classic · 4px" : "Slim · 3px"} instead</a>
    <a className="px-btn px-btn--ghost" href={exports.bedrock} download={EXPORT_FILENAMES.bedrock} onClick={started}>Download Bedrock PNG · Classic</a>
    {message && <p role="status">{message}</p>}
    <p className="px-caption">Custom PNG import is supported by Java Edition and supported Bedrock clients on Windows and mobile. This is not an Xbox console skin installation or Marketplace submission.</p>
    <button className="studio-text-btn" onClick={onApplyGuide}>How to use your skin →</button>
  </div>;
}
