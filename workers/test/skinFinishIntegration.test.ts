import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderSkinEngine, SKIN_ENGINE_VERSION } from "../src/skinEngine";
import { validateFinalAtlas } from "../src/skinPost";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";

const cases: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));

it.each(cases)("accepts face/footwear finishing through the actual engine for $id", (fixture) => {
  const a = normalizeAnalysisForRendering(strictBoundaryAnalysisFromAnnotation(fixture).analysis);
  const plan = buildSkinPlan(a);
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, features, plan.hairPlan);
  const baseline = buildProceduralSourceAtlas(features, style, plan);
  const planBefore = JSON.stringify(plan);
  const sourceBefore = baseline.rgba.slice();
  const result = renderSkinEngine(baseline, plan, a, style);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.engine.version).toBe(SKIN_ENGINE_VERSION);
  expect(result.engine.integrity.valid).toBe(true);
  expect(validateFinalAtlas(result.atlas).ok).toBe(true);
  expect(JSON.stringify(plan)).toBe(planBefore);
  expect(baseline.rgba).toEqual(sourceBefore);
}, 20000);
