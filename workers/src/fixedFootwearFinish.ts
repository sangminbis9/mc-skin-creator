/** Refines the existing footwear paint, never adding a pixel or a shoe row. */
import { paintFootwearBase, paintFootwearRelief } from "../../shared/footwearFinish";
import { photoMaterialRamp, type MaterialRgb } from "./fixedMaterialPalette";
import type { OutfitPlan } from "./outfitIdentity";
import type { RawImage } from "./png";
import { CLASSIC_LAYOUT, type Rect } from "./uvLayout";

export function refineFixedFootwear(atlas: RawImage, lower: OutfitPlan["lower"]): number {
  const start = Math.max(lower.garmentRows, 12 - lower.shoeRows);
  if (start >= 12 || lower.shoeStyle === "sandals" || !/^#[0-9a-f]{6}$/i.test(lower.shoeColor)) return 0;
  const pigment: MaterialRgb = [1, 3, 5].map(i => parseInt(lower.shoeColor.slice(i, i + 2), 16)) as [number, number, number];
  const ramp = photoMaterialRamp(pigment, "shoe");
  const prior = new Uint8Array(atlas.rgba.length);
  const faceNames = ["front", "right", "left", "back"] as const;
  let changed = 0;
  const paint = (r: Rect, x: number, y: number, color: MaterialRgb) => {
    const i = ((r.y + y) * 64 + r.x + x) * 4;
    // Only repaint an exact, opaque cell from the previous shoe recipe. A
    // trim/graphic borrowed by another stage stays in its original color.
    if (prior[i + 3] !== 255 || atlas.rgba[i + 3] !== 255 || !prior.subarray(i, i + 3).every((v, c) => v === atlas.rgba[i + c])) return;
    if (color.every((v, c) => v === atlas.rgba[i + c])) return;
    atlas.rgba.set(color, i);
    changed++;
  };

  for (const part of ["rightLeg", "leftLeg"] as const) {
    const box = CLASSIC_LAYOUT[part];
    paintFootwearBase(prior, box.base, pigment, start, lower.shoeStyle);
    paintFootwearRelief(prior, box.overlay, pigment, start);
    const shoeHasUpper = start < 10;
    // A continuous sole, not a stripe across exposed leg or a raised rim.
    const sole = ramp[0];
    for (const face of faceNames) {
      const rect = box.base[face];
      for (let y = start; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const inside = x > 0 && x < rect.w - 1;
        const row = rect.h - 1 - y;
        const level = row === 0 ? 0 : !inside ? 1
          : face === "front" && row === 1 ? 4
          : face === "front" && lower.shoeStyle === "sneakers" && shoeHasUpper && y === start ? 3
          : face === "back" ? 1 : 2;
        paint(rect, x, y, ramp[level]);
      }
    }
    for (let y = 0; y < box.base.bottom.h; y++) for (let x = 0; x < box.base.bottom.w; x++) paint(box.base.bottom, x, y, sole);
    if (start < 11) for (const x of [1, 2]) paint(box.overlay.front, x, 10, ramp[4]);
  }
  return changed;
}
