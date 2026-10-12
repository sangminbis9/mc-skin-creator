import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-011/summary.json", "utf8")).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
function input(clothing = primary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(primary), outfitPrompt: clothing, identityPrompt: primary.observed.hair,
    faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry });
  a.observed.clothing = clothing;
  return normalizeAnalysisForRendering(a);
}
it.each([
  [primary.observed.clothing, ["#273954", "#2f7775"]],
  ["Brown shirt with horizontal stripes in brown, navy blue, and teal", ["#273954", "#2f7775"]],
  ["Brown shirt with navy, green and yellow horizontal stripes", ["#273954", "#467a50", "#d5af3f"]],
  ["Brown shirt with horizontal stripes in navy, navy blue and green", ["#273954", "#467a50"]],
])("preserves explicit scoped band palette: %s", (clothing, colors) => {
  const p = buildOutfitPlan(input(clothing as string));
  expect(p.upper.pattern.stripeColors).toEqual(colors);
  expect(p.upper.pattern.color).toBe(colors[0]);
});
it.each([
  "Brown shirt with navy horizontal stripes",
  "Brown shirt with horizontal stripes in brown and navy",
  "Brown shirt with no navy and green horizontal stripes",
  "Brown shirt with possibly navy and green horizontal stripes",
  "Brown shirt with horizontal stripes in navy and green hidden by a coat",
  "Plain brown shirt. Pants with horizontal stripes in navy and green",
  "Brown shirt with navy stripes and green shoes",
  "Brown shirt with navy and green vertical stripes",
  "Brown shirt with navy and green plaid bands",
])("does not infer multi-color horizontal bands: %s", clothing => {
  expect(buildOutfitPlan(input(clothing)).upper.pattern.stripeColors).toBeUndefined();
});
it("does not import inferred or hidden colors", () => {
  const a = input("Brown shirt with navy horizontal stripes");
  a.outfitPrompt = "Brown shirt with horizontal stripes in navy and green";
  expect(buildOutfitPlan(a).upper.pattern.stripeColors).toBeUndefined();
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.stripeColors).toBeUndefined();
});
it("keeps band phase across torso and sleeves without changing alpha or placement", () => {
  const p = buildOutfitPlan(input());
  const atlas = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  applyOutfitPlan(atlas, p, live.features.skinTone);
  for (const part of ["body", "leftArm", "rightArm"] as const) for (const face of ["front", "right", "left", "back"] as const) {
    const rect = CLASSIC_LAYOUT[part].base[face];
    const factor = { front: 1, right: 0.86, left: 0.92, back: 0.78 }[face];
    const at = ((rect.y + 5) * 64 + rect.x) * 4;
    expect(Array.from(atlas.rgba.slice(at, at + 4))).toEqual([47, 119, 117].map(v => Math.round(v * factor)).concat(255));
  }
});
it("isolates retained teal from the stored current hair material and preserves historical artifacts", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const priorRoot = "evaluation-artifacts/current-011-scalp-shadow-20260927-Spvz6u";
    const priorBytes = readFileSync(`${priorRoot}/results.json`);
    const prior = JSON.parse(priorBytes.toString());
    const beforePlan = prior.afterPlan as SkinPlan;
    const a = input(), upper = buildOutfitPlan(a).upper;
    const legacyUpper = structuredClone(upper); delete legacyUpper.pattern.stripeColors;
    expect(legacyUpper).toEqual(beforePlan.outfitPlan.upper);
    const afterPlan = structuredClone(beforePlan); afterPlan.outfitPlan.upper = upper;
    const style = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    expect(before.rgba).toEqual((await decodePng(readFileSync(`${priorRoot}/after.png`))).rgba);
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
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const root = mkdtempSync("evaluation-artifacts/current-011-stripe-palette-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, priorRoot,
      afterRgbaHash: createHash("sha256").update(after.rgba).digest("hex"),
      upper, changes, craft, headDiff: 0, lowerDiff: 0, alphaDiff: 0,
      limitation: "Offline observed-palette preservation; tan is absent from this primary and is not invented." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${priorRoot}/results.json`)).toEqual(priorBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`STRIPE_PALETTE_ARTIFACT ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
