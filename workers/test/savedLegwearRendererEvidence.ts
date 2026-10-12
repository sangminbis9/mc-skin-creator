import { expect } from "vitest";
import type { RawImage } from "../src/png";
import type { OutfitPlan } from "../src/outfitIdentity";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

/** Immutable live PNG vs current saved-plan renderer. Only the deliberate
 * legwear redesign and its connected skirt-pleat layer routing may differ.
 * This is NOT historical renderer byte equality or new live evidence.
 */
export function verifyLegwearRedesign(actual: RawImage, current: RawImage, plan: OutfitPlan): number {
  const legs = [CLASSIC_LAYOUT.leftLeg, CLASSIC_LAYOUT.rightLeg].flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
  // skirt_pleats draws its torso anchor at body.h - 3; moving a whole seam
  // group between layers can also change that anchor and its bottom partners.
  const hems = plan.outerLayer.regions.includes("skirt_pleats")
    ? [CLASSIC_LAYOUT.body.base, CLASSIC_LAYOUT.body.overlay].flatMap(box => {
      const start = Math.min(plan.lower.waistRow, box.front.h - 3);
      return [box.bottom, ...[box.front, box.back, box.left, box.right].map(r => ({ ...r, y: r.y + start, h: r.h - start }))];
    }) : [];
  let changes = 0;
  for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== current.rgba[i * 4 + ch])) {
    expect([...legs, ...hems].some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h), `unrelated historical change ${i}`).toBe(true);
    changes++;
  }
  return changes;
}
