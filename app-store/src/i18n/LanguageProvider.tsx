import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { translate, type Language, type Translator } from "./messages";

const STORAGE_KEY = "skin-studio-ios:language";
type LanguageSettings = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
};
const LanguageContext = createContext<LanguageSettings | null>(null);

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ko" || saved === "en") return saved;
  } catch { /* Language switching still works without storage. */ }
  return navigator.language.toLowerCase().split("-")[0] === "en" ? "en" : "ko";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, "app.name");
    document.querySelector('meta[name="description"]')?.setAttribute("content", translate(language, "app.description"));
    try { localStorage.setItem(STORAGE_KEY, language); } catch { /* Optional persistence. */ }
  }, [language]);
  const settings = useMemo<LanguageSettings>(() => ({
    language, setLanguage, t: (key, values) => translate(language, key, values),
  }), [language]);
  return <LanguageContext.Provider value={settings}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageSettings {
  const settings = useContext(LanguageContext);
  if (!settings) throw new Error("LanguageProvider is required");
  return settings;
}
