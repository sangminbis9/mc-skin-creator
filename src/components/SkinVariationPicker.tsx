import { useMemo, useState } from "react";
import type { SkinDocument } from "../editor/editorState";
import { pixelsToSkinCanvas } from "../lib/skinAtlas";
import { renderSkinPortrait } from "../lib/skinPortrait";
import {
  createSkinVariations,
  replaceSkinRegion,
  type SkinVariation,
  type VariationRegion,
} from "../lib/skinVariations";
import { PixelButton } from "./pixel/PixelButton";
import { StudioIcon } from "./StudioIcon";

const REGIONS: { id: VariationRegion; label: string; note: string }[] = [
  {
    id: "head",
    label: "머리",
    note: "눈·코·입은 유지하고 헤어 윗부분과 옆·뒷면을 바꿔요. 원본의 긴 머리나 액세서리는 일부 남을 수 있어요.",
  },
  {
    id: "upper",
    label: "상의",
    note: "몸통과 양팔을 함께 바꿔요. 손 색은 원본 얼굴에서 추정해요.",
  },
  {
    id: "lower",
    label: "하의",
    note: "양다리와 신발을 함께 바꿔요. 사진에 하의가 없어도 직접 선택할 수 있어요.",
  },
];
function thumbnail(option: SkinVariation, region: VariationRegion): string {
  const portrait = renderSkinPortrait(pixelsToSkinCanvas(option.pixels));
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const crop =
    region === "head"
      ? [4, 0, 8, 8]
      : region === "upper"
        ? [0, 8, 16, 12]
        : [4, 20, 8, 12];
  const scale = 64 / Math.max(crop[2], crop[3]);
  const w = crop[2] * scale,
    h = crop[3] * scale;
  ctx.drawImage(
    portrait,
    crop[0],
    crop[1],
    crop[2],
    crop[3],
    (80 - w) / 2,
    (80 - h) / 2,
    w,
    h,
  );
  return canvas.toDataURL();
}

export function SkinVariationPicker({
  doc,
  onPreview,
  onInspect,
  onClose,
}: {
  doc: SkinDocument;
  onPreview: (canvas: HTMLCanvasElement) => void;
  onInspect: () => void;
  onClose: (applied: boolean) => void;
}) {
  const [session] = useState(() => {
    const current = doc.getPixels();
    const options = createSkinVariations(doc.getOriginalPixels(), current);
    const images = Object.fromEntries(
      REGIONS.map(({ id }) => [
        id,
        options[id].map((option) => thumbnail(option, id)),
      ]),
    ) as Record<VariationRegion, string[]>;
    return { current, options, images };
  });
  const [region, setRegion] = useState<VariationRegion>("head");
  const [selected, setSelected] = useState<Record<VariationRegion, string>>({
    head: "current",
    upper: "current",
    lower: "current",
  });
  const compose = (choices: typeof selected) =>
    REGIONS.reduce(
      (pixels, { id }) =>
        replaceSkinRegion(
          pixels,
          session.options[id].find((option) => option.id === choices[id])!
            .pixels,
          id,
        ),
      session.current,
    );
  const selectedLabels = useMemo(
    () =>
      REGIONS.map(
        ({ id }) =>
          session.options[id].find((option) => option.id === selected[id])!
            .label,
      ).join(" · "),
    [selected, session],
  );
  const choose = (next: typeof selected) => {
    setSelected(next);
    onPreview(pixelsToSkinCanvas(compose(next)));
  };

  return (
    <section className="variation-panel" aria-label="스킨 조합 작업실">
      <div className="variation-heading">
        <h2>옷장</h2>
      </div>
      <p className="variation-help">
        준비된 스타일을 조합해요. 추가 AI 생성은 없어요.
      </p>
      <div className="studio-segment" aria-label="조합할 부위">
        {REGIONS.map(({ id, label }) => (
          <button
            type="button"
            key={id}
            aria-pressed={region === id}
            onClick={() => setRegion(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="variation-note">
        {REGIONS.find(({ id }) => id === region)!.note}
      </p>
      <div
        className="variation-grid"
        aria-label={`${REGIONS.find(({ id }) => id === region)!.label} 후보`}
      >
        {session.options[region].map((option, index) => (
          <button
            type="button"
            className="variation-card"
            key={option.id}
            aria-pressed={selected[region] === option.id}
            onClick={() => choose({ ...selected, [region]: option.id })}
          >
            <img
              src={session.images[region][index]}
              alt=""
              width={80}
              height={80}
            />
            <span>{option.label}</span>
            <small>
              {selected[region] === option.id ? "✓ 선택됨" : "미리보기"}
            </small>
          </button>
        ))}
      </div>
      <p className="variation-selection" role="status">
        {selectedLabels}
      </p>
      <PixelButton variant="ghost" onClick={onInspect}>
        <StudioIcon name="cube" size={16} /> 조합 미리보기
      </PixelButton>
      <button
        className="studio-text-btn"
        type="button"
        onClick={() =>
          choose({ head: "original", upper: "original", lower: "original" })
        }
      >
        전체 생성 원본으로 보기
      </button>
      <div className="variation-actions">
        <PixelButton variant="ghost" onClick={() => onClose(false)}>
          취소
        </PixelButton>
        <PixelButton
          onClick={() => {
            doc.applyComposition(compose(selected));
            onClose(true);
          }}
        >
          이 조합 적용
        </PixelButton>
      </div>
      <p className="variation-help">
        바꾼 부위의 직접 편집 내용은 교체돼요. 적용 후에도 스킨 편집의
        되돌리기로 복원할 수 있어요.
      </p>
    </section>
  );
}
