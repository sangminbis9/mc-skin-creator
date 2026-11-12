import { useLanguage } from "../i18n/LanguageProvider";
import { useMemo, useState } from 'react';
import type { MessageKey } from '../i18n/messages';
import type { SkinDocument } from '../editor/editorState';
import type { SkinGeometry } from '../lib/skinAtlas';
import { EXPORT_FILENAMES, exportSkinPng, type ExportFormat } from '../lib/javaBedrockExport';
import { exportPng } from '../lib/nativeExport';

export function DownloadPage({ doc, onBack, onApplyGuide, preferredGeometry }: {
  doc: SkinDocument; onBack: () => void; onApplyGuide: () => void; preferredGeometry: SkinGeometry;
}) {
  const { t, language } = useLanguage();
  const [message, setMessage] = useState<MessageKey | ''>('');
  const [busy, setBusy] = useState(false);
  const exports = useMemo(() => Object.fromEntries(
    (['java-classic', 'java-slim', 'bedrock'] as const).map(format => [format, exportSkinPng(doc.canvas, format)]),
  ) as Record<ExportFormat, string>, [doc]);
  const preferred: ExportFormat = preferredGeometry === 'slim' ? 'java-slim' : 'java-classic';
  const modelName = t(preferredGeometry === "slim" ? "model.slim" : "model.classic");
  const otherModelName = t(preferredGeometry === "slim" ? "model.classic" : "model.slim");
  async function save(format: ExportFormat) {
    setBusy(true); setMessage('');
    try {
      await exportPng(exports[format], EXPORT_FILENAMES[format], language);
      setMessage('export.closed');
    } catch { setMessage('export.failed'); }
    finally { setBusy(false); }
  }
  return <div className="px-screen">
    <button className="studio-text-btn" onClick={onBack}>{t("common.backSkin")}</button>
    <h1 className="px-title">{t("export.title")}</h1>
    <p className="px-subtitle">{t("export.intro")}</p>
    <figure className="web-export-preview"><img src={exports[preferred]} alt={t("export.alt")} width="128" height="128" /><figcaption>{t("export.currentModel", { model: modelName })}</figcaption></figure>
    <div className="px-panel"><p>{t("export.iphone")}</p></div>
    <button className="px-btn" disabled={busy} onClick={() => void save(preferred)}>{t("export.current", { model: modelName })}</button>
    <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void save(preferredGeometry === 'slim' ? 'java-classic' : 'java-slim')}>{t("export.other", { model: otherModelName })}</button>
    <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void save('bedrock')}>{t("export.bedrock")}</button>
    {message && <p role="status">{t(message)}</p>}
    <p className="px-caption">{t("export.support")}</p>
    <button className="studio-text-btn" onClick={onApplyGuide}>{t("export.guide")}</button>
  </div>;
}
