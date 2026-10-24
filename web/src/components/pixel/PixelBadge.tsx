import type { ReactNode } from "react";

interface PixelBadgeProps {
  tone?: "gold" | "green" | "red" | "gray";
  children: ReactNode;
}

export function PixelBadge({ tone = "gold", children }: PixelBadgeProps) {
  const toneClass = tone === "gold" ? "" : `px-badge--${tone}`;
  return <span className={`px-badge ${toneClass}`}>{children}</span>;
}
