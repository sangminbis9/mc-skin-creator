import { expect, it } from "vitest";
import { normalizeAnalysisForRendering } from "../src/generate";
import { makeAnalysis } from "./helpers";
import { readFileSync } from "node:fs";

function normalized(hair: string, accessories: string, scale: "small" | "medium" | "large") {
  const a = makeAnalysis();
  a.observed.hair = hair; a.observed.accessories = accessories;
  a.identityPrompt = ""; a.inferred.hairBack = { value: "unknown", rationale: "unknown" };
  a.renderHints.hairAccessory = "bow"; a.renderHints.hairAccessoryScale = scale;
  return normalizeAnalysisForRendering(a).renderHints.hairAccessoryScale;
}
it("keeps G002's small hair bows independent of its large neck bow", () => {
  expect(normalized("long pink hair; two small pink bows on the left and right hair sides",
    "small pink bows on the sides of the hair; a large pink neck bow at the throat; small pink bows on the cardigan near the waist", "small")).toBe("small");
});
it("preserves the head accessory scale actually returned in consumed G002", () => {
  const t = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-002/summary.json", "utf8"))
    .currentDefaultE2E.result.propagationTrace;
  expect(t.primary.renderHints.hairAccessoryScale).toBe("small");
  expect(t.renderAnalysis.renderHints.hairAccessoryScale).toBe("large");
  // Test only the stored cue fields; this is not a reconstructed primary response.
  expect(normalized(t.primary.observed.hair, t.primary.observed.accessories,
    t.primary.renderHints.hairAccessoryScale)).toBe("small");
});
it.each([
  "a large neck bow at the throat", "an oversized ribbon on the cardigan",
  "a large bow at the waist", "a large bow on the thigh", "possibly a large hair bow",
])("does not promote head accessory size from unsupported ownership: %s", accessory => {
  expect(normalized("long hair with a bow", accessory, "small")).toBe("small");
});
it("preserves a positively observed large hair accessory beside a small neck bow", () => {
  expect(normalized("hair with a large pink bow on viewer-left", "a small neck bow", "medium")).toBe("large");
});
it("preserves genuine flower clusters and tiny head clips", () => {
  expect(normalized("hair with a large flower cluster beside the temple", "none", "medium")).toBe("large");
  expect(normalized("hair with a tiny pink clip", "none", "medium")).toBe("small");
});
