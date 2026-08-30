import { describe, expect, it } from "vitest";
import {
  assessIdentitySensitivity,
  buildIdentityCalibrationAtlases,
  buildScoreHistogram,
  summarizeIdentityScores,
  validateCalibrationBenchmark,
} from "../src/identityCalibration";
import { assessPairwiseOrderBias } from "../src/headIdentity";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry, makeSyntheticAtlas } from "./helpers";

describe("absolute identity evaluator calibration", () => {
  it("builds blind A-D stimuli with identical, minor, P5-degraded, and generic changes", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const plans = buildIdentityPixelPlans(analysis);
    const current = makeSyntheticAtlas(17);
    const variants = buildIdentityCalibrationAtlases(current, plans.facePixelPlan, plans.hairPlan);
    expect(variants.map((variant) => variant.level)).toEqual([
      "A_identical",
      "B_minor",
      "C_degraded",
      "D_generic",
    ]);
    expect(variants[0].atlas.rgba).toEqual(current.rgba);
    expect(variants[1]).toMatchObject({ changedPixels: 1, changedIdentityDimensions: [] });
    expect(variants[2].changedIdentityDimensions).toContain("glasses_readability");
    expect(variants[2].changedPixels).toBeGreaterThan(0);
    expect(variants[3].changedIdentityDimensions).toEqual(expect.arrayContaining(["hairline", "eye_layout", "mouth_expression"]));
    expect(variants[3].changedPixels).toBeGreaterThan(variants[2].changedPixels);
  });

  it("accepts the complete integer 0-100 range instead of five-point buckets", () => {
    const histogram = buildScoreHistogram([80, 82, 83, 84, 85, 86, 87, 88, 89, 90]);
    expect(histogram.count).toBe(10);
    expect(histogram.distinctScores).toBe(10);
    expect(histogram.bins[83]).toBe(1);
    expect(histogram.bins[89]).toBe(1);
  });

  it("detects the observed 85 plateau without changing any score", () => {
    const identities = [40, 65, 72, 75, 82, 82, ...Array(36).fill(85), 88, 90];
    const faceHair = [30, 60, 70, ...Array(3).fill(75), ...Array(26).fill(80), 85, 85, 86, ...Array(9).fill(90)];
    const summary = summarizeIdentityScores(identities.map((identityScore, index) => ({
      id: String(index),
      identityScore,
      faceHairScore: faceHair[index],
    })));
    expect(summary.identity.mode).toBe(85);
    expect(summary.identity.modeCount).toBe(36);
    expect(summary.identity.modeShare).toBeCloseTo(36 / 44);
    expect(summary.faceHair.modeShare).toBeCloseTo(26 / 44);
    expect(summary.suspiciousIdentityPlateau).toBe(true);
  });

  it("measures monotonic degradation and reports both plateaus and inversions", () => {
    const monotonic = assessIdentitySensitivity([
      { id: "current", retainedIdentity: 1, critique: { identityScore: 91, faceHairScore: 90 } },
      { id: "minor", retainedIdentity: 0.9, critique: { identityScore: 90, faceHairScore: 89 } },
      { id: "flat-hairline", retainedIdentity: 0.65, critique: { identityScore: 84, faceHairScore: 82 } },
      { id: "generic", retainedIdentity: 0, critique: { identityScore: 61, faceHairScore: 70 } },
    ]);
    expect(monotonic.monotonic).toBe(true);
    expect(monotonic.strictDrops).toBe(3);
    expect(monotonic.totalIdentityDrop).toBe(30);

    const insensitive = assessIdentitySensitivity([
      { id: "current", retainedIdentity: 1, critique: { identityScore: 85, faceHairScore: 90 } },
      { id: "degraded", retainedIdentity: 0.5, critique: { identityScore: 85, faceHairScore: 75 } },
      { id: "generic", retainedIdentity: 0, critique: { identityScore: 86, faceHairScore: 65 } },
    ]);
    expect(insensitive.monotonic).toBe(false);
    expect(insensitive.plateauSteps).toBe(1);
    expect(insensitive.inversions).toHaveLength(1);
  });

  it("validates identical, minor, degraded, generic and improved benchmark semantics", () => {
    expect(validateCalibrationBenchmark([
      { level: "A_identical", absolute: { identityScore: 91, faceHairScore: 90 }, pairwise: { winner: "tie", confidence: 0.9 } },
      { level: "B_minor", absolute: { identityScore: 90, faceHairScore: 90 } },
      { level: "C_degraded", absolute: { identityScore: 80, faceHairScore: 78 }, pairwise: { winner: "A", confidence: 0.85 } },
      { level: "D_generic", absolute: { identityScore: 62, faceHairScore: 68 } },
      { level: "E_improved", pairwise: { winner: "B", confidence: 0.8 } },
    ])).toEqual([]);
  });
});

describe("pairwise order calibration", () => {
  it("normalizes A/B reversal to candidate identity", () => {
    const stable = assessPairwiseOrderBias({ winner: "A" }, { winner: "B" });
    expect(stable).toEqual({
      forwardWinner: "first",
      reversedWinner: "first",
      consistent: true,
      biasedTowardLabel: null,
    });
  });

  it("detects label-position bias and keeps identical ties stable", () => {
    expect(assessPairwiseOrderBias({ winner: "A" }, { winner: "A" })).toMatchObject({
      consistent: false,
      biasedTowardLabel: "A",
    });
    expect(assessPairwiseOrderBias({ winner: "tie" }, { winner: "tie" })).toMatchObject({
      consistent: true,
      biasedTowardLabel: null,
    });
  });
});
