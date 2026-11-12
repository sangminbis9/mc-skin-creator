import { useEffect, useId, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageProvider";
import type { Language } from "../i18n/messages";

const LANGUAGES = [
  { id: "ko", name: "한국어" },
  { id: "en", name: "English" },
] as const;

function Flag({ language }: { language: Language }) {
  return <img className="studio-language-flag" src={`/flags/${language}.svg`} alt="" aria-hidden="true" />;
}

export function LanguageMenu() {
  const { language, setLanguage, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    selected.current?.focus();
    // WebKit can blur the focused button before a tap on another button delivers its click.
    const closeOutside = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return <div className="studio-language" ref={container}
    onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); close(); } }}>
    <button type="button" className="studio-language-trigger" ref={trigger}
      aria-label={t("language.current", { name: t(language === "ko" ? "language.ko" : "language.en") })}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <Flag language={language} />
    </button>
    <div id={id} className="studio-language-menu" role="group" aria-label={t("language.label")} hidden={!open}>
      {LANGUAGES.map(option => <button type="button" key={option.id}
        ref={language === option.id ? selected : null} aria-pressed={language === option.id}
        onClick={() => { setLanguage(option.id); close(); }}>
        <Flag language={option.id} />
        <span lang={option.id}>{option.name}</span>
        {language === option.id && <span className="studio-language-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>
  </div>;
}
