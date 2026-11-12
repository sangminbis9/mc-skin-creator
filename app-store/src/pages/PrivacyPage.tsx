import { useLanguage } from "../i18n/LanguageProvider";
import { useState } from 'react';
import type { MessageKey } from '../i18n/messages';
import { clearGenerationCache } from '../lib/cloudflareAI';

export function PrivacyPage() {
  const { t } = useLanguage();
  const [message, setMessage] = useState<MessageKey | ''>('');
  return <article className="web-document">
    <a href="#/">{t("privacy.back")}</a><h1>{t("privacy.title")}<br />{t("privacy.accent")}</h1>
    <p className="web-lead">{t("privacy.intro")}</p>
    <h2>{t("privacy.transmitted")}</h2><p>{t("privacy.transmittedText")}</p>
    <h2>{t("privacy.ai")}</h2><p>{t("privacy.aiText")}</p>
    <h2>{t("privacy.providers")}</h2><p>{t("privacy.providersText")}</p>
    <p><a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer">{t("privacy.cloudflare")}</a> · <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/" target="_blank" rel="noreferrer">{t("privacy.workers")}</a></p>
    <h2>{t("privacy.storage")}</h2><p>{t("privacy.storageText")}</p>
    <button className="px-btn px-btn--ghost" onClick={() => {
      try { clearGenerationCache(); setMessage('privacy.cacheCleared'); }
      catch { setMessage('privacy.cacheError'); }
    }}>{t("privacy.clear")}</button>
    {message && <p role="status">{t(message)}</p>}
    <h2>{t("library.title")}</h2><p>{t("privacy.libraryText")}</p>
    <h2>{t("privacy.sharing")}</h2><p>{t("privacy.sharingText")}</p>
    <a href="#/library">{t("library.title")} →</a>
  </article>;
}
