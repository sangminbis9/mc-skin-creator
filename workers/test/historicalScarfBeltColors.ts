// Test-only inverse of the reviewed material change; never rewrites evidence.
import { expect } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { RawImage } from "../src/png";
import { sourceAccessoryStencils } from "../src/referenceOutfitRetention";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";

export function historicalScarfBeltPlan(plan: SkinPlan): SkinPlan {
  const result = structuredClone(plan), outfit = result.outfitPlan;
  const repaired = new Set(outfit.provenance.filter(p => /^accessories\.(scarf|belt)\.color$/.test(p.target)).map(p => p.target.split(".")[1]));
  for (const accessory of outfit.accessories) if (repaired.has(accessory.kind) && accessory.source === "observed")
    accessory.color = outfit.upper.accentColor;
  outfit.provenance = outfit.provenance.filter(p => !/^accessories\.(scarf|belt)\.color$/.test(p.target));
  return result;
}

export function assertAccessoryPaletteBoundary(before: RawImage, after: RawImage, plan: SkinPlan, skin: string, styled = false): number[] {
  const paints = sourceAccessoryStencils(plan.outfitPlan, skin).filter(s => /^accessory:(scarf|belt):/.test(s.id)).flatMap(s => s.paints);
  const allowed = new Set<number>();
  for (const layer of (styled ? ["base", "overlay"] : ["overlay"]) as ("base" | "overlay")[]) {
    for (const c of paints) {
      const r = CLASSIC_LAYOUT[c.part][layer][c.face]; allowed.add((r.y + c.y) * 64 + r.x + c.x);
    }
    // Existing seam reconciliation propagates only to physical partners of
    // accessory edge cells. This is not permission to repaint a whole UV face.
    for (const part of new Set(paints.map(c => c.part))) {
      const seams = getBoxUvSeams(CLASSIC_LAYOUT[part][layer]);
      for (let pass = 0; pass < 3; pass++) for (const seam of [...seams.vertical, ...seams.horizontal])
        seam.primary.forEach((p, i) => {
          const a = p.y * 64 + p.x, b = seam.adjacent[i].y * 64 + seam.adjacent[i].x;
          if (allowed.has(a) || allowed.has(b)) { allowed.add(a); allowed.add(b); }
        });
    }
  }
  const changed: number[] = [];
  for (let i = 0; i < 4096; i++) {
    expect(after.rgba[i * 4 + 3], `alpha:${i}`).toBe(before.rgba[i * 4 + 3]);
    if ([0, 1, 2].some(c => after.rgba[i * 4 + c] !== before.rgba[i * 4 + c])) {
      expect(allowed.has(i), `outside_accessory_or_seam:${i}`).toBe(true); changed.push(i);
    }
  }
  return changed;
}
