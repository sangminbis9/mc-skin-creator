// Offline before/after comparison; baseline is saved before the production edit.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as uv from "../src/uvLayout";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const baselinePath = "evaluation-artifacts/reference-seam-cost-20261010-CeBYcm/summary.json";
interface CaseResult {
  caseId: string; inputHash: string;
  compositions: Array<{ id: string; atlasHash: string; diagnosticHash: string } | { id: string; error: string }>;
  candidatesHash: string; renderAttempts: number; selectedDesignHash: string; selectedAtlasHash: string;
  compositionMs: number; seamBuildCalls: number;
}
it("preserves every candidate composition, validation, score and selected atlas", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const seams = vi.spyOn(uv, "getBoxUvSeams");
  const annotation = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
  const fixtures: AnnotatedCase[] = JSON.parse(annotation.toString());
  const cases: CaseResult[] = [];
  try {
    for (const fixture of fixtures) {
      const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
      if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(
        `evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const a = normalizeAnalysisForRendering(raw), source = buildSkinPlan(a);
      const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const style = buildFaceStyle(a, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
      const design = buildReferenceStylePlan(a), inputHash = sha(JSON.stringify({ a, source, style }));
      const compositions = [];
      seams.mockClear(); const started = performance.now();
      for (const face of design.candidates.face) for (const hair of design.candidates.hair) for (const outfit of design.candidates.outfit) {
        const choice = { ...design, face, hair, outfit }, id = `${face.family}/${hair.family}/${outfit.family}`;
        try {
          const result = composeReferenceStyleAtlas(baseline, source, choice, style);
          compositions.push({ id, atlasHash: sha(result.atlas.rgba), diagnosticHash: sha(JSON.stringify(result.diagnostic)) });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("reference_composition_")) throw error;
          compositions.push({ id, error: error.message });
        }
      }
      const compositionMs = performance.now() - started, seamBuildCalls = seams.mock.calls.length;
      const result = selectReferenceStyleAtlas(baseline, source, design, style);
      expect(result.selected, fixture.id).not.toBeNull();
      expect(sha(JSON.stringify({ a, source, style }))).toBe(inputHash);
      cases.push({ caseId: fixture.id, inputHash, compositions,
        candidatesHash: sha(JSON.stringify(result.candidates)), renderAttempts: result.renderAttempts,
        selectedDesignHash: sha(JSON.stringify(result.selected!.design)), selectedAtlasHash: sha(result.selected!.composition.atlas.rgba),
        compositionMs, seamBuildCalls });
      // Mutating a returned source-painted result must not contaminate the
      // fixed UV graph or the next invocation in the same Worker isolate.
      const selected = result.selected!, expected = sha(JSON.stringify(selected.composition));
      selected.composition.atlas.rgba.fill(17);
      for (const cell of selected.composition.diagnostic.surfacePixels) cell.color.fill(23);
      const repeat = composeReferenceStyleAtlas(baseline, source, selected.design, style);
      expect(sha(JSON.stringify(repeat)), fixture.id).toBe(expected);
    }
    expect(cases).toHaveLength(12); expect(network).not.toHaveBeenCalled();
    {
      const beforeBytes = readFileSync(baselinePath);
      expect(sha(beforeBytes)).toBe("9f3ded28fcce45579b380bab3cf2565f6611240662569dbb3f0159380d404ffa");
      const before = JSON.parse(beforeBytes.toString());
      expect(before.annotationHash).toBe(sha(annotation));
      const semantic = ({ compositionMs: _ms, seamBuildCalls: _calls, ...rest }: CaseResult) => {
        void _ms; void _calls; return rest;
      };
      expect(cases.map(semantic)).toEqual(before.cases.map(semantic));
      expect(cases.reduce((n, c) => n + c.seamBuildCalls, 0)).toBeLessThan(before.cases.reduce((n: number, c: CaseResult) => n + c.seamBuildCalls, 0));
    }
    const root = freshAuditOutput("evaluation-artifacts/reference-seam-cost-20261010-");
    writeFileSync(`${root}/summary.json`, JSON.stringify({ providerCalls: 0, annotationHash: sha(annotation),
      rendererHash: sha(readFileSync("src/referenceStyleRenderer.ts")), baseline: baselinePath,
      cases, limitations: "local timings are not edge limits or a reproduction of D003" }, null, 2), { flag: "wx" });
    console.info("SEAM_COST", root);
  } finally { seams.mockRestore(); network.mockRestore(); }
}, 120_000);
