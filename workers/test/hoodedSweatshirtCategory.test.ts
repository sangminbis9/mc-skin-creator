import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildFaceStyle, fallbackFeaturesToHex } from "../src/generate";

function input(clothing: string) {
  const a = makeAnalysis(); a.observed.clothing = clothing; a.observed.accessories = "none";
  a.identityPrompt = ""; a.outfitPrompt = "";
  a.canonicalIdentity = { overallImpression: "", mustPreserve: [], features: [] };
  a.inferred = { hairBack: a.inferred.hairBack, upperBody: null, lowerBody: null, shoes: null };
  a.fallbackFeatures.topType = "tshirt"; a.fallbackFeatures.sleeveLength = "short";
  a.renderHints.outerGarment = "none"; a.renderHints.neckAccessory = "none";
  a.visibleRegions.upperBody = true; return a;
}
it.each(["black hooded sweatshirt", "hooded gray sweatshirt", "red hooded sweatshirt with long sleeves",
  "a black hooded sweatshirt with a large black cross graphic on the chest, worn with baggy black cargo-style pants and white sneakers"])(
  "preserves positively attached hood construction: %s", text => {
    const a = input(text), snapshot = JSON.stringify(a), p = buildOutfitPlan(a);
    expect(p.upper.garmentType).toBe("hoodie"); expect(p.upper.collar).toBe("hood");
    expect(p.upper.neckline).toMatchObject({ kind: "hood_opening", innerVisible: false });
    expect(p.outerLayer.regions).toContain("hood_rim");
    expect(p.upper.leftSleeve.length).toBe("long");
    expect(buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures)).topType).toBe("hoodie");
    expect(JSON.stringify(a)).toBe(snapshot);
  });
it.each(["plain gray sweatshirt", "crewneck sweatshirt", "hoodless sweatshirt", "no hooded sweatshirt",
  "possibly a hooded sweatshirt", "hooded sweatshirt hidden", "hooded sweatshirt under a jacket",
  "jacket over a hooded sweatshirt", "hooded sweatshirt print", "sweatshirt with a hooded character graphic",
  "hooded scarf and gray sweatshirt"])("does not invent a hood from unrelated or uncertain evidence: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.garmentType).not.toBe("hoodie");
});
it("does not use hidden, inferred or accessory-only construction", () => {
  const a = input("hooded sweatshirt"); a.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(a).upper.garmentType).not.toBe("hoodie");
  a.visibleRegions.upperBody = true; a.observed.clothing = "plain sweatshirt";
  a.outfitPrompt = "hooded sweatshirt"; a.observed.accessories = "hooded sweatshirt";
  expect(buildOutfitPlan(a).upper.garmentType).toBe("sweater");
});
it.each([["short-sleeved", "short"], ["sleeveless", "sleeveless"]])("preserves explicit %s sleeves", (prefix, length) => {
  const p = buildOutfitPlan(input(`${prefix} black hooded sweatshirt`));
  expect(p.upper.garmentType).toBe("hoodie"); expect(p.upper.leftSleeve.length).toBe(length);
});
