import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";

/** Authored relief on the existing hair foundation, not a new root part,
 * scalp window or inferred measurement. Keep the smooth bob/long-hair rules
 * unless both tousled silhouette and staggered fringe were supplied.
 * Removal only: the compositor still requires source ownership, seam support
 * and its unchanged whole-run budget for every retained raised cell.
 */
export function retainLayeredCrownAccent(
  face: string, x: number, y: number, plan: SkinPlan, design: ReferenceStylePlan, style: FaceStyle,
): boolean {
  const hair = plan.hairPlan, ownership = plan.headIdentityPlan.ownership;
  const eligible = design.hair.family === "medium_layered" && hair.lengthClass === "medium"
    && style.hairSilhouette === "tousled" && style.fringeEdge === "staggered"
    && !hair.surfaceOnly && hair.headMask.source === "semantic_template"
    && hair.structure.source === "semantic_analysis"
    && !ownership?.covering && !ownership?.tiedMass
    && !plan.facePixelPlan.layout.geometryUsage.hairline
    && !ownership?.cells.some(c => c.provenance === "validated_derived");
  return !(eligible && face === "front" && y === 0 && (x === 3 || x === 4));
}
