/** Bounded categorical short-fringe design. Never a measured hairline.
 * The generic semantic cap has two solid front rows regardless of edge/sweep.
 * Author only interior forehead openings in its second row; leave source
 * fringe instructions, crown/side seams and every facial/accessory cue intact.
 */
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";

export interface ReferenceShortFringe {
  provenance: "template_design";
  status: "authored" | "source_preserved";
  reason: "categorical_short_fringe" | "not_short_template" | "protected_source_mask" | "unsupported_fringe" | "foundation_incomplete" | "protected_cell";
  /** Authored skin windows, not newly observed source coordinates. */
  windows: Array<{ face: "front"; x: number; y: 1 }>;
}

export function buildReferenceShortFringe(source: SkinPlan, design: ReferenceStylePlan, style: FaceStyle): ReferenceShortFringe {
  const preserve = (reason: ReferenceShortFringe["reason"]): ReferenceShortFringe => ({ provenance: "template_design", status: "source_preserved", reason, windows: [] });
  if (!["short_shaggy_masculine", "short_soft_feminine"].includes(design.hair.family)) return preserve("not_short_template");
  const hair = source.hairPlan, head = source.headIdentityPlan.ownership, face = source.facePixelPlan;
  if (!head || head.execution !== "resolved" || head.covering || head.tiedMass || hair.surfaceOnly || hair.lengthClass !== "short"
    || hair.headMask.source !== "semantic_template" || !hair.headMask.semanticSilhouette
    || hair.structure.source !== "semantic_analysis" || head.cells.some(c => c.provenance === "validated_derived")
    || face.layout.geometryUsage.hairline
    || style.hat !== "none" || style.hairAccessory && style.hairAccessory !== "none") return preserve("protected_source_mask");
  // Do not substitute this shallow grammar for a long, absent, split or
  // otherwise unsupported fringe. Existing source categories remain intact.
  if (style.bangsLength !== "short" || style.fringeOpening !== "none" || style.bangs !== hair.fringe
    || !["straight", "side", "wispy"].includes(hair.fringe) || !["blunt", "staggered", "wispy"].includes(style.fringeEdge ?? "")) return preserve("unsupported_fringe");
  let xs: number[];
  // Only the central pair is design space: lateral interior cells can be
  // source brow reservations even when the generic hair mask covers them.
  if (hair.fringe === "wispy" || style.fringeEdge === "wispy") xs = [3];
  else if (hair.fringe === "side") xs = face.layout.fringeDirection === "right_swept" ? [3] : [4];
  else xs = style.fringeEdge === "staggered" ? [3, 4] : [];
  // The unmeasured central cap pair is the only replacement foundation.
  // No widening, new hair cell, lower tip or seam repair is authorized.
  if ([3, 4].some(x => !head.cells.some(c => c.face === "front" && c.layer === "base" && c.x === x && c.y === 1 && c.owner === "hair_base"))) return preserve("foundation_incomplete");
  const windows = xs.map(x => ({ face: "front" as const, x, y: 1 as const }));
  // P5 hairline salience remains protected by the actual source fringe
  // instructions. It does not turn the generic, unclaimed extra cap row into
  // measured geometry. Never erase even one explicit fringe/landmark cell.
  if (windows.some(p => face.pixels.some(c => c.x === p.x && c.y === p.y)
    || head.cells.some(c => c.face === "front" && c.layer === "outer" && c.x === p.x && c.y === p.y
      && (c.owner !== "hair_outer" && c.owner !== "clear" || c.owner === "clear" && c.provenance !== "inferred")))) return preserve("protected_cell");
  return { provenance: "template_design", status: "authored", reason: "categorical_short_fringe", windows };
}
