/** Authored crown relief, not a new photographic measurement. Two connected
 * lock groups over an existing hair foundation, never an inflated full cap. */
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import { headMaterialPoint } from "./referenceMaterialDetail";
import type { BoxUV } from "./uvLayout";

type Point = { face: keyof BoxUV; x: number; y: number };
type Rgb = [number, number, number];
export function hasReferenceHairVolume(plan: SkinPlan, design: ReferenceStylePlan, style?: FaceStyle): boolean {
  const hair = plan.hairPlan, head = plan.headIdentityPlan.ownership;
  return !!design.hairVolumePolicy && !!head && head.execution === "resolved"
    && ["short_shaggy_masculine", "short_soft_feminine", "medium_layered", "long_straight_with_bangs", "long_wavy_with_bangs", "long_pastel_straight"].includes(design.hair.family)
    && !head.covering && !head.tiedMass && !hair.surfaceOnly && hair.lengthClass !== "none"
    && hair.headMask.source === "semantic_template" && !plan.facePixelPlan.layout.geometryUsage.hairline
    && !head.cells.some(c => c.provenance === "validated_derived") && style?.hat === "none"
    && style.sideHairShape !== "undercut" && style.hairBackShape !== "undercut";
}

/** UV top y=0 meets back y=0 with reversed x. Keep each bundle atomic so
 * accessory clipping or a full budget cannot leave disconnected scalp dots. */
export function referenceHairVolumeGroups(style: Pick<FaceStyle, "hairPart">): Point[][] {
  const lanes = style.hairPart === "left" ? [[1], [4, 5]] : style.hairPart === "right" ? [[2, 3], [6]] : [[1, 2], [5, 6]];
  return lanes.map(xs => xs.flatMap((x, n) => [
    ...Array.from({ length: n === 0 ? 4 : 3 }, (_, y) => ({ face: "top" as const, x, y })),
    ...Array.from({ length: n === 0 ? 4 : 3 }, (_, y) => ({ face: "back" as const, x: 7 - x, y })),
  ]));
}

/** Broad crown light, recessed part and a tapered rear reflection. Physical
 * coordinates make top/back seam colors identical. Front/side/nape boundary
 * pixels are deliberately unchanged; this is not a new dye or hairline. */
export function referenceHairVolumeColor(current: Rgb, pigment: Rgb, p: Point, style: Pick<FaceStyle, "hairPart">, outer = false,
  policy: ReferenceStylePlan["hairVolumePolicy"] = "crown_relief_v1"): Rgb {
  const [u, v, z] = headMaterialPoint(p.face, p.x, p.y);
  if (u === 0 || u === 7 || z === 0 || v >= 6 || (p.face !== "top" && p.face !== "back")) return current;
  const root = style.hairPart === "left" ? 2 : style.hairPart === "right" ? 5 : 3.5;
  const distance = Math.abs(u - root);
  if (policy === "flowing_crown_v2") {
    // A stepped reflection wraps the crown/back seam in physical coordinates.
    // Blend into the existing lock material instead of replacing it with two
    // flat rectangular panels. This is authored shading, not measured geometry.
    const travel = 7 - z + v;
    const lane = Math.floor(distance);
    const start = 1 + lane % 2, end = start + 2;
    const reflected = distance >= 1 && travel >= start && travel <= end;
    const factor = distance < 1 ? .82 : reflected ? 1.12 : v >= 4 ? .88 : .98;
    const light = reflected ? Math.max(0, 9 - Math.max(...pigment) * .03) : 0;
    return pigment.map((c, i) => Math.max(0, Math.min(255,
      Math.round(current[i] * .55 + (c * factor + light + (outer ? 2 : 0)) * .45)))) as Rgb;
  }
  const ridge = distance >= 1 && distance <= 2.5;
  const crown = v === 0 && z >= 2 && z <= 6;
  const rear = z === 7 && v >= 1 && v <= 3;
  const factor = distance < 1 ? 0.80 : ridge && (crown || rear) ? 1.13 : v >= 4 ? 0.88 : 0.98;
  const reflection = ridge && (crown || rear) ? Math.max(0, 10 - Math.max(...pigment) * 0.025) : 0;
  return pigment.map(c => Math.max(0, Math.min(255, Math.round(c * factor + reflection + (outer ? 3 : 0))))) as Rgb;
}
