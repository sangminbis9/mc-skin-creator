import type { FacePixelInstruction, FaceLayoutPlan, FacePixelPlan } from "./identityPlans";
import { headwearFootprint } from "../../shared/headwear";
export { headwearFootprint } from "../../shared/headwear";

/** An unusually high measured eye/frame establishes a real opening in a
 * soft hat. Opaque helmet material deliberately has different semantics. */
export function headwearVisibleLandmarks(plan?: FacePixelPlan) {
  return [
    ...(plan?.pixels.filter(p => ["left_eye", "right_eye", "glasses", "mouth"].includes(p.cluster)).map(p => ({ face: "front" as const, x: p.x, y: p.y })) ?? []),
    ...(plan?.glassesPlan.framePixels ?? []), ...(plan?.glassesPlan.sideArms ?? []),
  ];
}

/** Material occlusion of authored categorical brows, not deletion of source
 * brow evidence. Actual measured/protected layouts remain authoritative.
 * Only the shared cap/beanie footprint can claim these paint instructions;
 * hair, scarves, unknown hats and visible brows outside it are unaffected.
 */
export function categoricalHeadwearBrowOcclusion(
  hat: string, pixels: readonly FacePixelInstruction[], layout: FaceLayoutPlan,
): Array<{ x: number; y: number }> {
  if (layout.geometryUsage.brows !== false || layout.protectedGeometry.includes("eye_layout")
    || layout.renderContract.eyes?.protected) return [];
  const covered = new Set(headwearFootprint(hat).filter(p => p.face === "front").map(p => `${p.x}:${p.y}`));
  return pixels.filter(p => p.role === "brow" && Number.isInteger(p.x) && Number.isInteger(p.y)
    && covered.has(`${p.x}:${p.y}`)
    && !pixels.some(q => q.x === p.x && q.y === p.y && q.role !== "brow"))
    .map(({ x, y }) => ({ x, y }));
}
