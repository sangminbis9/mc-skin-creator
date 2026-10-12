import type { BoxUV } from "./uvLayout";
import type { FacePixelInstruction, FaceLayoutPlan } from "./identityPlans";

/** Existing cap/beanie painter's bounded footprint, shared with ownership.
 * This is not a full headscarf: side locks, nape and face remain independent.
 */
export function headwearFootprint(hat: string): Array<{ face: keyof BoxUV; x: number; y: number; shade: number }> {
  if (hat !== "cap" && hat !== "beanie") return [];
  const cells: Array<{ face: keyof BoxUV; x: number; y: number; shade: number }> = [];
  for (const face of ["top", "front", "right", "left", "back"] as const) {
    const rows = face === "top" ? 8 : hat === "beanie" || face === "front" ? 3 : 2;
    for (let y = 0; y < rows; y++) for (let x = 0; x < 8; x++)
      cells.push({ face, x, y, shade: face !== "top" && y === 2 ? 0.8 : 1 });
  }
  return cells;
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
