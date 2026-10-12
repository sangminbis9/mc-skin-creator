import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildFaceStyle, fallbackFeaturesToHex } from "../src/generate";

function input(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.observed.accessories = "none";
  a.identityPrompt = ""; a.outfitPrompt = "";
  a.canonicalIdentity = { overallImpression: "", mustPreserve: [], features: [] };
  a.visibleRegions.upperBody = true;
  a.fallbackFeatures.topType = "hoodie"; a.fallbackFeatures.sleeveLength = "short";
  a.renderHints.outerGarment = "none";
  return a;
}

it.each(["a loose-fitting hoodie with a pastel checkered pattern; white pants", "plain blue hoodie"])("retains existing hoodie sleeve policy in executable plan: %s", text => {
  const a = input(text), snapshot = JSON.stringify(a);
  const style = buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures)), p = buildOutfitPlan(a);
  expect(style.sleeveLength).toBe("long");
  expect(p.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
  expect(p.upper.rightSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
  expect(p.provenance.find(p => p.target === "upper.sleeves")).toMatchObject({ source: "strongly_implied", confidence: 0.58 });
  expect(JSON.stringify(a)).toBe(snapshot);
});

it.each([
  ["blue short-sleeved hoodie", "short", 4], ["sleeveless blue hoodie", "sleeveless", 0],
  ["blue hoodie with rolled sleeves", "rolled", 8], ["blue hoodie with elbow sleeves", "elbow", 7],
  ["long-sleeved hoodie", "long", 11],
] as const)("preserves explicit sleeves: %s", (text, length, terminationRow) => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.leftSleeve).toMatchObject({ length, terminationRow, source: "observed" });
  expect(p.upper.rightSleeve).toMatchObject({ length, terminationRow, source: "observed" });
});

it.each(["no hoodie", "maybe a hoodie", "hoodie hidden", "hoodie print", "blue jacket over a hoodie",
  "hoodie under a jacket", "shirt and hoodie", "blue shirt"])("does not infer sleeves from unsupported or layered hoodie: %s", text => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.leftSleeve.length).toBe("short");
  expect(p.upper.leftSleeve.source).not.toBe("strongly_implied");
});

it("does not promote hidden or inferred hoodie prose", () => {
  const hidden = input("blue hoodie"); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.leftSleeve.length).toBe("short");
  const inferred = input("blue shirt"); inferred.outfitPrompt = "blue hoodie";
  expect(buildOutfitPlan(inferred).upper.leftSleeve.length).toBe("short");
});
