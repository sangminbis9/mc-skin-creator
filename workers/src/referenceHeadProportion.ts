/** A-H-inspired display proportions. This is an authored skin-space contract,
 * never a correction to provider observations or measured facial landmarks.
 * Historical designs without the policy retain their original pixels. */
import type { FacePixelInstruction, FacePixelPlan } from "./identityPlans";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { RawImage } from "./png";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import { facialHairBaseFootprint } from "./facialHairFootprint";
import { headMaterialPoint, referenceHairMaterial } from "./referenceMaterialDetail";
import { hasReferenceHairVolume, referenceHairVolumeColor } from "./referenceHairVolume";
import { CLASSIC_LAYOUT, type BoxUV } from "./uvLayout";

export interface HeadProportionPaint {
  face: keyof BoxUV;
  x: number; y: number;
  role: "skin" | "hair" | "iris" | "sclera";
  color: [number, number, number];
}
export interface ReferenceHeadProportion {
  version: "reference_head_proportion_v1";
  provenance: "template_design";
  eyes: "lower_narrow_pair" | "source_preserved";
  outline: "semantic_continuation" | "source_preserved";
  paints: HeadProportionPaint[];
  eyePixels: FacePixelInstruction[];
}
export function headProportionOffset(p: Pick<HeadProportionPaint, "face" | "x" | "y">): number {
  const r = CLASSIC_LAYOUT.head.base[p.face];
  return ((r.y + p.y) * 64 + r.x + p.x) * 4;
}
const hex = (s: string | undefined): [number, number, number] | undefined => s && /^#[0-9a-f]{6}$/i.test(s)
  ? [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) as [number, number, number] : undefined;
const shade = (c: readonly number[], n: number) => c.map(v => Math.max(0, Math.min(255, Math.round(v * n)))) as [number, number, number];

export function buildReferenceHeadProportion(source: SkinPlan, design: ReferenceStylePlan, style: FaceStyle,
  foundation: RawImage, displayed: FacePixelPlan,
  foundationHair: ReadonlyArray<{ face: keyof BoxUV; x: number; y: number }> = []): ReferenceHeadProportion {
  const result: ReferenceHeadProportion = { version: "reference_head_proportion_v1", provenance: "template_design",
    eyes: "source_preserved", outline: "source_preserved", paints: [], eyePixels: [] };
  if (design.headProportionPolicy !== "reference_low_eyes_v1") return result;
  const head = source.headIdentityPlan.ownership, hair = source.hairPlan, face = source.facePixelPlan;
  const skin = hex(style.skinTone), pigment = hex(style.eyeColor), hairColor = hex(style.hairColor);
  if (!head || head.execution !== "resolved" || !skin) return result;
  // A request-local index avoids scanning the entire head for every pixel of
  // every template candidate. Ownership and output colors are unchanged.
  const ownedIndex = new Map<string, typeof head.cells>();
  for (const c of head.cells) {
    const key = `${c.face}:${c.x}:${c.y}`, cells = ownedIndex.get(key) ?? [];
    cells.push(c); ownedIndex.set(key, cells);
  }
  const owned = (f: keyof BoxUV, x: number, y: number) => ownedIndex.get(`${f}:${x}:${y}`) ?? [];
  const beard = facialHairBaseFootprint(style);
  const blocked = (f: keyof BoxUV, x: number, y: number) => owned(f, x, y).some(c =>
    ["covering", "tied_hair", "other_p5", "glasses"].includes(c.owner) || c.provenance === "validated_derived")
    || f === "front" && beard.some(p => p.x === x && p.y === y);
  const outerClear = (f: keyof BoxUV, x: number, y: number) => {
    const r = CLASSIC_LAYOUT.head.overlay[f];
    return foundation.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3] === 0;
  };
  const paints = new Map<string, HeadProportionPaint>();
  const put = (f: keyof BoxUV, x: number, y: number, role: HeadProportionPaint["role"], color: [number, number, number]) => {
    if (!blocked(f, x, y)) paints.set(`${f}:${x}:${y}`, { face: f, x, y, role, color });
  };
  const sourceEyes = displayed.pixels.filter(p => ["left_eye", "right_eye"].includes(p.cluster) && p.role !== "brow");
  // Open categorical eyes use the references' one-column iris and external
  // sclera. Compact/closed/asymmetric/validated eyes and eyewear stay intact.
  const canProject = pigment && face.glassesPlan.topology === "none" && !face.layout.geometryUsage.eyes
    && !face.renderContract.eyes?.preserveAsymmetry && ["readable", "open"].includes(face.layout.eyeOpenness)
    && sourceEyes.some(p => p.cluster === "left_eye" && p.role === "iris")
    && sourceEyes.some(p => p.cluster === "right_eye" && p.role === "iris")
    && sourceEyes.every(p => !blocked("front", p.x, p.y) && outerClear("front", p.x, p.y))
    && [1, 2, 5, 6].every(x => [5, 6].every(y => !blocked("front", x, y) && outerClear("front", x, y)
      && !owned("front", x, y).some(c => c.layer === "base" && c.owner === "hair_base")));
  if (canProject) {
    result.eyes = "lower_narrow_pair";
    for (const p of sourceEyes) put("front", p.x, p.y, "skin", skin);
    // Also clear authored lash/catch cells; the caller's independently
    // reconstructed finish supplies these as part of the displayed contract.
    for (const [cluster, x, outerX] of [["left_eye", 2, 1], ["right_eye", 5, 6]] as const) for (const y of [5, 6]) {
      const iris = shade(pigment, y === 5 ? 0.65 : 1.2);
      put("front", x, y, "iris", iris);
      put("front", outerX, y, "sclera", y === 5 ? [224, 220, 213] : [246, 243, 235]);
      result.eyePixels.push({ x, y, role: "iris", cluster }, { x: outerX, y, role: "sclera", cluster });
    }
  }
  // Use source topology, not an all-head rectangular fill. Tight scalp hair,
  // curls, tied sections, headwear and measured silhouettes are not loose caps.
  const ordinary = ["short_shaggy_masculine", "short_soft_feminine", "medium_layered", "long_straight_with_bangs", "long_wavy_with_bangs", "long_pastel_straight"].includes(design.hair.family);
  if (hairColor && ordinary && !head.covering && !head.tiedMass && !hair.surfaceOnly && hair.lengthClass !== "none"
    && style.sideHairShape !== "undercut" && style.hairBackShape !== "undercut"
    && hair.headMask.source === "semantic_template" && !face.layout.geometryUsage.hairline
    && !head.cells.some(c => c.provenance === "validated_derived") && style.hat === "none") {
    result.outline = "semantic_continuation";
    const roots = head.cells.filter(c => c.layer === "base" && c.owner === "hair_base");
    const columns = new Map<string, typeof roots>();
    for (const c of roots) {
      const key = `${c.face}:${c.x}`, cells = columns.get(key) ?? [];
      cells.push(c); columns.set(key, cells);
    }
    for (const f of ["front", "right", "back", "left"] as const) for (let x = 0; x < 8; x++) {
      const column = columns.get(`${f}:${x}`) ?? [];
      // Some legacy side masks omit entire crown columns although the top
      // foundation is hair. Let that connected crown support the side cap.
      if (!column.length && (f === "front" || f === "back")) continue;
      const end = Math.max(-1, ...column.map(c => c.y));
      let target = end;
      if (f === "front") {
        if (!canProject || hair.fringe === "none") continue;
        const opening = face.layout.fringeOpening;
        const gap = opening === "center" && (x === 3 || x === 4) || opening === "left" && x === 2 || opening === "right" && x === 5;
        if (gap) continue;
        target = Math.min(4, end + 2);
      } else {
        // Right's front edge is x7; left's is x0. Keep the lower two-column
        // ear/cheek window instead of wrapping a solid cap across the face.
        const fromFront = f === "right" ? 7 - x : x;
        const nearFace = f !== "back" && fromFront <= 1;
        const shortProfile = f !== "back" && hair.lengthClass === "short";
        target = nearFace ? 4 : shortProfile ? Math.min(6, 3 + fromFront) : f === "back" ? Math.min(7, end + 2) : 7;
      }
      // Side templates formerly contained ear-shaped holes in the middle of
      // the cap. Complete one connected crown-to-tip mass, leaving the front
      // cheek window open; do not attach isolated tips below those holes.
      const start = f === "front" || f === "back" ? end + 1 : 0;
      for (let y = start; y <= target; y++) {
        if (blocked(f, x, y)) break;
        if (f === "front" && (face.layout.geometryUsage.brows && displayed.pixels.some(p => p.role === "brow" && p.x === x && p.y === y)
          || result.eyePixels.some(p => p.x === x && p.y === y))) break;
        // Extend an existing contiguous strand, with the same source pigment.
        put(f, x, y, "hair", design.materialDetailPolicy ? referenceHairMaterial(hairColor, f, x, y, style, false, design.materialDetailPolicy)
          : shade(hairColor, (1 - Math.min(y, 6) * 0.015) * (x % 4 === 1 ? 1.08 : 1)));
      }
    }
    if (design.headSeamPolicy === "connected_outline_v1") {
      // Reference skins wrap the SAME hair mass around cube edges, including
      // a narrow underside rim on long hair, while retaining a central neck.
      // Group the three texels at a corner together; pairwise copying would
      // depend on edge iteration order. Never infer hair ownership from RGB.
      const key = (p: { face: keyof BoxUV; x: number; y: number }) => `${p.face}:${p.x}:${p.y}`;
      const finalHair = new Set((foundationHair.length ? foundationHair : roots).map(key));
      for (const p of paints.values()) {
        if (p.role === "hair") finalHair.add(key(p)); else finalHair.delete(key(p));
      }
      const groups = new Map<string, Array<{ face: keyof BoxUV; x: number; y: number }>>();
      for (const f of ["front", "right", "back", "left", "top", "bottom"] as const)
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (x !== 0 && x !== 7 && y !== 0 && y !== 7) continue;
          const p = { face: f, x, y }, physical = headMaterialPoint(f, x, y).join(":");
          const group = groups.get(physical) ?? []; group.push(p); groups.set(physical, group);
        }
      for (const group of groups.values()) {
        if (!group.some(p => finalHair.has(key(p)))) continue;
        for (const p of group) {
          if (finalHair.has(key(p)) || p.face === "front" || blocked(p.face, p.x, p.y)) continue;
          // Do not close the face opening, ear/cheek window or a source-owned
          // explicit opening. Bottom interiors never enter these edge groups.
          if ((p.face === "right" && p.x >= 6 || p.face === "left" && p.x <= 1) && p.y >= 5) continue;
          if (owned(p.face, p.x, p.y).some(c => /window/.test(c.sourceGroupId))) continue;
          const material = referenceHairMaterial(hairColor, p.face, p.x, p.y, style, false, design.materialDetailPolicy);
          const color = hasReferenceHairVolume(source, design, style)
            ? referenceHairVolumeColor(material, hairColor, p, style) : material;
          put(p.face, p.x, p.y, "hair", color);
        }
      }
    }
  }
  // Eye paint takes priority over a fringe tip. No material is painted over
  // glasses, facial hair or real accessories, and no alpha/outer-shell edits.
  result.paints = [...paints.values()];
  return result;
}

export function applyReferenceHeadProportion(atlas: RawImage, plan: ReferenceHeadProportion): void {
  for (const p of plan.paints) atlas.rgba.set(p.color, headProportionOffset(p));
}

export function headProportionFaceContract(displayed: FacePixelPlan, p: ReferenceHeadProportion): FacePixelPlan {
  if (p.eyes === "source_preserved") return displayed;
  return { ...displayed, pixels: [...displayed.pixels.filter(c => !["left_eye", "right_eye"].includes(c.cluster) || c.role === "brow"), ...p.eyePixels] };
}
