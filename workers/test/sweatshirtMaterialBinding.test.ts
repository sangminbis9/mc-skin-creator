// Offline material ownership tests, without a live runner or source-ID logic.
import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";

function input(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.observed.accessories = "none";
  a.identityPrompt = ""; a.outfitPrompt = "";
  a.canonicalIdentity = { overallImpression: "", mustPreserve: [], features: [] };
  a.visibleRegions.upperBody = true; a.visibleRegions.lowerBody = true;
  a.inferred = { hairBack: a.inferred.hairBack, upperBody: null, lowerBody: null, shoes: null };
  a.fallbackFeatures = { ...a.fallbackFeatures, topType: "tshirt", topColor: "blue", bottomColor: "denim", sleeveLength: "short" };
  a.renderHints = { ...a.renderHints, outerGarment: "none", garmentTexture: "plain", bottomPattern: "plain", legwear: "none" };
  return a;
}

it.each([
  ["a plain black crewneck sweatshirt and straight-leg gray pants, paired with plain white sneakers", "#22201e", "#242326", "#77777c"],
  ["white sweatshirt with black pants", "#f2f2f2", "#eeeae1", "#242326"],
  ["green sweatshirt; beige trousers", "#4fa05a", "#467a50", "#c5aa82"],
  ["gray pants and a black sweatshirt", "#22201e", "#242326", "#77777c"],
  ["a red sweatshirt, blue jeans and white sneakers", "#c0392b", "#b53a35", "#416b9d"],
])("binds sweatshirt and lower material independently: %s", (clothing, parameter, upper, lower) => {
  const a = input(clothing), before = JSON.stringify(a);
  const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures));
  const p = buildOutfitPlan(a);
  expect(colors.topColor).toBe(parameter); expect(p.upper.baseColor).toBe(upper); expect(p.lower.baseColor).toBe(lower);
  expect(p.upper.leftSleeve.color).toBe(upper); expect(p.upper.rightSleeve.color).toBe(upper);
  expect(p.upper.colorBlocks[0].color).toBe(upper);
  expect(p.upper.garmentType).toBe("sweater"); expect(p.upper.leftSleeve.length).toBe("long");
  expect(p.upper.leftSleeve.source).toBe("strongly_implied");
  const style = buildFaceStyle(a, colors);
  expect(style.topType).toBe("sweater"); expect(style.sleeveLength).toBe("long");
  expect(style.garmentTexture).toBe("plain");
  expect(JSON.stringify(a)).toBe(before);
});

it.each([
  ["blue shirt with black sweatpants", "#4d9de0", "#416b9d"],
  ["white hoodie with black pants", "#f2f2f2", "#eeeae1"],
  ["red sweatshirt under a blue jacket", "#4d9de0", "#416b9d"],
  ["blue jacket over a red sweatshirt", "#4d9de0", "#416b9d"],
])("does not confuse other nouns or replace existing layer priority: %s", (clothing, parameter, upper) => {
  const a = input(clothing);
  expect(refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)).topColor).toBe(parameter);
  expect(buildOutfitPlan(a).upper.baseColor).toBe(upper);
});

it.each(["no black sweatshirt", "possibly black sweatshirt", "black sweatshirt hidden", "black sweatshirt graphic"])("does not promote unsupported sweatshirt evidence: %s", clothing => {
  const a = input(clothing);
  expect(refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)).topColor).toBe("#4d9de0");
  expect(buildOutfitPlan(a).upper.baseColor).toBe("#416b9d");
  expect(buildOutfitPlan(a).upper.garmentType).toBe("tshirt");
});

it.each([
  ["black sweatshirt with short sleeves", "short"],
  ["black sleeveless sweatshirt", "sleeveless"],
  ["black sweatshirt with long sleeves", "long"],
])("preserves explicit sleeve construction: %s", (clothing, length) => {
  const a = input(clothing), p = buildOutfitPlan(a);
  expect(p.upper.leftSleeve.length).toBe(length); expect(p.upper.rightSleeve.length).toBe(length);
  expect(p.upper.leftSleeve.source).toBe("observed");
  expect(buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures)).sleeveLength).toBe(length);
});

it("does not promote hidden, inferred, layered, or accessory sweatshirt evidence", () => {
  for (const kind of ["hidden", "inferred", "layered", "accessory"] as const) {
    const a = input("black sweatshirt");
    if (kind === "hidden") a.visibleRegions.upperBody = false;
    if (kind === "layered") a.renderHints.outerGarment = "open_jacket";
    if (kind === "inferred" || kind === "accessory") {
      a.observed.clothing = "blue shirt";
      a.outfitPrompt = "black sweatshirt";
      a.observed.accessories = "black sweatshirt";
    }
    expect(buildOutfitPlan(a).upper.garmentType).not.toBe("sweater");
    expect(buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures)).topType).not.toBe("sweater");
  }
});
