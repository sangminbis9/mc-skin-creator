import { describe, expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { validateAtlasCraft, validateAtlasCraftFoundation } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture() {
  const raw = makeAnalysis();
  raw.observed.hair = "short straight hair";
  raw.observed.clothing = "plain knit sweater";
  raw.renderHints.overallHairLength = "ear"; raw.renderHints.sideHairLength = "short";
  raw.renderHints.eyeShape = "almond"; raw.renderHints.bangs = "none";
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "beard";
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const source = buildSkinPlan(analysis), style = buildFaceStyle(analysis, features, source.hairPlan);
  const baseline = buildProceduralFallbackAtlas(features, style, source)!;
  const design = buildReferenceStylePlan(analysis), composition = composeReferenceStyleAtlas(baseline, source, design, style);
  const plan = buildReferenceCraftPlan(source, design, composition);
  return { source, style, baseline, composition, plan };
}

describe("reference executable craft plan: not a legacy-error filter", () => {
  it("snapshots identity/style/paint independently without changing the source", () => {
    const b = fixture(), before = JSON.stringify(b.source);
    expect(b.plan.identity).toEqual(b.source); expect(b.plan.identity).not.toBe(b.source);
    expect(b.plan.execution).not.toBe(b.composition.diagnostic);
    const verdict = validateReferenceAtlasCraft(b.composition.atlas, b.baseline, b.source, b.style, b.plan);
    expect(verdict.construction?.violations).toEqual([]);
    expect(verdict.foundation).toEqual(validateAtlasCraftFoundation(b.composition.atlas, b.style));
    expect(verdict.ok).toBe(verdict.foundation?.ok);
    b.composition.diagnostic.surfacePixels[0].color[0] = 0;
    expect(b.plan.execution.surfacePixels).not.toEqual(b.composition.diagnostic.surfacePixels);
    expect(JSON.stringify(b.source)).toBe(before);
  });
  it("still rejects flattened material even if the executable paint list is rewritten", () => {
    const b = fixture(), atlas = { ...b.composition.atlas, rgba: b.composition.atlas.rgba.slice() };
    for (const part of Object.values(CLASSIC_LAYOUT)) for (const r of Object.values(part.base)) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) atlas.rgba.set([80, 80, 80, 255], ((r.y + y) * 64 + r.x + x) * 4);
    }
    for (const p of b.plan.execution.surfacePixels.filter(p => p.layer === "base")) p.color = [80, 80, 80];
    const verdict = validateReferenceAtlasCraft(atlas, b.baseline, b.source, b.style, b.plan);
    expect(verdict.ok).toBe(false);
    expect(verdict.foundation?.problems).toContain("base palette too small (1)");
    expect(verdict.foundation?.problems).toContain("too few shaded base faces (0)");
    const legacy = validateAtlasCraft(atlas, b.style, b.source.facePixelPlan, b.source.hairPlan, b.source);
    for (const problem of verdict.foundation!.problems) expect(legacy.problems).toContain(problem);
  });
  it("rejects identity-snapshot tampering and invalid atlas before metric traversal", () => {
    const b = fixture(); b.plan.identity.facePixelPlan.pixels[0].x += 1;
    expect(validateReferenceAtlasCraft(b.composition.atlas, b.baseline, b.source, b.style, b.plan).problems).toContain("reference_craft_identity_changed");
    const invalid = { width: 1, height: 1, rgba: new Uint8Array(4) };
    const verdict = validateReferenceAtlasCraft(invalid, b.baseline, b.source, b.style, b.plan);
    expect(verdict.ok).toBe(false); expect(verdict.foundation).toBeNull(); expect(verdict.construction).toBeNull();
  });
  it("keeps common shell/coverage failures in legacy and reference contracts", () => {
    const b = fixture(), atlas = { ...b.composition.atlas, rgba: b.composition.atlas.rgba.slice() };
    for (const r of Object.values(CLASSIC_LAYOUT.body.overlay)) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) atlas.rgba.set([20, 20, 20, 255], ((r.y + y) * 64 + r.x + x) * 4);
    }
    const foundation = validateAtlasCraftFoundation(atlas, b.style);
    expect(foundation.ok).toBe(false);
    expect(foundation.problems).toContain("solid outer-layer shells found (6)");
    expect(foundation.problems).toContain("body outer layer is over-covered (1.000)");
    const legacy = validateAtlasCraft(atlas, b.style, b.source.facePixelPlan, b.source.hairPlan, b.source);
    for (const problem of foundation.problems) expect(legacy.problems).toContain(problem);
  });
});
