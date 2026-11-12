import { useLanguage } from "../../i18n/LanguageProvider";
import type { ReactNode } from "react";
import { PixelPanel } from "./PixelPanel";

interface PixelModalProps {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}

export function PixelModal({ open, onClose, children }: PixelModalProps) {
  const { t } = useLanguage();
  if (!open) {
    return null;
  }
  return (
    <div className="px-modal-overlay">
      <div className="px-modal">
        {onClose && (
          <button
            type="button"
            className="px-modal__close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ✕
          </button>
        )}
        <PixelPanel>{children}</PixelPanel>
      </div>
    </div>
  );
}
