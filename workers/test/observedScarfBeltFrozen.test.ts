import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng } from "../src/png";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { historicalScarfBeltPlan, assertAccessoryPaletteBoundary } from "./historicalScarfBeltColors";
import { freshAuditOutput } from "./freshAuditOutput";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("preserves twelve frozen plans and five calibrated geometries outside proven accessory palette changes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const beforeRoot = "evaluation-artifacts/reference-primary-integration-20261005-3ygZFG";
    const baselineBytes = readFileSync(`${beforeRoot}/results.json`);
    const previous: { cases: Array<{ caseId: string; sourcePlanHash: string; geometryHash: string; defaultAtlasHash: string }> } = JSON.parse(baselineBytes.toString());
    const input = "evaluation-artifacts/generalization-20260905/annotations.json", annotationBytes = readFileSync(input);
    const fixtures: AnnotatedCase[] = JSON.parse(annotationBytes.toString()), cases = [];
    for (const fixture of fixtures) {
      const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
      if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis), oldPlan = historicalScarfBeltPlan(source);
      const old = previous.cases.find(c => c.caseId === fixture.id)!;
      expect(hash(JSON.stringify(oldPlan)), fixture.id).toBe(old.sourcePlanHash);
      expect(hash(JSON.stringify(analysis.identityGeometry ?? null)), fixture.id).toBe(old.geometryHash);
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features, source.hairPlan), design = buildReferenceStylePlan(analysis);
      const baseline = buildProceduralSourceAtlas(features, style, source)!;
      const oldBaseline = buildProceduralSourceAtlas(features, style, oldPlan)!;
      const after = selectReferenceStyleAtlas(baseline, source, design, style).selected!;
      const before = selectReferenceStyleAtlas(oldBaseline, oldPlan, design, style).selected!;
      const historicalAtlas = await decodePng(readFileSync(`${beforeRoot}/${fixture.id}-default.png`));
      expect(hash(historicalAtlas.rgba)).toBe(old.defaultAtlasHash);
      const irisPixels = assertSingletonPigmentBoundary(before.composition.atlas, historicalAtlas, oldPlan, style);
      const changed = assertAccessoryPaletteBoundary(before.composition.atlas, after.composition.atlas, source, style.skinTone!, true);
      const craft = validateReferenceAtlasCraft(after.composition.atlas, baseline, source, style, buildReferenceCraftPlan(source, design, after.composition));
      expect(craft.ok, fixture.id).toBe(true);
      expect(after.quality.violations, fixture.id).toEqual([]);
      const paletteEvidence = source.outfitPlan.provenance.filter(p => /^accessories\.(scarf|belt)\.color$/.test(p.target));
      if (!paletteEvidence.length) expect(changed).toEqual([]);
      cases.push({ caseId: fixture.id, calibrated: !!fixture.existing, exactHistoricalPlanRecovered: true,
        geometryUnchanged: true, craftPass: true, intentionalAccessoryPixels: changed.length, intentionalIrisPixels: irisPixels,
        newPaletteEvidence: paletteEvidence, unrelatedPixelDelta: 0 });
    }
    expect(cases).toHaveLength(12); expect(cases.filter(c => c.calibrated)).toHaveLength(5);
    expect(hash(readFileSync(input))).toBe(hash(annotationBytes));
    expect(hash(readFileSync(`${beforeRoot}/results.json`))).toBe(hash(baselineBytes));
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-scarf-belt-frozen-20261010-");
    writeFileSync(`${output}/summary.json`, JSON.stringify({ beforeRoot, previousSummaryHash: hash(baselineBytes),
      annotationHash: hash(annotationBytes), providerCalls: 0, cases }, null, 2), { flag: "wx" });
    console.log("SCARF_BELT_FROZEN", output);
  } finally { network.mockRestore(); }
}, 120_000);
