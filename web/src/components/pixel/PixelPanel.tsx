import type { HTMLAttributes, ReactNode } from "react";

interface PixelPanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "paper" | "dirt" | "sky";
  children: ReactNode;
}

export function PixelPanel({
  tone = "paper",
  children,
  className = "",
  ...rest
}: PixelPanelProps) {
  const toneClass = tone === "paper" ? "" : `px-panel--${tone}`;
  return (
    <div className={`px-panel ${toneClass} ${className}`} {...rest}>
      {children}
    </div>
  );
}
