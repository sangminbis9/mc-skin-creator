import { describe, expect, it } from "vitest";
import {
  parseHeadPairwiseReview,
  selectHeadCandidate,
  shouldAcceptIdentityCorrection,
  HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE,
  measureHeadCandidateStructure,
  buildIdentityDimensionWeights,
  assessPairwiseDecision,
  buildHeadPairwisePrompt,
  assessCandidateAdmissibility,
  assessHeadPairwiseEligibility,
  runHeadPairwiseIfAdmissible,
  HEAD_PAIRWISE_BLIND_RULES,
  type HeadCandidate,
  type HeadPairwiseReview,
} from "../src/headIdentity";
import { buildFacePixelPlanVariants, buildIdentityPixelPlans } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry, makeSyntheticAtlas } from "./helpers";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";

function candidate(id: string, kind: HeadCandidate["kind"]): HeadCandidate {
  return {
    id,
    kind,
    atlas: makeSyntheticAtlas(id.length),
    headMontageDataUrl: "data:image/png;base64,AA==",
    structuralValidity: true,
    admissibilityEvidence: {
      p5Valid: true,
      craftValid: true,
      renderContractValid: true,
      criticalDefects: [],
      calibrationConflicts: [],
    },
  };
}

const dimension = (better: "A" | "B" | "tie" | "not_evaluable" = "tie") => ({
  better,
  structuralPresenceA: "present" as const,
  structuralPresenceB: "present" as const,
  visualReadabilityA: "strong" as const,
  visualReadabilityB: "strong" as const,
  sourceFidelityA: better === "A" ? "high" as const : better === "B" ? "low" as const : "high" as const,
  sourceFidelityB: better === "B" ? "high" as const : better === "A" ? "low" as const : "high" as const,
  reason: "both landmarks are structurally present and readable",
});

function review(overrides: Partial<HeadPairwiseReview> = {}): HeadPairwiseReview {
  return {
    winner: "B",
    confidence: 0.83,
    sourceSalientCues: [{ cue: "source-visible fringe", importance: "medium", dimension: "hairline" }],
    identityDimensions: {
      headSilhouette: dimension("tie"), hairline: dimension("B"), eyeLayout: dimension("tie"),
      mouthExpression: dimension("B"), distinctiveAccessories: dimension("tie"), faceProportions: dimension("tie"),
    },
    globalIdentityJudgment: { better: "B", replacementValue: "meaningful", reason: "B is more recognizable as the source person" },
    p5RegressionInB: false,
    structuralRegressionInB: false,
    craftRegressionInB: false,
    calibrationConflicts: [],
    reasons: ["B preserves the lower fringe opening"],
    failedIdentityFeatures: [],
    correctionTargets: [],
    ...overrides,
  };
}

describe("head identity candidate selection", () => {
  it("keeps pairwise evaluation blind to chronology, cost, contracts, and expected winner", () => {
    expect(HEAD_PAIRWISE_BLIND_RULES).toContain("labels are arbitrary");
    expect(HEAD_PAIRWISE_BLIND_RULES).toContain("only the source pixels and candidate pixels");
    expect(HEAD_PAIRWISE_BLIND_RULES).not.toContain("before(A)");
    expect(HEAD_PAIRWISE_BLIND_RULES).not.toContain("after(B)");
    const prompt = buildHeadPairwisePrompt("candidate_selection", true);
    expect(prompt).not.toMatch(/current candidate|degraded|identity\s*92|candidateCost|expected winner|strict gate|Tier\s*2/i);
    expect(prompt).toContain("more faithfully preserves the identity");
  });
  it("parses the bounded pairwise schema", () => {
    const parsed = parseHeadPairwiseReview({
      winner: "B",
      confidence: 0.83,
      sourceSalientCues: review().sourceSalientCues,
      identityDimensions: review().identityDimensions,
      globalIdentityJudgment: review().globalIdentityJudgment,
      p5RegressionInB: false,
      structuralRegressionInB: false,
      craftRegressionInB: false,
      reasons: ["B preserves the lower fringe opening"],
      failedIdentityFeatures: ["glasses remain too compact"],
      correctionTargets: ["head.front.glasses"],
    });
    expect(parsed).toMatchObject({
      winner: "B",
      confidence: 0.83,
      sourceSalientCues: [{ importance: "medium", dimension: "hairline" }],
      identityDimensions: { hairline: { better: "B" } },
      globalIdentityJudgment: { better: "B", replacementValue: "meaningful" },
      p5RegressionInB: false,
      reasons: ["B preserves the lower fringe opening"],
      failedIdentityFeatures: ["glasses remain too compact"],
      correctionTargets: ["head.front.glasses"],
    });
    expect(parseHeadPairwiseReview({ winner: "B", confidence: 8, reasons: [] })).toBeNull();
  });

  it("can reject a structurally valid generated face in favor of a more similar deterministic face", () => {
    const generated = candidate("generated", "generated");
    const deterministic = candidate("plan", "deterministic");
    const selected = selectHeadCandidate(generated, deterministic, review({
      reasons: ["B matches eye height and face width"],
    }));
    expect(generated.structuralValidity).toBe(true);
    expect(selected.id).toBe("plan");
  });

  it("rolls a correction back on a tie or before-winner", () => {
    const base = review({
      confidence: 0.9,
      reasons: ["before is closer"],
    });
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "A" })).toBe(false);
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "tie" })).toBe(false);
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "B" })).toBe(true);
  });

  it("requires calibrated confidence and rejects P5, structural, craft or terminology regressions", () => {
    const before = candidate("before", "generated");
    const after = candidate("after", "deterministic");
    expect(HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE).toBe(0.7);
    expect(assessPairwiseDecision(review({ confidence: 0.69 }))).toMatchObject({
      rawPreference: "B",
      actionableVerdict: "insufficient_confidence",
      replacementSafe: false,
    });
    expect(selectHeadCandidate(before, after, review({ confidence: 0.69 })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ p5RegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ structuralRegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ craftRegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ calibrationConflicts: ["presence/readability conflict"] })).id).toBe("before");
  });

  it("uses calibrated quantization cost only to break a valid identity-geometry tie", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry(),
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature) => ({ ...feature, confidence: "low" as const })),
      },
    });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    expect(variants.length).toBeGreaterThan(1);
    const planA = structuredClone(variants[0]);
    const planB = structuredClone(variants[1]);
    planA.candidateCost.totalCost = 0.6;
    planB.candidateCost.totalCost = 0.6 + planB.candidateCost.meaningfulMargin * 2;
    const a = { ...candidate("a", "deterministic"), facePlan: planA, structuralEvidence: { dimensions: review().identityDimensions as never, contractSatisfaction: {} as never, contractViolations: [], expectedPixels: 1, presentPixels: 1 } };
    const b = { ...candidate("b", "deterministic_variant"), facePlan: planB, structuralEvidence: { dimensions: review().identityDimensions as never, contractSatisfaction: {} as never, contractViolations: [], expectedPixels: 1, presentPixels: 1 } };
    expect(selectHeadCandidate(a, b, review({ winner: "tie", confidence: 0.45 })).id).toBe("a");
  });

  it("keeps the incumbent when a tie cost difference is below one meaningful cell or a contract fails", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    const planA = structuredClone(variants[0]);
    const planB = structuredClone(variants[1]);
    planA.candidateCost.totalCost = 0.6;
    planB.candidateCost.totalCost = 0.6 + planB.candidateCost.meaningfulMargin / 2;
    const a = { ...candidate("a", "deterministic"), facePlan: planA };
    const b = { ...candidate("b", "deterministic_variant"), facePlan: planB };
    expect(selectHeadCandidate(a, b, review({ winner: "tie", confidence: 0.4 })).id).toBe("a");
    b.structuralEvidence = { dimensions: {} as never, contractSatisfaction: {} as never, contractViolations: ["P5 contract failed"], expectedPixels: 1, presentPixels: 1 };
    planB.candidateCost.totalCost = 0.1;
    expect(selectHeadCandidate(a, b, review({ winner: "tie", confidence: 0.4 })).id).toBe("a");
  });

  it("never lets deterministic tie cost replace a generated candidate", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const plan = structuredClone(buildFacePixelPlanVariants(analysis, 1)[0]);
    plan.candidateCost.totalCost = 0;
    const generated = candidate("generated", "generated");
    const deterministic = { ...candidate("plan", "deterministic"), facePlan: plan };
    expect(selectHeadCandidate(generated, deterministic, review({ winner: "tie", confidence: 0.4 })).id).toBe("generated");
  });

  it("rejects an overall B winner when the structured identity dimensions contradict it", () => {
    const before = candidate("before", "generated");
    const after = candidate("after", "deterministic");
    const contradictory = review({
      identityDimensions: {
        headSilhouette: dimension("A"), hairline: dimension("A"), eyeLayout: dimension("A"),
        mouthExpression: dimension("tie"), distinctiveAccessories: dimension("B"), faceProportions: dimension("tie"),
      },
      globalIdentityJudgment: { better: "A", replacementValue: "meaningful", reason: "A is globally more recognizable" },
    });
    expect(shouldAcceptIdentityCorrection(contradictory)).toBe(false);
    expect(selectHeadCandidate(before, after, contradictory).id).toBe("before");
  });

  it("flags missing-glasses wording when structured presence says the frames exist", () => {
    const parsed = parseHeadPairwiseReview({
      ...review(),
      reasons: ["Candidate B is missing glasses"],
    });
    expect(parsed?.calibrationConflicts).toHaveLength(1);
    expect(parsed && shouldAcceptIdentityCorrection(parsed)).toBe(false);
  });

  it("rejects clear but wrong glasses when readability conflicts with source fidelity", () => {
    const parsed = parseHeadPairwiseReview({
      ...review({ winner: "B", confidence: 0.86 }),
      sourceSalientCues: [{ cue: "thin round source glasses", importance: "high", dimension: "distinctiveAccessories" }],
      identityDimensions: {
        ...review().identityDimensions,
        distinctiveAccessories: {
          ...dimension("B"),
          visualReadabilityA: "weak",
          visualReadabilityB: "strong",
          sourceFidelityA: "high",
          sourceFidelityB: "low",
          reason: "B is thicker and clearer but rectangular rather than source-matching",
        },
      },
    })!;
    expect(parsed.calibrationConflicts).toContain("distinctiveAccessories favored B without greater source fidelity");
    expect(parsed.calibrationConflicts).toContain("distinctiveAccessories readability overrode source fidelity for B");
    expect(assessPairwiseDecision(parsed)).toMatchObject({ actionableVerdict: "calibration_conflict", replacementSafe: false });
  });

  it("rejects a dramatic wrong fringe and cleaner generic eyes", () => {
    for (const fixture of [
      { dimension: "hairline" as const, cue: "subtle source fringe" },
      { dimension: "eyeLayout" as const, cue: "source-specific asymmetric eye spacing" },
    ]) {
      const parsed = parseHeadPairwiseReview({
        ...review({ winner: "B", confidence: 0.84 }),
        sourceSalientCues: [{ cue: fixture.cue, importance: "high", dimension: fixture.dimension }],
        identityDimensions: {
          ...review().identityDimensions,
          [fixture.dimension]: {
            ...dimension("B"),
            visualReadabilityA: "weak",
            visualReadabilityB: "strong",
            sourceFidelityA: "high",
            sourceFidelityB: "low",
            reason: "B is cleaner and more dramatic but does not match the source geometry",
          },
        },
      })!;
      expect(assessPairwiseDecision(parsed).actionableVerdict).toBe("calibration_conflict");
    }
  });

  it("allows a genuine source-fidelity improvement without incumbent bias", () => {
    const improved = review({
      winner: "B",
      confidence: 0.88,
      sourceSalientCues: [{ cue: "source-matching broad crown", importance: "high", dimension: "headSilhouette" }],
      identityDimensions: {
        headSilhouette: dimension("B"), hairline: dimension("tie"), eyeLayout: dimension("tie"),
        mouthExpression: dimension("tie"), distinctiveAccessories: dimension("tie"), faceProportions: dimension("tie"),
      },
    });
    expect(assessPairwiseDecision(improved)).toMatchObject({ actionableVerdict: "B", replacementSafe: true });
    expect(selectHeadCandidate(candidate("incumbent", "generated"), candidate("improved", "deterministic"), improved).id).toBe("improved");
  });

  it("keeps hairline, eye-layout, and head-silhouette near peers eligible while judging source fidelity", () => {
    for (const fixture of [
      { dimension: "hairline" as const, cue: "source-specific forehead opening" },
      { dimension: "eyeLayout" as const, cue: "source-specific asymmetric eye spacing" },
      { dimension: "headSilhouette" as const, cue: "source-specific crown and side contour" },
    ]) {
      const first = candidate(`${fixture.dimension}-a`, "generated");
      const second = candidate(`${fixture.dimension}-b`, "deterministic");
      expect(assessHeadPairwiseEligibility(first, second).eligible).toBe(true);
      const dimensions = {
        headSilhouette: dimension("tie"), hairline: dimension("tie"), eyeLayout: dimension("tie"),
        mouthExpression: dimension("tie"), distinctiveAccessories: dimension("tie"), faceProportions: dimension("tie"),
      };
      dimensions[fixture.dimension] = dimension("A");
      const result = review({
        winner: "A",
        confidence: 0.82,
        sourceSalientCues: [{ cue: fixture.cue, importance: "high", dimension: fixture.dimension }],
        identityDimensions: dimensions,
        globalIdentityJudgment: { better: "A", replacementValue: "meaningful", reason: "A preserves the source-specific geometry" },
      });
      expect(assessPairwiseDecision(result).actionableVerdict).toBe("A");
      expect(selectHeadCandidate(first, second, result).id).toBe(first.id);
    }
  });

  it("rejects inadmissible candidates before pairwise and consumes zero model calls", async () => {
    const cases: HeadCandidate[] = [
      { ...candidate("p5-missing", "corrected"), admissibilityEvidence: { ...candidate("base", "corrected").admissibilityEvidence, p5Valid: false } },
      { ...candidate("craft-invalid", "corrected"), admissibilityEvidence: { ...candidate("base", "corrected").admissibilityEvidence, craftValid: false } },
      { ...candidate("structure-invalid", "corrected"), structuralValidity: false },
      { ...candidate("contract-invalid", "corrected"), admissibilityEvidence: { ...candidate("base", "corrected").admissibilityEvidence, renderContractValid: false } },
      { ...candidate("critical", "corrected"), admissibilityEvidence: { ...candidate("base", "corrected").admissibilityEvidence, criticalDefects: ["identity cue collapsed"] } },
    ];
    for (const invalid of cases) {
      let pairwiseCalls = 0;
      const gated = await runHeadPairwiseIfAdmissible(candidate("valid", "generated"), invalid, async () => {
        pairwiseCalls++;
        return { ok: true as const, review: review(), neuronsSpent: 77 };
      });
      expect(pairwiseCalls).toBe(0);
      expect(gated).toMatchObject({ pairwiseExecuted: false, neuronsSpent: 0, stageOutcome: "rejected_before_pairwise" });
      expect(gated.eligibility.candidateB.admissible).toBe(false);
    }
  });

  it("allows exactly one pairwise invocation when both candidates are admissible", async () => {
    let pairwiseCalls = 0;
    const first = candidate("near-peer-a", "generated");
    const second = candidate("near-peer-b", "deterministic");
    expect(assessHeadPairwiseEligibility(first, second).eligible).toBe(true);
    const gated = await runHeadPairwiseIfAdmissible(first, second, async () => {
      pairwiseCalls++;
      return { ok: true as const, review: review(), neuronsSpent: 41 };
    });
    expect(pairwiseCalls).toBe(1);
    expect(gated).toMatchObject({ pairwiseExecuted: true, neuronsSpent: 41, stageOutcome: "pairwise_completed" });
  });

  it("records global same-person conflicts and blocks trivial replacement value", () => {
    const conflict = parseHeadPairwiseReview({
      ...review(),
      globalIdentityJudgment: { better: "A", replacementValue: "meaningful", reason: "A is globally closer to the source" },
    })!;
    expect(conflict.calibrationConflicts).toContain("overall winner conflicts with global same-person judgment");
    expect(assessPairwiseDecision(conflict).actionableVerdict).toBe("calibration_conflict");

    const trivial = review({
      globalIdentityJudgment: { better: "B", replacementValue: "trivial", reason: "B differs only cosmetically" },
    });
    expect(assessPairwiseDecision(trivial)).toMatchObject({
      actionableVerdict: "insufficient_identity_gain",
      replacementSafe: false,
    });
  });

  it("keeps identical admissible candidates tied with no replacement", () => {
    const identical = review({
      winner: "tie",
      confidence: 0.98,
      identityDimensions: {
        headSilhouette: dimension("tie"), hairline: dimension("tie"), eyeLayout: dimension("tie"),
        mouthExpression: dimension("tie"), distinctiveAccessories: dimension("tie"), faceProportions: dimension("tie"),
      },
      globalIdentityJudgment: { better: "tie", replacementValue: "trivial", reason: "The candidates are identical" },
    });
    expect(assessPairwiseDecision(identical).actionableVerdict).toBe("tie");
    expect(selectHeadCandidate(candidate("incumbent", "generated"), candidate("same", "deterministic"), identical).id).toBe("incumbent");
  });

  it("exposes specific deterministic admissibility reasons", () => {
    const invalid = candidate("invalid", "corrected");
    invalid.admissibilityEvidence = {
      p5Valid: false,
      craftValid: false,
      renderContractValid: false,
      criticalDefects: ["critical identity defect"],
      calibrationConflicts: ["contradictory contract evidence"],
    };
    expect(assessCandidateAdmissibility(invalid)).toMatchObject({
      admissible: false,
      reasons: ["p5_regression", "craft_invalid", "render_contract_violation", "critical_defect", "calibration_conflict"],
    });
  });

  it("measures structural landmark presence from atlas pixels instead of VLM output", () => {
    const analysis = makeAnalysis();
    const plans = buildIdentityPixelPlans(analysis);
    const atlas = makeSyntheticAtlas(42);
    const present = measureHeadCandidateStructure(atlas, plans.facePixelPlan, plans.hairPlan);
    expect(present.dimensions.mouthExpression).toBe("present");
    for (const pixel of plans.facePixelPlan.pixels.filter((item) => item.cluster === "mouth")) {
      atlas.rgba[((CLASSIC_LAYOUT.head.base.front.y + pixel.y) * ATLAS_SIZE + CLASSIC_LAYOUT.head.base.front.x + pixel.x) * 4 + 3] = 0;
    }
    const absent = measureHeadCandidateStructure(atlas, plans.facePixelPlan, plans.hairPlan);
    expect(absent.dimensions.mouthExpression).toBe("absent");
    expect(absent.contractSatisfaction.mouthExpression).toBe("violated");
    expect(absent.contractViolations.some((problem) => /mouth|teeth/.test(problem))).toBe(true);
  });

  it("distinguishes mouth pixel presence from P5 expression contract satisfaction", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 0
          ? { ...feature, feature: "wide toothy smile", evidence: "broad visible tooth row", category: "face" as const, priority: 5 as const }
          : feature),
      },
    });
    const plans = buildIdentityPixelPlans(analysis);
    const atlas = makeSyntheticAtlas(17);
    const mouth = plans.facePixelPlan.pixels.filter((pixel) => pixel.cluster === "mouth");
    const face = CLASSIC_LAYOUT.head.base.front;
    for (const pixel of mouth) {
      const offset = ((face.y + pixel.y) * ATLAS_SIZE + face.x + pixel.x) * 4;
      atlas.rgba.set([84, 42, 45, 255], offset);
    }
    const evidence = measureHeadCandidateStructure(atlas, plans.facePixelPlan);
    expect(evidence.dimensions.mouthExpression).toBe("present");
    expect(evidence.contractSatisfaction.mouthExpression).toBe("violated");
  });

  it("lets a high-confidence P5 identity dimension outweigh generic votes", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 0
          ? { ...feature, priority: 5 as const, confidence: "high" as const, feature: "distinctive crown hair silhouette", evidence: "unusually broad crown volume" }
          : { ...feature, priority: 1 as const, confidence: "low" as const }),
      },
    });
    const weighted = review({
      identityDimensions: {
        headSilhouette: dimension("A"), hairline: dimension("B"), eyeLayout: dimension("B"),
        mouthExpression: dimension("tie"), distinctiveAccessories: dimension("tie"), faceProportions: dimension("tie"),
      },
      sourceSalientCues: [{ cue: "distinctive crown", importance: "high", dimension: "headSilhouette" }],
      dimensionWeights: buildIdentityDimensionWeights(analysis),
    });
    expect(weighted.dimensionWeights!.headSilhouette).toBeGreaterThan(weighted.dimensionWeights!.hairline);
    expect(shouldAcceptIdentityCorrection(weighted)).toBe(false);
  });
});

describe("FacePixelPlan discrete identity diversity", () => {
  it("does not collapse different facial layouts to one generic coordinate set", () => {
    const base = makeAnalysis();
    const round = buildFacePixelPlanVariants(makeAnalysis({
      renderHints: {
        ...base.renderHints,
        faceShape: "round",
        eyeSize: "small",
        eyeSpacing: "close",
        mouthShape: "small",
        bangs: "none",
        bangsLength: "none",
      },
    }), 1)[0];
    const long = buildFacePixelPlanVariants(makeAnalysis({
      renderHints: {
        ...base.renderHints,
        faceShape: "long",
        eyeSize: "large",
        eyeSpacing: "wide",
        mouthShape: "wide",
        bangs: "straight",
        bangsLength: "eye",
      },
    }), 1)[0];
    expect(round.layout).not.toMatchObject({
      eyeRow: long.layout.eyeRow,
      leftEyeXs: long.layout.leftEyeXs,
      eyeWidth: long.layout.eyeWidth,
      mouthRow: long.layout.mouthRow,
      mouthWidth: long.layout.mouthWidth,
      hairlineDepth: long.layout.hairlineDepth,
    });
  });

  it("creates at most three variants only for uncertain axes", () => {
    const base = makeAnalysis();
    const uncertain = makeAnalysis({
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature) =>
          feature.category === "face" || feature.category === "hair"
            ? { ...feature, confidence: "low" as const }
            : feature,
        ),
      },
    });
    const variants = buildFacePixelPlanVariants(uncertain, 3);
    expect(variants).toHaveLength(3);
    expect(new Set(variants.map((plan) => plan.variantId)).size).toBe(3);
    expect(variants.every((plan) => plan.layout.uncertainAxes.length > 0)).toBe(true);
  });
});
