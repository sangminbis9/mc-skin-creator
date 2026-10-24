import { useMemo, useState } from "react";
import type { SkinDocument } from "../editor/editorState";
import { CLASSIC_LAYOUT, pixelsToSkinCanvas } from "../lib/skinAtlas";
import { renderSkinPortrait } from "../lib/skinPortrait";
import { headThumbnailPixels } from "../lib/headThumbnail";
import {
  createSkinVariations,
  replaceSkinRegion,
  type SkinVariation,
  type VariationRegion,
} from "../lib/skinVariations";
import { PixelButton } from "./pixel/PixelButton";

const REGIONS: { id: VariationRegion; label: string }[] = [
  { id: "head", label: "Head" },
  { id: "upper", label: "Tops" },
  { id: "lower", label: "Bottoms" },
];
type ThumbnailView = "front" | "right" | "back";
function thumbnail(
  option: SkinVariation,
  region: VariationRegion,
  view: ThumbnailView,
): string {
  if (region === "head") {
    const rendered = headThumbnailPixels(option.pixels, view);
    const canvas = document.createElement("canvas");
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(rendered.width, rendered.height);
    image.data.set(rendered.data);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }
  const skin = pixelsToSkinCanvas(option.pixels);
  const portrait = renderSkinPortrait(skin);
  if (view !== "front") {
    const ctx = portrait.getContext("2d")!;
    ctx.clearRect(0, 0, 16, 32);
    const placements = [
      ["head", 4, 0],
      ["body", 4, 8],
      ["rightArm", 0, 8],
      ["leftArm", 12, 8],
      ["rightLeg", 4, 20],
      ["leftLeg", 8, 20],
    ] as const;
    for (const layer of ["base", "overlay"] as const)
      for (const [part, x, y] of placements) {
        const r = CLASSIC_LAYOUT[part][layer][view];
        ctx.drawImage(skin, r.x, r.y, r.w, r.h, x, y, r.w, r.h);
      }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const crop = region === "upper" ? [0, 8, 16, 12] : [4, 20, 8, 12];
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
  onClose,
}: {
  doc: SkinDocument;
  onPreview: (canvas: HTMLCanvasElement) => void;
  onClose: (applied: boolean) => void;
}) {
  const [session] = useState(() => {
    const current = doc.getPixels();
    const options = createSkinVariations(
      doc.getOriginalPixels(),
      current,
      doc.variationHints,
    );
    return { current, options };
  });
  const [region, setRegion] = useState<VariationRegion>("head");
  const view: ThumbnailView = "front";
  const images = useMemo(
    () =>
      session.options[region].map((option) => thumbnail(option, region, view)),
    [session, region, view],
  );
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
    <section className="variation-panel" aria-label="Skin wardrobe">
      <div className="studio-segment" aria-label="Region to combine">
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
      <div
        key={region}
        className="variation-grid"
        aria-label={`${REGIONS.find(({ id }) => id === region)!.label} options`}
      >
        {session.options[region].map((option, index) => (
          <button
            type="button"
            className="variation-card"
            key={option.id}
            disabled={Boolean(option.disabledReason)}
            title={option.disabledReason ?? option.description}
            aria-pressed={selected[region] === option.id}
            onClick={() => choose({ ...selected, [region]: option.id })}
          >
            <img src={images[index]} alt="" width={80} height={80} />
            <span>{option.label}</span>
            {option.disabledReason && <small>Unavailable</small>}
          </button>
        ))}
      </div>
      <p className="sr-only" role="status">
        {selectedLabels}
      </p>
      <button
        className="studio-text-btn"
        type="button"
        onClick={() =>
          choose({ head: "original", upper: "original", lower: "original" })
        }
      >
        Reset to original
      </button>
      <div className="variation-actions">
        <PixelButton variant="ghost" onClick={() => onClose(false)}>
          Cancel
        </PixelButton>
        <PixelButton
          onClick={() => {
            doc.applyComposition(compose(selected));
            onClose(true);
          }}
        >
          Apply combination
        </PixelButton>
      </div>
    </section>
  );
}
