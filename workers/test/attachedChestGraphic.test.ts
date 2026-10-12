import { expect, it } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

function input(clothing: string) {
  const a = makeAnalysis(); a.observed.clothing = clothing; a.observed.accessories = "none";
  a.outfitPrompt = ""; a.identityPrompt = "";
  a.canonicalIdentity = { overallImpression: "", mustPreserve: [], features: [] };
  a.visibleRegions.upperBody = true; a.renderHints.outerGarment = "none";
  a.renderHints.garmentTexture = "plain";
  a.fallbackFeatures.topType = "hoodie"; a.fallbackFeatures.sleeveLength = "short";
  return a;
}
const evidence = "a black pullover hoodie with a large, stylized black cross graphic on the center chest, and black baggy cargo-style pants with visible side pockets.";
it.each([
  "Oversized black pullover hoodie featuring a centered tonal dark gothic cross graphic on the chest and front kangaroo pocket, loose-fitting wide-leg black cargo pants with side pockets, and clean white low-top sneakers.",
  "blue sweatshirt with a centered red cross graphic on the chest",
  "black hoodie with a dark gothic cross emblem on the chest and a kangaroo pocket",
])("keeps bounded centered/Gothic cross attachment and same-garment pocket continuation: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross",
    surfaceParts: ["body"], source: "observed" });
});
it.each([
  "hoodie with a centered dark gothic cross graphic on the sleeve",
  "hoodie with a centered dark gothic cross necklace on the chest",
  "hoodie with a centered dark gothic cross graphic on the chest and a star",
  "hoodie with a centered dark gothic cross graphic on the chest possibly",
  "hoodie and shirt with a centered dark gothic cross graphic on the chest",
  "picture of a hoodie with a centered dark gothic cross graphic on the chest",
])("does not use centered/Gothic modifiers to bypass chest ownership: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each([
  ["a black oversized hoodie with a large, matte black graphic of a stylized cross on the center chest, and baggy black cargo-style pants", "#242326"],
  ["blue sweatshirt with a red print of a stylized cross on the chest", "#b53a35"],
  ["gray shirt with a white emblem of a stylized cross on the central chest", "#eeeae1"],
])("keeps an existing cross identity when stylized modifies graphic content: %s", (text, ink) => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: ink,
    surfaceParts: ["body"], source: "observed" });
  if (/hoodie|sweatshirt/.test(text)) expect(p.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
});
it.each([
  "hoodie with a black graphic of a stylized cross necklace on the chest",
  "hoodie with a black graphic of a stylized cross on the sleeve",
  "hoodie with a black graphic of a stylized cross on the chest hidden",
  "hoodie with a black graphic of a stylized cross or a star on the chest",
  "hoodie with a black graphic of a stylized cross on the chest possibly",
  "hoodie and shirt with a black graphic of a stylized cross on the chest",
  "picture of a hoodie with a black graphic of a stylized cross on the chest",
])("keeps all graphic attachment guards around stylized content: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each([
  ["Oversized black pullover hoodie with a tonal dark cross emblem printed/embossed on the center chest, relaxed wide-leg black cargo trousers with side cargo pockets, and clean white low-top sneakers", "#242326"],
  ["blue sweatshirt with a red cross emblem printed on the chest", "#b53a35"],
  ["gray shirt featuring a white emblem of a cross embossed on the central chest", "#eeeae1"],
  ["green hoodie with a tonal black cross motif on the chest", "#242326"],
  ["gray hoodie with a blue cross emblem on the chest", "#416b9d"],
])("preserves explicit attached cross identity across tonal/application wording: %s", (text, ink) => {
  const a = input(text), immutable = JSON.stringify(a), p = buildOutfitPlan(a);
  expect(p.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: ink,
    surfaceParts: ["body"], source: "observed" });
  // Application-method ambiguity does not invent raised garment topology.
  expect(p.outerLayer.regions).not.toContain("graphic_depth");
  expect(JSON.stringify(a)).toBe(immutable);
});
it.each([
  "hoodie with a tonal cross emblem printed on the chest",
  "hoodie with a tonal mystery cross emblem printed on the chest",
  "hoodie with a tonal dark cross necklace on the chest",
  "hoodie with a dark cross emblem printed on the sleeve",
  "hoodie with a dark cross emblem printed on the chest possibly",
  "hoodie with a dark cross or star emblem printed on the chest",
  "hoodie with a dark emblem of a cross necklace printed on the chest",
  "hoodie and shirt with a dark cross emblem printed on the chest",
  "picture of a hoodie with a dark cross emblem on the chest",
  "hoodie with a scarf with a dark cross emblem on the chest",
  "hoodie; trousers with a dark cross emblem on the chest",
])("does not let tonal/emblem/application wording bypass evidence gates: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each([
  ["An oversized black hoodie featuring a large, matte black cross graphic on the center chest. Paired with baggy black cargo-style pants and white low-top sneakers.", "#242326"],
  ["blue sweatshirt with a matte red cross print on the chest", "#b53a35"],
  ["gray shirt featuring a small matte white graphic of a cross on the central chest", "#eeeae1"],
])("preserves explicit ink and cross identity through a matte finish: %s", (text, ink) => {
  expect(buildOutfitPlan(input(text)).upper.pattern).toMatchObject({ graphicShape: "cross", color: ink, surfaceParts: ["body"], source: "observed" });
});
it.each([
  "hoodie with a matte mystery cross graphic on the chest",
  "hoodie with a matte black cross necklace on the chest",
  "hoodie with a matte black cross graphic on the sleeve",
  "hoodie with a matte black cross graphic on the chest possibly",
  "hoodie and shirt with a matte black cross graphic on the chest",
  "picture of a hoodie with a matte black cross graphic on the chest",
])("does not use matte to bypass attachment guards: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each([
  "A plain black oversized hoodie with a large black graphic of a cross on the center chest. Below, the subject wears plain black wide-leg cargo pants with visible side pockets. On the feet are plain white low-top sneakers.",
  "blue sweatshirt featuring a red print of a cross on the chest",
  "gray shirt with a white motif of a cross on the central chest",
])("preserves an explicitly named cross inside attached graphic content: %s", text => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.pattern).toMatchObject({ graphicShape: "cross", source: "observed", surfaceParts: ["body"] });
});
it.each([
  "hoodie with a black graphic of a cross necklace on the chest",
  "hoodie with a black graphic of a cross on the sleeve",
  "hoodie with a black graphic of a cross on the chest hidden",
  "hoodie with a black graphic of a shirt on the chest",
  "hoodie with a black graphic of a cross or a star on the chest",
  "hoodie with a black graphic of a cross on the chest possibly",
])("does not generalize graphic content beyond the positive attachment: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each([
  ["Oversized black hoodie featuring a large, dark graphic cross on the chest; baggy black cargo-style pants; plain white low-top sneakers.", "#242326", "cross"],
  ["blue hoodie featuring a red cross graphic on the central chest", "#b53a35", "cross"],
  ["gray sweatshirt with a small white graphic cross on the chest", "#eeeae1", "cross"],
  ["green sweatshirt featuring a dark logo on the center chest", "#242326", undefined],
])("binds explicit featuring/graphic-cross attachment without borrowing shoe ink: %s", (text, ink, shape) => {
  const p = buildOutfitPlan(input(text!));
  expect(p.upper.pattern).toMatchObject({ kind: "center_graphic", color: ink, surfaceParts: ["body"], source: "observed" });
  expect(p.upper.pattern.graphicShape).toBe(shape);
  expect(p.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
});
it.each([
  "hoodie featuring a mystery graphic cross on the chest",
  "hoodie featuring a dark necklace cross on the chest",
  "hoodie featuring a dark graphic cross on the sleeve",
  "hoodie featuring a dark graphic cross on the chest possibly",
  "hoodie and shirt featuring a dark graphic cross on the chest",
  "hoodie; pants featuring a dark graphic cross on the chest",
  "hoodie featuring a dark-red graphic cross on the chest",
  "picture of a hoodie featuring a dark graphic cross on the chest",
])("keeps ownership/uncertainty guards on featuring: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.graphicShape).toBeUndefined();
});
it.each(["white low-top sneakers", "black high-top shoes", "gray mid-top sneakers"])("does not count footwear height as another top: %s", shoes => {
  const a = input(`A black hoodie with a large, stylized black cross graphic on the center chest, paired with black wide-leg cargo pants featuring side pockets. ${shoes} are worn.`);
  const p = buildOutfitPlan(a);
  expect(p.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326" });
  expect(p.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
});
it.each(["hoodie over a white top with low-top sneakers", "hoodie and a red crop-top with high-top shoes"])(
  "still treats a separate top as another garment: %s", text => {
    const p = buildOutfitPlan(input(`${text} with a black cross graphic on the chest`));
    expect(p.upper.pattern.graphicShape).toBeUndefined();
    expect(p.upper.leftSleeve.source).not.toBe("strongly_implied");
  });
it.each([evidence, "blue hoodie with a red cross graphic on the chest", "gray sweatshirt with a small white logo on the central chest"])(
  "keeps the standalone pullover construction with attached chest ink: %s", text => {
    const a = input(text), before = JSON.stringify(a), p = buildOutfitPlan(a);
    expect(p.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    expect(p.upper.rightSleeve.length).toBe("long"); expect(p.outerLayer.regions).toContain("cuffs");
    expect(p.upper.pattern).toMatchObject({ kind: "center_graphic", placement: "front", surfaceParts: ["body"], source: "observed" });
    expect(JSON.stringify(a)).toBe(before);
  });
it.each(["black", "red", "white", "blue"])("binds %s cross ink, not the cached white accent", ink => {
  const p = buildOutfitPlan(input(`black hoodie with a ${ink} cross graphic on the chest; gray pants`));
  expect(p.upper.pattern.graphicShape).toBe("cross"); expect(p.outerLayer.regions).not.toContain("graphic_depth");
  expect(p.upper.pattern.color).toBe({ black: "#242326", red: "#b53a35", white: "#eeeae1", blue: "#416b9d" }[ink]);
});
it.each(["short-sleeved", "sleeveless", "long-sleeved"])("does not replace explicit %s construction", sleeve => {
  const p = buildOutfitPlan(input(`${sleeve} hoodie with a black cross graphic on the chest`));
  expect(p.upper.leftSleeve.length).toBe(sleeve === "short-sleeved" ? "short" : sleeve === "sleeveless" ? "sleeveless" : "long");
});
it.each([
  "hoodie print", "possibly a hoodie with a black cross graphic on the chest", "hoodie with no black cross graphic on the chest",
  "hoodie with a black cross graphic on the back", "hoodie with a black cross graphic on a sleeve",
  "hoodie with a mystery cross graphic on the chest", "hoodie with a scarf with a black cross graphic on the chest",
  "hoodie over a shirt with a black cross graphic on the chest", "shirt and hoodie with a black cross graphic on the chest",
  "hoodie; pants with a black cross graphic on the chest",
  "picture of a hoodie with a black cross graphic on the chest", "hoodie with a black cross graphic on the chest hidden",
])("does not newly infer sleeves or a cross from unsafe ownership: %s", text => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.pattern.graphicShape).toBeUndefined();
  expect(p.upper.leftSleeve.source).not.toBe("strongly_implied");
});
it("keeps an accessory cross separate without changing the existing plain-hoodie sleeve default", () => {
  const p = buildOutfitPlan(input("hoodie with a black cross necklace on the chest"));
  expect(p.upper.pattern.graphicShape).toBeUndefined();
  expect(p.upper.leftSleeve.source).toBe("strongly_implied");
});
it("does not recover hidden or prompt-only chest evidence", () => {
  const a = input(evidence); a.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(a).upper.pattern.graphicShape).toBeUndefined();
  a.visibleRegions.upperBody = true; a.outfitPrompt = evidence; a.observed.clothing = "plain hoodie";
  expect(buildOutfitPlan(a).upper.pattern.graphicShape).toBeUndefined();
});

it("prints one connected cross on the chest base, without stamping arms/back or a raised duplicate", () => {
  const p = buildOutfitPlan(input(evidence));
  const without = structuredClone(p); without.upper.pattern = { ...p.upper.pattern, kind: "none" };
  const before = makeSyntheticAtlas(4), after = makeSyntheticAtlas(4);
  applyOutfitPlan(before, without, "#efd0c7"); applyOutfitPlan(after, p, "#efd0c7");
  const chest = CLASSIC_LAYOUT.body.base.front, changed: string[] = [];
  for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.rgba[i * 4 + ch] !== after.rgba[i * 4 + ch])) {
    const x = i % 64 - chest.x, y = Math.floor(i / 64) - chest.y;
    expect(x >= 0 && x < chest.w && y >= 0 && y < chest.h).toBe(true);
    changed.push(`${x}:${y}`); expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
  }
  const expected = Array.from({ length: 6 }, (_, y) => [`3:${y + 3}`, `4:${y + 3}`]).flat().concat(["2:5", "5:5"]);
  expect(changed.sort()).toEqual(expected.sort());
});

it("uses observed generic graphic ink for its existing depth pixels instead of cached garment accent", () => {
  const p = buildOutfitPlan(input("black hoodie with a blue logo on the chest"));
  p.upper.accentColor = "#ffffff";
  const atlas = makeSyntheticAtlas(4); applyOutfitPlan(atlas, p, "#efd0c7");
  const front = CLASSIC_LAYOUT.body.overlay.front, i = ((front.y + 3) * 64 + front.x + 3) * 4;
  expect(Array.from(atlas.rgba.slice(i, i + 4))).toEqual([65, 107, 157, 255]);
});
