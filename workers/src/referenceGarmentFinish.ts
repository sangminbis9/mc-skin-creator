/** Designed cloth folds on source-authorized material, not photographic noise.
 * Plain garment interiors only: no skin, pattern, neckline, edge or shoe paint.
 * The default production painter is unchanged; this is reference composition.
 */
import type { RawImage } from "./png";
import type { OutfitPlan } from "./outfitIdentity";
import { CLASSIC_LAYOUT, type BodyPart, type BoxUV } from "./uvLayout";

type Rgb = [number, number, number];
type VerticalFace = "front" | "right" | "left" | "back";
export interface ReferenceGarmentFold {
  part: Exclude<BodyPart, "head">;
  face: VerticalFace;
  x: number;
  y: number;
  sourceColor: Rgb;
  color: Rgb;
}
const faceShade: Record<VerticalFace, number> = { front: 1, right: 0.86, left: 0.92, back: 0.78 };
const verticalFaces: VerticalFace[] = ["front", "right", "left", "back"];
function rgb(hex: string): Rgb | null {
  return /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb : null;
}
const shade = (color: Rgb, factor: number): Rgb => color.map(v => Math.min(255, Math.max(0, Math.round(v * factor)))) as Rgb;

/** A paired, continuous highlight/shadow fold stays inside the cloth segment.
 * Constant edge rows/columns keep physical seams and source boundaries intact.
 * Coordinates come from the garment plan, never RGB-based hair ownership.
 */
export function referenceGarmentFoldPlan(plan: OutfitPlan, clustered = false): ReferenceGarmentFold[] {
  const paints: ReferenceGarmentFold[] = [];
  function segment(part: ReferenceGarmentFold["part"], from: number, end: number, hex: string, allowedFaces: readonly VerticalFace[] = verticalFaces) {
    const material = rgb(hex);
    if (!material) return;
    const box: BoxUV = CLASSIC_LAYOUT[part].base;
    for (const face of allowedFaces) {
      const r = box[face], start = Math.max(1, Math.ceil(from)), stop = Math.min(r.h - 1, Math.floor(end));
      if (stop - start < 2) continue;
      const sourceColor = shade(material, faceShade[face]);
      // White cloth has no highlight headroom. Use a quiet two-step inward
      // crease instead of clipping the lit ridge to the same white plateau.
      // This is a material ramp, not extra texture or a craft-score adjustment.
      const whiteCloth = sourceColor.every(channel => channel >= 224);
      // Near-black material needs a small reflected-light ridge: multiplying
      // its channels by 1.08 barely changes the visible cloth at this scale.
      // A neutral lift retains the source hue; the trough stays dark. These
      // are two continuous planes, not scattered texture/high-frequency noise.
      const darkCloth = Math.max(...sourceColor) <= 64;
      const broadTorso = part === "body" && r.w > 4;
      const colors: readonly [Rgb, Rgb] = whiteCloth
        ? [shade(sourceColor, 0.90), shade(sourceColor, 0.84)]
        : darkCloth
          ? [sourceColor.map(v => v + (broadTorso ? 6 : clustered ? 8 : 16)) as Rgb, shade(sourceColor, clustered ? 0.90 : broadTorso ? 0.85 : 0.50)]
          : [shade(sourceColor, 1.08), shade(sourceColor, 0.90)];
      // Broad torso faces need a quiet center plane. A long adjacent pair at
      // x=3/4 reads as an invented placket/tie on otherwise plain knitwear.
      // Place its light/shadow planes just inside the side contours instead;
      // the same source ramp and all seam/print/structural guards still apply.
      const left = broadTorso ? 1 : Math.max(1, Math.floor(r.w / 2) - 1);
      const right = broadTorso ? r.w - 2 : Math.min(r.w - 2, left + 1);
      if (left === right) continue;
      for (let y = start; y < stop; y++) for (const [x, color] of [[left, colors[0]], [right, colors[1]]] as const) {
        // Two-cell shoulder/cuff and knee/hem folds leave a quiet material
        // interval between them. Never draw a full-height barcode or a new
        // central placket. Boundaries still come from the actual garment.
        if (clustered && stop - start >= 5 && y >= start + 2 && y < stop - 2) continue;
        paints.push({ part, face, x, y, sourceColor, color });
      }
    }
  }
  // The canonical "all" block declares the base itself, not an inset motif.
  // Actual color-blocked/layered torso panels and openings stay untouched.
  const insetBlocks = plan.upper.colorBlocks.filter(b => b.region !== "all" || b.color.toLowerCase() !== plan.upper.baseColor.toLowerCase());
  const printedFaces = plan.upper.pattern.kind === "none" || (plan.upper.pattern.surfaceParts && !plan.upper.pattern.surfaceParts.includes("body")) ? verticalFaces
    : plan.upper.pattern.placement === "front" ? verticalFaces.filter(f => f !== "front") : [];
  // Canonical inset regions are front-only; an opening does not turn a plain
  // jacket back into a printed panel. A non-nominal "all" declaration remains
  // conservatively excluded. Exact source-fill checking still protects paint.
  const bodyFaces = insetBlocks.some(b => b.region === "all") ? []
    : printedFaces.filter(f => f !== "front" || insetBlocks.length === 0);
  segment("body", Math.max(2, plan.upper.neckline.depth + 1), (plan.upper.hem?.endRow ?? plan.lower.waistRow) - 1, plan.upper.baseColor, bodyFaces);
  // Torso color blocks do not paint sleeves. A front-only torso graphic does
  // not authorize treating the sleeves as printed, or discarding their folds.
  for (const [part, sleeve] of [["rightArm", plan.upper.rightSleeve], ["leftArm", plan.upper.leftSleeve]] as const) {
    const faces = plan.upper.pattern.surfaceParts
      ? plan.upper.pattern.surfaceParts.includes(part) ? verticalFaces.filter(f => f !== "front") : verticalFaces
      : plan.upper.pattern.kind === "none" || plan.upper.pattern.placement === "front" ? verticalFaces : [];
    segment(part, 1, sleeve.terminationRow - 1, sleeve.color, faces);
  }
  const lowerFaces = plan.lower.pattern.kind === "none" ? verticalFaces
    : plan.lower.pattern.placement === "front" ? verticalFaces.filter(f => f !== "front") : [];
  for (const part of ["rightLeg", "leftLeg"] as const) {
    // Lower cloth precedes exposure/legwear/shoes. Ending before that boundary
    // prevents a fold from lengthening a skirt or manufacturing covered skin.
    const end = Math.min(12 - plan.lower.shoeRows, plan.lower.garmentRows) - 1;
    const faces = plan.lower.pattern.surfaceParts && !plan.lower.pattern.surfaceParts.includes(part) ? verticalFaces : lowerFaces;
    segment(part, 1, end, plan.lower.baseColor, faces);
  }
  return paints;
}

export function applyReferenceGarmentFinish(atlas: RawImage, plan: OutfitPlan, clustered = false): ReferenceGarmentFold[] {
  if (atlas.width !== 64 || atlas.height !== 64 || atlas.rgba.length !== 16384) throw new Error("reference_garment_finish_atlas_invalid");
  const changed: ReferenceGarmentFold[] = [];
  for (const p of referenceGarmentFoldPlan(plan, clustered)) {
    const r = CLASSIC_LAYOUT[p.part].base[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
    // An exact source fill check protects any existing structural decoration.
    // This is not an arbitrary palette tolerance or an ownership classifier.
    if (atlas.rgba[i + 3] !== 255 || p.sourceColor.some((v, ch) => atlas.rgba[i + ch] !== v)) continue;
    if (p.color.every((v, ch) => v === atlas.rgba[i + ch])) continue;
    atlas.rgba.set(p.color, i); changed.push(p);
  }
  return changed;
}
