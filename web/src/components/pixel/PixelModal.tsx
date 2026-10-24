import type { ReactNode } from "react";
import { PixelPanel } from "./PixelPanel";

interface PixelModalProps {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}

export function PixelModal({ open, onClose, children }: PixelModalProps) {
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
            aria-label="닫기"
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
