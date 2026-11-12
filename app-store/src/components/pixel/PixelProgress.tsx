interface PixelProgressProps {
  /** 0 ~ 100 */
  value: number;
  tone?: "grass" | "gold" | "danger";
}

export function PixelProgress({ value, tone = "grass" }: PixelProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const toneClass = tone === "grass" ? "" : `px-progress__fill--${tone}`;
  return (
    <div
      className="px-progress"
      role="progressbar"
      aria-label="스킨 생성 진행"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={`px-progress__fill ${toneClass}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
