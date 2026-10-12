import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedQualifiedScalpCloseHair } from "../src/scalpCloseHairEvidence";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";

const livePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-007/summary.json";
const liveBytes = readFileSync(livePath);
const live = JSON.parse(liveBytes.toString()).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
const beforeRoot: string | null = "evaluation-artifacts/qualified-cropped-hair-20260927-trMIMa";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

function input(hair = saved.observed.hair) {
  // Omitted rich fields are explicit helper context, not recovered provider evidence.
  const analysis = makeAnalysis({ ...structuredClone(saved), identityPrompt: hair, outfitPrompt: saved.observed.clothing });
  analysis.observed.hair = hair;
  return normalizeAnalysisForRendering(analysis);
}
it.each([
  saved.observed.hair,
  "Very short, nearly bald hair following the scalp.",
  "Extremely short, almost-bald hair.",
  "Closely cropped hair, nearly bald in appearance.",
])("preserves visible scalp-close hair instead of promoting qualified baldness: %s", hair => {
  const analysis = input(hair), plan = buildSkinPlan(analysis);
  expect(plan.hairPlan.template).not.toBe("bald");
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
  expect(style.hairstyle).toBe("buzz");
  expect(style.sideHairLength).toBe("none");
  expect(plan.facePixelPlan).toEqual(live.analysis.skinPlan.facePixelPlan);
  // Unsaved inferred lower-body context differs from the live plan; compare
  // only the identical helper-filled before context, never pretend recovery.
  const historicalOutfit = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8")).plan.outfitPlan;
  expect(plan.outfitPlan.upper.pattern.color).toBe("#684b38");
  const fixedPalette = structuredClone(plan.outfitPlan);
  expect(fixedPalette.upper.pattern.crossedBandColors).toEqual(["#684b38", "#c5aa82"]);
  // This hair-only historical ablation predates multi-color crossed bands.
  delete fixedPalette.upper.pattern.crossedBandColors;
  fixedPalette.upper.pattern.color = historicalOutfit.upper.pattern.color;
  expect(fixedPalette).toEqual(historicalOutfit);
});
it.each([
  "Bald head with no visible hair.", "Balding head with short hair at the sides.",
  "Very short hair around a bare scalp.", "Very short almost bald sides, but a bare scalp at the crown.",
  "Very short almost bald hair with a receding hairline.",
  "Possibly very short, almost bald hair.", "Very short almost bald hair hidden by a hat.",
  "Very short almost bald hair is clipped out of frame.", "Not very short, almost bald hair.",
  "Almost bald hair.",
])("does not promote bald/uncertain/insufficient evidence to scalp-close hair: %s", hair => {
  expect(buildSkinPlan(input(hair)).hairPlan.surfaceOnly).toBeUndefined();
});
it.each(["hidden", "bald_enum", "measured", "covering", "accessory", "volume", "length", "fringe", "sides", "explicit_canonical_bald"])("preserves %s protection", mode => {
  const analysis = input();
  if (mode === "hidden") analysis.visibleRegions.hair = false;
  if (mode === "bald_enum") analysis.fallbackFeatures.hairstyle = "bald";
  if (mode === "measured") analysis.identityGeometry = makeIdentityGeometry();
  if (mode === "covering") analysis.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") analysis.renderHints.hairAccessory = "bow";
  if (mode === "volume") analysis.renderHints.hairVolume = "full";
  if (mode === "length") analysis.renderHints.overallHairLength = "jaw";
  if (mode === "fringe") analysis.renderHints.bangs = "straight";
  if (mode === "sides") analysis.renderHints.sideHairLength = "short";
  if (mode === "explicit_canonical_bald") analysis.canonicalIdentity.features.push({
    feature: "bare bald crown", category: "hair", priority: 5, confidence: "high", evidence: "visible bare crown", targetRegions: ["head.top"] });
  expect(observedQualifiedScalpCloseHair(analysis)).toBe(false);
  // The synthetic geometry and this closed-mouth context have no admissible
  // face candidate. Test the hair evidence gate directly, without relaxing it.
  if (mode !== "measured") expect(buildSkinPlan(analysis).hairPlan.surfaceOnly).toBeUndefined();
});
it("captures fixed-context current-source replay and preserves every historical byte", async () => {
  const analysis = input(), plan = buildSkinPlan(analysis);
  // Isolate hair against the immutable pre-palette snapshot. Assert the new
  // coordinated-list color before pinning this ablation's outfit color only.
  const currentPatternColor = plan.outfitPlan.upper.pattern.color;
  expect(currentPatternColor).toBe("#684b38");
  expect(plan.outfitPlan.upper.pattern.crossedBandColors).toEqual(["#684b38", "#c5aa82"]);
  delete plan.outfitPlan.upper.pattern.crossedBandColors;
  plan.outfitPlan.upper.pattern.color = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8")).plan.outfitPlan.upper.pattern.color;
  const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
  const atlas = buildProceduralFallbackAtlas(live.features, style, plan);
  expect(atlas).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
  const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
  expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(atlas).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/qualified-cropped-hair-20260927-");
  const changed = [], explicitScleraPaletteChanges = [];
  if (beforeRoot) {
    const before = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8"));
    const old = await decodePng(readFileSync(`${beforeRoot}/atlas.png`));
    expect(plan.facePixelPlan).toEqual(before.plan.facePixelPlan);
    expect(plan.outfitPlan).toEqual(before.plan.outfitPlan);
    expect(plan.hairPlan.surfaceOnly).toBe(true);
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => atlas.rgba[p * 4 + c] !== old.rgba[p * 4 + c])) {
      const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
      expect(y).toBeLessThan(16);
      if (atlas.rgba[p * 4 + 3] !== old.rgba[p * 4 + 3]) {
        expect(x).toBeGreaterThanOrEqual(32); // Head overlay only, no new shell.
        expect(atlas.rgba[p * 4 + 3]).toBe(0);
      }
      const landmark = plan.facePixelPlan.pixels.find(cell => cell.cluster !== "fringe" && cell.x + 8 === x && cell.y + 8 === y);
      if (landmark) {
        // This immutable snapshot predates the independent explicit-sclera
        // palette repair. Permit only that exact RGB, never landmark movement.
        expect(landmark.role).toBe("sclera");
        const skin = [1, 3, 5].map(i => parseInt(live.features.skinTone.slice(i, i + 2), 16));
        expect(Array.from(atlas.rgba.slice(p * 4, p * 4 + 4)))
          .toEqual([...skin.map((v, i) => Math.round(v * .28 + [236, 232, 218][i] * .72)), 255]);
        expect(old.rgba[p * 4 + 3]).toBe(255);
        explicitScleraPaletteChanges.push({ x, y });
      }
    }
    expect(changed.length).toBeGreaterThan(0);
  }
  writeFileSync(`${root}/atlas.png`, await encodePng(atlas), { flag: "wx" });
  for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "back"].includes(v.name))) {
    writeFileSync(`${root}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    if (view.name === "front") writeFileSync(`${root}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, plan, style, craft, changed, explicitScleraPaletteChanges,
    independentPaletteAblation: { currentPatternColor, pinnedHistoricalColor: plan.outfitPlan.upper.pattern.color },
    liveSummarySha256: sha(liveBytes), atlasHash: sha(atlas.rgba),
    limitation: "Fixed partial -007 primary context, not a new live PNG or complete provider-response reconstruction." }, null, 2), { flag: "wx" });
  expect(readFileSync(livePath)).toEqual(liveBytes);
  console.info(`QUALIFIED_CROP_ROOT ${root}`);
}, 30_000);
