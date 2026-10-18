/** Bounded, offline-first selection of actually rendered templates.
 * Source construction and shared craft floors both gate candidate ranking.
 * Neither is a bypass of the legacy mask contract; reference masks are explicit.
 * Source plans remain immutable; no provider or request-scoped global state.
 */
import type { RawImage } from "./png";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import { facialHairBaseFootprint } from "./facialHairFootprint";
import { buildHeadwearPaint } from "../../shared/headwear";
import { headwearVisibleLandmarks } from "./headwearFootprint";
import { buildReferencePairedHair, buildReferencePairedDrapePlan } from "./referencePairedHair";
import { buildReferenceLooseHair } from "./referenceLooseHair";
import { buildReferenceScarfFinish } from "./referenceScarfFinish";
import { buildReferenceShortFringe } from "./referenceShortFringe";
import { applyReferenceFaceFinish, referencePresentedFaceContract, referenceIrisGlintCells, referenceIrisPigmentCells } from "./referenceFaceFinish";
import { measureFaceRenderContract } from "./identityRenderContract";
import { measureReferenceAccessoryRetention, measureReferenceGarmentFoundation, measureReferenceGarmentStructure } from "./referenceOutfitRetention";
import { validateAtlasCraftFoundation, validateFinalAtlas } from "./skinPost";
import { composeReferenceStyleAtlas, deriveCompositionHeadProportion, referenceBaseHairColor, type ReferenceCompositionResult } from "./referenceStyleRenderer";
import { referenceLooseHairMaterial } from "./referenceMaterialDetail";
import { hasReferenceHairVolume, referenceHairVolumeGroups } from "./referenceHairVolume";
import { headProportionFaceContract, headProportionOffset } from "./referenceHeadProportion";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "./referenceStyleConstraints";
import { REFERENCE_OUTER_COVERAGE, type ReferenceStylePlan } from "./referenceStyleTemplates";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BodyPart } from "./uvLayout";

const parts = Object.keys(CLASSIC_LAYOUT) as BodyPart[];
function offset(c: StyledSurfaceCell): number {
  const r = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return ((r.y + c.y) * 64 + r.x + c.x) * 4;
}
function samePixel(a: RawImage, b: RawImage, i: number): boolean {
  return [0, 1, 2, 3].every(ch => a.rgba[i + ch] === b.rgba[i + ch]);
}
function distance(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, v, ch) => sum + Math.abs(v - b[ch]), 0);
}
export interface ReferenceRenderedQuality {
  constructionValid: boolean;
  violations: string[];
  faceContract: ReturnType<typeof measureFaceRenderContract>;
  mouthPresentation: "retain_source" | "omit_neutral" | "omit_style";
  accessoryRetention: ReturnType<typeof measureReferenceAccessoryRetention>;
  garmentFoundation: ReturnType<typeof measureReferenceGarmentFoundation>;
  garmentStructure: ReturnType<typeof measureReferenceGarmentStructure>;
  metrics: {
    eyeContrast: number;
    outerCoverage: Record<BodyPart, number>;
    headTopCoverage: number;
    isolatedOuterPixels: number;
    actualBaseHairCells: number;
    actualOuterHairCells: number;
    protectedAccessorySeamPairs: number;
    visibleIrisCells: number;
    sourceEyewearOccludedIrisCells: number;
    accidentalEyeOcclusionCells: number;
    irisToneSeparation: number;
  };
  /** A reproducible design heuristic, not a measured likeness/evaluator score. */
  score: number;
}

export function measureReferenceRenderedQuality(
  result: ReferenceCompositionResult, baseline: RawImage, source: SkinPlan,
  design: ReferenceStylePlan, style: FaceStyle,
): ReferenceRenderedQuality {
  if (!design.headProportionPolicy) return measureReferenceFoundationQuality(result, baseline, source, design, style);
  // Rebuild the prior stage from immutable inputs, NOT from candidate paint
  // declarations. Restore only independently authorized projection cells for
  // its original validator, then check every final authored pixel exactly.
  const foundation = composeReferenceStyleAtlas(baseline, source, { ...design, headProportionPolicy: undefined }, style);
  const projected = deriveCompositionHeadProportion(foundation, source, design, style);
  const restored = { ...result.atlas, rgba: result.atlas.rgba.slice() };
  const errors = new Set<string>();
  if (JSON.stringify(projected) !== JSON.stringify(result.diagnostic.headProportion)) errors.add("head_proportion_contract_changed");
  for (const p of projected.paints) {
    const i = headProportionOffset(p);
    if (result.atlas.rgba[i + 3] !== (p.layer === "overlay" ? 255 : foundation.atlas.rgba[i + 3]) || p.color.some((v, ch) => result.atlas.rgba[i + ch] !== v)) errors.add("head_proportion_pixel_changed");
    restored.rgba.set(foundation.atlas.rgba.slice(i, i + 4), i);
  }
  const quality = measureReferenceFoundationQuality({ ...result, atlas: restored }, baseline, source, design, style);
  quality.violations.forEach(e => errors.add(e));
  const material = source.headIdentityPlan.ownership?.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner)) ?? [];
  const displayed = referencePresentedFaceContract(source.facePixelPlan, design, style,
    [...facialHairBaseFootprint(style), ...material, ...buildReferencePairedDrapePlan(source, design, style).junctions]);
  const faceContract = measureFaceRenderContract(result.atlas, headProportionFaceContract(displayed, projected));
  faceContract.violations.forEach(e => errors.add(`face_contract:${e}`));
  if (!validateFinalAtlas(result.atlas).ok) errors.add("final_atlas_invalid");
  const metrics = { ...quality.metrics };
  let score = quality.score;
  if (projected.eyes === "lower_narrow_pair") {
    // Ranking must measure the final displayed pair, not a better-looking
    // intermediate eye that no longer exists in the delivered PNG.
    const iris = projected.eyePixels.filter(p => p.role === "iris");
    const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
    const rgb = (x: number, y: number) => {
      const i = ((front.y + y) * 64 + front.x + x) * 4;
      return [...result.atlas.rgba.slice(i, i + 3)];
    };
    const covered = iris.filter(p => result.atlas.rgba[((outer.y + p.y) * 64 + outer.x + p.x) * 4 + 3] > 0).length;
    metrics.visibleIrisCells = iris.length - covered;
    metrics.accidentalEyeOcclusionCells = covered;
    metrics.sourceEyewearOccludedIrisCells = 0;
    if (covered) errors.add("head_proportion_eye_occluded");
    metrics.eyeContrast = iris.reduce((n, p) => n + distance(rgb(p.x, p.y), rgb(p.x === 2 ? 1 : 6, p.y)), 0) / iris.length;
    metrics.irisToneSeparation = [2, 5].reduce((n, x) => n + distance(rgb(x, 5), rgb(x, 6)), 0) / 2;
    score += (Math.min(1, metrics.eyeContrast / 255) - Math.min(1, quality.metrics.eyeContrast / 255)) * 30
      + (Math.min(1, metrics.irisToneSeparation / 384) - Math.min(1, quality.metrics.irisToneSeparation / 384)) * 6;
  }
  const oldHair = new Set(foundation.diagnostic.surfaces.filter(p => p.part === "head" && p.layer === "base" && p.owner === "hair").map(p => headProportionOffset(p)));
  metrics.actualBaseHairCells += projected.paints.filter(p => !p.layer && p.role === "hair" && !oldHair.has(headProportionOffset(p))).length;
  const raised = projected.paints.filter(p => p.layer === "overlay");
  const added = raised.filter(p => !foundation.atlas.rgba[headProportionOffset(p) + 3]).length;
  metrics.actualOuterHairCells += added;
  metrics.outerCoverage = { ...metrics.outerCoverage, head: metrics.outerCoverage.head + added / 384 };
  if (metrics.outerCoverage.head > REFERENCE_OUTER_COVERAGE.head || metrics.actualOuterHairCells > metrics.actualBaseHairCells) errors.add("hair_relief_budget_exceeded");
  return { ...quality, faceContract, metrics, score: Math.round(score * 1000) / 1000, constructionValid: !errors.size, violations: [...errors].sort() };
}

function measureReferenceFoundationQuality(
  result: ReferenceCompositionResult, baseline: RawImage, source: SkinPlan,
  design: ReferenceStylePlan, style: FaceStyle,
): ReferenceRenderedQuality {
  const atlas = result.atlas, diagnostic = result.diagnostic, errors = new Set<string>();
  const final = validateFinalAtlas(atlas);
  if (!final.ok) errors.add("final_atlas_invalid");
  if (!validateFinalAtlas(baseline).ok) errors.add("source_atlas_invalid");
  const declared = validateReferenceStyleSurfaces(diagnostic.surfaces, design);
  declared.violations.forEach(v => errors.add(v));
  const sourceMaterials = source.headIdentityPlan.ownership?.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner)) ?? [];
  const pairedDrapePlan = buildReferencePairedDrapePlan(source, design, style);
  const presentedFace = referencePresentedFaceContract(source.facePixelPlan, design, style, [...facialHairBaseFootprint(style), ...sourceMaterials, ...pairedDrapePlan.junctions]);
  const faceContract = measureFaceRenderContract(atlas, presentedFace);
  faceContract.violations.forEach(v => errors.add(`face_contract:${v}`));
  const accessoryRetention = measureReferenceAccessoryRetention(atlas, source.outfitPlan, style.skinTone ?? "#d39e80");
  accessoryRetention.violations.forEach(v => errors.add(v));
  // Derived from immutable source, not candidate labels or rewritten colors.
  const scarfFinish = buildReferenceScarfFinish(source, style.skinTone ?? "#d39e80");
  if (JSON.stringify(scarfFinish) !== JSON.stringify(diagnostic.scarfFinish)) errors.add("scarf_finish_contract_changed");
  const garmentFoundation = measureReferenceGarmentFoundation(atlas, source.outfitPlan, style.skinTone ?? "#d39e80", design, diagnostic.bodyGroups, diagnostic.surfaces, scarfFinish.paints);
  garmentFoundation.violations.forEach(v => errors.add(v));
  const garmentStructure = measureReferenceGarmentStructure(atlas, source.outfitPlan, style.skinTone ?? "#d39e80", design, diagnostic.bodyGroups, scarfFinish.paints);
  garmentStructure.violations.forEach(v => errors.add(v));
  const expected = new Map(diagnostic.surfacePixels.map(c => [offset(c), c]));
  for (const p of scarfFinish.paints) {
    const c = { ...p, layer: "base" as const, owner: "accessory" as const }, i = offset(c);
    const outer = offset({ ...c, layer: "overlay" });
    if (expected.get(i)?.owner !== "accessory" || atlas.rgba[i + 3] !== 255 || atlas.rgba[outer + 3] !== 0
      || p.color.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("source_scarf_tail_missing");
  }
  // Independently rederive the only authorized silhouette replacement. A
  // rewritten diagnostic cannot turn arbitrary missing hair into a nape.
  const pairedHair = buildReferencePairedHair(source, design);
  // A generic long curtain is not an equally faithful alternative to an
  // explicitly supported paired silhouette, even if its color score is high.
  for (const family of ["twin_braids", "twin_tails"] as const) {
    const required = buildReferencePairedHair(source, { ...design, hair: { ...design.hair, family } });
    if (required.status === "authored" && design.hair.family !== family) errors.add("source_paired_hair_missing");
  }
  if (JSON.stringify(pairedHair) !== JSON.stringify(diagnostic.pairedHair)) errors.add("paired_hair_contract_changed");
  const skin = /^#[0-9a-f]{6}$/i.test(style.skinTone ?? "") ? [1, 3, 5].map(i => Number.parseInt(style.skinTone!.slice(i, i + 2), 16)) : [211, 158, 128];
  const hairPalette = /^#[0-9a-f]{6}$/i.test(style.hairColor ?? "") ? [1, 3, 5].map(i => Number.parseInt(style.hairColor!.slice(i, i + 2), 16)) : [57, 42, 33];
  const shortFringe = buildReferenceShortFringe(source, design, style);
  if (JSON.stringify(shortFringe) !== JSON.stringify(diagnostic.shortFringe)) errors.add("short_fringe_contract_changed");
  for (const p of shortFringe.windows) {
    const i = offset({ ...p, part: "head", layer: "base", owner: "face" });
    const outer = offset({ ...p, part: "head", layer: "overlay", owner: "hair" });
    if (expected.get(i)?.owner !== "face" || atlas.rgba[i + 3] !== 255 || atlas.rgba[outer + 3] !== 0
      || skin.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("short_fringe_window_invalid");
  }
  for (const p of pairedHair.accents) {
    const i = offset({ ...p, part: "head", layer: "overlay", owner: "hair" });
    if (expected.get(i)?.owner !== "hair" || atlas.rgba[i + 3] !== 255 || hairPalette.some((v, ch) => atlas.rgba[i + ch] !== Math.round(v * 0.84))) errors.add("paired_hair_accent_missing");
  }
  const pairedDrape = pairedDrapePlan.points;
  for (const p of pairedDrapePlan.junctions) {
    const i = offset({ ...p, part: "head", layer: "base", owner: "hair" });
    const cell = expected.get(i);
    const root = offset({ ...p, y: 6, part: "head", layer: "base", owner: "hair" });
    if (cell?.owner !== "hair" || cell.drapeGroup !== p.drapeGroup || expected.get(root)?.owner !== "hair"
      || atlas.rgba[i + 3] !== 255 || hairPalette.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("paired_hair_junction_invalid");
  }
  const looseHair = buildReferenceLooseHair(source, design, style);
  if (JSON.stringify(looseHair) !== JSON.stringify(diagnostic.looseHair)) errors.add("loose_hair_contract_changed");
  const actualLoose = diagnostic.surfaces.filter(c => c.owner === "hair" && c.part !== "head" && !pairedDrape.some(p => c.face === "front" && c.x === p.x && c.y === p.y));
  if (actualLoose.length !== looseHair.points.length) errors.add("loose_hair_drape_invalid");
  for (const p of looseHair.points) {
    const i = offset({ ...p, part: "body", layer: "base", owner: "hair" });
    const c = expected.get(i);
    const color = referenceLooseHairMaterial(hairPalette as [number, number, number], p, style, design.hair.family !== "preserve_existing" && (design.materialDetailPolicy ?? false));
    if (!c || c.owner !== "hair" || c.drapeGroup !== p.drapeGroup || atlas.rgba[i + 3] !== 255
      || color.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("loose_hair_drape_invalid");
  }
  if (pairedDrape.length) {
    const declaredDrape = diagnostic.surfaces.filter(c => c.owner === "hair" && c.part !== "head");
    if (declaredDrape.length !== pairedDrape.length) errors.add("paired_hair_drape_invalid");
    for (const p of pairedDrape) {
      const i = offset({ ...p, part: "body", face: "front", layer: "base", owner: "hair" });
      const cell = expected.get(i), factor = pairedHair.family === "twin_braids" && p.y % 2 ? 1.16 : 1;
      if (!cell || cell.owner !== "hair" || cell.drapeGroup !== p.drapeGroup || atlas.rgba[i + 3] !== 255 || hairPalette.some((v, ch) => atlas.rgba[i + ch] !== Math.min(255, Math.round(v * factor)))) errors.add("paired_hair_drape_invalid");
    }
  }
  if (expected.size !== diagnostic.surfaces.length || diagnostic.surfacePixels.length !== expected.size) errors.add("paint_contract_ownership_mismatch");
  for (const c of diagnostic.surfaces) {
    const p = expected.get(offset(c));
    if (!p || p.owner !== c.owner || p.drapeGroup !== c.drapeGroup) errors.add("paint_contract_ownership_mismatch");
  }
  for (const [i, c] of expected) if (atlas.rgba[i + 3] !== 255 || [0, 1, 2].some(ch => atlas.rgba[i + ch] !== c.color[ch])) errors.add(`paint_contract_mismatch:${c.owner}`);
  const front = CLASSIC_LAYOUT.head.base.front;
  for (const p of diagnostic.facePixels) {
    const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    if ([0, 1, 2].some(ch => atlas.rgba[i + ch] !== p.color[ch])) errors.add("face_finish_paint_mismatch");
  }
  const protectedFace = source.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "glasses"].includes(p.cluster) || p.role === "brow");
  // Independently require the source headwear material, including the visor.
  // Editing a paint diagnostic cannot turn a red helmet into hair or skin.
  for (const c of buildHeadwearPaint(style.hat, style.hatColor ?? "#303030", style.hatVisor, headwearVisibleLandmarks(source.facePixelPlan))) {
    const i = offset({ ...c, part: "head", owner: "covering" });
    if (atlas.rgba[i + 3] !== 255 || c.color.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("headwear_material_changed");
  }
  const material = source.headIdentityPlan.ownership?.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner)) ?? [];
  const eyePalette = style.eyeColor && /^#[0-9a-f]{6}$/i.test(style.eyeColor) ? [1, 3, 5].map(i => Number.parseInt(style.eyeColor!.slice(i, i + 2), 16)) : undefined;
  // Reconstruct the clean skin window and face finish independently of the
  // candidate's paint diagnostic. Rewriting that diagnostic cannot restore a
  // literal nose stripe, erase a lip or authorize a new complexion palette.
  const faceReference = { ...baseline, rgba: baseline.rgba.slice() };
  const protectedMaterials = [...facialHairBaseFootprint(style), ...material, ...pairedDrapePlan.junctions];
  const expectedFinish = applyReferenceFaceFinish(faceReference, source.facePixelPlan, design, {
    skinMid: [skin[0], skin[1], skin[2]],
    skinShade: [skin[0], skin[1], skin[2]].map(v => Math.round(v * 0.78)) as [number, number, number],
    lip: [Math.max(0, skin[0] - 18), Math.max(0, skin[1] - 45), Math.max(0, skin[2] - 45)],
    eye: eyePalette ? [eyePalette[0], eyePalette[1], eyePalette[2]] : undefined,
  }, protectedMaterials, style, baseline);
  if (diagnostic.faceFinish.mouthPresentation !== expectedFinish.mouthPresentation) errors.add("mouth_presentation_contract_changed");
  if (diagnostic.faceFinish.eyeRowOffset !== expectedFinish.eyeRowOffset) errors.add("eye_row_presentation_contract_changed");
  if (JSON.stringify(diagnostic.faceFinish.hairSpaceCells) !== JSON.stringify(expectedFinish.hairSpaceCells)) errors.add("hair_space_contract_changed");
  if (JSON.stringify(diagnostic.faceFinish.eyePresentation) !== JSON.stringify(expectedFinish.eyePresentation)) errors.add("eye_presentation_contract_changed");
  for (const p of expectedFinish.eyePresentation.cells) {
    const outer = CLASSIC_LAYOUT.head.overlay.front;
    if (atlas.rgba[((outer.y + p.y) * 64 + outer.x + p.x) * 4 + 3] !== 0) errors.add("eye_presentation_occluded");
  }
  const omittedMouth = expectedFinish.mouthPresentation !== "retain_source" ? source.facePixelPlan.pixels.filter(p => p.cluster === "mouth") : [];
  for (const p of [...expectedFinish.skinWindowCells, ...expectedFinish.changedCells, ...omittedMouth]) {
    const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    if (!samePixel(atlas, faceReference, i)) errors.add("source_face_finish_changed");
  }
  // Derive authorization from the immutable source/template, never the painted
  // diagnostic: editing a diagnostic cannot license an arbitrary iris color.
  const irisPigment = referenceIrisPigmentCells(source.facePixelPlan, design, eyePalette, [...facialHairBaseFootprint(style), ...material], skin);
  const irisGlint = referenceIrisGlintCells(source.facePixelPlan, design, eyePalette, [...facialHairBaseFootprint(style), ...material]);
  for (const p of protectedFace) {
    const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    // The unmeasured brow catch is an explicitly authored eye cell. When the
    // complete eye presentation moves, independently verify BOTH its cleared
    // old position and shifted position, just like the source iris cells.
    // Measured/unmodified brows still require exact baseline preservation.
    const movedCatch = expectedFinish.eyePresentation.kind === "paired_upper_catch_unmeasured_brow"
      && expectedFinish.eyePresentation.cells.some(c => c.x === p.x && c.y === p.y);
    if (expectedFinish.eyeRowOffset && (movedCatch || p.role !== "brow" && (p.cluster === "left_eye" || p.cluster === "right_eye"))) {
      if (!samePixel(atlas, faceReference, i) || !samePixel(atlas, faceReference, i + 256)) errors.add("source_eye_brow_changed");
      continue;
    }
    const authored = [...expectedFinish.eyePresentation.cells, ...irisPigment, ...irisGlint].find(c => c.x === p.x && c.y === p.y);
    if (authored ? atlas.rgba[i + 3] !== baseline.rgba[i + 3] || authored.color.some((v, ch) => atlas.rgba[i + ch] !== v) : !samePixel(atlas, baseline, i)) errors.add("source_eye_brow_changed");
  }
  let visibleIrisCells = 0, sourceEyewearOccludedIrisCells = 0, accidentalEyeOcclusionCells = 0;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  for (const p of presentedFace.pixels.filter(p => p.role === "iris")) {
    const i = ((overlay.y + p.y) * 64 + overlay.x + p.x) * 4;
    if (!atlas.rgba[i + 3]) { visibleIrisCells++; continue; }
    const sourceEyewear = source.headIdentityPlan.ownership?.cells.some(c => c.face === "front" && c.layer === "outer" && c.x === p.x && c.y === p.y && c.owner === "glasses");
    if (sourceEyewear && samePixel(atlas, baseline, i)) sourceEyewearOccludedIrisCells++;
    else accidentalEyeOcclusionCells++;
  }
  if (accidentalEyeOcclusionCells) errors.add("accidental_eye_occlusion");
  for (const p of facialHairBaseFootprint(style)) if (!samePixel(atlas, baseline, ((front.y + p.y) * 64 + front.x + p.x) * 4)) errors.add("source_facial_hair_changed");
  let actualBaseHairCells = 0, actualOuterHairCells = 0;
  const head = source.headIdentityPlan.ownership;
  if (!head || head.execution !== "resolved") errors.add("source_head_ownership_unresolved");
  for (const c of head?.cells ?? []) {
    const pos = { ...c, part: "head" as const, layer: c.layer === "outer" ? "overlay" as const : "base" as const, owner: "hair" as const };
    const i = offset(pos);
    if (["semantic-fringe-window", "semantic-fringe-length-window"].includes(c.sourceGroupId)) {
      if (c.layer === "outer" ? atlas.rgba[i + 3] !== 0
        : expected.get(i)?.owner !== "face" || atlas.rgba[i + 3] !== 255 || skin.some((v, ch) => atlas.rgba[i + ch] !== v)) {
        errors.add(c.sourceGroupId === "semantic-fringe-window" ? "source_semantic_fringe_window_closed" : "source_semantic_fringe_length_window_closed");
      }
    }
    if (c.layer === "outer" && c.sourceGroupId === "curly-profile-window") {
      if (atlas.rgba[i + 3] !== 0) errors.add("source_curly_profile_window_closed");
      const baseIndex = offset({ ...pos, layer: "base" });
      // Curly categorical openings expose the existing source-painted cheek,
      // not a replacement hair mass licensed by a rewritten paint diagnostic.
      if (!samePixel(atlas, baseline, baseIndex)) errors.add("source_curly_profile_material_changed");
    }
    if (c.owner === "hair_base") {
      if (shortFringe.windows.some(p => p.face === c.face && p.x === c.x && p.y === c.y)) continue;
      if (pairedHair.nape.some(p => p.face === c.face && p.x === c.x && p.y === c.y)) {
        if (expected.get(i)?.owner !== "face" || atlas.rgba[i + 3] !== 255 || skin.some((v, ch) => atlas.rgba[i + ch] !== Math.round(v * 0.78))) errors.add("paired_hair_nape_invalid");
        continue;
      }
      if (expected.get(i)?.owner !== "hair" || atlas.rgba[i + 3] !== 255) errors.add("source_base_hair_missing");
      // Independently derive the exact source-owned finish, including bounded
      // near-black coily reflection. A rewritten diagnostic cannot authorize
      // arbitrary recoloring within a loose tolerance.
      const authoredColor = referenceBaseHairColor([...baseline.rgba.slice(i, i + 3)] as [number, number, number], c, source, design, style);
      if (authoredColor.some((v, ch) => atlas.rgba[i + ch] !== v)) errors.add("source_hair_palette_changed");
    }
    if (["glasses", "tied_hair", "other_p5"].includes(c.owner) && !samePixel(atlas, baseline, i)) errors.add("source_head_accessory_changed");
  }
  for (const [i, c] of expected) if (c.owner === "hair" && atlas.rgba[i + 3] === 255) {
    if (c.layer === "base") actualBaseHairCells++; else actualOuterHairCells++;
  }
  const outerCoverage = {} as Record<BodyPart, number>;
  const opaqueOuter = new Set<number>();
  for (const part of parts) {
    let occupied = 0, area = 0;
    for (const r of Object.values(CLASSIC_LAYOUT[part].overlay)) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      area++; const i = ((r.y + y) * 64 + r.x + x) * 4;
      if (!atlas.rgba[i + 3]) continue;
      occupied++; opaqueOuter.add(i);
      if (!expected.has(i)) errors.add(`undeclared_outer_pixel:${part}`);
    }
    outerCoverage[part] = occupied / area;
    if (outerCoverage[part] > REFERENCE_OUTER_COVERAGE[part]) errors.add(`actual_outer_coverage:${part}`);
  }
  let protectedAccessorySeamPairs = 0;
  const connected = new Map([...opaqueOuter].map(i => [i, new Set<number>()]));
  const connect = (a: number, b: number) => { if (connected.has(a) && connected.has(b)) { connected.get(a)!.add(b); connected.get(b)!.add(a); } };
  for (const part of parts) {
    for (const r of Object.values(CLASSIC_LAYOUT[part].overlay)) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * 64 + r.x + x) * 4;
      if (x + 1 < r.w) connect(i, i + 4);
      if (y + 1 < r.h) connect(i, i + 256);
    }
    const seams = getBoxUvSeams(CLASSIC_LAYOUT[part].overlay);
    for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, index) => {
      const q = seam.adjacent[index], a = (p.y * 64 + p.x) * 4, b = (q.y * 64 + q.x) * 4;
      connect(a, b);
      if (part === "head" && (expected.get(a)?.owner === "accessory" || expected.get(b)?.owner === "accessory")) { protectedAccessorySeamPairs++; return; }
      if (!!atlas.rgba[a + 3] !== !!atlas.rgba[b + 3]) errors.add(`overlay_seam_alpha:${part}`);
      if (atlas.rgba[a + 3] && atlas.rgba[b + 3] && [0, 1, 2].some(ch => atlas.rgba[a + ch] !== atlas.rgba[b + ch])) errors.add(`overlay_seam_color:${part}`);
    });
  }
  const isolatedOuterPixels = [...connected.values()].filter(neighbors => neighbors.size === 0).length;
  const top = CLASSIC_LAYOUT.head.overlay.top;
  let headTop = 0;
  for (let y = 0; y < top.h; y++) for (let x = 0; x < top.w; x++) if (atlas.rgba[((top.y + y) * 64 + top.x + x) * 4 + 3]) headTop++;
  const landmarkKeys = new Set(source.facePixelPlan.pixels.filter(p => p.cluster !== "complexion").map(p => `${p.x}:${p.y}`));
  const iris = presentedFace.pixels.filter(p => p.role === "iris");
  const contrasts = iris.map(p => {
    const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    const outer = ((overlay.y + p.y) * 64 + overlay.x + p.x) * 4;
    if (atlas.rgba[outer + 3]) return 0; // Hidden ink is not visible eye contrast.
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
      .filter(q => q.x >= 0 && q.x < 8 && q.y >= 0 && q.y < 8 && !landmarkKeys.has(`${q.x}:${q.y}`));
    // A visible adjacent hair cell is part of the eye's actual boundary.
    // Excluding it rewarded dim catches against pale skin while ignoring
    // whether that same eye merged into dark side hair. Ownership still
    // protects all source hair; this changes ranking, never painted pixels.
    return neighbors.length ? neighbors.reduce((sum, q) => {
      const base = ((front.y + q.y) * 64 + front.x + q.x) * 4;
      const covering = ((overlay.y + q.y) * 64 + overlay.x + q.x) * 4;
      const j = atlas.rgba[covering + 3] ? covering : base;
      return sum + distance([...atlas.rgba.slice(i, i + 3)], [...atlas.rgba.slice(j, j + 3)]);
    }, 0) / neighbors.length : 0;
  });
  const eyeContrast = contrasts.reduce((sum, v) => sum + v, 0) / Math.max(1, contrasts.length);
  // Visible internal tone separation distinguishes an eye from adjoining hair.
  // Actual RGBA only: a diagnostic label or an occluded highlight earns nothing.
  const tonePairs = irisGlint.map(p => {
    const q = irisPigment.find(c => c.x === p.x && c.y === p.y + 1);
    if (!q || [p, q].some(c => atlas.rgba[((overlay.y + c.y) * 64 + overlay.x + c.x) * 4 + 3])) return 0;
    const a = ((front.y + p.y) * 64 + front.x + p.x) * 4, b = ((front.y + q.y) * 64 + front.x + q.x) * 4;
    return distance([...atlas.rgba.slice(a, a + 3)], [...atlas.rgba.slice(b, b + 3)]);
  });
  const irisToneSeparation = tonePairs.reduce((sum, v) => sum + v, 0) / Math.max(1, tonePairs.length);
  const headTopCoverage = headTop / (top.w * top.h);
  // The requested volume finish must not choose a different source hairstyle
  // merely because it adds supported relief. Keep the existing ranking cost
  // of that candidate's silhouette. Actual coverage/seams/ownership above are
  // still validated on the delivered atlas with the unchanged hard budgets.
  let volumePresentationCost = 0;
  if (hasReferenceHairVolume(source, design, style)) {
    // These interior/rear bundle positions do not overlap the eligible
    // families' legacy front/temple/perimeter accents. Count the validated
    // delivered hair cells, not the full proposed bundle or an accessory.
    // No extra candidate render (or inference) is needed for this accounting.
    const bundleKeys = new Set(referenceHairVolumeGroups(style).flat().map(p => `${p.face}:${p.x}:${p.y}`));
    let addedHead = 0, addedTop = 0;
    for (const [i, c] of expected) {
      if (c.part === "head" && c.layer === "overlay" && c.owner === "hair" && atlas.rgba[i + 3]
        && bundleKeys.has(`${c.face}:${c.x}:${c.y}`)) { addedHead++; if (c.face === "top") addedTop++; }
    }
    volumePresentationCost = addedHead / 384 * 12 + addedTop / 64 * 12;
  }
  const score = Math.round((Math.min(1, eyeContrast / 255) * 30
    + Math.min(1, irisToneSeparation / 384) * 6
    - Object.values(outerCoverage).reduce((sum, v) => sum + v, 0) * 12
    - headTopCoverage * 12 - isolatedOuterPixels * 2 + volumePresentationCost
    - (design.face.cost + design.hair.cost + design.outfit.cost) * 0.1) * 1000) / 1000;
  return { constructionValid: errors.size === 0, violations: [...errors].sort(), faceContract, mouthPresentation: expectedFinish.mouthPresentation, accessoryRetention, garmentFoundation, garmentStructure,
    metrics: { eyeContrast, outerCoverage, headTopCoverage, isolatedOuterPixels, actualBaseHairCells, actualOuterHairCells, protectedAccessorySeamPairs, visibleIrisCells, sourceEyewearOccludedIrisCells, accidentalEyeOcclusionCells, irisToneSeparation }, score };
}

export interface ReferenceSelection {
  selected: { design: ReferenceStylePlan; composition: ReferenceCompositionResult; quality: ReferenceRenderedQuality; foundation: ReturnType<typeof validateAtlasCraftFoundation> } | null;
  candidates: Array<{ id: string; quality: ReferenceRenderedQuality | null; foundation: ReturnType<typeof validateAtlasCraftFoundation> | null; rejection: string | null }>;
  renderAttempts: number;
}
export function selectReferenceStyleAtlas(baseline: RawImage, source: SkinPlan, design: ReferenceStylePlan, style: FaceStyle): ReferenceSelection {
  // At most 27 concrete atlases, independent of provider feature count.
  if (Object.values(design.candidates).some(axis => axis.length === 0 || axis.length > 3 || new Set(axis.map(c => c.family)).size !== axis.length)) throw new Error("reference_candidate_set_invalid");
  const candidates: ReferenceSelection["candidates"] = [];
  let selected: ReferenceSelection["selected"] = null, selectedId = "", renderAttempts = 0;
  for (const face of design.candidates.face) for (const hair of design.candidates.hair) for (const outfit of design.candidates.outfit) {
    const choice = { ...design, face, hair, outfit }, id = `${face.family}/${hair.family}/${outfit.family}`;
    renderAttempts++;
    let composition: ReferenceCompositionResult;
    try { composition = composeReferenceStyleAtlas(baseline, source, choice, style); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("reference_composition_")) throw error;
      candidates.push({ id, quality: null, foundation: null, rejection: error.message }); continue;
    }
    const quality = measureReferenceRenderedQuality(composition, baseline, source, choice, style);
    const foundation = validateAtlasCraftFoundation(composition.atlas, style);
    const accepted = quality.constructionValid && foundation.ok;
    candidates.push({ id, quality, foundation, rejection: !quality.constructionValid ? "rendered_contract_rejected" : !foundation.ok ? "craft_foundation_rejected" : null });
    if (accepted && (!selected || quality.score > selected.quality.score || (quality.score === selected.quality.score && id < selectedId))) {
      selected = { design: choice, composition, quality, foundation }; selectedId = id;
    }
  }
  return { selected, candidates, renderAttempts };
}
