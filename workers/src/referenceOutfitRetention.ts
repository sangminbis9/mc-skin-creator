/** Independent source accessory retention. Expected paints come from the
 * existing production OutfitPlan painter, never the candidate's diagnostics.
 * No RGB heuristic is used to decide ownership or to erase clothing as hair.
 */
import type { RawImage } from "./png";
import type { OutfitPlan } from "./outfitIdentity";
import { applyOutfitPlan } from "./outfitRenderer";
import { applyReferenceGarmentFinish } from "./referenceGarmentFinish";
import { CLASSIC_LAYOUT, type BodyPart, type BoxUV } from "./uvLayout";
import { getBoxUvSeams } from "./uvLayout";
import { OUTFIT_STYLE_TEMPLATES, type GarmentAccent, type ReferenceStylePlan } from "./referenceStyleTemplates";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "./referenceStyleConstraints";

export interface SourceAccessoryPaint {
  part: BodyPart;
  face: keyof BoxUV;
  x: number;
  y: number;
  color: [number, number, number];
}
export interface SourceAccessoryStencil {
  id: string;
  /** Empty if the current production painter has no executable footprint. */
  paints: SourceAccessoryPaint[];
}
const parts = (Object.keys(CLASSIC_LAYOUT) as BodyPart[]).filter(p => p !== "head");
const coordinateKey = (c: SourceAccessoryPaint) => `${c.part}:${c.face}:${c.x}:${c.y}`;
const colorKey = (rgb: readonly number[]) => rgb.join(":");
function overlayPaints(image: RawImage): SourceAccessoryPaint[] {
  const paints: SourceAccessoryPaint[] = [];
  for (const part of parts) for (const face of Object.keys(CLASSIC_LAYOUT[part].overlay) as (keyof BoxUV)[]) {
    const r = CLASSIC_LAYOUT[part].overlay[face];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * 64 + r.x + x) * 4;
      if (image.rgba[i + 3]) paints.push({ part, face, x, y, color: [...image.rgba.slice(i, i + 3)] as [number, number, number] });
    }
  }
  return paints;
}
/** Source-only physical corner closure. A later construction may cover a seam
 * partner as well as its originally authored pixel; candidate labels cannot
 * manufacture these occlusion positions.
 */
// Only fixed UV coordinate pairs are shared between calls. Source paints,
// palettes, occlusion and validation results remain request-local. Preserve
// the original seam order and three closure passes, including corner links.
const sourceSeamPairs = Object.freeze(parts.map(part => {
    const uv = CLASSIC_LAYOUT[part].overlay, seams = getBoxUvSeams(uv);
    const locate = (p: { x: number; y: number }): string => {
      for (const face of Object.keys(uv) as (keyof BoxUV)[]) {
        const r = uv[face];
        if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return `${part}:${face}:${p.x - r.x}:${p.y - r.y}`;
      }
      throw new Error("reference_garment_seam_outside_uv");
    };
    return Object.freeze([...seams.vertical, ...seams.horizontal].flatMap(seam =>
      seam.primary.map((p, index) => Object.freeze([locate(p), locate(seam.adjacent[index])] as const))));
}));
function closedSourcePositions(paints: readonly SourceAccessoryPaint[]): Set<string> {
  const positions = new Set(paints.map(coordinateKey));
  if (!positions.size) return positions;
  for (const pairs of sourceSeamPairs) {
    for (let pass = 0; pass < 3; pass++) for (const [a, b] of pairs) {
      if (positions.has(a) || positions.has(b)) { positions.add(a); positions.add(b); }
    }
  }
  return positions;
}
export function sourceAccessoryStencils(plan: OutfitPlan, skin: string): SourceAccessoryStencil[] {
  return plan.accessories.map((accessory, index) => {
    const image: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    // large_pocket is represented by the production pocket construction,
    // rather than its otherwise empty accessory placeholder.
    applyOutfitPlan(image, { ...plan, accessories: [accessory], outerLayer: { ...plan.outerLayer, regions: accessory.kind === "large_pocket" ? ["pocket"] : [] } }, skin);
    return { id: `accessory:${accessory.kind}:${index}`, paints: overlayPaints(image) };
  });
}
export interface AccessoryRetention {
  valid: boolean;
  violations: string[];
  cues: Array<{ id: string; sourcePixels: number; visibleSourcePixels: number; retainedPixels: number; basePixels: number; outerPixels: number; coveredByLaterSourceAccessory: number }>;
}
export function measureReferenceAccessoryRetention(atlas: RawImage, plan: OutfitPlan, skin: string): AccessoryRetention {
  const errors = new Set<string>(), cues: AccessoryRetention["cues"] = [];
  if (atlas.width !== 64 || atlas.height !== 64 || atlas.rgba.length !== 16384) return { valid: false, violations: ["accessory_atlas_invalid"], cues };
  const stencils = sourceAccessoryStencils(plan, skin);
  for (const [index, stencil] of stencils.entries()) {
    const later = new Set(stencils.slice(index + 1).flatMap(s => s.paints.map(coordinateKey)));
    const visible = stencil.paints.filter(c => !later.has(coordinateKey(c)));
    const palette = new Set(stencil.paints.map(c => colorKey(c.color)));
    let retainedPixels = 0, basePixels = 0, outerPixels = 0;
    for (const c of visible) {
      const outer = CLASSIC_LAYOUT[c.part].overlay[c.face], base = CLASSIC_LAYOUT[c.part].base[c.face];
      const o = ((outer.y + c.y) * 64 + outer.x + c.x) * 4, b = ((base.y + c.y) * 64 + base.x + c.x) * 4;
      // The actual visible layer wins. A hidden base accessory is not retained
      // merely because its color remains underneath opaque garment construction.
      const isOuter = atlas.rgba[o + 3] === 255, i = isOuter ? o : b;
      const color = [...atlas.rgba.slice(i, i + 3)];
      // Front topology/color is a signature. Wrapping seam partners may use
      // another exact shade already authored for this same source accessory.
      const matches = c.face === "front" ? colorKey(color) === colorKey(c.color) : palette.has(colorKey(color));
      if (atlas.rgba[i + 3] === 255 && matches) { retainedPixels++; if (isOuter) outerPixels++; else basePixels++; }
    }
    if (!stencil.paints.length || !visible.length) errors.add(`source_accessory_unrenderable:${stencil.id}`);
    if (retainedPixels !== visible.length) errors.add(`source_accessory_missing:${stencil.id}`);
    cues.push({ id: stencil.id, sourcePixels: stencil.paints.length, visibleSourcePixels: visible.length, retainedPixels, basePixels, outerPixels, coveredByLaterSourceAccessory: stencil.paints.length - visible.length });
  }
  return { valid: !errors.size, violations: [...errors].sort(), cues };
}

export interface GarmentStructureRetention {
  valid: boolean;
  violations: string[];
  cues: Array<{ id: string; sourcePixels: number; visibleSourcePixels: number; retainedPixels: number; coveredBySourceConstruction: number }>;
}

/** Independent source primitives remain mandatory even if a candidate deletes
 * an entire group from its diagnostics. Selective outer/base routing may move
 * the cue to another layer, not erase its observable construction signature.
 */
export function measureReferenceGarmentStructure(
  atlas: RawImage, plan: OutfitPlan, skin: string, design: ReferenceStylePlan,
  groups: readonly { id: string; placement: "outer_structure" | "base_anchor" }[],
  scarfPaints: readonly SourceAccessoryPaint[] = [],
): GarmentStructureRetention {
  const errors = new Set<string>(), cues: GarmentStructureRetention["cues"] = [];
  if (atlas.width !== 64 || atlas.height !== 64 || atlas.rgba.length !== 16384) return { valid: false, violations: ["garment_atlas_invalid"], cues };
  const regionAccent: Record<string, GarmentAccent> = { collar: "collar", lapels: "collar", cuffs: "cuff", hem: "hem", hood_rim: "hood_rim", skirt_pleats: "pleat", pocket: "pocket" };
  const preferred: readonly GarmentAccent[] = design.outfit.family === "preserve_existing" ? [] : OUTFIT_STYLE_TEMPLATES[design.outfit.family].accents;
  const regions = plan.outerLayer.regions.filter(r => r !== "pattern_depth" && r !== "graphic_depth")
    .map((region, index) => ({ region, index, priority: preferred.indexOf(regionAccent[region]) }))
    .sort((a, b) => (a.priority < 0 ? 100 : a.priority) - (b.priority < 0 ? 100 : b.priority) || a.index - b.index);
  const stencils = regions.map(({ region }) => {
    const image: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    applyOutfitPlan(image, { ...plan, accessories: [], outerLayer: { ...plan.outerLayer, regions: [region] } }, skin);
    const paints = overlayPaints(image).filter(c => !(region === "cuffs" && (c.face === "top" || c.y === 0)));
    return { id: `structure:${region}`, paints };
  });
  const accessoryPositions = closedSourcePositions([...sourceAccessoryStencils(plan, skin).flatMap(s => s.paints), ...scarfPaints]);
  for (const [index, stencil] of stencils.entries()) {
    const later = closedSourcePositions(stencils.slice(index + 1).flatMap(s => s.paints));
    const visible = stencil.paints.filter(c => !accessoryPositions.has(coordinateKey(c)) && !later.has(coordinateKey(c)));
    const palette = new Set(stencil.paints.map(c => colorKey(c.color)));
    const route = groups.filter(g => g.id === stencil.id);
    if (route.length !== 1) errors.add(`source_structure_route_missing:${stencil.id}`);
    let retainedPixels = 0;
    for (const c of visible) {
      const base = CLASSIC_LAYOUT[c.part].base[c.face], outer = CLASSIC_LAYOUT[c.part].overlay[c.face];
      const b = ((base.y + c.y) * 64 + base.x + c.x) * 4, o = ((outer.y + c.y) * 64 + outer.x + c.x) * 4;
      const i = atlas.rgba[o + 3] === 255 ? o : b;
      const color = colorKey([...atlas.rgba.slice(i, i + 3)]);
      // Front light/shadow roles define the actual collar/fold, not simply a
      // garment-colored blob. Only wrapping seam partners may share its ramp.
      const matches = c.face === "front" ? color === colorKey(c.color) : palette.has(color);
      if (atlas.rgba[i + 3] === 255 && matches) retainedPixels++;
    }
    // A fully covered source primitive is recorded as an occlusion, not a
    // fabricated visible cue or an excuse to bypass an independent accessory.
    if (retainedPixels !== visible.length) errors.add(`source_structure_missing:${stencil.id}`);
    cues.push({ id: stencil.id, sourcePixels: stencil.paints.length, visibleSourcePixels: visible.length, retainedPixels, coveredBySourceConstruction: stencil.paints.length - visible.length });
  }
  const ids = new Set(stencils.map(s => s.id));
  for (const g of groups) if (g.id.startsWith("structure:") && !ids.has(g.id)) errors.add(`source_structure_unproven:${g.id}`);
  return { valid: !errors.size, violations: [...errors].sort(), cues };
}

export interface GarmentFoundationRetention {
  valid: boolean;
  violations: string[];
  sourceBasePixels: number;
  unchangedBasePixels: number;
  materialFoldPixels: number;
  authorizedConstructionPixels: number;
  connectedHairDrapePixels: number;
  designedFloralPixels: number;
  designedScarfPixels: number;
  unexpectedChanges: number;
}

/** Source foundations own material/color blocks/patterns, sleeve termination,
 * exposed skin, waist, legwear and shoes. A base-route declaration alone is not
 * an exemption: it must match the source primitive's coordinates and palette.
 */
export function measureReferenceGarmentFoundation(
  atlas: RawImage, plan: OutfitPlan, skin: string, design: ReferenceStylePlan,
  groups: readonly { id: string; placement: "outer_structure" | "base_anchor" }[],
  surfaces: readonly StyledSurfaceCell[],
  scarfPaints: readonly SourceAccessoryPaint[] = [],
): GarmentFoundationRetention {
  const result: GarmentFoundationRetention = { valid: true, violations: [], sourceBasePixels: 0, unchangedBasePixels: 0, materialFoldPixels: 0, authorizedConstructionPixels: 0, connectedHairDrapePixels: 0, designedFloralPixels: 0, designedScarfPixels: 0, unexpectedChanges: 0 };
  if (atlas.width !== 64 || atlas.height !== 64 || atlas.rgba.length !== 16384) return { ...result, valid: false, violations: ["garment_atlas_invalid"] };
  const errors = new Set<string>();
  validateReferenceStyleSurfaces(surfaces, design).violations.forEach(v => errors.add(v));
  const basePlan = { ...plan, accessories: [], outerLayer: { ...plan.outerLayer, regions: [] } };
  const expected: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
  applyOutfitPlan(expected, basePlan, skin);
  const finished = { ...expected, rgba: expected.rgba.slice() };
  const folds = new Map(applyReferenceGarmentFinish(finished, basePlan, !!design.materialDetailPolicy).map(p => [`${p.part}:${p.face}:${p.x}:${p.y}`, colorKey(p.color)]));
  const allowedConstruction = new Map<string, Set<string>>();
  for (const group of groups.filter(g => g.placement === "base_anchor")) {
    const image: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    let paints: SourceAccessoryPaint[] = [];
    if (group.id.startsWith("accessory:")) {
      const kind = group.id.slice("accessory:".length);
      paints = sourceAccessoryStencils(plan, skin).filter(s => s.id.startsWith(`accessory:${kind}:`)).flatMap(s => s.paints);
    } else if (group.id.startsWith("structure:")) {
      const region = plan.outerLayer.regions.find(r => group.id === `structure:${r}`);
      if (region) {
        applyOutfitPlan(image, { ...basePlan, outerLayer: { ...basePlan.outerLayer, regions: [region] } }, skin);
        paints = overlayPaints(image).filter(c => !(region === "cuffs" && (c.face === "top" || c.y === 0)));
      }
    }
    if (!paints.length) { errors.add(`garment_base_route_unproven:${group.id}`); continue; }
    const positions = closedSourcePositions(paints);
    const palette = new Set(paints.map(c => colorKey(c.color)));
    for (const key of positions) {
      const colors = allowedConstruction.get(key) ?? new Set<string>();
      palette.forEach(c => colors.add(c)); allowedConstruction.set(key, colors);
    }
  }
  const drape = new Set(surfaces.filter(c => c.part !== "head" && c.layer === "base" && c.owner === "hair" && c.drapeGroup
    && (c.drapeGroup === "rear_curtain" ? design.drape.rearCompletion === "source_supported" && c.part === "body" && c.face === "back" : design.drape.eligible)).map(c => `${c.part}:${c.face}:${c.x}:${c.y}`));
  const floral = new Map<string, string>();
  const scarf = new Map(scarfPaints.map(p => [coordinateKey(p), colorKey(p.color)]));
  if (design.outfit.family === "black_floral_streetwear" && plan.upper.pattern.kind === "irregular_group" && plan.upper.pattern.surfaceParts === undefined && /\b(?:floral|flower)\b/i.test(plan.observedConstruction)) {
    const hex = plan.upper.pattern.color || plan.upper.accentColor;
    const ink = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      const targets: BodyPart[] = /\bsleeves?\b/i.test(plan.observedConstruction) ? ["rightArm", "leftArm"] : ["body"];
      for (const part of targets) for (const [dx, dy] of [[0, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as const) {
        const r = CLASSIC_LAYOUT[part].base.front, x = Math.floor(r.w / 2) + dx, y = 3 + dy;
        const end = part === "rightArm" ? plan.upper.rightSleeve.terminationRow : part === "leftArm" ? plan.upper.leftSleeve.terminationRow : plan.lower.waistRow;
        if (y < end && x >= 0 && x < r.w) floral.set(`${part}:front:${x}:${y}`, colorKey(ink.map(v => Math.round(v * (dy === 1 && dx === 0 ? 0.72 : 1)))));
      }
    }
  }
  for (const part of parts) for (const face of Object.keys(CLASSIC_LAYOUT[part].base) as (keyof BoxUV)[]) {
    const r = CLASSIC_LAYOUT[part].base[face];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      result.sourceBasePixels++;
      const i = ((r.y + y) * 64 + r.x + x) * 4, key = `${part}:${face}:${x}:${y}`;
      const actualColor = colorKey([...atlas.rgba.slice(i, i + 3)]);
      if ([0, 1, 2, 3].every(ch => atlas.rgba[i + ch] === expected.rgba[i + ch])) result.unchangedBasePixels++;
      else if (atlas.rgba[i + 3] === 255 && folds.get(key) === actualColor) result.materialFoldPixels++;
      else if (atlas.rgba[i + 3] === 255 && allowedConstruction.get(key)?.has(actualColor)) result.authorizedConstructionPixels++;
      else if (atlas.rgba[i + 3] === 255 && drape.has(key)) result.connectedHairDrapePixels++;
      else if (atlas.rgba[i + 3] === 255 && floral.get(key) === actualColor) result.designedFloralPixels++;
      else if (atlas.rgba[i + 3] === 255 && scarf.get(key) === actualColor) result.designedScarfPixels++;
      else { result.unexpectedChanges++; errors.add(`source_garment_foundation_changed:${part}`); }
    }
  }
  result.valid = errors.size === 0; result.violations = [...errors].sort();
  return result;
}
