interface PixelProgressProps {
  /** 0 ~ 100 */
  value: number;
  tone?: "grass" | "gold" | "danger";
}

export function PixelProgress({ value, tone = "grass" }: PixelProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const toneClass = tone === "grass" ? "" : `px-progress__fill--${tone}`;
  return (
    <div className="px-progress">
      <div
        className={`px-progress__fill ${toneClass}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
