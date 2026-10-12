import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import type { SkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-012";
const bytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing = primary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(primary), identityPrompt: primary.observed.hair,
    outfitPrompt: clothing, negativePrompt: "" });
  a.observed.clothing = clothing;
  return normalizeAnalysisForRendering(a);
}
it.each([
  [primary.observed.clothing, "#c5aa82"],
  ["Blue shirt with blue, tan, and dark stripes", "#c5aa82"],
  ["Blue shirt with blue, light, and tan stripes", "#c5aa82"],
  ["Red shirt with red, cream and dark checks", "#ded2b6"],
  ["Green shirt with dark, green and yellow bands", "#d5af3f"],
])("retains explicit colors beside unlocalized tonal descriptors: %s", (clothing, expected) => {
  expect(buildOutfitPlan(input(clothing)).upper.pattern.color).toBe(expected);
});
it.each([
  "Blue shirt with no blue, tan and dark stripes",
  "Blue shirt with possibly blue, tan and dark stripes",
  "Blue shirt with tan buttons and dark stripes",
  "Blue shirt with dark stripes and tan shoes",
  "Blue shirt over pants with blue, tan and dark stripes",
  "Blue shirt over a blouse with blue, tan and dark stripes",
  "Blue shirt with light and dark stripes",
])("does not invent color from tone or unrelated/qualified text: %s", clothing => {
  expect(buildOutfitPlan(input(clothing)).upper.pattern.color).toBe("#eeeae1");
});
it("keeps inferred and hidden colors ineligible", () => {
  const a = input("Blue shirt with dark stripes");
  a.outfitPrompt = "Blue shirt with blue, tan and dark stripes";
  expect(buildOutfitPlan(a).upper.pattern.color).toBe("#eeeae1");
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.color).toBe("#eeeae1");
});
it("isolates the accepted observed tan in actual stored outfit context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = input(), upper = buildOutfitPlan(a).upper;
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const ownership = resolveHeadOwnership(a, beforePlan.hairPlan, beforePlan.facePixelPlan);
    expect(ownership.cells.slice(0, 512)).toEqual(beforePlan.headIdentityPlan.ownership!.cells);
    expect({ ...ownership, cells: [] }).toEqual({ ...beforePlan.headIdentityPlan.ownership, cells: [] });
    beforePlan.headIdentityPlan.ownership = ownership;
    expect(upper.pattern.color).toBe("#c5aa82");
    const restoredUpper = structuredClone(upper); restoredUpper.pattern.color = beforePlan.outfitPlan.upper.pattern.color;
    expect(restoredUpper).toEqual(beforePlan.outfitPlan.upper);
    const afterPlan = structuredClone(beforePlan); afterPlan.outfitPlan.upper = upper;
    const style = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    expect(before).not.toBeNull(); expect(after).not.toBeNull();
    const actual = await decodePng(pngBytes);
    const rects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    const changes = [], baselineDiff = [];
    for (let p = 0; p < 4096; p++) {
      const x = p % 64, y = Math.floor(p / 64);
      if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== actual.rgba[p * 4 + c])) {
        baselineDiff.push({ x, y });
      }
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changes.push({ x, y });
      }
    }
    expect(baselineDiff).toHaveLength(0); expect(changes.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-012-tan-palette-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, liveSummaryHash: sha(bytes),
      livePngHash: sha(pngBytes), observedClothing: primary.observed.clothing,
      beforeColor: beforePlan.outfitPlan.upper.pattern.color, afterColor: upper.pattern.color,
      afterRgbaHash: sha(after.rgba), changes, craft, headDiff: 0, lowerDiff: 0, alphaDiff: 0,
      actualLiveReplayDiff: 0, ownershipRecovery: "deterministic_resolver_from_saved_inputs",
      limitation: "Offline color-only counterfactual, not a fresh live output. Historical ownership projection was truncated at 512; complete resolver replay matches actual PNG. Tonal dark/light descriptors do not supply RGB." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`TAN_PALETTE_ARTIFACT ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
