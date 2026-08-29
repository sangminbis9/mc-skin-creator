import { describe, expect, it } from "vitest";
import {
  parseHeadPairwiseReview,
  selectHeadCandidate,
  shouldAcceptIdentityCorrection,
  HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE,
  type HeadCandidate,
  type HeadPairwiseReview,
} from "../src/headIdentity";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

function candidate(id: string, kind: HeadCandidate["kind"]): HeadCandidate {
  return {
    id,
    kind,
    atlas: makeSyntheticAtlas(id.length),
    headMontageDataUrl: "data:image/png;base64,AA==",
    structuralValidity: true,
  };
}

const dimension = (better: "A" | "B" | "tie" | "not_evaluable" = "tie") => ({
  better,
  structuralPresenceA: "present" as const,
  structuralPresenceB: "present" as const,
  visualReadabilityA: "strong" as const,
  visualReadabilityB: "strong" as const,
  reason: "both landmarks are structurally present and readable",
});

function review(overrides: Partial<HeadPairwiseReview> = {}): HeadPairwiseReview {
  return {
    winner: "B",
    confidence: 0.83,
    identityDimensions: {
      hairSilhouette: dimension("tie"), hairline: dimension("B"), eyeLayout: dimension("tie"),
      glassesReadability: dimension("tie"), mouthExpression: dimension("B"), faceWidth: dimension("tie"),
    },
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
  it("parses the bounded pairwise schema", () => {
    const parsed = parseHeadPairwiseReview({
      winner: "B",
      confidence: 0.83,
      identityDimensions: review().identityDimensions,
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
      identityDimensions: { hairline: { better: "B" } },
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
    expect(selectHeadCandidate(before, after, review({ confidence: 0.69 })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ p5RegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ structuralRegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ craftRegressionInB: true })).id).toBe("before");
    expect(selectHeadCandidate(before, after, review({ calibrationConflicts: ["presence/readability conflict"] })).id).toBe("before");
  });

  it("rejects an overall B winner when the structured identity dimensions contradict it", () => {
    const before = candidate("before", "generated");
    const after = candidate("after", "deterministic");
    const contradictory = review({
      identityDimensions: {
        hairSilhouette: dimension("A"), hairline: dimension("A"), eyeLayout: dimension("A"),
        glassesReadability: dimension("B"), mouthExpression: dimension("tie"), faceWidth: dimension("tie"),
      },
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
