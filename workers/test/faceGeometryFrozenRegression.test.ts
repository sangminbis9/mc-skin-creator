import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { buildIdentityPixelPlans as beforePlans } from "../evaluation-artifacts/face-only-geometry-20260914/baseline-identityPlans";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { normalizeCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { wireFixture } from "./compactV3Support";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

it("compares this iteration's exact baseline quantizer/plans and atlases for all twelve strict fixtures", async () => {
  const annotations = JSON.parse(await readFile("evaluation-artifacts/generalization-20260905/annotations.json", "utf8")) as AnnotatedCase[];
  const results = [];
  for (const c of annotations) {
    const { analysis, audit } = strictBoundaryAnalysisFromAnnotation(c);
    const wire = wireFixture(analysis);
    const v2 = normalizeCompactPhotoAnalysisV2(wire), v3 = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(v2.ok, c.id).toBe(true); expect(v3.ok, c.id).toBe(true);
    if (!v2.ok || !v3.ok) throw new Error("strict_failed");
    expect(v2.analysis).toEqual(v3.analysis);
    expect(audit.evidenceClasses.D).toBe(0);
    if (c.existing) {
      const stored = JSON.parse(await readFile(`evaluation-artifacts/head-structure-iteration-final/${c.id}/metrics.json`, "utf8"));
      analysis.identityGeometry = parseIdentityGeometry(stored.sourceGeometryAfter)!;
    }
    const normalized = normalizeAnalysisForRendering(analysis);
    const before = beforePlans(normalized), after = buildIdentityPixelPlans(normalized);
    expect(after, c.id).toEqual(before);
    const skinPlan = buildSkinPlan(normalized);
    const colors = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
    const style = buildFaceStyle(normalized, colors);
    const oldAtlas = buildProceduralFallbackAtlas(colors, style, { ...skinPlan, ...before });
    const atlas = buildProceduralFallbackAtlas(colors, style, skinPlan);
    expect(atlas).toBeTruthy(); expect(atlas, c.id).toEqual(oldAtlas);
    if (!atlas) throw new Error("atlas_missing");
    expect(validateFinalAtlas(atlas).ok, c.id).toBe(true);
    expect(validateAtlasCraft(atlas, style, undefined, undefined, skinPlan).ok, c.id).toBe(true);
    results.push({ id: c.id, calibrated: !!c.existing, strict: true, craft: true, fabrication: 0, planDiff: 0, atlasDiff: 0, planHash: hash(after), atlasHash: hash(atlas.rgba) });
  }
  expect(results).toHaveLength(12); expect(results.filter(r => r.calibrated)).toHaveLength(5);
  if (process.env.FACE_ONLY_REGRESSION_PATH) await writeFile(process.env.FACE_ONLY_REGRESSION_PATH, JSON.stringify({ strict: 12, craft: 12, fabrication: 0, calibratedFiveRegression: 0, results }, null, 2), { flag: "wx" });
}, 30_000);
