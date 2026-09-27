import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { parseIdentityGeometry } from "../src/identityGeometry";

const livePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json";
const liveBytes = readFileSync(livePath);
const live = JSON.parse(liveBytes.toString()).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const beforeRoot = "evaluation-artifacts/close-cropped-evidence-20260927-hiHPJ2";
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
function input(hair: string) {
  const base = makeAnalysis();
  return makeAnalysis({ observed: { ...base.observed, hair, accessories: "none" },
    renderHints: { ...saved.renderHints }, fallbackFeatures: { ...base.fallbackFeatures, hat: "none" } });
}
it.each([
  saved.observed.hair,
  "Closely cropped black hair.",
  "Close-cropped hair with no fringe.",
  "Very short cropped hair, without bangs or a parting.",
  "Buzz cut without any visible fringe or parting.",
  "Extremely short, closely-cropped hair with no visible parting.",
])("preserves affirmative scalp-close hair despite absent unrelated features: %s", hair => {
  const analysis = normalizeAnalysisForRendering(input(hair));
  expect(analysis.renderHints.overallHairLength).toBe("cropped");
  const plan = buildSkinPlan(analysis);
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  const style = buildFaceStyle(analysis, {}, plan.hairPlan);
  expect(style.hairstyle).toBe("buzz");
  expect(style.hairTexture).toBe(analysis.renderHints.hairTexture);
});
it.each([
  "Not closely cropped hair.", "No close-cropped hair is visible.",
  "Possibly closely cropped black hair.", "Maybe a buzz cut.",
  "Closely cropped hair is hidden by a hat.", "Close-cropped hair is occluded.",
  "Close-cropped hair is clipped out of frame.", "Hair is not visible, possibly close-cropped.",
  "Short coily hair without visible parting.", "No hair, only a buzz-cut-like shadow.",
  "Not without bangs, close-cropped hair.", "Closely cropped hair without visible hair detail.",
  "Closely cropped hair with no fringe or visible scalp.",
])("does not promote negative/uncertain/incomplete evidence: %s", hair => {
  expect(buildSkinPlan(input(hair)).hairPlan.surfaceOnly).toBeUndefined();
});
it.each(["measured", "hidden", "covering", "accessory", "volume", "length", "fringe", "sides"])("preserves %s protection", mode => {
  const analysis = input(saved.observed.hair);
  if (mode === "measured") analysis.identityGeometry = makeIdentityGeometry();
  if (mode === "hidden") analysis.visibleRegions.hair = false;
  if (mode === "covering") analysis.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") analysis.renderHints.hairAccessory = "bow";
  if (mode === "volume") analysis.renderHints.hairVolume = "full";
  if (mode === "length") analysis.renderHints.overallHairLength = "jaw";
  if (mode === "fringe") analysis.renderHints.bangs = "straight";
  if (mode === "sides") analysis.renderHints.sideHairLength = "short";
  expect(buildSkinPlan(analysis).hairPlan.surfaceOnly).toBeUndefined();
});

it("captures frozen twelve plus fixed-context current-source replay without network or overwrite", async () => {
  const fixtures: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const subjects = fixtures.map(fixture => {
    const { analysis } = strictBoundaryAnalysisFromAnnotation(fixture);
    if (fixture.existing) {
      const stored = JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8"));
      analysis.identityGeometry = parseIdentityGeometry(stored.sourceGeometryAfter)!;
    }
    return { id: fixture.id, calibrated: !!fixture.existing, analysis };
  });
  // Missing rich fields are helper defaults, not recovered provider evidence.
  subjects.push({ id: "current-source-fixed-context", calibrated: false,
    analysis: makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing }) });
  const root = mkdtempSync("evaluation-artifacts/close-cropped-evidence-20260927-");
  const baselineBytes = beforeRoot ? readFileSync(`${beforeRoot}/results.json`) : null;
  const baseline = baselineBytes ? JSON.parse(baselineBytes.toString()) : null;
  // Independent measured-eye-axis repair has its own exact before/after test.
  const eyeAxisBaseline = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8"));
  const cases = [];
  for (const subject of subjects) {
    const analysis = normalizeAnalysisForRendering(subject.analysis);
    const plan = buildSkinPlan(analysis);
    // Isolate the hair repair from subsequent, independently tested outfit palette recovery.
    if (subject.id === "current-source-fixed-context" && baseline)
      plan.outfitPlan.upper.pattern.color = baseline.cases.find((r: { id: string }) => r.id === subject.id).plan.outfitPlan.upper.pattern.color;
    const features = subject.id === "current-source-fixed-context" ? live.features : refineFeatureColorsFromAnalysis(analysis,
      fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, plan.hairPlan);
    const atlas = buildProceduralFallbackAtlas(features, style, plan);
    expect(atlas, subject.id).not.toBeNull();
    if (!atlas) throw new Error("candidate_rejected");
    const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(craft.ok, `${subject.id}: ${JSON.stringify(craft)}`).toBe(true);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const planHash = sha(JSON.stringify(plan)), atlasHash = sha(atlas.rgba);
    const changed = [];
    if (baseline) {
      const previous = baseline.cases.find((r: { id: string }) => r.id === subject.id);
      if (subject.id !== "current-source-fixed-context") {
        const currentBaseline = eyeAxisBaseline.cases.find((r: { id: string }) => r.id === subject.id);
        expect(planHash, subject.id).toBe(currentBaseline.planHash);
        expect(atlasHash, subject.id).toBe(currentBaseline.atlasHash);
      } else {
        expect(plan.facePixelPlan).toEqual(previous.plan.facePixelPlan);
        expect(plan.outfitPlan).toEqual(previous.plan.outfitPlan);
        const old = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
        for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => old.rgba[p * 4 + c] !== atlas.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y }); expect(y).toBeLessThan(16);
          // Protected base face features must not be repainted by a hair-only repair.
          expect(plan.facePixelPlan.pixels.some(cell => cell.cluster !== "fringe" && cell.x + 8 === x && cell.y + 8 === y)).toBe(false);
        }
        expect(plan.hairPlan.surfaceOnly).toBe(true);
        expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
        expect(changed.length).toBeGreaterThan(0);
      }
    }
    cases.push({ id: subject.id, calibrated: subject.calibrated, planHash, atlasHash, craft, changed,
      ...(subject.id === "current-source-fixed-context" ? { plan, features, style } : {}) });
    writeFileSync(`${root}/${subject.id}.png`, await encodePng(atlas), { flag: "wx" });
    if (subject.id === "current-source-fixed-context") {
      const view = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${root}/current-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot: beforeRoot ?? null, cases,
    limitation: "Current source is a partial-context hair-only replay with pattern color frozen to baseline, not a new production PNG or recovered full provider analysis." }, null, 2), { flag: "wx" });
  if (baselineBytes) expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(baselineBytes);
  expect(readFileSync(livePath)).toEqual(liveBytes);
  console.info(`CLOSE_CROP_ROOT ${root}`);
}, 30_000);
