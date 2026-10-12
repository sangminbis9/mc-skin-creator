import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019/summary.json", "utf8")).currentDefaultE2E.result;
function input(clothing = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: "", outfitPrompt: clothing, negativePrompt: "" });
  a.observed.clothing = clothing;
  return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.clothing,
  "Red long-sleeved button-up shirt with a collar.", "Blue button down shirt with white stripes.",
])("retains explicit visible standalone button shirt despite contradictory dress fallback: %s", clothing => {
  const a = input(clothing), before = structuredClone(a), p = buildOutfitPlan(a);
  expect(p.upper.garmentType).toBe("shirt"); expect(p.lower.garmentType).toBe("pants");
  expect(p.lower.waistRow).toBe(10); expect(a).toEqual(before);
});
it.each([
  "Blue shirt dress with buttons.", "Blue button-down shirt dress.",
  "Blue button-down shirt over a dress.", "Blue button-down shirt underneath a sweater.",
  "Blue button-down shirt worn under a hoodie.", "Blue button-down shirt-inspired dress.",
  "Possibly a blue button-down shirt.", "Not a blue button-down shirt.",
  "No blue button-down shirt is visible.", "Blue button-down shirt hidden by an accessory.",
  "Blue shirt with buttons.", "Blue dress with a button-down collar.",
])("does not reclassify ambiguous, layered, hidden or unsupported evidence: %s", clothing => {
  expect(buildOutfitPlan(input(clothing)).upper.garmentType).toBe("dress_upper");
});
it("does not use hidden evidence or outfit-prompt-only clothing to override the category", () => {
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.garmentType).toBe("dress_upper");
  const inferred = input("Blue upper garment."); inferred.outfitPrompt = "Blue button-down shirt.";
  expect(buildOutfitPlan(inferred).upper.garmentType).toBe("dress_upper");
});
it("keeps existing outerwear and coherent fallback behavior", () => {
  const outer = input(); outer.renderHints.outerGarment = "open_jacket";
  expect(buildOutfitPlan(outer).upper.garmentType).toBe("jacket");
  const shirt = input(); shirt.fallbackFeatures.topType = "shirt";
  expect(buildOutfitPlan(shirt).upper.garmentType).toBe("shirt");
});
it("isolates the corrected garment classification from exact live PNG without rebuilding missing inference", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = normalizeAnalysisForRendering(input()), computed = buildOutfitPlan(a);
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const afterPlan = structuredClone(beforePlan);
    expect(computed.upper.pattern).toEqual(beforePlan.outfitPlan.upper.pattern);
    expect(computed.upper.leftSleeve).toEqual(beforePlan.outfitPlan.upper.leftSleeve);
    expect(computed.upper.rightSleeve).toEqual(beforePlan.outfitPlan.upper.rightSleeve);
    // Preserve captured hidden completion and all other plans. Only the
    // directly category-dependent render fields are replayed here.
    afterPlan.outfitPlan.upper.garmentType = computed.upper.garmentType;
    afterPlan.outfitPlan.lower.garmentType = computed.lower.garmentType;
    afterPlan.outfitPlan.lower.waistRow = computed.lower.waistRow;
    const style = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    const png = readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019/skin.png");
    expect(before.rgba).toEqual((await decodePng(png)).rgba);
    let changes = 0, alphaChanges = 0;
    const garmentRects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftLeg, CLASSIC_LAYOUT.rightLeg]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    for (let p = 0; p < 4096; p++) {
      if (Math.floor(p / 64) < 16) expect(after.rgba.slice(p * 4, p * 4 + 4)).toEqual(before.rgba.slice(p * 4, p * 4 + 4));
      if ([0, 1, 2, 3].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(garmentRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changes++;
        if (after.rgba[p * 4 + 3] !== before.rgba[p * 4 + 3]) alphaChanges++;
      }
    }
    expect(changes).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-019-shirt-category-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${output}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ mode: "offline_category_counterfactual", providerCalls: 0,
      baselineExact: true, changedPixels: changes, headDiff: 0, sleeveDiff: 0, garmentAlphaChanges: alphaChanges, craft,
      before: { upper: beforePlan.outfitPlan.upper.garmentType, lower: beforePlan.outfitPlan.lower.garmentType, waist: beforePlan.outfitPlan.lower.waistRow },
      after: { upper: computed.upper.garmentType, lower: computed.lower.garmentType, waist: computed.lower.waistRow },
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Only saved category-dependent render fields replaced; missing inference is not reconstructed. Not a fresh live output." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`SHIRT_CATEGORY ${output}`);
  } finally { network.mockRestore(); }
});
