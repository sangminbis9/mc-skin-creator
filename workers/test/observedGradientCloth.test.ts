import { expect, it } from "vitest";
import { buildOutfitPlan, outfitPlanSignature } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function input(clothing: string, visible = true) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.observed.accessories = "none"; a.outfitPrompt = "";
  a.visibleRegions.upperBody = visible; a.renderHints.garmentTexture = "plain";
  a.renderHints.outerGarment = "none"; a.fallbackFeatures.topType = "tshirt";
  return a;
}
it.each(["top", "shirt", "sweater"])("preserves an observed pastel gradient on a %s, not a checker pattern", garment => {
  const a = input(`A short-sleeved ${garment} with puff sleeves, featuring a pastel gradient of pink, yellow, purple, and light blue; white cargo pants; green belt`);
  const immutable = JSON.stringify(a), p = buildOutfitPlan(a).upper.pattern;
  expect(p).toMatchObject({ kind: "color_panel", construction: "stepped_gradient", placement: "wrap", source: "observed",
    gradientColors: ["#d9a5af", "#e1c87d", "#a38cab", "#a9d5eb"] });
  expect(p.blockColors).toBeUndefined(); expect(p.gradientDirection).toBeUndefined();
  expect(p.evidence).not.toContain("pants"); expect(JSON.stringify(a)).toBe(immutable);
});
it.each(["horizontal", "vertical"] as const)("keeps an explicit %s direction independently from colors", direction => {
  expect(buildOutfitPlan(input(`Shirt with a ${direction} gradient of red and blue`)).upper.pattern)
    .toMatchObject({ gradientDirection: direction, gradientColors: ["#b53a35", "#416b9d"] });
});
it.each([
  "Shirt with a pastel rainbow color gradient (purple, blue, pink, yellow) and ruffled sleeves",
  "Shirt featuring a pastel gradient (purple, blue, pink, yellow)",
  "Shirt with a pastel colour gradient pattern (purple, blue, pink, and yellow)",
  "Shirt with a pastel gradient of purple, blue, pink, yellow and puff sleeves",
])("preserves only the explicit full palette across list notation: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern).toMatchObject({ construction: "stepped_gradient",
    gradientColors: ["#a38cab", "#819cba", "#d9a5af", "#e1c87d"], source: "observed" });
});
it.each([
  "A cropped top with a pastel gradient pattern of purple, pink, and yellow",
  "A short-sleeved puff-sleeve top with a pastel gradient of purple, pink, and yellow",
  "A cropped, short-sleeved puff-sleeve top with a pastel gradient pattern of purple, pink, and yellow; white cargo pants",
])("retains a complete garment-owned gradient palette in equivalent construction wording: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern).toMatchObject({
    construction: "stepped_gradient", source: "observed", gradientColors: ["#a38cab", "#d9a5af", "#e1c87d"],
  });
});
it.each([
  "Shirt with no gradient of red and blue",
  "Possibly a shirt with a gradient of red and blue",
  "Shirt with an unknown gradient of red and blue",
  "Shirt with a gradient of red and mystery",
  "Shirt with a gradient of red and blue and mystery",
  "Shirt with a gradient of red and red",
  "Shirt with a gradient of red, green, blue, pink, white and yellow",
  "Shirt with a gradient of red and blue on one sleeve",
  "Shirt with a gradient of red and blue on the front",
  "Shirt with a scarf featuring a gradient of red and blue",
  "Shirt with a gradient logo of red and blue",
  "Shirt with a logo featuring a gradient of red and blue",
  "Shirt depicting a gradient of red and blue",
  "Shirt with a bow featuring a gradient of red and blue",
  "Shirt with a collar featuring a gradient of red and blue",
  "Shirt with puff sleeves with a gradient of red and blue",
  "Shirt with a sleeve featuring a gradient of red and blue",
  "Plain shirt; pants with a gradient of red and blue",
  "Shirt over a sweater with a gradient of red and blue",
  "Shirt with diagonal gradient of red and blue",
  "Shirt with a possibly pastel gradient of red and blue",
  "Shirt with a gradient of red and blue, green cuffs",
  "Puff-sleeve top with no gradient pattern of red and blue",
  "Shirt with a puff-sleeve featuring a gradient pattern of red and blue",
  "Shirt with puff sleeves with a gradient pattern of red and blue",
  "Shirt with a gradient pattern of red and blue on one sleeve",
  "Shirt with a gradient pattern of red and mystery",
  "Shirt with a logo featuring a gradient pattern of red and blue",
  "Shirt with a rainbow color gradient",
  "Shirt with a gradient (red, mystery)",
  "Shirt with a gradient (red, blue) and red sleeves",
  "Shirt with a gradient (red, blue) on ruffled sleeves",
  "Shirt with ruffled sleeves featuring a gradient (red, blue)",
  "Shirt with a logo featuring a gradient (red, blue)",
  "Shirt with a gradient (red, blue) and a scarf",
  "Shirt with a possibly rainbow color gradient (red, blue)",
])("does not borrow uncertain, local, unknown or other-garment gradient evidence: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("stepped_gradient");
});
it("does not fill absent/hidden palette evidence from a prompt or cached accent", () => {
  const a = input("Plain shirt"); a.outfitPrompt = "Shirt with a pastel gradient of pink and blue";
  expect(buildOutfitPlan(a).upper.pattern.construction).not.toBe("stepped_gradient");
  expect(buildOutfitPlan(input(a.outfitPrompt, false)).upper.pattern.construction).not.toBe("stepped_gradient");
});
it("makes palette and explicit direction part of the source-specific signature", () => {
  const plans = ["red and blue", "red and green"].flatMap(p => ["horizontal", "vertical"].map(d =>
    buildOutfitPlan(input(`Shirt with a ${d} gradient of ${p}`))));
  expect(new Set(plans.map(outfitPlanSignature)).size).toBe(4);
});

it("renders different palettes/directions deterministically and keeps horizontal endpoints around the cuboid", () => {
  const images = [];
  for (const colors of ["red and blue", "red and green"]) for (const direction of ["horizontal", "vertical"]) {
    const p = buildOutfitPlan(input(`Shirt with a ${direction} gradient of ${colors}`));
    const render = () => {
      const a = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
      applyOutfitPlan(a, p, "#d39e80"); return a;
    };
    const a = render(); expect(a.rgba).toEqual(render().rgba); images.push(Buffer.from(a.rgba).toString("hex"));
    if (direction === "horizontal") {
      const palette = p.upper.pattern.gradientColors!;
      for (const [face, x, colorIndex, factor] of [
        ["front", 0, 0, 1], ["front", 7, 1, 1], ["back", 0, 1, 0.78], ["back", 7, 0, 0.78],
        ["right", 0, 0, 0.86], ["right", 3, 0, 0.86], ["left", 0, 1, 0.92], ["left", 3, 1, 0.92],
      ] as const) {
        const r = CLASSIC_LAYOUT.body.base[face], i = ((r.y + 4) * 64 + r.x + x) * 4;
        const color = [1, 3, 5].map(at => Math.round(Number.parseInt(palette[colorIndex].slice(at, at + 2), 16) * factor));
        expect([...a.rgba.subarray(i, i + 4)]).toEqual([...color, 255]);
      }
    }
  }
  expect(new Set(images).size).toBe(4);
});
