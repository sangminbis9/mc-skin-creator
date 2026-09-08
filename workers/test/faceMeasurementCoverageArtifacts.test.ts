import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { FACE_MEASUREMENT_VALUES, resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { analysisFromAnnotation, type AnnotatedCase } from "./generalizationSupport";

const ROOT = resolve("evaluation-artifacts/face-measurement-coverage-20260908");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

describe.skipIf(process.env.RUN_FACE_MEASUREMENT_COVERAGE !== "1")("frozen measurement coverage replay", () => {
  it("preserves all frozen inputs without relabelling manual annotations as production evidence", async () => {
    const phase = process.env.FACE_MEASUREMENT_PHASE;
    expect(["before", "after"]).toContain(phase);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline replay forbids network"));
    try {
      const annotations = JSON.parse(await readFile(resolve("evaluation-artifacts/generalization-20260905/annotations.json"), "utf8")) as AnnotatedCase[];
      const cases = annotations.map((c) => {
        const analysis = analysisFromAnnotation(c);
        return { c, analysis };
      });
      const results = [];
      const evidenceAudit = [];
      // Ground truth is read only for this separate report, never passed into
      // PhotoAnalysis, the quantizer, or the renderer as measured evidence.
      const previous = JSON.parse(await readFile(resolve("evaluation-artifacts/face-quantization-generalization-20260907/after/summary.json"), "utf8"));
      for (const { c, analysis } of cases) {
        if (c.existing) {
          const stored = JSON.parse(await readFile(resolve(`evaluation-artifacts/head-structure-iteration-final/${c.id}/metrics.json`), "utf8"));
          const geometry = parseIdentityGeometry(stored.sourceGeometryAfter);
          expect(geometry).not.toBeNull();
          analysis.identityGeometry = geometry!;
        }
        const normalized = normalizeAnalysisForRendering(structuredClone(analysis));
        const features = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
        const plan = buildSkinPlan(normalized);
        const atlas = buildProceduralFallbackAtlas(features, buildFaceStyle(normalized, features), plan);
        expect(atlas, c.id).not.toBeNull();
        const candidates = buildFacePixelPlanVariants(normalized, 99);
        expect(candidates.length).toBeLessThanOrEqual(3);
        results.push({
          id: c.id, tier: c.existing ? "stored_geometry" : "manual_evaluation_only",
          analysisHash: hash(JSON.stringify(analysis)), facePlanHash: hash(JSON.stringify(plan.facePixelPlan)),
          atlasHash: hash(atlas!.rgba), accepted: true, candidates: candidates.length,
          productionCategoricalCues: Object.values(analysis.faceMeasurementEvidence?.cues ?? {}).filter(cue => cue.provenance === "observed_categorical" && cue.value !== "unknown").length,
        });
        const manual = previous.cases[c.id].sourceAudit as Record<string, unknown> | null;
        const decisions = resolveFaceMeasurements(normalized);
        evidenceAudit.push({
          id: c.id, replayAnalysisOrigin: "manual_evaluation_adapter",
          storedContinuousGeometry: Boolean(c.existing),
          productionCategoricalResponseAvailable: false,
          comparison: Object.fromEntries(Object.keys(FACE_MEASUREMENT_VALUES).map(key => [key, {
            manualGroundTruth: manual?.[key === "expression" ? "mouthTopology" : key] ?? "not_annotated",
            productionCategorical: "not_measured",
            agreement: "not_assessable_without_primary_response",
            replayDecision: decisions[key as keyof typeof decisions],
          }])),
        });
      }
      const snapshot = { results, apiCalls: 0, calibratedCases: results.filter(c => c.tier === "stored_geometry").length, manualOnlyCases: results.filter(c => c.tier === "manual_evaluation_only").length, productionCategoricalCases: results.filter(c => c.productionCategoricalCues > 0).length };
      await mkdir(ROOT, { recursive: true });
      if (phase === "before") {
        await writeFile(join(ROOT, "before.json"), JSON.stringify(snapshot, null, 2), { flag: "wx" });
      } else {
        const baseline = JSON.parse(await readFile(join(ROOT, "before.json"), "utf8"));
        expect(snapshot).toEqual(baseline);
        await writeFile(join(ROOT, "after.json"), JSON.stringify(snapshot, null, 2));
        await writeFile(join(ROOT, "evidence-audit.json"), JSON.stringify({
          notes: "Manual categories are evaluation ground truth only. Missing primary responses are not reported as model observations or successes.",
          cases: evidenceAudit,
        }, null, 2));
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  }, 120000);
});
