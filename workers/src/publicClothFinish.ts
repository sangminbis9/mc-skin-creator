/** Public pixel-art lighting. Paint only last-writer-owned cloth; never infer
 * a pocket, fastening, logo, cuff, or a new garment from its colour. */
import type { OutfitPlan } from "./outfitIdentity";
import { renderOutfitFabricFoundation } from "./outfitRenderer";
import type { PhotoDrapeCell } from "./photoHairFinish";
import type { RawImage } from "./png";
import { referenceGarmentFoldPlan, type GarmentFinishPolicy } from "./referenceGarmentFinish";
import { buildReferenceScarfFinish } from "./referenceScarfFinish";
import type { StyledSurfaceCell } from "./referenceStyleConstraints";
import type { SkinPlan } from "./skinPlan";
import { CLASSIC_LAYOUT, getBoxUvSeams, type Rect } from "./uvLayout";

export const PUBLIC_CLOTH_POLICY = "material_fold_clusters_v1" as const;
const parts = ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const;
const faces = ["front", "right", "left", "back"] as const;
type Part = typeof parts[number];
type Face = typeof faces[number];
type Family = "jersey" | "knit" | "tailored" | "outerwear" | "denim" | "drape" | "stretch";
type Rgb = readonly [number, number, number];
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const at = (r: Rect, x: number, y: number) => ((r.y + y) * 64 + r.x + x) * 4;
const same = (rgba: Uint8Array, pos: number, rgb: Rgb) => rgba[pos] === rgb[0] && rgba[pos + 1] === rgb[1] && rgba[pos + 2] === rgb[2];

function upperFamily(plan: OutfitPlan): Family {
  const kind = plan.upper.garmentType;
  if (plan.formalSuit || kind === "shirt" || kind === "vest" && plan.upper.collar === "paired") return "tailored";
  if (kind === "dress_upper") return "drape";
  if (kind === "sweater") return "knit";
  if (kind === "jacket" || kind === "coat" || kind === "vest") return "outerwear";
  return "jersey";
}
function lowerFamily(plan: OutfitPlan): Family {
  switch (plan.lower.garmentType) {
    case "jeans": return "denim";
    case "skirt": case "dress_continuation": return "drape";
    case "leggings": return "stretch";
    case "pants": return "tailored";
    default: return "jersey";
  }
}

/** Use broad negative space and connected folds above joints/waist instead of
 * a repeated tile. Physical edges keep the existing face-light relationship. */
function clothTone(family: Family, part: Part, face: Face, x: number, y: number, width: number, start: number, end: number, pleated: boolean): number {
  const n = end - start, row = y - start, tail = end - 1 - y;
  if (n < 3 || row < 0 || tail < 0 || x === 0 || x === width - 1) return 0;
  const u = face === "back" ? width - 1 - x : x;
  const wide = part === "body" && width === 8;
  const bend = Math.floor(n * (part.endsWith("Arm") ? .58 : .52));
  if (wide) {
    if (family === "drape" && (part === "body" && start > 0 || pleated)) {
      if (tail === 0 || u === 2 && row >= 1 || u === 5 && row >= 1) return -1;
      return u === 1 || u === 4 && row >= 1 ? 1 : 0;
    }
    // No lit centre placket on a plain tee. Short shoulder/fold clusters leave
    // space for contrast with an observed opening or chest emblem.
    if (row <= 2 && (u === 1 || u === 2 && row !== 2 || u === 3 && row === 0)) return family === "knit" || family === "outerwear" ? 2 : 1;
    if (u >= 5 && row >= 2 && (row <= 4 || u === 6 && row <= 6)) return -1;
    if (tail <= 2 && tail >= 0) {
      if (tail <= 1 && (u <= 2 || u >= 5) || tail === 0 && family === "outerwear") return -2;
      if ((u === 2 || u === 3) && tail === 2) return 1;
    }
    if (family === "knit" && n > 6 && u === 2 && row >= 3 && tail >= 3) return 1;
    return 0;
  }
  if (family === "drape") {
    if (pleated && row >= 1) return u === (face === "back" ? 2 : 1) ? 1 : -1;
    if (tail === 0 || u === 2 && tail === 1) return -1;
    return row >= 1 && row <= 3 && u === 1 ? 1 : 0;
  }
  if (family === "denim") {
    if (row >= 1 && row <= bend && u === 1) return row <= 3 ? 2 : 1;
    if ((u === 2 && row === bend || row === bend + 1) && tail >= 2) return -1;
    if (tail === 2 && u === 2) return 1;
    return tail <= 1 ? -1 : 0;
  }
  if (family === "stretch") return u === 1 && row >= 1 && row <= bend ? 1 : u === 2 && row >= bend && tail > 0 ? -1 : 0;
  if (row < (family === "outerwear" ? 4 : 3) && (u === 1 || row === 0)) return family === "outerwear" ? 2 : 1;
  if (n >= 7 && (row === bend && u === 2 || row === bend + 1)) return -1;
  if (tail === 2 && u === 1 && n >= 5) return 1;
  if (tail <= 1 && (n < 5 || u === 2 || tail === 0)) return family === "knit" || family === "outerwear" ? -2 : -1;
  return 0;
}

function colorWithTone(rgb: Rgb, tone: number, family: Family): Rgb {
  const lightness = (rgb[0] * 2 + rgb[1] * 5 + rgb[2]) / 8;
  const strength = { jersey: .82, knit: 1.07, tailored: .81, outerwear: 1, denim: 1.07, drape: .88, stretch: .65 }[family];
  const amount = (tone > 0 ? Math.max(4, Math.min(14, (255 - lightness) * .105))
    : Math.max(3.5, Math.min(13, lightness * .07))) * tone * strength;
  // Restrained hue shift keeps the garment's dominant dye, even near black.
  return rgb.map((v, i) => byte(v + amount * (tone > 0 ? [1.06, 1, .91][i] : [1.04, 1, .90][i]))) as unknown as Rgb;
}

const seamPairs = parts.flatMap(part => {
  const box = CLASSIC_LAYOUT[part].base, s = getBoxUvSeams(box);
  return [...s.vertical, ...s.horizontal].flatMap(seam => seam.primary.map((p, i) => [p, seam.adjacent[i]].map(q => (q.y * 64 + q.x) * 4)));
});

export function applyPublicClothFinish(image: RawImage, source: SkinPlan, skin: string, legacy: GarmentFinishPolicy,
  drape: readonly PhotoDrapeCell[] = [], ownership: readonly StyledSurfaceCell[] = []): number {
  if (image.width !== 64 || image.height !== 64 || image.rgba.length !== 16384) return 0;
  const plan = source.outfitPlan;
  const { atlas: foundation, fabric } = renderOutfitFabricFoundation(plan, skin);
  const reserved = new Set<number>();
  const folded = new Map(referenceGarmentFoldPlan(plan, legacy).map(p => [at(CLASSIC_LAYOUT[p.part].base[p.face], p.x, p.y), p.color]));
  const upper = upperFamily(plan), lower = lowerFamily(plan);
  const pleated = plan.lower.pattern.kind === "vertical_stripe" && plan.lower.pattern.source === "observed";
  for (const p of [...buildReferenceScarfFinish(source, skin).paints, ...drape.map(c => ({ ...c, part: "body" as const })),
    ...ownership.filter(c => c.part !== "head" && c.owner !== "garment")]) {
    reserved.add(at(CLASSIC_LAYOUT[p.part].base[p.face], p.x, p.y));
  }
  let changed = 0;
  for (const part of parts) for (const face of faces) {
    const { base, overlay } = CLASSIC_LAYOUT[part];
    for (let y = 0; y < base[face].h; y++) for (let x = 0; x < base[face].w; x++) {
      const j = at(overlay[face], x, y);
      // Protect the authored accents even if a prior stage demoted them to the
      // base because of the outer budget. Keep the actual top layer unchanged.
      if (foundation.rgba[j + 3] || image.rgba[j + 3]) reserved.add(at(base[face], x, y));
    }
  }
  for (let i = 0; i < 3; i++) for (const [a, b] of seamPairs) if (reserved.has(a) || reserved.has(b)) { reserved.add(a); reserved.add(b); }
  for (const part of parts) for (const face of faces) {
    const r = CLASSIC_LAYOUT[part].base[face];
    const sleeve = part === "rightArm" ? plan.upper.rightSleeve : part === "leftArm" ? plan.upper.leftSleeve : undefined;
    for (let y = 0; y < r.h; y++) for (let x = 1; x < r.w - 1; x++) {
      const i = at(r, x, y), owner = fabric.get(i);
      if (!owner || reserved.has(i) || image.rgba[i + 3] !== 255) continue;
      const sourceColor: Rgb = [foundation.rgba[i], foundation.rgba[i + 1], foundation.rgba[i + 2]];
      const oldFold = folded.get(i);
      if (!same(image.rgba, i, sourceColor) && !(oldFold && same(image.rgba, i, oldFold))) continue;
      const family = owner === "upper" ? upper : lower;
      const start = part === "body" ? owner === "lower" ? plan.lower.waistRow
        : face === "front" ? Math.min(2, plan.upper.neckline.depth) : 1 : 0;
      const end = part === "body" ? owner === "lower" ? r.h : Math.min(plan.upper.hem?.endRow ?? r.h, plan.lower.waistRow)
        : sleeve ? sleeve.terminationRow : Math.min(plan.lower.garmentRows, r.h - plan.lower.shoeRows);
      const tone = clothTone(family, part, face, x, y, r.w, start, end, pleated);
      // Clear previous long strip highlights where the new cluster leaves a
      // quiet plane. Never paint nonexistent fabric, alpha or shoe rows.
      const color = tone ? colorWithTone(sourceColor, tone, family) : sourceColor;
      if (same(image.rgba, i, color)) continue;
      image.rgba.set(color, i); changed++;
    }
  }
  return changed;
}
