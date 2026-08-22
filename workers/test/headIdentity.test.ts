import { describe, expect, it } from "vitest";
import {
  parseHeadPairwiseReview,
  selectHeadCandidate,
  shouldAcceptIdentityCorrection,
  type HeadCandidate,
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

describe("head identity candidate selection", () => {
  it("parses the bounded pairwise schema", () => {
    expect(parseHeadPairwiseReview({
      winner: "B",
      confidence: 0.83,
      reasons: ["B preserves the lower fringe opening"],
      failedIdentityFeatures: ["glasses remain too compact"],
      correctionTargets: ["head.front.glasses"],
    })).toEqual({
      winner: "B",
      confidence: 0.83,
      reasons: ["B preserves the lower fringe opening"],
      failedIdentityFeatures: ["glasses remain too compact"],
      correctionTargets: ["head.front.glasses"],
    });
    expect(parseHeadPairwiseReview({ winner: "B", confidence: 8, reasons: [] })).toBeNull();
  });

  it("can reject a structurally valid generated face in favor of a more similar deterministic face", () => {
    const generated = candidate("generated", "generated");
    const deterministic = candidate("plan", "deterministic");
    const selected = selectHeadCandidate(generated, deterministic, {
      winner: "B",
      confidence: 0.78,
      reasons: ["B matches eye height and face width"],
      failedIdentityFeatures: [],
      correctionTargets: [],
    });
    expect(generated.structuralValidity).toBe(true);
    expect(selected.id).toBe("plan");
  });

  it("rolls a correction back on a tie or before-winner", () => {
    const base = {
      confidence: 0.9,
      reasons: ["before is closer"],
      failedIdentityFeatures: [],
      correctionTargets: [],
    } as const;
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "A" })).toBe(false);
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "tie" })).toBe(false);
    expect(shouldAcceptIdentityCorrection({ ...base, winner: "B" })).toBe(true);
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
