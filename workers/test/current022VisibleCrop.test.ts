import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-022";
const summary = readFileSync(`${root}/summary.json`), live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-022-live-verification-20260928-01pOge/verification.json", "utf8"));
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hair = live.diagnostics.normalizedPrimary.observed.hair) {
  const p = live.diagnostics.normalizedPrimary;
  const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
  a.observed.hair = hair; return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.hair,
  "Extremely short close-cropped brown hair with visible scalp.", "Very short closely cropped hair; scalp is visible."])("retains explicit skin under very short close crop: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(true);
});
it.each(["Short close-cropped hair with visible scalp.", "Very short close-cropped hair.", "Very short hair with visible scalp.",
  "Possibly very short close-cropped hair with visible scalp.", "Very short close-cropped hair with no visible scalp.",
  "Very short close-cropped hair on sides with visible scalp.", "Very short close-cropped hair with visible scalp along the part.",
  "Very short close-cropped hair with visible scalp through thinning.", "Very short close-cropped hair with a bare crown and visible scalp.",
  "Very short close-cropped beard, visible scalp.", "Very short close-cropped hair with hidden scalp."])("does not extend material to unproven or local skin evidence: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(false);
});
it("replays material-only correction against exact 022 final primary-only plan and PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(summary)).toBe(baseline.summarySha256);
    const a = input(), original = live.analysis.skinPlan;
    // Provider shape/semantic acceptance is not renderer admissibility.
    // Actual final plan uses the existing primary-only fail-open path.
    expect(Object.values(original.facePixelPlan.layout.geometryUsage).every(v => v === false)).toBe(true);
    // Historical run dropped geometry; the separately tested contract-aligned
    // eye quantizer now preserves it. Keep this material-only replay on the
    // actual primary-only final plan rather than mixing the independent fix.
    expect(buildIdentityPixelPlans({ ...a, faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry })
      .facePixelPlan.layout.geometryUsage.eyes).toBe(true);
    const parts = buildIdentityPixelPlans(a);
    expect(parts.facePixelPlan).toEqual(original.facePixelPlan); expect(parts.headIdentityPlan).toEqual(original.headIdentityPlan);
    const expected = structuredClone(original.hairPlan); expected.surfaceMaterial = "scalp_shadow";
    expect(parts.hairPlan).toEqual(expected);
    const plan = structuredClone(original); plan.hairPlan = parts.hairPlan;
    const style = buildFaceStyle(a, live.features, plan.hairPlan); expect(style).toEqual(baseline.style);
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, original)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(live.features, style, plan)!;
    let changed = 0;
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) { expect(Math.floor(p / 64)).toBeLessThan(16); changed++; }
    }
    for (const cell of original.facePixelPlan.pixels) {
      const i = ((8 + cell.y) * 64 + 8 + cell.x) * 4; expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    expect(changed).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-022-visible-crop-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), changedHeadPixels: changed,
      facePixelDiff: 0, alphaDiff: 0, bodyDiff: 0, maskAndOwnershipDiff: 0, afterRgbaSha256: sha(after.rgba), craft,
      limitation: "Offline only. Existing material linked to explicit visible scalp + very short close crop. No density estimate or geometry change." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`VISIBLE_CROP_022 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
