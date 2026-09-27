import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";

const saved = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
let guard: ReturnType<typeof vi.spyOn>;
beforeAll(() => { guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterAll(() => { expect(guard).not.toHaveBeenCalled(); guard.mockRestore(); });
function plan(clothing: string, visible = true, prompt = clothing) {
  const base = makeAnalysis();
  return buildOutfitPlan(makeAnalysis({ observed: { ...base.observed, clothing, accessories: "none" }, outfitPrompt: prompt,
    visibleRegions: { ...base.visibleRegions, upperBody: visible },
    fallbackFeatures: { ...base.fallbackFeatures, topType: "shirt", topAccentColor: "white" },
    renderHints: { ...base.renderHints, garmentTexture: "patterned", outerGarment: "none" } }));
}
it("retains both observed axes and the actual pattern palette from -005", () => {
  const p = plan(saved.observed.clothing);
  expect(p.upper.pattern.kind).toBe("checker_block");
  expect(p.upper.pattern.construction).toBe("crossed_bands");
  expect(p.upper.pattern.color).toBe("#c5aa82");
  expect(p.upper.baseColor).toBe("#273954");
});
it.each([
  "Blue shirt with horizontal and vertical stripes",
  "Blue shirt with vertical and horizontal stripes",
  "Blue shirt with horizontal stripes and vertical stripes",
])("preserves coordinated two-axis evidence: %s", text => {
  expect(plan(text).upper.pattern.construction).toBe("crossed_bands");
});
it.each([
  "Blue shirt with vertical stripes",
  "Blue shirt with horizontal stripes",
  "Blue shirt with horizontal or vertical stripes",
  "Blue shirt with no horizontal and vertical stripes",
  "Blue shirt with possibly horizontal and vertical stripes",
  "Blue shirt with horizontal stripes and pants with vertical stripes",
  "Blue shirt over a blouse with horizontal and vertical stripes",
])("does not invent crossed bands from absent/uncertain/other-garment evidence: %s", text => {
  expect(plan(text).upper.pattern.construction).toBeUndefined();
});
it.each([
  ["Dark blue shirt with stripes in shades of dark blue, tan, and black", "#c5aa82"],
  ["Red shirt with stripes in red and white", "#eeeae1"],
  ["Blue shirt with stripes in navy and yellow", "#273954"],
  ["Blue shirt with stripes in blue", "#416b9d"],
  ["Blue shirt with stripes and tan pants", "#eeeae1"],
  ["Blue shirt with possibly tan stripes", "#eeeae1"],
])("binds a postposed stripe palette without taking another garment color: %s", (text, expected) => {
  expect(plan(text).upper.pattern.color).toBe(expected);
});
it("does not promote hidden or inferred-only crossing evidence", () => {
  expect(plan("Blue shirt", true, saved.observed.clothing).upper.pattern.construction).toBeUndefined();
  expect(plan(saved.observed.clothing, false).upper.pattern.construction).toBeUndefined();
  expect(plan(saved.observed.clothing, false).upper.pattern.color).toBe("#eeeae1");
});
