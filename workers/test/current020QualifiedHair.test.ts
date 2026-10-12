import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedQualifiedScalpCloseHair } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020";
const summary = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
const live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const capture = process.env.CAPTURE_020_QUALIFIED_HAIR === "offline-baseline-only";
const baselineRoot = "evaluation-artifacts/current-020-qualified-hair-before-20260928-XOfeL5";
function input() {
  const p = live.diagnostics.normalizedPrimary;
  return normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
}
it.runIf(capture)("captures exact pre-fix style and earliest failed hair evidence gate offline", async () => {
  const a = input(), plans = buildIdentityPixelPlans(a);
  expect(observedQualifiedScalpCloseHair(a)).toBe(false);
  expect(plans.hairPlan.template).toBe("bald");
  const withoutAlternative = structuredClone(a);
  withoutAlternative.canonicalIdentity.mustPreserve = withoutAlternative.canonicalIdentity.mustPreserve
    .map(v => v.replace("close-cropped/bald hair silhouette", "close-cropped hair silhouette"));
  expect(observedQualifiedScalpCloseHair(withoutAlternative)).toBe(true);
  const style = buildFaceStyle(a, live.features, live.analysis.skinPlan.hairPlan);
  expect(buildProceduralFallbackAtlas(live.features, style, live.analysis.skinPlan)!.rgba).toEqual((await decodePng(png)).rgba);
  const out = mkdtempSync("evaluation-artifacts/current-020-qualified-hair-before-20260928-");
  writeFileSync(`${out}/baseline.json`, JSON.stringify({ summarySha256: sha(summary), pngSha256: sha(png),
    style, plans, evidenceGate: false, providerCalls: 0, productionFileSha256: sha(readFileSync("src/scalpCloseHairEvidence.ts")) }, null, 2), { flag: "wx" });
  console.info(`QUALIFIED_020_BASELINE ${out}`);
});
it.skipIf(capture).each(["close-cropped/bald hair silhouette", "closely cropped / bald hair silhouette", "bald/close-cropped hair silhouette"])(
  "keeps corroborated visible cropped hair when canonical summary uses an alternative: %s", phrase => {
    const a = input(); a.canonicalIdentity.mustPreserve = a.canonicalIdentity.mustPreserve.map(v => v.includes("/bald") ? phrase : v);
    const unchanged = structuredClone(a);
    expect(observedQualifiedScalpCloseHair(a)).toBe(true);
    const p = buildIdentityPixelPlans(a);
    expect(p.hairPlan.lengthClass).toBe("short"); expect(p.hairPlan.surfaceOnly).toBe(true);
    expect(p.hairPlan.surfaceMaterial).toBe("scalp_shadow");
    expect(p.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(p.facePixelPlan).toEqual(live.analysis.skinPlan.facePixelPlan);
    expect(a).toEqual(unchanged);
  });
it.skipIf(capture).each(["bald crown", "bare scalp", "receding hairline", "close-cropped sides and bald crown", "close-cropped/bald head with bare crown"])(
  "keeps independent canonical absence/recession evidence as veto: %s", evidence => {
    const a = input(); a.canonicalIdentity.features.push({ category: "hair", feature: evidence, evidence, priority: 5, confidence: "high", targetRegions: ["head.top"] });
    expect(observedQualifiedScalpCloseHair(a)).toBe(false);
  });
it.skipIf(capture).each(["hidden", "bald_enum", "measured", "covering", "accessory", "volume", "length", "fringe", "sides", "unqualified", "uncertain", "negated"])(
  "retains the existing %s gate", mode => {
    const a = input();
    if (mode === "hidden") a.visibleRegions.hair = false;
    if (mode === "bald_enum") a.fallbackFeatures.hairstyle = "bald";
    if (mode === "measured") a.identityGeometry = makeIdentityGeometry();
    if (mode === "covering") a.fallbackFeatures.hat = "headscarf";
    if (mode === "accessory") a.renderHints.hairAccessory = "bow";
    if (mode === "volume") a.renderHints.hairVolume = "full";
    if (mode === "length") a.renderHints.overallHairLength = "shoulder";
    if (mode === "fringe") a.renderHints.bangs = "straight";
    if (mode === "sides") a.renderHints.sideHairLength = "short";
    if (mode === "unqualified") a.observed.hair = "Bald scalp.";
    if (mode === "uncertain") a.observed.hair = "Possibly " + a.observed.hair;
    if (mode === "negated") a.observed.hair = "No " + a.observed.hair;
    expect(observedQualifiedScalpCloseHair(a)).toBe(false);
  });
it.skipIf(capture).each([
  "Very short, close-cropped black hair, appearing almost bald. Hair follows the head contour.",
  "Very short, close-cropped black hair, appearing almost bald. No scalp is visible.",
  "Very short, close-cropped black hair, appearing almost bald. Possibly visible scalp.",
  "Very short, close-cropped black hair, appearing almost bald with a visible scalp parting.",
])("does not manufacture scalp transparency from absent/confounded skin evidence: %s", hair => {
  const a = input(); a.observed.hair = hair;
  expect(buildIdentityPixelPlans(a).hairPlan.surfaceMaterial).toBeUndefined();
});
it.skipIf(capture)("isolates accepted hair occupancy from immutable actual PNG, preserving face and outfit", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const baseline = JSON.parse(readFileSync(`${baselineRoot}/baseline.json`, "utf8"));
    expect(baseline.summarySha256).toBe(sha(summary)); expect(baseline.pngSha256).toBe(sha(png));
    const a = input(), built = buildIdentityPixelPlans(a), before = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const after = structuredClone(before); after.hairPlan = built.hairPlan; after.headIdentityPlan = built.headIdentityPlan;
    expect(built.facePixelPlan).toEqual(before.facePixelPlan);
    expect(after.hairPlan.surfaceOnly).toBe(true); expect(after.hairPlan.surfaceMaterial).toBe("scalp_shadow");
    const style = buildFaceStyle(a, live.features, after.hairPlan);
    expect(style.facialHair).toBe(baseline.style.facialHair); expect(style.goateeHasMustache).toBe(baseline.style.goateeHasMustache);
    const oldAtlas = buildProceduralFallbackAtlas(live.features, baseline.style, before)!;
    const newAtlas = buildProceduralFallbackAtlas(live.features, style, after)!;
    expect(oldAtlas.rgba).toEqual((await decodePng(png)).rgba);
    let changedPixels = 0;
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => oldAtlas.rgba[p * 4 + c] !== newAtlas.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16); changedPixels++;
    }
    for (const p of before.facePixelPlan.pixels) {
      const at = ((p.y + 8) * 64 + p.x + 8) * 4;
      expect(newAtlas.rgba.slice(at, at + 4)).toEqual(oldAtlas.rgba.slice(at, at + 4));
    }
    expect(changedPixels).toBeGreaterThan(0);
    const craft = validateAtlasCraft(newAtlas, style, undefined, undefined, after);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(newAtlas).ok).toBe(true);
    const combinedPlan = structuredClone(after);
    combinedPlan.outfitPlan.upper.pattern.color = buildOutfitPlan(a).upper.pattern.color;
    expect(combinedPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    const combined = buildProceduralFallbackAtlas(live.features, style, combinedPlan)!;
    const combinedCraft = validateAtlasCraft(combined, style, undefined, undefined, combinedPlan);
    expect(combinedCraft.ok).toBe(true); expect(validateFinalAtlas(combined).ok).toBe(true);
    for (let p = 0; p < 64 * 16; p++) expect(combined.rgba.slice(p * 4, p * 4 + 4)).toEqual(newAtlas.rgba.slice(p * 4, p * 4 + 4));
    const out = mkdtempSync("evaluation-artifacts/current-020-qualified-hair-after-20260928-");
    for (const [name, atlas] of [["before", oldAtlas], ["after", newAtlas], ["combined-offline", combined]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), pngSha256: sha(png),
      baselineRoot, changedPixels, bodyDiff: 0, faceFeatureDiff: 0, exactBaselineReplay: true,
      surfaceOnly: true, scalpMaterial: after.hairPlan.surfaceMaterial, hairOuterCells: after.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length,
      craft, afterRgbaSha256: sha(newAtlas.rgba),
      combinedOffline: { changes: ["hair occupancy/material", "checker pattern color"], craft: combinedCraft, rgbaSha256: sha(combined.rgba) },
      limitation: "Offline hair-only counterfactual; no new live PNG or numeric scalp-density claim. Existing scalp-shadow material uses explicit visible-scalp evidence. Missing inference not reconstructed." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(summary); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`QUALIFIED_020_AFTER ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
