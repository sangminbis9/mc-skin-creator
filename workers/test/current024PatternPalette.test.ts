import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-024";
const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-024-live-verification-20260928-A11uD0/verification.json", "utf8"));
function input(text = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
  a.observed.clothing = text; return a;
}
it.each([
  [live.diagnostics.normalizedPrimary.observed.clothing, ["#c5aa82", "#eeeae1"]],
  ["Navy shirt with a plaid pattern featuring navy blue, tan, and thin white lines.", ["#c5aa82", "#eeeae1"]],
  ["Navy shirt with a plaid pattern featuring navy blue, red, and thin cream/light lines.", ["#b53a35", "#ded2b6"]],
  ["Navy shirt with a plaid pattern featuring tan and white.", ["#c5aa82", "#eeeae1"]],
])("preserves the full explicit featuring-palette rather than nearest line color: %s", (text, colors) => {
  const a = input(text), copy = structuredClone(a), p = buildOutfitPlan(a);
  expect(p.upper.pattern).toMatchObject({ construction: "crossed_bands", color: colors[0], crossedBandColors: colors });
  expect(a).toEqual(copy);
});
it.each([
  "Navy shirt without a plaid pattern featuring navy blue, tan, and thin white/light lines.",
  "Navy shirt with possibly a plaid pattern featuring navy blue, tan, and thin white/light lines.",
  "Navy shirt with a hidden plaid pattern featuring navy blue, tan, and thin white/light lines.",
  "Navy shirt. Pants with a plaid pattern featuring navy blue, tan, and thin white/light lines.",
  "Navy shirt with a plaid pattern; tan shoes and thin white/light lines.",
  "Navy shirt with a plaid pattern featuring white/light lines; tan collar.",
  "Navy shirt with a plaid pattern featuring dark and light lines.",
])("does not promote missing, uncertain or other-garment tan: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.crossedBandColors).toBeUndefined();
});
it("requires visible observed upper-garment evidence", () => {
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.crossedBandColors).toBeUndefined();
  const inferred = input("Navy plaid shirt."); inferred.outfitPrompt = live.diagnostics.normalizedPrimary.observed.clothing;
  expect(buildOutfitPlan(inferred).upper.pattern.crossedBandColors).toBeUndefined();
});
it("replays actual 024 and changes only the observed upper pattern palette", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const beforePlan = structuredClone(live.analysis.skinPlan), afterPlan = structuredClone(beforePlan);
    const next = buildOutfitPlan(input()).upper.pattern;
    expect(next.crossedBandColors).toEqual(["#c5aa82", "#eeeae1"]);
    expect({ ...next, color: beforePlan.outfitPlan.upper.pattern.color, crossedBandColors: undefined })
      .toEqual({ ...beforePlan.outfitPlan.upper.pattern, crossedBandColors: undefined });
    afterPlan.outfitPlan.upper.pattern = next;
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, beforePlan)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(live.features, baseline.style, afterPlan)!;
    const rects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    let changed = 0;
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true); changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, baseline.style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-024-palette-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, baselineExact: true, changedPixels: changed,
      headDiff: 0, lowerDiff: 0, alphaDiff: 0, topologyDiff: 0, craft,
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Offline palette replay only. Existing plaid topology/stripe widths retained, not claimed as source measurement." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`PALETTE_024 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
