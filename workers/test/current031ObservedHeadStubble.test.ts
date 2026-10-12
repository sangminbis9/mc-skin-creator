import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-031";
const summary = readFileSync(`${root}/summary.json`), live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-031-live-verification-20260928-T2qECa/verification.json", "utf8"));
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hair = live.diagnostics.normalizedPrimary.observed.hair) {
  const p = live.diagnostics.normalizedPrimary;
  const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p), faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry,
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
  a.observed.hair = hair; return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.hair,
  "Shaved head with visible very short stubble.", "Shaved scalp with very short visible stubble."])("retains directly localized visible scalp stubble: %s", hair => {
  const a = input(hair), original = structuredClone(a);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  expect(buildIdentityPixelPlans(a).hairPlan).toMatchObject({ surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" });
  expect(a).toEqual(original);
});
it.each(["Shaved head.", "Shaved head with stubble.", "Shaved head with very short stubble.",
  "Bald head with very short stubble visible.", "Shaved head with visible beard stubble.",
  "Shaved head with very short stubble visible on the chin.", "Shaved head with very short stubble visible on sides only.",
  "Shaved head with very short stubble visible at the temples.", "Shaved head with very short stubble visible through thinning patches.",
  "Possibly shaved head with very short stubble visible.", "Shaved head with no very short stubble visible.",
  "Shaved head with very short stubble not visible.", "Shaved head with very short stubble visible; bare crown.",
  "Shaved head with very short stubble visible; longer hair at back.", "Shaved head; very short stubble visible on cheeks."])("keeps absent, ambiguous, partial and facial stubble rejected: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(false);
});
it.each(["visibility", "hat", "accessory", "geometry", "length", "volume", "fringe", "sides", "no_hair"])("preserves the %s gate", mode => {
  const a = input();
  if (mode === "visibility") a.visibleRegions.hair = false;
  if (mode === "hat") a.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") a.renderHints.hairAccessory = "bow";
  if (mode === "geometry") a.identityGeometry = makeIdentityGeometry();
  if (mode === "length") a.renderHints.overallHairLength = "shoulder";
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "sides") a.renderHints.sideHairLength = "short";
  if (mode === "no_hair") a.canonicalIdentity.mustPreserve.push("no visible hair or stubble");
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});
it("isolates the exact 031 observation-to-material correction without changing face geometry or outfit", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(summary)).toBe(baseline.summarySha256);
    const a = input(), original = live.analysis.skinPlan, parts = buildIdentityPixelPlans(a);
    expect(parts.facePixelPlan).toEqual(original.facePixelPlan);
    // The sanitized primary omits free-form inference used by the historical
    // outfit. Keep the exact stored outfit; compare equal-context plans only.
    expect(parts.outfitPlan).toEqual(buildIdentityPixelPlans(input("Shaved head.")).outfitPlan);
    expect(parts.hairPlan).toMatchObject({ surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" });
    const plan = structuredClone(original); plan.hairPlan = parts.hairPlan; plan.headIdentityPlan = parts.headIdentityPlan;
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, original)!.rgba).toEqual(before.rgba);
    const style = buildFaceStyle(a, live.features, plan.hairPlan), after = buildProceduralFallbackAtlas(live.features, style, plan)!;
    expect(style.facialHair).toBe(baseline.style.facialHair);
    let changed = 0;
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) { expect(Math.floor(p / 64)).toBeLessThan(16); changed++; }
    }
    for (const cell of original.facePixelPlan.pixels) {
      const i = ((8 + cell.y) * 64 + 8 + cell.x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    expect(changed).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-031-head-stubble-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), changedHeadPixels: changed,
      facePixelDiff: 0, alphaDiff: 0, bodyDiff: 0, afterRgbaSha256: sha(after.rgba), craft,
      limitation: "Offline counterfactual only. Direct observed scalp stubble selects the existing material; no density measurement, provider cue correction or contract relaxation." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`HEAD_STUBBLE_031 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
