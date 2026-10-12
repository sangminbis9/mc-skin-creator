import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";

const primary = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-017/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
function input(hair = primary.observed.hair) {
  const a = makeAnalysis({ ...structuredClone(primary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
  a.observed.hair = hair;
  return a;
}
it.each([primary.observed.hair,
  "Very short dark buzz cut with visible scalp.",
  "Extremely short blond buzz cut; scalp is visible.",
])("retains visible scalp beneath explicitly very short buzz cut: %s", hair => {
  const a = input(hair);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  expect(buildIdentityPixelPlans(a).hairPlan.surfaceMaterial).toBe("scalp_shadow");
});
it.each([
  "Very short buzz cut.", "Buzz cut with visible scalp.",
  "Short buzz cut with visible scalp.", "Very short hair with visible scalp.",
  "Possibly very short buzz cut with visible scalp.", "Very short buzz cut with no visible scalp.",
  "Very short buzz cut on sides with visible scalp.", "Very short buzz cut with visible scalp through thinning patches.",
  "Very short buzz cut with visible scalp along the part.", "Very short buzz cut with visible scalp and bare crown.",
  "Very short beard buzz cut; visible scalp elsewhere.", "Very short buzz cut but scalp hidden by a hat.",
])("does not invent material from ambiguous, local or absent scalp evidence: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(false);
});
it("keeps visibility, geometry, fringe, volume and head-covering gates", () => {
  for (const mode of ["hidden", "fringe", "volume", "hat", "inferred"] as const) {
    const a = input();
    if (mode === "hidden") a.visibleRegions.hair = false;
    if (mode === "fringe") a.renderHints.bangs = "straight";
    if (mode === "volume") a.renderHints.hairVolume = "full";
    if (mode === "hat") a.fallbackFeatures.hat = "headscarf";
    if (mode === "inferred") {
      a.observed.hair = "Short dark hair";
      a.inferred.hairBack = { value: primary.observed.hair, rationale: "Unseen rear" };
    }
    expect(observedShavedScalpHairShadow(a)).toBe(false);
  }
});
