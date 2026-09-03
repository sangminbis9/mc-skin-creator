import { describe, expect, it } from "vitest";
import {
  assessIdentitySensitivity,
  assessEvaluatorHealth,
  assessMeaningfulImprovementSensitivity,
  assessPairwiseStability,
  assessPairwiseEvaluatorRoleHealth,
  buildIdentityCalibrationAtlases,
  buildScoreHistogram,
  summarizeIdentityScores,
  validateCalibrationBenchmark,
  classifyCalibrationPairwiseRole,
  NEAR_PEER_CALIBRATION_DATASET,
} from "../src/identityCalibration";
import { assessPairwiseOrderBias, type PairwiseDecision } from "../src/headIdentity";
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
      { level: "D_generic", absolute: { identityScore: 62, faceHairScore: 68 }, pairwise: { winner: "A", confidence: 0.9 } },
      { level: "E_improved", pairwise: { winner: "B", confidence: 0.8 } },
    ])).toEqual([]);
  });

  it("defines three admissible near-peer domains with bounded deterministic differences", () => {
    expect(NEAR_PEER_CALIBRATION_DATASET.map((fixture) => fixture.primaryDimension)).toEqual([
      "hairline",
      "eyeLayout",
      "headSilhouette",
    ]);
    for (const fixture of NEAR_PEER_CALIBRATION_DATASET) {
      expect(fixture.candidateA).toMatchObject({ p5Valid: true, craftValid: true, renderContractValid: true, criticalDefects: [] });
      expect(fixture.candidateB).toMatchObject({ p5Valid: true, craftValid: true, renderContractValid: true, criticalDefects: [] });
      expect(Object.values(fixture.deterministicDifference).some((distance) => distance > 0)).toBe(true);
    }
  });

  it("reclassifies inadmissible C/D comparisons as stress-test evidence", () => {
    const inadmissible = {
      admissible: false,
      reasons: ["p5_regression" as const, "critical_defect" as const],
      details: ["distinctive accessory is missing"],
    };
    const c = {
      level: "C_degraded" as const,
      absolute: { identityScore: 52, faceHairScore: 58 },
      candidateAdmissibility: inadmissible,
      pairwise: { winner: "B" as const, confidence: 0.62 },
    };
    const d = {
      level: "D_generic" as const,
      absolute: { identityScore: 54, faceHairScore: 52 },
      candidateAdmissibility: inadmissible,
      pairwise: { winner: "B" as const, confidence: 0.8 },
    };
    expect(classifyCalibrationPairwiseRole(c)).toBe("stress_test_only");
    expect(classifyCalibrationPairwiseRole(d)).toBe("stress_test_only");
    expect(validateCalibrationBenchmark([
      { level: "A_identical", absolute: { identityScore: 92, faceHairScore: 90 } },
      c,
      d,
    ])).not.toEqual(expect.arrayContaining([
      "degraded candidate was an actionable winner",
      "generic candidate was an actionable winner",
    ]));
  });

  it("reports evaluator health separately by architectural role", () => {
    expect(assessPairwiseEvaluatorRoleHealth({
      inadmissibleCandidatesRejected: 3,
      inadmissiblePairwiseCalls: 0,
      stability: null,
      expectedMeaningfullyImprovedCandidateId: null,
      sourceFidelityConflictCount: 0,
    })).toEqual({
      catastrophicCandidateSafety: "healthy",
      nearPeerSafety: "unknown",
      nearPeerDiscrimination: "unknown",
      rawOrderStability: "unknown",
      decisionOrderStability: "unknown",
      meaningfulImprovementSensitivity: "unknown",
      sourceFidelityCalibration: "unknown",
    });

    const meaningful = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: {
        candidateOrder: ["X", "Y"],
        decision: { rawPreference: "B", confidence: 0.82, actionableVerdict: "B", replacementSafe: true },
      },
      reverse: {
        candidateOrder: ["Y", "X"],
        decision: { rawPreference: "A", confidence: 0.81, actionableVerdict: "A", replacementSafe: false },
      },
    });
    expect(assessPairwiseEvaluatorRoleHealth({
      inadmissibleCandidatesRejected: 3,
      inadmissiblePairwiseCalls: 0,
      stability: meaningful,
      expectedMeaningfullyImprovedCandidateId: "Y",
      sourceFidelityConflictCount: 0,
    })).toEqual({
      catastrophicCandidateSafety: "healthy",
      nearPeerSafety: "healthy",
      nearPeerDiscrimination: "healthy",
      rawOrderStability: "healthy",
      decisionOrderStability: "healthy",
      meaningfulImprovementSensitivity: "healthy",
      sourceFidelityCalibration: "healthy",
    });

    const safeDrift = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: {
        candidateOrder: ["X", "Y"],
        decision: { rawPreference: "B", confidence: 0.58, actionableVerdict: "insufficient_confidence", replacementSafe: false },
      },
      reverse: {
        candidateOrder: ["Y", "X"],
        decision: { rawPreference: "tie", confidence: 0.5, actionableVerdict: "tie", replacementSafe: false },
      },
    });
    expect(assessPairwiseEvaluatorRoleHealth({
      inadmissibleCandidatesRejected: 2,
      inadmissiblePairwiseCalls: 0,
      stability: safeDrift,
      expectedMeaningfullyImprovedCandidateId: null,
      sourceFidelityConflictCount: 2,
    })).toEqual({
      catastrophicCandidateSafety: "healthy",
      nearPeerSafety: "healthy",
      nearPeerDiscrimination: "safe_but_uncertain",
      rawOrderStability: "degraded",
      decisionOrderStability: "healthy",
      meaningfulImprovementSensitivity: "unknown",
      sourceFidelityCalibration: "improving",
    });
  });

  it("classifies evaluator health without bypassing the release gate", () => {
    const observations = [
      { level: "A_identical" as const, absolute: { identityScore: 91, faceHairScore: 90 } },
      { level: "B_minor" as const, absolute: { identityScore: 90, faceHairScore: 90 } },
      { level: "C_degraded" as const, absolute: { identityScore: 80, faceHairScore: 78 }, pairwise: { winner: "A" as const, confidence: 0.9 } },
      { level: "D_generic" as const, absolute: { identityScore: 62, faceHairScore: 68 }, pairwise: { winner: "A" as const, confidence: 0.9 } },
    ];
    expect(assessEvaluatorHealth({
      observations,
      diagnosisConflictCount: 0,
      completedPairwiseComparisons: 4,
      requiredPairwiseComparisons: 4,
      liveCallFailures: 0,
      orderBiasDetected: false,
    })).toMatchObject({ status: "healthy", reasons: [] });

    expect(assessEvaluatorHealth({
      observations,
      diagnosisConflictCount: 1,
      completedPairwiseComparisons: 4,
      requiredPairwiseComparisons: 4,
      liveCallFailures: 0,
      orderBiasDetected: false,
    })).toMatchObject({ status: "degraded" });

    expect(assessEvaluatorHealth({
      observations: observations.slice(0, 3),
      diagnosisConflictCount: 0,
      completedPairwiseComparisons: 2,
      requiredPairwiseComparisons: 4,
      liveCallFailures: 0,
      orderBiasDetected: false,
    })).toMatchObject({ status: "unknown" });
  });
});

describe("pairwise order calibration", () => {
  const decision = (
    rawPreference: PairwiseDecision["rawPreference"],
    confidence: number,
    actionableVerdict: PairwiseDecision["actionableVerdict"],
  ): PairwiseDecision => ({
    rawPreference,
    confidence,
    actionableVerdict,
    replacementSafe: actionableVerdict === "B",
  });

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

  it("separates weak raw drift from stable abstention and production decisions", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("B", 0.58, "insufficient_confidence") },
      reverse: { candidateOrder: ["Y", "X"], decision: decision("tie", 0.5, "tie") },
    });
    expect(stability).toMatchObject({
      rawPreferenceStable: false,
      actionableVerdictStable: true,
      productionDecisionStable: true,
      safeAbstention: true,
      forward: {
        normalizedRawPreference: "Y",
        actionableVerdict: "insufficient_confidence",
        productionDecision: { kind: "retain_incumbent", selectedCandidateId: "X" },
      },
      reverse: {
        normalizedRawPreference: "tie",
        actionableVerdict: "tie",
        productionDecision: { kind: "retain_incumbent", selectedCandidateId: "X" },
      },
    });
  });

  it("flags contradictory actionable winners by real candidate identity", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("B", 0.82, "B") },
      reverse: { candidateOrder: ["Y", "X"], decision: decision("B", 0.81, "B") },
    });
    expect(stability.rawPreferenceStable).toBe(false);
    expect(stability.actionableVerdictStable).toBe(false);
    expect(stability.productionDecisionStable).toBe(false);
    expect(stability.forward?.productionDecision).toEqual({ kind: "replace_incumbent", selectedCandidateId: "Y" });
    expect(stability.reverse?.productionDecision).toEqual({ kind: "retain_incumbent", selectedCandidateId: "X" });
  });

  it("supports a stable meaningful improvement across reversed labels", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("B", 0.82, "B") },
      reverse: { candidateOrder: ["Y", "X"], decision: decision("A", 0.8, "A") },
    });
    expect(stability).toMatchObject({
      rawPreferenceStable: true,
      actionableVerdictStable: true,
      productionDecisionStable: true,
      safeAbstention: false,
    });
    expect(stability.forward?.normalizedActionableOutcome).toEqual({ kind: "select_candidate", candidateId: "Y" });
    expect(stability.reverse?.normalizedActionableOutcome).toEqual({ kind: "select_candidate", candidateId: "Y" });
    expect(assessMeaningfulImprovementSensitivity(stability, "Y")).toBe("supported");
  });

  it("keeps identical ties stable without manufacturing a selected winner", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("tie", 0.5, "tie") },
      reverse: { candidateOrder: ["Y", "X"], decision: decision("tie", 0.5, "tie") },
    });
    expect(stability).toMatchObject({
      rawPreferenceStable: true,
      actionableVerdictStable: true,
      productionDecisionStable: true,
      safeAbstention: true,
    });
  });

  it("treats low-confidence winner drift as safe abstention", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("B", 0.61, "insufficient_confidence") },
      reverse: { candidateOrder: ["Y", "X"], decision: decision("B", 0.62, "insufficient_confidence") },
    });
    expect(stability.rawPreferenceStable).toBe(false);
    expect(stability.actionableVerdictStable).toBe(true);
    expect(stability.productionDecisionStable).toBe(true);
    expect(stability.safeAbstention).toBe(true);
    expect(assessMeaningfulImprovementSensitivity(stability, "Y")).toBe("not_supported");
  });

  it("keeps decision stability inconclusive when one direction is missing", () => {
    const stability = assessPairwiseStability({
      incumbentCandidateId: "X",
      forward: { candidateOrder: ["X", "Y"], decision: decision("tie", 0, "tie") },
    });
    expect(stability).toMatchObject({
      rawPreferenceStable: null,
      actionableVerdictStable: null,
      productionDecisionStable: null,
      safeAbstention: null,
      reverse: null,
    });
    expect(assessMeaningfulImprovementSensitivity(stability, "Y")).toBe("not_measured");
  });
});
