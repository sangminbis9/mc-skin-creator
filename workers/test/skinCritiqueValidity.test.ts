import { describe, expect, it } from "vitest";
import {
  evaluateSkinReleaseGate,
  parseSkinCritique,
  SKIN_RELEASE_THRESHOLDS,
  type SkinCritique,
} from "../src/skinCritique";
import { makeAnalysis } from "./helpers";

function rawScores(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identityScore: 89,
    faceHairScore: 86,
    outfitScore: 79,
    consistencyScore: 83,
    layerScore: 71,
    p5IdentityChecks: [],
    defects: [],
    ...overrides,
  };
}

describe("skin critique schema and strict release gate", () => {
  it("parses non-bucket integer scores and preserves their exact values", () => {
    const parsed = parseSkinCritique(rawScores({
      identityScore: 83,
      faceHairScore: 87,
      outfitScore: 89,
    }));
    expect(parsed).toMatchObject({ identityScore: 83, faceHairScore: 87, outfitScore: 89 });
  });

  it("rejects out-of-range and fractional scores", () => {
    expect(parseSkinCritique(rawScores({ identityScore: 101 }))).toBeNull();
    expect(parseSkinCritique(rawScores({ identityScore: -1 }))).toBeNull();
    expect(parseSkinCritique(rawScores({ identityScore: 88.5 }))).toBeNull();
  });

  it("normalizes only coherent legacy 0-10 responses", () => {
    expect(parseSkinCritique(rawScores({
      identityScore: 9,
      faceHairScore: 8,
      outfitScore: 8,
      consistencyScore: 9,
      layerScore: 7,
    }))).toMatchObject({ identityScore: 90, faceHairScore: 80, outfitScore: 80, consistencyScore: 90, layerScore: 70 });
    expect(parseSkinCritique(rawScores({ identityScore: 9, faceHairScore: 86 }))).toMatchObject({ identityScore: 9, faceHairScore: 86 });
  });

  it("keeps the release thresholds unchanged and P5 removal remains a hard failure", () => {
    expect(SKIN_RELEASE_THRESHOLDS).toEqual({
      identityScore: 88,
      faceHairScore: 85,
      outfitScore: 78,
      consistencyScore: 82,
      layerScore: 70,
    });
    const analysis = makeAnalysis();
    const p5IdentityChecks: SkinCritique["p5IdentityChecks"] = analysis.canonicalIdentity.features
      .filter((feature) => feature.priority === 5)
      .map((feature) => ({
        feature: feature.feature,
        status: "present",
        evidence: "visible in the candidate",
        targetRegions: feature.targetRegions,
      }));
    const passing: SkinCritique = {
      identityScore: 88,
      faceHairScore: 85,
      outfitScore: 78,
      consistencyScore: 82,
      layerScore: 70,
      p5IdentityChecks,
      defects: [],
    };
    expect(evaluateSkinReleaseGate(analysis, passing).approved).toBe(true);
    const missingP5: SkinCritique = {
      ...passing,
      p5IdentityChecks: p5IdentityChecks.map((check, index) => index === 0 ? { ...check, status: "missing" } : check),
    };
    expect(evaluateSkinReleaseGate(analysis, missingP5)).toMatchObject({ approved: false });
  });
});
