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
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-031";
const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-031-live-verification-20260928-T2qECa/verification.json", "utf8"));
function input(text = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
  a.observed.clothing = text; return a;
}
it.each([
  [live.diagnostics.normalizedPrimary.observed.clothing, ["#684b38", "#2f7775"]],
  ["Navy shirt with a striped pattern in navy, tan and teal.", ["#c5aa82", "#2f7775"]],
  ["Navy shirt with a horizontal striped pattern in navy, red and white.", ["#b53a35", "#eeeae1"]],
])("preserves the explicit striped-pattern color list: %s", (text, colors) => {
  const a = input(text), copy = structuredClone(a), pattern = buildOutfitPlan(a).upper.pattern;
  expect(pattern).toMatchObject({ kind: "horizontal_stripe", color: colors[0], stripeColors: colors });
  expect(a).toEqual(copy);
});
it.each(["Navy shirt without a striped pattern in tan and teal.", "Navy shirt with possibly a striped pattern in tan and teal.",
  "Navy shirt with a hidden striped pattern in tan and teal.", "Navy shirt. Pants with a striped pattern in tan and teal.",
  "Navy striped shirt with a tan and teal collar."])("does not borrow uncertain/other-garment colors: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.stripeColors).toBeUndefined();
});
it("requires visible observed garment evidence", () => {
  const hidden = input(); hidden.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(hidden).upper.pattern.stripeColors).toBeUndefined();
  const inferred = input("Navy striped shirt."); inferred.outfitPrompt = live.diagnostics.normalizedPrimary.observed.clothing;
  expect(buildOutfitPlan(inferred).upper.pattern.stripeColors).toBeUndefined();
});
it("replays only actual 031 pattern colors, not head, geometry, lower body or topology", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const beforePlan = structuredClone(live.analysis.skinPlan), plan = structuredClone(beforePlan), next = buildOutfitPlan(input()).upper.pattern;
    expect(next.stripeColors).toEqual(["#684b38", "#2f7775"]);
    expect({ ...next, stripeColors: undefined }).toEqual({ ...beforePlan.outfitPlan.upper.pattern, stripeColors: undefined });
    plan.outfitPlan.upper.pattern = next;
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, beforePlan)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(live.features, baseline.style, plan)!;
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
    const craft = validateAtlasCraft(after, baseline.style, undefined, undefined, plan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-031-striped-pattern-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, baselineExact: true, changedPixels: changed,
      headDiff: 0, lowerDiff: 0, alphaDiff: 0, topologyDiff: 0, craft, palette: next.stripeColors,
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Offline color-list propagation, not provider correction. Brown/tan ambiguity remains unchanged." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`STRIPED_PATTERN_031 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
