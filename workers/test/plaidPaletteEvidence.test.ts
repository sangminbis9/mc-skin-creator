import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews } from "../src/skinRender";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { assertHairMaterialPixelBoundary, historicalHairMaterialPlan } from "./historicalHairMaterial";
import { assertAccessoryPaletteBoundary, historicalScarfBeltPlan } from "./historicalScarfBeltColors";

const livePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json";
const live = JSON.parse(readFileSync(livePath, "utf8")).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
function plan(clothing: string, visible = true, prompt = clothing) {
  const base = makeAnalysis();
  return buildOutfitPlan(makeAnalysis({ observed: { ...base.observed, clothing, accessories: "none" }, outfitPrompt: prompt,
    visibleRegions: { ...base.visibleRegions, upperBody: visible },
    fallbackFeatures: { ...base.fallbackFeatures, topType: "shirt", topAccentColor: "white" },
    renderHints: { ...base.renderHints, garmentTexture: "patterned", outerGarment: "none" } }));
}
it.each([
  [saved.observed.clothing, "#c5aa82"],
  ["Blue shirt with a plaid pattern in shades of blue, tan, and dark brown", "#c5aa82"],
  ["Green shirt with checks in green and cream", "#ded2b6"],
  ["Navy shirt with a plaid pattern in navy and beige", "#c5aa82"],
])("retains an explicit observed plaid palette: %s", (text, expected) => {
  expect(plan(text).upper.pattern.color).toBe(expected);
  expect(plan(text).upper.accentColor).toBe("#eeeae1");
});
it("retains both explicit checker squares instead of the historical single accent slot", () => {
  // Intentional representation change: direct checker lists now preserve the
  // entire ordered palette. True plaid/crossed-band cases above stay unchanged.
  const p = plan("Red shirt with a checkered pattern in red and yellow");
  expect(p.upper.pattern).toMatchObject({ kind: "checker_block", construction: "pixel_blocks",
    color: "#b53a35", blockColors: ["#b53a35", "#d5af3f"] });
  expect(p.upper.accentColor).toBe("#eeeae1");
});
it.each([
  "Blue shirt with possibly a plaid pattern in blue and tan",
  "Blue shirt without a checkered pattern in blue and tan",
  "Blue shirt with a hidden plaid pattern in blue and tan",
  "Blue shirt and pants with a plaid pattern in tan and brown",
  "Blue shirt over a blouse with a plaid pattern in tan and brown",
  "Blue shirt with a plaid pattern and tan pants",
  "Blue shirt with an unspecified pattern in blue and tan",
])("does not recover unsupported or other-garment palette: %s", text => {
  expect(plan(text).upper.pattern.color).toBe("#eeeae1");
});
it("does not promote hidden or inferred-only palette evidence", () => {
  expect(plan(saved.observed.clothing, false).upper.pattern.color).toBe("#eeeae1");
  expect(plan("Blue shirt", true, saved.observed.clothing).upper.pattern.color).toBe("#eeeae1");
});

it("retains frozen twelve and isolates the historical single-band palette replay", async () => {
  const beforeRoot = "evaluation-artifacts/close-cropped-evidence-20260927-k2LUlw";
  const baselineBytes = readFileSync(`${beforeRoot}/results.json`), liveBytes = readFileSync(livePath);
  const baseline = JSON.parse(baselineBytes.toString());
  // Independent measured-eye-axis repair has its own exact before/after test.
  const eyeAxisBaseline = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8"));
  // The separately recorded sclera-role repair deliberately changes RGB only
  // on planned sclera cells. Retain the earlier plan pin and prove that exact
  // bounded migration; never refresh a golden hash from today's rendering.
  const scleraRoot = "evaluation-artifacts/sclera-role-regression-20260927-GgHdQd";
  const scleraBytes = readFileSync(`${scleraRoot}/results.json`), scleraBaseline = JSON.parse(scleraBytes.toString());
  const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
  const fixtures: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const subjects = fixtures.map(fixture => {
    const { analysis } = strictBoundaryAnalysisFromAnnotation(fixture);
    if (fixture.existing) analysis.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(
      `evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
    return { id: fixture.id, calibrated: !!fixture.existing, analysis };
  });
  subjects.push({ id: "current-source-fixed-context", calibrated: false,
    analysis: makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing }) });
  const root = mkdtempSync("evaluation-artifacts/plaid-palette-evidence-20260927-");
  const cases = [];
  for (const subject of subjects) {
    const analysis = normalizeAnalysisForRendering(subject.analysis), currentPlan = buildSkinPlan(analysis);
    // This historical palette ablation predates the intentional foundation
    // material redesign. Reverse only that independently checked RGB-role
    // migration; keep every original golden and prove the current pixel delta.
    const materialPlan = historicalHairMaterialPlan(currentPlan);
    // The historical snapshot also predates the observed brown-belt repair.
    // Project only that reviewed material migration, keeping the old goldens.
    const afterPlan = historicalScarfBeltPlan(materialPlan);
    expect(afterPlan.outfitPlan).toEqual(historicalScarfBeltPlan(currentPlan).outfitPlan);
    const current = subject.id === "current-source-fixed-context";
    const laterCrossedBandColors = current ? afterPlan.outfitPlan.upper.pattern.crossedBandColors : undefined;
    if (current) {
      // The earlier saved experiment predates the independent two-color weave
      // grammar. Keep that historical ablation single-band; this is not a
      // claim that today's full production plan omits the observed brown band.
      // current009PatternPalette/plaidPatternRetention cover the newer field.
      expect(laterCrossedBandColors).toEqual(["#c5aa82", "#684b38"]);
      delete afterPlan.outfitPlan.upper.pattern.crossedBandColors;
      delete materialPlan.outfitPlan.upper.pattern.crossedBandColors;
      delete currentPlan.outfitPlan.upper.pattern.crossedBandColors;
    }
    const features = current ? live.features : refineFeatureColorsFromAnalysis(analysis,
      fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, afterPlan.hairPlan);
    const after = buildProceduralFallbackAtlas(features, style, afterPlan);
    expect(after, subject.id).not.toBeNull(); if (!after) throw new Error("atlas_rejected");
    const currentAtlas = buildProceduralFallbackAtlas(features, style, currentPlan);
    expect(currentAtlas, subject.id).not.toBeNull(); if (!currentAtlas) throw new Error("current_atlas_rejected");
    const materialAtlas = buildProceduralFallbackAtlas(features, style, materialPlan)!;
    expect(materialAtlas).toBeTruthy();
    const intentionalMaterialPixels = assertHairMaterialPixelBoundary(currentAtlas, materialAtlas, currentPlan);
    const intentionalAccessoryPixels = assertAccessoryPaletteBoundary(after, materialAtlas, currentPlan, style.skinTone!);
    expect(validateAtlasCraft(currentAtlas, style, currentPlan.facePixelPlan, currentPlan.hairPlan, currentPlan).ok, subject.id).toBe(true);
    expect(validateFinalAtlas(currentAtlas).ok, subject.id).toBe(true);
    const craft = validateAtlasCraft(after, style, afterPlan.facePixelPlan, afterPlan.hairPlan, afterPlan);
    expect(craft.ok, subject.id).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const previous = baseline.cases.find((row: { id: string }) => row.id === subject.id);
    const planHash = sha(JSON.stringify(afterPlan)), atlasHash = sha(after.rgba);
    const changed = [];
    const historicalScleraMigration: Array<{ x: number; y: number; before: number[]; after: number[] }> = [];
    if (!current) {
      const currentBaseline = eyeAxisBaseline.cases.find((row: { id: string }) => row.id === subject.id);
      const frozen = scleraBaseline.cases.find((row: { id: string }) => row.id === subject.id);
      expect(planHash, subject.id).toBe(currentBaseline.planHash);
      expect(frozen.planHash, subject.id).toBe(currentBaseline.planHash);
      const oldAtlas = await decodePng(readFileSync(`evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/${subject.id}.png`));
      const frozenAtlas = await decodePng(readFileSync(`${scleraRoot}/${subject.id}.png`));
      expect(sha(oldAtlas.rgba)).toBe(currentBaseline.atlasHash); expect(sha(frozenAtlas.rgba)).toBe(frozen.rgbaHash);
      const front = CLASSIC_LAYOUT.head.base.front;
      const scleraIndices = new Set(afterPlan.facePixelPlan.pixels.filter(p => p.role === "sclera")
        .map(p => (front.y + p.y) * 64 + front.x + p.x));
      const boundedMigration = [];
      for (let p = 0; p < 4096; p++) {
        expect(frozenAtlas.rgba[p * 4 + 3]).toBe(oldAtlas.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => oldAtlas.rgba[p * 4 + c] !== frozenAtlas.rgba[p * 4 + c])) {
          expect(scleraIndices.has(p), `${subject.id}: unauthorized baseline migration`).toBe(true);
          boundedMigration.push({ x: p % 64, y: Math.floor(p / 64),
            before: Array.from(oldAtlas.rgba.slice(p * 4, p * 4 + 4)), after: Array.from(frozenAtlas.rgba.slice(p * 4, p * 4 + 4)) });
        }
      }
      expect(boundedMigration).toEqual(frozen.changed);
      expect(after.rgba, subject.id).toEqual(frozenAtlas.rgba); expect(atlasHash, subject.id).toBe(frozen.rgbaHash);
    } else {
      expect(afterPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
      const withOldPalette = structuredClone(afterPlan);
      withOldPalette.outfitPlan.upper.pattern.color = previous.plan.outfitPlan.upper.pattern.color;
      // Compare on the artifact's JSON boundary (undefined is not persisted).
      expect(JSON.parse(JSON.stringify(withOldPalette))).toEqual(previous.plan);
      const historicalBefore = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
      expect(sha(historicalBefore.rgba)).toBe(previous.atlasHash);
      const before = buildProceduralFallbackAtlas(features, style, withOldPalette)!;
      expect(before).not.toBeNull();
      // Apply the same independently tested sclera migration to this older
      // partial-context sample. All non-sclera pixels must match its PNG;
      // the actual palette ablation below uses one identical renderer context.
      const front = CLASSIC_LAYOUT.head.base.front;
      const scleraIndices = new Set(afterPlan.facePixelPlan.pixels.filter(p => p.role === "sclera")
        .map(p => (front.y + p.y) * 64 + front.x + p.x));
      for (let p = 0; p < 4096; p++) {
        expect(before.rgba[p * 4 + 3]).toBe(historicalBefore.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => before.rgba[p * 4 + c] !== historicalBefore.rgba[p * 4 + c])) {
          expect(scleraIndices.has(p), `${subject.id}: non-sclera historical migration ${p % 64},${Math.floor(p / 64)}`).toBe(true);
          historicalScleraMigration.push({ x: p % 64, y: Math.floor(p / 64),
            before: Array.from(historicalBefore.rgba.slice(p * 4, p * 4 + 4)), after: Array.from(before.rgba.slice(p * 4, p * 4 + 4)) });
        }
      }
      expect(historicalScleraMigration.length).toBe(scleraIndices.size);
      for (let p = 0; p < 4096; p++) {
        expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
          // Only base torso / base right arm and base left arm UV regions.
          expect((x >= 16 && x < 56 && y >= 16 && y < 32)
            || (x >= 32 && x < 48 && y >= 48 && y < 64), `historical replay delta ${x},${y}`).toBe(true);
        }
      }
      expect(changed.length).toBeGreaterThan(0);
      for (const [name, atlas] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
      }
    }
    cases.push({ id: subject.id, calibrated: subject.calibrated, planHash, atlasHash, craft, changed,
      currentPlanHash: sha(JSON.stringify(currentPlan)), currentAtlasHash: sha(currentAtlas.rgba), intentionalMaterialPixels, intentionalAccessoryPixels,
      ...(current ? { scope: "historical_single_band_ablation", laterCrossedBandColorsExcluded: laterCrossedBandColors,
        historicalScleraMigration } : {}) });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, frozenAtlasBaseline: scleraRoot, cases,
    limitation: "Partial-context controlled replay; not a fresh live PNG or recovered complete provider analysis." }, null, 2), { flag: "wx" });
  expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(baselineBytes);
  expect(readFileSync(`${scleraRoot}/results.json`)).toEqual(scleraBytes);
  expect(readFileSync(livePath)).toEqual(liveBytes);
  console.info(`PLAID_PALETTE_ROOT ${root}`);
}, 30_000);
