// Current-tree round trip, not a replacement for missing historical evidence.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";
import { expect, it, vi } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { normalizeCompactPhotoAnalysisV2, validateCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, normalizeCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { adaptGemmaNamedPhotoAnalysis, validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { validateFinalAtlas } from "../src/skinPost";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function render(raw: PhotoAnalysis) {
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const colors = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, colors, plan.hairPlan);
  const baseline = buildProceduralSourceAtlas(colors, style, plan)!;
  expect(baseline).toBeTruthy();
  const selected = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(analysis), style).selected!;
  expect(selected).toBeTruthy();
  expect(validateFinalAtlas(selected.composition.atlas).ok).toBe(true);
  const craft = validateReferenceAtlasCraft(selected.composition.atlas, baseline, plan, style,
    buildReferenceCraftPlan(plan, selected.design, selected.composition));
  expect(craft.ok, craft.problems.join(",")).toBe(true);
  return { plan, design: selected.design, rgba: selected.composition.atlas.rgba };
}

it("preserves twelve current source-supported contracts through both provider shapes and strict normalization", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const annotationPath = "evaluation-artifacts/generalization-20260905/annotations.json";
  const bytes = readFileSync(annotationPath), annotations: AnnotatedCase[] = JSON.parse(bytes.toString());
  const providerValidate = new Ajv({ allErrors: true }).compile(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
  const rows = [], context = { imageCount: 1 };
  try {
    expect(annotations).toHaveLength(12);
    for (const fixture of annotations) {
      const { analysis, audit } = strictBoundaryAnalysisFromAnnotation(fixture);
      expect(audit.evidenceClasses.C + audit.evidenceClasses.D, fixture.id).toBe(0);
      expect(audit.finalFeatures.length, fixture.id).toBeGreaterThanOrEqual(4);
      expect(validatePhotoAnalysis(analysis).ok, fixture.id).toBe(true);
      const wire = wireFixture(analysis), input = JSON.stringify(wire);
      expect(providerValidate(wire), JSON.stringify(providerValidate.errors)).toBe(true);
      expect(validateCompactPhotoAnalysisV2(wire), fixture.id).toEqual([]);
      expect(validateCompactPhotoAnalysisV3(wire, context), fixture.id).toEqual([]);
      const named = namedGemmaFixture(wire), namedInput = JSON.stringify(named);
      expect(validateGemmaNamedPhotoAnalysis(named), fixture.id).toEqual([]);
      const adapted = adaptGemmaNamedPhotoAnalysis(named);
      expect(adapted.ok, fixture.id).toBe(true);
      if (!adapted.ok) throw new Error("named_adapter_rejected");
      const v2 = normalizeCompactPhotoAnalysisV2(wire), v3 = normalizeCompactPhotoAnalysisV3(wire, context);
      const gemma = normalizeCompactPhotoAnalysisV3(adapted.compact, context);
      expect(v2, fixture.id).toEqual(v3); expect(gemma, fixture.id).toEqual(v3);
      if (!v3.ok) throw new Error("current_strict_normalization_rejected");
      expect(validatePhotoAnalysis(v3.analysis).ok, fixture.id).toBe(true);
      expect(v3.analysis.renderHints).toEqual(analysis.renderHints);
      expect(v3.analysis.canonicalIdentity.features).toEqual(audit.finalFeatures);
      const geometry = fixture.existing ? parseIdentityGeometry(JSON.parse(readFileSync(
        `evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter) : null;
      if (fixture.existing) expect(geometry, fixture.id).toBeTruthy();
      // Geometry is caller-owned, not sent through the primary Compact wire.
      const before = render({ ...analysis, ...(geometry ? { identityGeometry: geometry } : {}) });
      const after = render({ ...v3.analysis, ...(geometry ? { identityGeometry: geometry } : {}) });
      expect(after, fixture.id).toEqual(before);
      expect(JSON.stringify(wire)).toBe(input); expect(JSON.stringify(named)).toBe(namedInput);
      rows.push({ id: fixture.id, calibrated: Boolean(fixture.existing), features: audit.finalFeatures.length,
        sourceFields: audit.sourceFields, providerShapesPass: true, v2V3GemmaRichEqual: true,
        currentRichPlanAtlasDiff: 0, craftPass: true, planSha256: sha(JSON.stringify(after.plan)), atlasSha256: sha(after.rgba) });
    }
    expect(rows.filter(r => r.calibrated)).toHaveLength(5);
    expect(readFileSync(annotationPath)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    const root = freshAuditOutput("evaluation-artifacts/compact-current-normalization-20261008-");
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "current_tree_round_trip_only",
      historicalComparison: "not_performed", replacesHistoricalEvidence: false,
      annotationSha256: sha(bytes), providerCalls: 0, accepted: rows.length, fabricatedFeatures: 0, rows }, null, 2), { flag: "wx" });
    console.info(`COMPACT_CURRENT_NORMALIZATION ${root}`);
  } finally { network.mockRestore(); }
}, 120_000);
