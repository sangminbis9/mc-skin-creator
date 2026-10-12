// Frozen offline inputs, NOT a reconstruction of the missing D003 response.
import { createHash } from "node:crypto";
import { cpuUsage, memoryUsage } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { encodePng, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
async function sample<T>(work: () => T | Promise<T>) {
  const start = performance.now(), cpu = cpuUsage(), heapBefore = memoryUsage().heapUsed;
  const value = await work(), used = cpuUsage(cpu), heapAfter = memoryUsage().heapUsed;
  return { value, metric: { wallMs: performance.now() - start,
    processCpuMs: (used.user + used.system) / 1000, heapBefore, heapAfter } };
}

it("separates frozen production phase costs while preserving exact plans and PNG bytes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const file = "evaluation-artifacts/generalization-20260905/annotations.json", original = readFileSync(file);
  const fixtures: AnnotatedCase[] = JSON.parse(original.toString()), cases = [];
  try {
    for (const fixture of fixtures) {
      const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
      if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(
        `evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const inputHash = sha(JSON.stringify(raw));
      const context = await sample(() => {
        const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
        const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
        return { analysis, plan, features, style: buildFaceStyle(analysis, features, plan.hairPlan) };
      });
      const { analysis, plan, features, style } = context.value, planHash = sha(JSON.stringify(plan));
      const baseline = await sample(() => buildProceduralSourceAtlas(features, style, plan));
      expect(baseline.value, fixture.id).not.toBeNull();
      const render = await sample(() => renderReferencePrimaryAtlas(baseline.value!, plan, analysis, style));
      expect(render.value.ok, fixture.id).toBe(true);
      if (!render.value.ok) throw new Error(`frozen_render_failed:${fixture.id}`);
      const result = render.value;
      expect(result.summary.craftValidation).toBe("pass");
      const png = await sample(() => encodePng(result.atlas));
      const decoded = await decodePng(png.value);
      expect(validateFinalAtlas(decoded).ok).toBe(true);
      expect(decoded.rgba).toEqual(result.atlas.rgba);
      expect(sha(JSON.stringify(plan))).toBe(planHash);
      expect(sha(JSON.stringify(raw))).toBe(inputHash);
      cases.push({ caseId: fixture.id, calibrated: !!fixture.existing, inputHash, planHash,
        atlasHash: sha(decoded.rgba), pngHash: sha(png.value), craft: "pass", finalAtlas: "pass",
        candidateCount: result.summary.renderAttempts, context: context.metric, baseline: baseline.metric,
        referenceRender: render.metric, pngEncode: png.metric });
    }
    expect(cases).toHaveLength(12); expect(cases.filter(c => c.calibrated)).toHaveLength(5);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(original);
    const root = freshAuditOutput("evaluation-artifacts/post-geometry-production-cost-20261010-");
    writeFileSync(`${root}/summary.json`, JSON.stringify({ mode: "offline_frozen_inputs_local_node",
      providerCalls: 0, annotationHash: sha(original), nodeVersion: process.version, cases,
      limitations: ["not D003 provider output", "local process CPU is not edge request CPU",
        "heap endpoints are not peak memory", "cold and warm cases are not controlled benchmarks",
        "1102 CPU versus memory cause remains unobserved"],
    }, null, 2), { flag: "wx" });
    console.info("POST_GEOMETRY_COST", root);
  } finally { network.mockRestore(); }
}, 120_000);
