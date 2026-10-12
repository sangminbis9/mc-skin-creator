import { expect, it } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";

function input(clothing: string) {
  const a = makeAnalysis();
  return makeAnalysis({ observed: { ...a.observed, clothing, accessories: "none" },
    outfitPrompt: "", renderHints: { ...a.renderHints, outerGarment: "none" },
    fallbackFeatures: { ...a.fallbackFeatures, topType: "hoodie", sleeveLength: "long" } });
}
it.each([
  ["Pink hoodie with white ribbed cuffs", "#eeeae1"],
  ["Red sweater with blue cuffs", "#416b9d"],
  ["Oversized hoodie with pastel pixelated blocks (pink, lilac, yellow, cyan, white) and a central dark pixel face graphic on the chest, white ribbed cuffs; white pants", "#eeeae1"],
])("retains explicitly observed attached cuff material: %s", (text, color) => {
  const a = input(text), before = JSON.stringify(a), p = buildOutfitPlan(a);
  for (const sleeve of [p.upper.leftSleeve, p.upper.rightSleeve])
    expect(sleeve).toMatchObject({ length: "long", terminationRow: 11, cuff: { color, source: "observed" } });
  expect(JSON.stringify(a)).toBe(before);
});
it.each([
  "Pink hoodie", "Pink hoodie with cuffs", "Pink hoodie with one white cuff",
  "Pink hoodie with white cuffs on the left", "Pink hoodie with no white cuffs",
  "Possibly a pink hoodie with white cuffs", "Pink hoodie with hidden white cuffs",
  "Pink hoodie with white cuffs; cuffs are absent", "Pink hoodie with white and blue cuffs",
  "Pink hoodie with blue/white cuffs", "Pink hoodie with white striped cuffs",
  "Pink hoodie with white cuffs with blue stripes", "Pink hoodie with white wrist cuffs",
  "Pink hoodie with detached white cuffs", "Pink hoodie with gloves and white cuffs",
  "Pink hoodie over a shirt with white cuffs", "Pink hoodie; pants with white cuffs",
  "Pink hoodie with a print of white cuffs", "Pink hoodie with white cuffs; blue cuffs",
  "Pink hoodie with white cuffs or blue cuffs", "Pink hoodie with unknown cuffs",
])("does not infer attached paired cuff color: %s", text => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.leftSleeve).not.toHaveProperty("cuff");
  expect(p.upper.rightSleeve).not.toHaveProperty("cuff");
});
it("does not invent topology, visibility, or prompt-only evidence", () => {
  for (const length of ["short", "sleeveless"] as const) {
    const a = input(`Pink hoodie with ${length} sleeves and white cuffs`);
    const p = buildOutfitPlan(a); expect(p.upper.leftSleeve).not.toHaveProperty("cuff");
  }
  const a = input("Pink hoodie with white cuffs"); a.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(a).upper.leftSleeve).not.toHaveProperty("cuff");
  a.visibleRegions.upperBody = true; a.observed.clothing = "Pink hoodie"; a.outfitPrompt = "white cuffs";
  expect(buildOutfitPlan(a).upper.leftSleeve).not.toHaveProperty("cuff");
});
