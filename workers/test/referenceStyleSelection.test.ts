import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture() {
  const raw = makeAnalysis();
  raw.observed.hair = "short straight hair"; raw.observed.clothing = "plain knit sweater";
  raw.renderHints.overallHairLength = "ear"; raw.renderHints.sideHairLength = "short";
  raw.renderHints.eyeShape = "almond"; raw.renderHints.bangs = "none";
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "beard";
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const plan = buildSkinPlan(analysis), style = buildFaceStyle(analysis, features, plan.hairPlan);
  const baseline = buildProceduralFallbackAtlas(features, style, plan)!;
  const design = buildReferenceStylePlan(analysis);
  return { baseline, plan, style, design };
}
function mutate(b: ReturnType<typeof fixture>, point: { x: number; y: number }, layer: "base" | "overlay" = "base") {
  const result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
  const r = CLASSIC_LAYOUT.head[layer].front, i = ((r.y + point.y) * 64 + r.x + point.x) * 4;
  result.atlas.rgba.set([239, 4, 217, 255], i);
  return measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style);
}
describe("reference rendered candidate selection", () => {
  it("replaces a deliberately worse initial face choice with the highest actually rendered score", () => {
    const b = fixture();
    const initial = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const valid = initial.candidates.filter(c => c.quality?.constructionValid && c.foundation?.ok);
    const worst = [...valid].sort((a, b) => a.quality!.score - b.quality!.score)[0];
    expect(worst.quality!.score).toBeLessThan(initial.selected!.quality.score);
    const [face, hair, outfit] = worst.id.split("/");
    b.design.face = b.design.candidates.face.find(c => c.family === face)!;
    b.design.hair = b.design.candidates.hair.find(c => c.family === hair)!;
    b.design.outfit = b.design.candidates.outfit.find(c => c.family === outfit)!;
    expect(b.design.face).toBeDefined(); expect(b.design.hair).toBeDefined(); expect(b.design.outfit).toBeDefined();
    const selected = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(selected.selected!.quality.score).toBe(initial.selected!.quality.score);
    expect(selected.selected!.composition.atlas.rgba).toEqual(initial.selected!.composition.atlas.rgba);
    expect(selected.selected!.design.face.family !== b.design.face.family
      || selected.selected!.design.hair.family !== b.design.hair.family
      || selected.selected!.design.outfit.family !== b.design.outfit.family).toBe(true);
  });
  it("scores actual atlases without modifying source or making provider calls", () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const b = fixture(), source = JSON.stringify(b.plan), pixels = b.baseline.rgba.slice();
      // This test exercises historical candidate contrast diversity. The new
      // mouthless layout may legitimately tie candidates after row translation.
      delete b.design.faceLayoutPolicy;
      const selected = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
      expect(selected.renderAttempts).toBe(b.design.candidates.face.length * b.design.candidates.hair.length * b.design.candidates.outfit.length);
      expect(selected.renderAttempts).toBeLessThanOrEqual(27);
      expect(selected.selected, JSON.stringify(selected.candidates)).not.toBeNull();
      const valid = selected.candidates.filter(c => c.quality?.constructionValid && c.foundation?.ok);
      expect(selected.selected!.foundation.ok).toBe(true);
      expect(selected.selected!.quality.score).toBe(Math.max(...valid.map(c => c.quality!.score)));
      expect(new Set(valid.map(c => c.quality!.metrics.eyeContrast)).size).toBeGreaterThan(1);
      expect(JSON.stringify(b.plan)).toBe(source); expect(b.baseline.rgba).toEqual(pixels);
      const reverse = structuredClone(b.design);
      reverse.candidates.face.reverse(); reverse.candidates.hair.reverse(); reverse.candidates.outfit.reverse();
      const repeated = selectReferenceStyleAtlas(b.baseline, b.plan, reverse, b.style);
      expect(repeated.selected!.design.face).toEqual(selected.selected!.design.face);
      expect(repeated.selected!.design.hair).toEqual(selected.selected!.design.hair);
      expect(repeated.selected!.composition.atlas.rgba).toEqual(selected.selected!.composition.atlas.rgba);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("rejects actual eye and beard damage even with unchanged declared geometry", () => {
    const b = fixture();
    const originalEye = b.plan.facePixelPlan.pixels.find(p => p.role === "iris")!;
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const eye = { ...originalEye, y: originalEye.y + composed.diagnostic.faceFinish.eyeRowOffset };
    expect(mutate(b, eye).violations).toContain("source_eye_brow_changed");
    expect(mutate(b, { x: 0, y: 7 }).violations).toContain("source_facial_hair_changed");
  });
  it("rejects a restored literal nose stripe even when the face paint diagnostic is rewritten", () => {
    const b = fixture(), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const point = result.diagnostic.faceFinish.skinWindowCells.find(p => p.x >= 3 && p.x <= 4 && p.y >= 3 && p.y <= 5)!;
    expect(point).toBeDefined();
    const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + point.y) * 64 + r.x + point.x) * 4;
    const color = [240, 110, 60]; result.atlas.rgba.set(color, i);
    const diagnostic = result.diagnostic.facePixels.find(p => p.x === point.x && p.y === point.y);
    if (diagnostic) diagnostic.color = [...color];
    else result.diagnostic.facePixels.push({ ...point, color: [...color] as [number, number, number] });
    expect(measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style).violations).toContain("source_face_finish_changed");
  });
  it("rejects erased source base hair and body structure paint", () => {
    const b = fixture(), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    for (const owner of ["hair", "garment"] as const) {
      const copied = { ...result, atlas: { ...result.atlas, rgba: result.atlas.rgba.slice() } };
      const c = result.diagnostic.surfacePixels.find(c => c.owner === owner && c.layer === "base")!;
      const r = CLASSIC_LAYOUT[c.part][c.layer][c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      copied.atlas.rgba.set([240, 1, 229], i);
      expect(measureReferenceRenderedQuality(copied, b.baseline, b.plan, b.design, b.style).violations).toContain(`paint_contract_mismatch:${owner}`);
    }
  });
  it("rejects undeclared outer clutter that still satisfies the old 64x64 format", () => {
    const b = fixture(), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const r = CLASSIC_LAYOUT.body.overlay.front;
    const occupied = new Set(result.diagnostic.surfacePixels.filter(c => c.part === "body" && c.layer === "overlay" && c.face === "front").map(c => `${c.x}:${c.y}`));
    let point = { x: 0, y: 0 };
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (!occupied.has(`${x}:${y}`)) point = { x, y };
    result.atlas.rgba.set([30, 20, 10, 255], ((r.y + point.y) * 64 + r.x + point.x) * 4);
    const quality = measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style);
    expect(quality.constructionValid).toBe(false); expect(quality.violations).toContain("undeclared_outer_pixel:body");
  });
  it("rejects accidental outer eye occlusion even if the paint diagnostic is rewritten", () => {
    const b = fixture(), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const sourceEye = b.plan.facePixelPlan.pixels.find(p => p.role === "iris")!;
    const eye = { ...sourceEye, y: sourceEye.y + result.diagnostic.faceFinish.eyeRowOffset };
    const r = CLASSIC_LAYOUT.head.overlay.front, i = ((r.y + eye.y) * 64 + r.x + eye.x) * 4;
    result.atlas.rgba.set([57, 42, 33, 255], i);
    const cell = { part: "head" as const, layer: "overlay" as const, face: "front" as const, x: eye.x, y: eye.y, owner: "hair" as const };
    result.diagnostic.surfaces.push(cell); result.diagnostic.surfacePixels.push({ ...cell, color: [57, 42, 33] });
    const quality = measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style);
    expect(quality.violations).toContain("accidental_eye_occlusion");
    expect(quality.metrics.accidentalEyeOcclusionCells).toBe(1);
  });
  it("cannot authorize a new iris palette by changing a pigment diagnostic", () => {
    const b = fixture();
    const iris = b.plan.facePixelPlan.pixels.find(p => p.role === "iris")!;
    // Synthetic two-row source topology, not measured photo evidence.
    const lower = { ...iris, y: iris.y + 1 };
    b.plan.facePixelPlan.pixels.push(lower);
    const result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + lower.y) * 64 + r.x + lower.x) * 4;
    result.atlas.rgba.set([220, 4, 230], i);
    result.diagnostic.faceFinish.irisPigmentCells = [{ x: lower.x, y: lower.y, color: [220, 4, 230] }];
    expect(measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style).violations).toContain("source_eye_brow_changed");
  });
  it("cannot authorize a lost light catch by rewriting face paint and glint diagnostics", () => {
    const b = fixture();
    b.plan.facePixelPlan.pixels = [
      { x: 2, y: 3, role: "iris", cluster: "left_eye" }, { x: 2, y: 4, role: "iris", cluster: "left_eye" },
      { x: 5, y: 3, role: "iris", cluster: "right_eye" }, { x: 5, y: 4, role: "iris", cluster: "right_eye" },
    ];
    // A clear authored unit face window, not a changed frozen source mask.
    b.plan.headIdentityPlan.ownership!.cells = b.plan.headIdentityPlan.ownership!.cells.filter(c => !(c.face === "front" && c.layer === "base" && b.plan.facePixelPlan.pixels.some(p => p.x === c.x && p.y === c.y)));
    const result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(result.diagnostic.faceFinish.irisGlintCells).toHaveLength(2);
    const p = result.diagnostic.faceFinish.irisGlintCells[0], r = CLASSIC_LAYOUT.head.base.front;
    const i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
    result.atlas.rgba.set([44, 33, 24], i);
    p.color = [44, 33, 24];
    const painted = result.diagnostic.facePixels.find(c => c.x === p.x && c.y === p.y)!; painted.color = [44, 33, 24];
    const quality = measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style);
    expect(quality.violations).toContain("source_eye_brow_changed");
  });
  it("does not expand invalid candidate sets or conceal unsupported head ownership", () => {
    const b = fixture();
    b.design.candidates.face.push(b.design.candidates.face[0]);
    expect(() => selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style)).toThrow("reference_candidate_set_invalid");
    b.design.candidates.face.pop(); b.plan.headIdentityPlan.ownership!.execution = "preserve_existing_grammar";
    const result = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(result.selected).toBeNull(); expect(result.candidates.every(c => c.rejection === "reference_composition_head_ownership_unresolved")).toBe(true);
  });
  it("does not select a source-safe but under-shaded atlas", () => {
    const b = fixture();
    // Authored unit contract: black wrapped print on black cloth, bare arms,
    // short lower cloth. It is legal source construction but lacks sufficient
    // material planes; repainting its pattern/skin to force a PASS is forbidden.
    const outfit = b.plan.outfitPlan;
    outfit.upper.baseColor = "#111111"; outfit.upper.colorBlocks = [];
    outfit.upper.pattern = { ...outfit.upper.pattern, kind: "horizontal_stripe", color: "#111111", placement: "wrap" };
    outfit.upper.leftSleeve.terminationRow = 0; outfit.upper.rightSleeve.terminationRow = 0;
    outfit.lower.baseColor = "#111111"; outfit.lower.shoeColor = "#111111";
    outfit.lower.garmentRows = 2;
    outfit.lower.pattern = { ...outfit.lower.pattern, kind: "horizontal_stripe", color: "#111111", placement: "wrap" };
    outfit.outerLayer.regions = []; outfit.accessories = [];
    const result = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(result.candidates.some(c => c.quality?.constructionValid)).toBe(true);
    expect(result.candidates.filter(c => c.quality?.constructionValid).every(c => !c.foundation?.ok && c.rejection === "craft_foundation_rejected")).toBe(true);
    expect(result.candidates.some(c => c.foundation?.problems.some(p => p.startsWith("too few shaded base faces")))).toBe(true);
    expect(result.selected).toBeNull();
  });
});
