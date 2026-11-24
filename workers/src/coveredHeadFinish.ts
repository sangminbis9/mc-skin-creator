/** Omit display eyewear on source-preserved hoods, headscarves and helmets.
 * Analysis, validated eyes, and actual covering material remain unchanged. */
import { buildHeadwearPaint } from "../../shared/headwear";
import { headwearVisibleLandmarks } from "./headwearFootprint";
import { applyLockedHeadFinish } from "./lockedHeadFinish";
import type { RawImage } from "./png";
import type { ReferenceCompositionDiagnostic } from "./referenceStyleRenderer";
import type { SkinPresentation } from "./referenceStyleTemplates";
import { composeGlassesOverlay, type FaceStyle } from "./skinPack";
import type { SkinPlan } from "./skinPlan";
import { CLASSIC_LAYOUT, type BoxUV } from "./uvLayout";

export const COVERED_HEAD_FINISH = "covered_head_no_eyewear_v1" as const;

export function applyCoveredHeadFinish(input: RawImage, source: SkinPlan, style: FaceStyle, presentation: SkinPresentation,
  execution?: ReferenceCompositionDiagnostic): RawImage {
  const result = applyLockedHeadFinish(input, source, style, presentation, execution);
  if (style.glasses === "none") return result;
  const head = CLASSIC_LAYOUT.head;
  const at = (p: { face: keyof BoxUV; x: number; y: number }) => {
    const rect = head.overlay[p.face];
    return ((rect.y + p.y) * 64 + rect.x + p.x) * 4;
  };
  const plan = source.facePixelPlan;
  const protectedPaint = new Set(buildHeadwearPaint(style.hat, style.hatColor ?? "#303030", style.hatVisor, headwearVisibleLandmarks(plan))
    .filter(p => p.layer === "overlay").map(at));
  for (const p of execution?.surfaces ?? []) {
    if (p.part === "head" && p.layer === "overlay" && (p.owner === "covering" || p.owner === "hair")) protectedPaint.add(at(p));
  }
  for (const p of source.headIdentityPlan.ownership?.cells ?? []) {
    if (p.layer === "outer" && p.owner === "other_p5") protectedPaint.add(at(p));
  }
  const fringe = new Set((source.headIdentityPlan.ownership?.cells ?? [])
    .filter(p => p.layer === "outer" && p.owner === "covering").map(at));
  const paint: RawImage = { ...result, rgba: new Uint8Array(result.rgba.length) };
  composeGlassesOverlay(paint, style);
  const remove = new Set([...plan.glassesPlan.framePixels, ...plan.glassesPlan.sideArms].map(at));
  if (style.glasses === "sunglasses") for (const p of plan.glassesPlan.lensOpenings) remove.add(at({ ...p, face: "front" }));
  for (const [face, xs] of [["right", [6, 7]], ["left", [0, 1]]] as const) {
    for (const x of xs) remove.add(at({ face, x, y: 3 }));
  }
  for (let i = 0; i < paint.rgba.length; i += 4) if (paint.rgba[i + 3]) remove.add(i);
  for (const i of remove) {
    // Outside the named eyeglass owner, real cloth is authoritative. For
    // unresolved coverings only the exact legacy eyewear paint can override it.
    if (protectedPaint.has(i)) continue;
    if (fringe.has(i) && (!paint.rgba[i + 3] || !paint.rgba.subarray(i, i + 4).every((v, c) => v === result.rgba[i + c]))) continue;
    result.rgba.fill(0, i, i + 4);
  }
  return result;
}
