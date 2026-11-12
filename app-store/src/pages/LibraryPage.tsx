import { useLanguage } from "../i18n/LanguageProvider";
import { useEffect, useState } from 'react';
import type { MessageKey } from '../i18n/messages';
import { deleteSkin, readSkins, type SavedSkin } from '../lib/skinLibrary';
import { exportPng } from '../lib/nativeExport';
import { decodeSkinPng } from '../lib/skinDecode';
import { exportSkinPng, EXPORT_FILENAMES } from '../lib/javaBedrockExport';

export function LibraryPage({ onOpen }: { onOpen: (skin: SavedSkin) => Promise<void> }) {
  const { t, language } = useLanguage();
  const [skins, setSkins] = useState<SavedSkin[]>([]);
  const [error, setError] = useState<MessageKey | ''>('');
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  useEffect(() => { try { setSkins(readSkins()); } catch { setError('library.readError'); } }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch { setError('library.actionError'); }
    finally { setBusy(false); }
  }
  return <section className="px-screen">
    <h1 className="px-title">{t("library.title")}</h1>
    <p className="px-subtitle">{t("library.intro")}</p>
    {error && <p role="alert">{t(error)}</p>}
    {!skins.length && <p>{t("library.empty")}</p>}
    <div className="skin-library">{skins.map(skin => {
      const name = /^스킨 \d/.test(skin.name)
        ? t("library.skinName", { date: new Date(skin.savedAt).toLocaleString(language === "ko" ? "ko-KR" : "en-US") })
        : skin.name;
      return <article className="px-panel" key={skin.id}>
      <img src={skin.png} alt={name} width="128" height="128" className="px-pixelated" />
      <h2>{name}</h2><p>{t(skin.geometry === "slim" ? "model.slimSize" : "model.classicSize")}</p>
      <button className="px-btn" disabled={busy} onClick={() => void run(() => onOpen(skin))}>{t("library.open")}</button>
      <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void run(async () => {
        const canvas = await decodeSkinPng(skin.png.split(',')[1]);
        if (!canvas) throw new Error('스킨을 읽을 수 없습니다.');
        const format = skin.geometry === 'slim' ? 'java-slim' : 'java-classic';
        await exportPng(exportSkinPng(canvas, format), EXPORT_FILENAMES[format], language);
      })}>{t("common.export")}</button>
      {pendingDelete === skin.id ? <div role="group" aria-label={t("library.confirm")}><p>{t("library.deletePrompt")}</p><button disabled={busy} onClick={() => {
        try { deleteSkin(skin.id); setSkins(readSkins()); setPendingDelete(null); } catch { setError('library.deleteError'); }
      }}>{t("library.deleteNow")}</button> <button onClick={() => setPendingDelete(null)}>{t("common.cancel")}</button></div>
        : <button className="studio-text-btn" disabled={busy} onClick={() => setPendingDelete(skin.id)}>{t("library.delete")}</button>}
    </article>;
    })}</div>
    <a href="#/">{t("common.backStudio")}</a>
  </section>;
}
