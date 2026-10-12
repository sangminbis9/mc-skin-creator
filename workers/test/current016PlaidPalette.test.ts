import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { SkinPlan } from "../src/skinPlan";

const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-016/summary.json", "utf8")).currentDefaultE2E.result;
function input(clothing = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: "", outfitPrompt: clothing, negativePrompt: "" });
  a.observed.clothing = clothing;
  return a;
}
it.each([
  [live.diagnostics.normalizedPrimary.observed.clothing, ["#273954", "#c5aa82"]],
  ["Blue plaid shirt with navy and tan stripes", ["#273954", "#c5aa82"]],
  ["Blue shirt with plaid bands in blue, navy blue and tan/beige", ["#273954", "#c5aa82"]],
  ["Red plaid shirt with green and black bands", ["#467a50", "#242326"]],
])("preserves two explicit crossed-band accents: %s", (text, colors) => {
  const p = buildOutfitPlan(input(text));
  expect(p.upper.pattern.construction).toBe("crossed_bands");
  expect(p.upper.pattern.crossedBandColors).toEqual(colors);
  expect(p.upper.pattern.stripeColors).toBeUndefined();
});
it.each([
  "Blue plaid shirt with tan stripes", "Blue shirt with navy and tan horizontal stripes",
  "Blue shirt with navy and tan vertical stripes", "Blue checkered shirt with navy and tan checks",
  "Blue plaid shirt with possibly navy and tan stripes", "Blue plaid shirt with no navy and tan stripes",
  "Blue plaid shirt. Navy and tan striped pants", "Blue plaid shirt with navy stripes and tan shoes",
])("does not invent a crossed palette: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.crossedBandColors).toBeUndefined();
});
it("does not promote hidden/inferred colors", () => {
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.crossedBandColors).toBeUndefined();
  const inferred = input("Blue plaid shirt with tan stripes");
  inferred.outfitPrompt = "Blue plaid shirt with navy and tan stripes";
  expect(buildOutfitPlan(inferred).upper.pattern.crossedBandColors).toBeUndefined();
});
it("keeps the same band phase across torso and both long sleeves", () => {
  const plan = buildOutfitPlan(input());
  const atlas = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  applyOutfitPlan(atlas, plan, live.features.skinTone);
  for (const part of ["body", "leftArm", "rightArm"] as const) for (const face of ["front", "right", "left", "back"] as const) {
    const rect = CLASSIC_LAYOUT[part].base[face], factor = { front: 1, right: 0.86, left: 0.92, back: 0.78 }[face];
    for (const [row, rgb] of [[2, [39, 57, 84]], [5, [197, 170, 130]]] as const) {
      const at = ((rect.y + row) * 64 + rect.x) * 4;
      expect([...atlas.rgba.slice(at, at + 4)]).toEqual([...rgb.map(v => Math.round(v * factor)), 255]);
    }
  }
});
it("isolates the observed navy/tan palette from exact actual 016 PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const sourceRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-016";
    const png = readFileSync(`${sourceRoot}/skin.png`), a = normalizeAnalysisForRendering(input());
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const afterPlan = structuredClone(beforePlan);
    afterPlan.outfitPlan.upper.pattern = buildOutfitPlan(a).upper.pattern;
    const style = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    expect(before.rgba).toEqual((await decodePng(png)).rgba);
    const rects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    const changes = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changes.push({ x, y });
      }
    }
    expect(changes.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-016-crossed-palette-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, baselineExact: true,
      beforePattern: beforePlan.outfitPlan.upper.pattern, afterPattern: afterPlan.outfitPlan.upper.pattern,
      changedPixels: changes.length, headDiff: 0, lowerDiff: 0, alphaDiff: 0, craft,
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Preserves provider plaid topology; does not claim source horizontal-pattern measurement was corrected." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`CROSSED_PALETTE ${output}`);
  } finally { network.mockRestore(); }
});
