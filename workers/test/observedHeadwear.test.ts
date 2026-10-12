import { expect, it } from "vitest";
import { observedGenericHatCategory } from "../src/observedHeadwear";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { adaptGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { makeAnalysis } from "./helpers";

it.each([
  "A large, oversized, fluffy light-blue hat covering most of the crown.",
  "A red hat on the head.", "Wearing a small white hat.", "A green hat and silver earrings.",
])("reconstructs observed generic headwear, not a source-specific silhouette: %s", accessories => {
  const a = makeAnalysis(); a.observed.accessories = accessories;
  const wire = wireFixture(a); delete wire.fallbackFeatures;
  const immutable = JSON.stringify(wire);
  expect(observedGenericHatCategory(accessories)).toBe("cap");
  const v3 = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
  const adapted = adaptGemmaNamedPhotoAnalysis(namedGemmaFixture(wire));
  expect(adapted.ok).toBe(true); if (!adapted.ok) throw Error("adapter_failed");
  expect(normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 })).toEqual(v3);
  expect(v3.ok).toBe(true); if (!v3.ok) throw Error("normalization_failed");
  expect(v3.analysis.fallbackFeatures.hat).toBe("cap");
  expect(v3.analysis.observed.accessories).toBe(accessories);
  expect(JSON.stringify(wire)).toBe(immutable);
});

it.each([
  "No blue hat", "Without a hat", "Maybe a blue hat", "Hat is absent", "Hat shape unknown",
  "A hat printed on the shirt", "A hat motif", "A graphic of a hat", "An embroidered hat picture",
  "Holding a blue hat", "A hat held in the hand", "Carries a hat", "A hat in the background",
  "Hat removed", "The hat is off", "Hat-like hair silhouette", "Hat-shaped hair", "A red hat. No hat visible.",
  "A neck scarf and brown hair", "A blue headscarf", "A black hood", "Cap sleeves", "A hoodie",
])("does not reconstruct generic headwear from ineligible evidence: %s", text => {
  expect(observedGenericHatCategory(text)).toBeNull();
});

it.each(["none", "cap", "beanie", "hood"])("keeps explicit category authoritative: %s", hat => {
  const a = makeAnalysis(); a.observed.accessories = "A large light-blue hat covering the crown.";
  a.fallbackFeatures.hat = hat;
  const result = normalizeCompactPhotoAnalysisV3(wireFixture(a), { imageCount: 1 });
  expect(result.ok).toBe(true); if (!result.ok) throw Error("normalization_failed");
  expect(result.analysis.fallbackFeatures.hat).toBe(hat);
});

it("does not borrow generic hat evidence from outfit instructions or inferred completion", () => {
  const a = makeAnalysis(); a.observed.accessories = "silver earrings";
  a.outfitPrompt = "A blue hat could complete this outfit.";
  const wire = wireFixture(a); delete wire.fallbackFeatures;
  const result = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
  expect(result.ok).toBe(true); if (!result.ok) throw Error("normalization_failed");
  expect(result.analysis.fallbackFeatures.hat).toBe("none");
});
