import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeadPairwiseComparison, type HeadStructuralEvidence } from "../src/headIdentity";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const dimension = {
  better: "tie",
  visualReadabilityA: "strong",
  visualReadabilityB: "strong",
  sourceFidelityA: "high",
  sourceFidelityB: "high",
  reason: "the two visible footprints are indistinguishable",
};

describe("blind pairwise request", () => {
  it("does not leak chronology, deterministic contracts, cost, or expected winner", async () => {
    const evidence: HeadStructuralEvidence = {
      dimensions: {
        headSilhouette: "present",
        hairline: "present",
        eyeLayout: "present",
        mouthExpression: "present",
        distinctiveAccessories: "present",
        faceProportions: "present",
      },
      contractSatisfaction: {
        headSilhouette: "satisfied",
        hairline: "satisfied",
        eyeLayout: "satisfied",
        mouthExpression: "satisfied",
        distinctiveAccessories: "satisfied",
        faceProportions: "satisfied",
      },
      contractViolations: ["SECRET_EXPECTED_WINNER_B"],
      expectedPixels: 99,
      presentPixels: 99,
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      expect(serialized).toContain("Candidate A (blind label)");
      expect(serialized).toContain("Candidate B (blind label)");
      expect(serialized).toContain("Candidate labels are arbitrary");
      expect(serialized).not.toContain("SECRET_EXPECTED_WINNER_B");
      expect(serialized).not.toContain("contractSatisfaction");
      expect(serialized).not.toContain("candidateCost");
      expect(serialized).not.toContain("before correction");
      expect(serialized).not.toContain("after correction");
      expect(serialized).not.toContain("identity 92");
      expect(serialized).not.toContain("C_degraded");
      return Response.json({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({
            winner: "tie",
            confidence: 0.95,
            sourceSalientCues: [{ cue: "source eye spacing", importance: "high", dimension: "eyeLayout" }],
            identityDimensions: {
              headSilhouette: dimension,
              hairline: dimension,
              eyeLayout: dimension,
              mouthExpression: dimension,
              distinctiveAccessories: dimension,
              faceProportions: dimension,
            },
            globalIdentityJudgment: { better: "tie", replacementValue: "trivial", reason: "both candidates are equally recognizable" },
            p5RegressionInB: false,
            structuralRegressionInB: false,
            craftRegressionInB: false,
            reasons: ["visually identical"],
            failedIdentityFeatures: [],
            correctionTargets: [],
          }) }] },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runHeadPairwiseComparison(
      { GEMINI_API_KEY: "test-key", VISION_MODEL: "gemini-test" } as Env,
      makeAnalysis(),
      "data:image/png;base64,AA==",
      "data:image/png;base64,AQ==",
      "data:image/png;base64,Ag==",
      "correction_guard",
      undefined,
      evidence,
      evidence,
    );
    expect(result.ok && result.review.winner).toBe("tie");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
