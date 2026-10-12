// Test-only reproduction of the former whole-group collision policy. Never
// used by production. Allows immutable live output to remain an exact baseline.
import { vi } from "vitest";
import * as looseHair from "../src/referenceLooseHair";
import { sourceAccessoryStencils } from "../src/referenceOutfitRetention";

export function historicalLooseHairCollision() {
  const current = looseHair.buildReferenceLooseHair;
  return vi.spyOn(looseHair, "buildReferenceLooseHair").mockImplementation((source, design, style) => {
    const result = current({ ...source, outfitPlan: { ...source.outfitPlan, accessories: [] } }, design, style);
    const reserved = sourceAccessoryStencils(source.outfitPlan, style.skinTone ?? "#d39e80").flatMap(s => s.paints);
    const conflicts = new Set(result.points.filter(p => reserved.some(c => c.part === "body" && c.face === p.face && c.x === p.x && c.y === p.y)).map(p => p.drapeGroup));
    result.points = result.points.filter(p => !conflicts.has(p.drapeGroup));
    result.roots = result.roots.filter(p => !conflicts.has(p.drapeGroup));
    if (!result.points.some(p => p.face === "front")) result.frontEvidence = null;
    if (!result.points.some(p => p.face === "back")) result.rearEvidence = null;
    return result;
  });
}
