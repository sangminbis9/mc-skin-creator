import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { LanguageProvider } from "./i18n/LanguageProvider";
import "./index.css";
import "./styles/studio.css";
import "./styles/web.css";
import "./styles/native.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </StrictMode>,
);
