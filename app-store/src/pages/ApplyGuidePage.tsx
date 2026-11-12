import { useLanguage } from '../i18n/LanguageProvider';

export function ApplyGuidePage({ onBack, onDownload }: { onBack: () => void; onDownload: () => void }) {
  const { t } = useLanguage();
  return <article className="web-document">
    <button className="studio-text-btn" onClick={onBack}>{t("common.backSkin")}</button>
    <h1>{t("guide.title")}<br />{t("guide.titleAccent")}</h1>
    <h2>{t("guide.java")}</h2>
    <ol><li>{t("guide.javaDownload")}</li><li>{t("guide.javaOpen")}</li><li>{t("guide.javaApply")}</li></ol>
    <h2>{t("guide.bedrock")}</h2>
    <ol><li>{t("guide.bedrockDownload")}</li><li>{t("guide.bedrockOpen")}</li><li>{t("guide.bedrockApply")}</li></ol>
    <p>{t("guide.note")}</p>
    <button className="px-btn" onClick={onDownload}>{t("guide.download")}</button>
  </article>;
}
