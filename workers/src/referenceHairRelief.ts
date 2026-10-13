/** Raised connected fringe inspired by supplied skins, not new photographic
 * evidence. No demographic inference, bitmap copying, RNG or provider calls. */
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { RawImage } from "./png";
import type { FacePixelPlan } from "./identityPlans";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import { REFERENCE_OUTER_COVERAGE } from "./referenceStyleTemplates";
import type { HeadProportionPaint, ReferenceHeadProportion } from "./referenceHeadProportion";
import { hasReferenceHairVolume } from "./referenceHairVolume";
import { referenceHairMaterial } from "./referenceMaterialDetail";
import { CLASSIC_LAYOUT, type BoxUV } from "./uvLayout";

type Point = { face: keyof BoxUV; x: number; y: number };
const key = (p: Point) => `${p.face}:${p.x}:${p.y}`;
export function buildReferenceHairRelief(source: SkinPlan, design: ReferenceStylePlan, style: FaceStyle,
  foundation: RawImage, projection: ReferenceHeadProportion, displayed: FacePixelPlan,
  foundationHair: readonly Point[]): HeadProportionPaint[] {
  if (design.hairDetailPolicy !== "eye_line_relief_v1" || !hasReferenceHairVolume(source, design, style)
    || projection.outline !== "semantic_continuation") return [];
  const head = source.headIdentityPlan.ownership!;
  const pigment = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
  const hair = pigment(style.hairColor!), skin = pigment(style.skinTone!);
  const result: HeadProportionPaint[] = [];
  const baseHair = new Set(foundationHair.map(key));
  for (const p of projection.paints) { if (p.role === "hair") baseHair.add(key(p)); else baseHair.delete(key(p)); }
  // Exposed short-hair ears are small base-layer skin windows, not floating
  // outer-layer flesh. Only source skin windows (unclaimed base or face-owned)
  // may be restored; explicitly owned source hair must never be carved away.
  // Mirroring is anatomical: right front edge is x7, left front edge is x0.
  if (source.hairPlan.lengthClass === "short" && ["visible", "partial"].includes(style.earExposure ?? "")) for (const face of ["right", "left"] as const) {
    const ear: Point[] = [];
    for (const distance of [1, 2]) for (const y of [5, 6]) {
      const p = { face, x: face === "right" ? 7 - distance : distance, y };
      const cell = head.cells.find(c => c.layer === "base" && key(c) === key(p));
      if (!cell || cell.owner === "face" && cell.provenance !== "validated_derived") ear.push(p);
    }
    if (ear.length < 2) continue;
    for (const c of ear) {
      if (head.cells.some(p => p.layer === "outer" && key(p) === key(c) && !["clear", "hair_outer"].includes(p.owner))) continue;
      const distance = face === "right" ? 7 - c.x : c.x;
      const shade = distance === 2 && c.y === 5 ? 0.90 : 1;
      result.push({ face, x: c.x, y: c.y, role: "skin", color: skin.map(v => Math.round(v * shade)) as [number, number, number] });
      baseHair.delete(key(c));
    }
  }
  const eyes = projection.eyes === "lower_narrow_pair" ? projection.eyePixels : displayed.pixels;
  const eyeTop = Math.min(...eyes.filter(p => p.role === "iris").map(p => p.y));
  if (!Number.isFinite(eyeTop)) return result;
  let occupied = 0;
  for (const r of Object.values(CLASSIC_LAYOUT.head.overlay)) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++)
    if (foundation.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3]) occupied++;
  const outerOwners = new Map(head.cells.filter(c => c.layer === "outer").map(c => [key(c), c]));
  const nonHair = head.cells.filter(c => c.layer === "outer" && !["hair_outer", "clear"].includes(c.owner)).filter(c => {
    const r = CLASSIC_LAYOUT.head.overlay[c.face]; return foundation.rgba[((r.y + c.y) * 64 + r.x + c.x) * 4 + 3] > 0;
  }).length;
  const existingHair = occupied - nonHair; // Includes already added crown/back relief.
  let added = 0;
  // Interior columns leave the existing seam-connected temple/crown/nape
  // accents intact. Whole contiguous locks end ABOVE the eyes; never a full cap.
  for (const x of [1, 2, 5, 6, 3, 4]) {
    const opening = source.facePixelPlan.layout.fringeOpening;
    if (opening === "center" && [3, 4].includes(x) || opening === "left" && x === 2 || opening === "right" && x === 5) continue;
    const tip = Math.min(4, eyeTop - 1, source.hairPlan.lengthClass === "short" && [3, 4].includes(x) ? 3 : 4);
    const group: HeadProportionPaint[] = [];
    for (let y = 1; y <= tip; y++) {
      const p = { face: "front" as const, x, y }, owner = outerOwners.get(key(p));
      // The old eye's generic face-window is no longer an eye after the
      // independently validated lower-eye projection. Explicit part/semantic
      // windows remain protected, as do every measured/accessory position.
      const oldEyeWindow = owner?.sourceGroupId === "face-window" && projection.eyes === "lower_narrow_pair";
      if (!baseHair.has(key(p)) || !owner || !["clear", "hair_outer"].includes(owner.owner)
        || /window/.test(owner.sourceGroupId) && !oldEyeWindow || owner.provenance === "validated_derived") break;
      group.push({ ...p, layer: "overlay", role: "hair",
        color: referenceHairMaterial(hair, p.face, x, y, style, true, design.materialDetailPolicy) });
    }
    if (group.length < 2) continue;
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const fresh = group.filter(p => !foundation.rgba[((front.y + p.y) * 64 + front.x + p.x) * 4 + 3]).length;
    if (occupied + fresh > Math.floor(384 * REFERENCE_OUTER_COVERAGE.head) || existingHair + added + fresh > baseHair.size) continue;
    occupied += fresh; added += fresh; result.push(...group);
  }
  if (design.hairProfilePolicy === "supported_profile_locks_v1") {
    // Short, stepped temple locks give side views depth without filling the
    // ear/nape or moving any physical seam. Attach to a continuous base-hair
    // crown, not a mandatory outer shell; whole bundles or none.
    for (const face of ["right", "left"] as const) {
      const points: Point[] = [];
      for (const distance of [1, 2]) for (let y = 1; y <= (distance === 1 ? 3 : 2); y++)
        points.push({ face, x: face === "right" ? 7 - distance : distance, y });
      if (!points.every(p => {
        const owner = outerOwners.get(key(p));
        return baseHair.has(key(p)) && owner && ["clear", "hair_outer"].includes(owner.owner)
          && !/window/.test(owner.sourceGroupId) && owner.provenance !== "validated_derived";
      })) continue;
      const rect = CLASSIC_LAYOUT.head.overlay[face];
      if (![1, 2].every(distance => baseHair.has(key({ face, x: face === "right" ? 7 - distance : distance, y: 0 })))) continue;
      const fresh = points.filter(p => !foundation.rgba[((rect.y + p.y) * 64 + rect.x + p.x) * 4 + 3]).length;
      if (occupied + fresh > Math.floor(384 * REFERENCE_OUTER_COVERAGE.head) || existingHair + added + fresh > baseHair.size) continue;
      occupied += fresh; added += fresh;
      result.push(...points.map(p => ({ ...p, layer: "overlay" as const, role: "hair" as const,
        color: referenceHairMaterial(hair, p.face, p.x, p.y, style, true, design.materialDetailPolicy) })));
    }
  }
  return result;
}
