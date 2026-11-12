import type { ReactNode } from "react";

interface PixelCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

export function PixelCheckbox({
  checked,
  onChange,
  children,
}: PixelCheckboxProps) {
  return (
    <label className="px-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="px-check__box">✓</span>
      <span>{children}</span>
    </label>
  );
}
