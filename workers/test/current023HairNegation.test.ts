import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-023";
const summary = readFileSync(`${root}/summary.json`), live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-023-live-verification-20260928-HsogrR/verification.json", "utf8"));
function input(hair = live.diagnostics.normalizedPrimary.observed.hair) {
  const p = live.diagnostics.normalizedPrimary;
  const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p), inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: hair, outfitPrompt: p.observed.clothing, negativePrompt: "" })); a.observed.hair = hair; return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.hair,
  "Very short buzz cut; no visible fringe or side hair length beyond the temples.",
  "Very short buzz cut; without fringe and side hair length beyond temples."])("keeps explicit cropped hair despite absent side-length extension: %s", hair => {
  const p = buildIdentityPixelPlans(input(hair));
  expect(p.hairPlan.surfaceOnly).toBe(true); expect(p.headIdentityPlan.outerHairGroupIds).toEqual([]);
  expect(p.hairPlan.surfaceMaterial).toBeUndefined(); // No skin-visibility evidence in this response.
});
it.each([
  "No very short buzz cut.", "Possibly a very short buzz cut.", "Very short buzz cut hidden by a hat.",
  "Very short buzz cut; no fringe or visible scalp.", "Very short buzz cut; no fringe or hair.",
  "Very short buzz cut; no fringe or side hair length beyond the temples or hair.",
  "No very short hair, fringe or side hair length beyond the temples.",
  "Very short buzz cut; no fringe or side hair length beyond the temples and uncertain hair.",
])("does not strip unrecognized or coordinated hair negation: %s", hair => {
  expect(buildIdentityPixelPlans(input(hair)).hairPlan.surfaceOnly).toBeUndefined();
});
it("isolates surface occupancy without inventing scalp transparency or changing face/outfit", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(sha(summary)).toBe(baseline.summarySha256);
    const original = live.analysis.skinPlan, parts = buildIdentityPixelPlans(input());
    expect(parts.facePixelPlan).toEqual(original.facePixelPlan); expect(parts.hairPlan.surfaceOnly).toBe(true);
    expect(parts.hairPlan.surfaceMaterial).toBeUndefined(); expect(parts.headIdentityPlan.outerHairGroupIds).toEqual([]);
    const plan = structuredClone(original); plan.hairPlan = parts.hairPlan; plan.headIdentityPlan = parts.headIdentityPlan;
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, original)!.rgba).toEqual(before.rgba);
    const style = buildFaceStyle(input(), live.features, plan.hairPlan);
    expect(style.hairstyle).toBe("buzz");
    expect({ ...style, hairstyle: baseline.style.hairstyle }).toEqual(baseline.style);
    const after = buildProceduralFallbackAtlas(live.features, style, plan)!;
    let changed = 0;
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) { expect(Math.floor(p / 64)).toBeLessThan(16); changed++; }
    for (const cell of original.facePixelPlan.pixels) {
      const i = ((cell.y + 8) * 64 + cell.x + 8) * 4; expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    expect(changed).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-023-hair-negation-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), changedHeadPixels: changed,
      bodyDiff: 0, faceFeatureDiff: 0, scalpMaterial: null, outerHairGroups: 0, craft, afterRgbaSha256: sha(after.rgba),
      limitation: "Offline only. Absence of extended side hair does not negate a buzz cut. Missing skin visibility is not invented." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`HAIR_NEGATION_023 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
