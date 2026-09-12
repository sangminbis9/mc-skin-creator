import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { normalizeCompactPhotoAnalysisV2, validateCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { normalizeCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex,
  normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { validateAtlasCraft } from "../src/skinPost";
import { analysisFromAnnotation, type AnnotatedCase } from "./generalizationSupport";
import { wireFixture } from "./compactV3Support";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";

const ROOT = process.env.COMPACT_MANUAL_COVERAGE_OUTPUT_ROOT ?? "evaluation-artifacts/compact-manual-fixture-coverage-20260910";
const context = { imageCount: 1 };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function render(analysis: PhotoAnalysis) {
  const normalized = normalizeAnalysisForRendering(analysis);
  const plan = buildSkinPlan(normalized);
  const colors = refineFeatureColorsFromAnalysis(normalized,
    fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  const style = buildFaceStyle(normalized, colors);
  const atlas = buildProceduralFallbackAtlas(colors, style, plan);
  if (!atlas) throw new Error("missing_fixture_atlas");
  return { plan, atlas, craft: validateAtlasCraft(atlas, style, undefined, undefined, plan) };
}

function corePlan(plan: ReturnType<typeof buildSkinPlan>) {
  return { ...plan, assignments: [] };
}

describe("source-supported manual fixture strict-boundary coverage", () => {
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); }); });
  afterAll(() => { expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard.mockRestore(); });

  it("recovers only atomized evidence already present in frozen annotations", async () => {
    const annotationText = await readFile("evaluation-artifacts/generalization-20260905/annotations.json", "utf8");
    const annotations = JSON.parse(annotationText) as AnnotatedCase[];
    const frozen = JSON.parse(await readFile("evaluation-artifacts/compact-primary-v2-20260909/frozen-regression.json", "utf8"));
    const results = [];

    for (const fixture of annotations) {
      const historical = analysisFromAnnotation(fixture);
      const baselineWire = wireFixture(historical);
      const baselineAccepted = validateCompactPhotoAnalysisV3(baselineWire, context).length === 0;
      const { analysis, audit } = strictBoundaryAnalysisFromAnnotation(fixture);
      if (fixture.existing) {
        const stored = JSON.parse(await readFile(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8"));
        const geometry = parseIdentityGeometry(stored.sourceGeometryAfter);
        expect(geometry, fixture.id).toBeTruthy();
        historical.identityGeometry = geometry!;
        analysis.identityGeometry = geometry!;
      }

      const storedRich = JSON.parse(await readFile(`evaluation-artifacts/generalization-20260905/after/${fixture.id}/analysis-and-plan.json`, "utf8"));
      expect(storedRich.analysis.canonicalIdentity.features, fixture.id).toEqual(audit.beforeFeatures);
      const wire = wireFixture(analysis);
      const v2Errors = validateCompactPhotoAnalysisV2(wire);
      const v3Errors = validateCompactPhotoAnalysisV3(wire, context);
      expect(v2Errors, fixture.id).toEqual([]);
      expect(v3Errors, fixture.id).toEqual([]);
      const v2 = normalizeCompactPhotoAnalysisV2(wire);
      const v3 = normalizeCompactPhotoAnalysisV3(wire, context);
      expect(v2, fixture.id).toEqual(v3);
      expect(v2.ok, fixture.id).toBe(true);
      expect(v3.ok, fixture.id).toBe(true);
      if (!v2.ok || !v3.ok) throw new Error("strict_normalization_failed");
      expect(v2.analysis.canonicalIdentity.features, fixture.id).toEqual(audit.finalFeatures);
      expect(v2.analysis.renderHints, fixture.id).toEqual(historical.renderHints);
      expect(validatePhotoAnalysis(v2.analysis).ok, fixture.id).toBe(true);

      const before = render(historical);
      const boundaryBaseline = render({
        ...analysis,
        canonicalIdentity: { ...analysis.canonicalIdentity, features: historical.canonicalIdentity.features },
      });
      const afterV2 = render({ ...v2.analysis, identityGeometry: analysis.identityGeometry });
      const afterV3 = render({ ...v3.analysis, identityGeometry: analysis.identityGeometry });
      const isGap = !baselineAccepted;
      expect(afterV3.plan, fixture.id).toEqual(afterV2.plan);
      expect(afterV3.atlas, fixture.id).toEqual(afterV2.atlas);
      if (isGap) {
        expect(boundaryBaseline.atlas, fixture.id).toEqual(before.atlas);
        expect(afterV3.plan.facePixelPlan, fixture.id).toEqual(boundaryBaseline.plan.facePixelPlan);
        expect(afterV3.plan.hairPlan, fixture.id).toEqual(boundaryBaseline.plan.hairPlan);
        expect(afterV3.plan.headIdentityPlan, fixture.id).toEqual(boundaryBaseline.plan.headIdentityPlan);
        expect(afterV3.plan.outfitPlan, fixture.id).toEqual(boundaryBaseline.plan.outfitPlan);
        expect(corePlan(afterV3.plan), fixture.id).toEqual(corePlan(boundaryBaseline.plan));
        expect(afterV3.atlas, fixture.id).toEqual(before.atlas);
      }
      expect(afterV3.craft.ok, fixture.id).toBe(true);

      const prior = frozen.results.find((entry: { id: string }) => entry.id === fixture.id);
      const historicalPlanDiff = hash(before.plan) === prior.planHash ? 0 : 1;
      const historicalAtlasDiff = hash(before.atlas.rgba) === prior.atlasHash ? 0 : 1;
      if (historicalPlanDiff || historicalAtlasDiff) {
        expect(["left", "right"], fixture.id).toContain(historical.renderHints.hairPart);
        expect(before.plan.hairPlan.structure.groups.some((group) => group.kind === "part_sweep"), fixture.id).toBe(true);
      }
      results.push({
        id: fixture.id,
        calibrated: Boolean(fixture.existing),
        beforeCount: audit.beforeFeatures.length,
        beforeFeatures: audit.beforeFeatures.map(({ feature, category }) => ({ feature, category, provenance: "A: stored trusted rich analysis" })),
        recoveredFeatures: audit.recoveredFeatures.map(({ feature, category, evidence }) => ({ feature, category, evidence, provenance: "B: frozen source-visible annotation" })),
        sourceFields: audit.sourceFields,
        compatibilitySourceFields: audit.compatibilitySourceFields,
        sourceSupportedAdded: audit.netAdded,
        finalCount: audit.finalFeatures.length,
        classification: audit.classification,
        evidenceClasses: audit.evidenceClasses,
        baselineAccepted,
        v2Strict: v2Errors.length === 0,
        v3Strict: v3Errors.length === 0,
        v2V3RichHashEqual: hash(v2.analysis) === hash(v3.analysis),
        identityFeaturesHash: hash(v3.analysis.canonicalIdentity.features),
        renderHintsHash: hash(v3.analysis.renderHints),
        facePixelPlanDiff: hash(afterV3.plan.facePixelPlan) === hash(boundaryBaseline.plan.facePixelPlan) ? 0 : 1,
        hairPlanDiff: hash(afterV3.plan.hairPlan) === hash(boundaryBaseline.plan.hairPlan) ? 0 : 1,
        headIdentityPlanDiff: hash(afterV3.plan.headIdentityPlan) === hash(boundaryBaseline.plan.headIdentityPlan) ? 0 : 1,
        outfitPlanDiff: hash(afterV3.plan.outfitPlan) === hash(boundaryBaseline.plan.outfitPlan) ? 0 : 1,
        corePlanDiff: hash(corePlan(afterV3.plan)) === hash(corePlan(boundaryBaseline.plan)) ? 0 : 1,
        fullPlanDiff: hash(afterV3.plan) === hash(before.plan) ? 0 : 1,
        fullPlanDelta: hash(afterV3.plan) === hash(before.plan) ? "none" : "canonical assignment audit only",
        atlasDiff: hash(afterV3.atlas.rgba) === hash(before.atlas.rgba) ? 0 : 1,
        atlasHash: hash(afterV3.atlas.rgba),
        historicalPlanDiff,
        historicalAtlasDiff,
        craft: afterV3.craft.ok,
      });
    }

    expect(results).toHaveLength(12);
    expect(results.filter((result) => result.baselineAccepted)).toHaveLength(7);
    expect(results.filter((result) => result.v2Strict && result.v3Strict)).toHaveLength(12);
    expect(results.filter((result) => result.corePlanDiff)).toHaveLength(0);
    expect(results.filter((result) => result.atlasDiff)).toHaveLength(0);
    expect(results.filter((result) => result.craft)).toHaveLength(12);
    const gaps = results.filter((result) => !result.baselineAccepted);
    expect(gaps).toHaveLength(5);
    expect(gaps.every((result) => result.beforeCount === 3 && result.finalCount === 4)).toBe(true);
    expect(gaps.every((result) => result.classification === "source_supported_recovery")).toBe(true);
    expect(gaps.every((result) => result.evidenceClasses.C === 0 && result.evidenceClasses.D === 0)).toBe(true);
    expect(gaps.filter((result) => result.corePlanDiff)).toHaveLength(0);
    expect(gaps.filter((result) => result.atlasDiff)).toHaveLength(0);
    expect(gaps.filter((result) => result.calibrated && result.atlasDiff)).toHaveLength(0);

    await mkdir(ROOT, { recursive: true });
    await writeFile(`${ROOT}/coverage.json`, JSON.stringify({
      annotationHash: createHash("sha256").update(annotationText).digest("hex"),
      historicalAnnotationsModified: false,
      productionChanged: false,
      compactV3Active: false,
      providerCalls: 0,
      beforeStrictAccepted: results.filter((result) => result.baselineAccepted).length,
      afterStrictAccepted: results.filter((result) => result.v2Strict && result.v3Strict).length,
      fabricationCount: results.reduce((sum, result) => sum + result.evidenceClasses.C + result.evidenceClasses.D, 0),
      v2V3RichDiffs: results.filter((result) => !result.v2V3RichHashEqual).length,
      targetGapFacePixelPlanDiffs: gaps.reduce((sum, result) => sum + result.facePixelPlanDiff, 0),
      targetGapHairPlanDiffs: gaps.reduce((sum, result) => sum + result.hairPlanDiff, 0),
      targetGapHeadIdentityPlanDiffs: gaps.reduce((sum, result) => sum + result.headIdentityPlanDiff, 0),
      targetGapOutfitPlanDiffs: gaps.reduce((sum, result) => sum + result.outfitPlanDiff, 0),
      targetGapCorePlanDiffs: gaps.reduce((sum, result) => sum + result.corePlanDiff, 0),
      targetGapFullPlanDiffs: gaps.reduce((sum, result) => sum + result.fullPlanDiff, 0),
      fullPlanDiffReason: "Recovered identity features necessarily add SkinPlan.assignments; all executable pixel plans are unchanged.",
      targetGapAtlasDiffs: gaps.reduce((sum, result) => sum + result.atlasDiff, 0),
      allStrictNormalizedCorePlanDiffs: results.reduce((sum, result) => sum + result.corePlanDiff, 0),
      allStrictNormalizedFullPlanDiffs: results.reduce((sum, result) => sum + result.fullPlanDiff, 0),
      allStrictNormalizedAtlasDiffs: results.reduce((sum, result) => sum + result.atlasDiff, 0),
      craftApproved: results.filter((result) => result.craft).length,
      calibratedCases: results.filter((result) => result.calibrated).length,
      calibratedAtlasDiffs: results.filter((result) => result.calibrated && result.atlasDiff).length,
      results,
    }, null, 2));
  }, 30_000);
});
