import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020";
const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
function input(clothing = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
  a.observed.clothing = clothing;
  return a;
}
it.each([
  [live.diagnostics.normalizedPrimary.observed.clothing, "#c5aa82"],
  ["Blue shirt with a checkered pattern consisting of blue and tan squares.", "#c5aa82"],
  ["Blue shirt with a checkered pattern consisting of blue and red squares.", "#b53a35"],
  ["Green shirt with a checkered pattern consisting of green and cream squares.", "#ded2b6"],
])("preserves explicitly named check squares without replacing topology: %s", (text, expected) => {
  const a = input(text), before = structuredClone(a), p = buildOutfitPlan(a);
  expect(p.upper.pattern).toMatchObject({ kind: "checker_block", color: expected });
  expect(p.upper.pattern.construction).toBeUndefined(); expect(a).toEqual(before);
});
it.each([
  "Blue shirt without a checkered pattern consisting of blue and tan squares.",
  "Blue shirt possibly with a checkered pattern consisting of blue and tan squares.",
  "Blue shirt with a hidden checkered pattern consisting of blue and tan squares.",
  "Blue shirt. Tan pants with a checkered pattern consisting of blue and tan squares.",
  "Blue shirt with a tan collar and a checkered pattern.",
  "Blue shirt with checkered squares; tan shoes.",
  "Blue shirt with a checkered pattern consisting of dark and light squares.",
])("does not turn unrelated, uncertain or uncoloured evidence into a tan accent: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.color).toBe("#eeeae1");
});
it("does not use hidden or inferred-only square palette", () => {
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.color).toBe("#eeeae1");
  const inferred = input("Blue checkered shirt."); inferred.outfitPrompt = live.diagnostics.normalizedPrimary.observed.clothing;
  expect(buildOutfitPlan(inferred).upper.pattern.color).toBe("#eeeae1");
});
it("replays only the corrected checker accent against the exact live atlas offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = normalizeAnalysisForRendering(input()), computed = buildOutfitPlan(a);
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan, afterPlan = structuredClone(beforePlan);
    expect(computed.upper.pattern.color).toBe("#c5aa82");
    const { color: oldColor, ...oldPattern } = beforePlan.outfitPlan.upper.pattern;
    const { color: newColor, ...newPattern } = computed.upper.pattern;
    expect(newPattern).toEqual(oldPattern);
    afterPlan.outfitPlan.upper.pattern.color = newColor;
    // Keep the pre-qualified-hair style for this strictly color-only ablation.
    const style = JSON.parse(readFileSync("evaluation-artifacts/current-020-qualified-hair-before-20260928-XOfeL5/baseline.json", "utf8")).style;
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    expect(before.rgba).toEqual((await decodePng(readFileSync(`${root}/skin.png`))).rgba);
    const rects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    let changedPixels = 0, exactTanPixels = 0;
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changedPixels++;
      }
      if ([197, 170, 130, 255].every((v, c) => after.rgba[p * 4 + c] === v)) exactTanPixels++;
    }
    expect(changedPixels).toBeGreaterThan(0); expect(exactTanPixels).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-020-checker-palette-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${output}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ mode: "offline_single_pattern_color_counterfactual", providerCalls: 0,
      oldColor, newColor, changedPixels, exactTanPixels, headDiff: 0, lowerDiff: 0, alphaDiff: 0, topologyDiff: 0,
      craft, afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Only the stored pattern color is changed. Missing inference is not reconstructed. Not a fresh live output." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`CHECKER_PALETTE ${output}`);
  } finally { network.mockRestore(); }
});
