import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-010";
const liveBytes = readFileSync(`${liveRoot}/summary.json`), livePng = readFileSync(`${liveRoot}/skin.png`);
const live = JSON.parse(liveBytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
function input(hair = primary.observed.hair) {
  const analysis = makeAnalysis({ ...structuredClone(primary), identityPrompt: hair, outfitPrompt: primary.observed.clothing, negativePrompt: "" });
  analysis.observed.hair = hair;
  return normalizeAnalysisForRendering(analysis);
}

it.each([
  primary.observed.hair,
  "Short shaved hair following the scalp.",
  "Very short, shaved hair with no visible fringe or parting.",
  "An extremely short-shaved head with no bangs.",
])("accepts corroborated scalp-close shaved hair: %s", hair => {
  const plan = buildSkinPlan(input(hair));
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.hairPlan.template).not.toBe("bald");
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  expect(plan.hairPlan.structure.groups.every(g => g.points.every(p => p.layer === "base"))).toBe(true);
  expect(plan.facePixelPlan).toEqual(live.analysis.skinPlan.facePixelPlan);
});
it.each([
  "Short hair and a shaved beard.", "Short, shaved beard, with coily hair above.",
  "Short shaved sides and long hair on top.", "Short shaved pattern in the eyebrows.",
  "Not short shaved hair.", "Possibly short shaved hair.", "Maybe short shaved hair.",
  "Short shaved hair hidden by a hat.", "Short shaved hair clipped out of frame.",
  "Short shaved hair with no visible crown.", "Bald head with no visible hair.",
])("does not infer scalp-close hair from uncertain or wrong-object evidence: %s", hair => {
  expect(buildSkinPlan(input(hair)).hairPlan.surfaceOnly).toBeUndefined();
});
it.each(["hidden", "bald", "headscarf", "accessory", "volume", "length", "fringe", "sides"])("keeps %s guard for shaved wording", mode => {
  const a = input();
  if (mode === "hidden") a.visibleRegions.hair = false;
  if (mode === "bald") a.fallbackFeatures.hairstyle = "bald";
  if (mode === "headscarf") a.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") a.renderHints.hairAccessory = "bow";
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "length") a.renderHints.overallHairLength = "jaw";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "sides") a.renderHints.sideHairLength = "short";
  expect(buildSkinPlan(a).hairPlan.surfaceOnly).toBeUndefined();
});

it("captures frozen twelve and live-010 fixed-context before/after without provider execution", async () => {
  const baselineRoot = process.env.SCALP_SHAVED_BASELINE_ROOT ?? "evaluation-artifacts/current-010-scalp-close-20260927-OlLX4m";
  const baseline = baselineRoot ? JSON.parse(readFileSync(`${baselineRoot}/results.json`, "utf8")) : null;
  const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const entries = annotations.map(fixture => {
    const { analysis: raw } = strictBoundaryAnalysisFromAnnotation(fixture);
    if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
    const analysis = normalizeAnalysisForRendering(raw);
    return { id: fixture.id, calibrated: !!fixture.existing, analysis,
      features: refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone)) };
  });
  entries.push({ id: "live-010-replay", calibrated: false, analysis: input(), features: live.features });
  const output = mkdtempSync("evaluation-artifacts/current-010-scalp-close-20260927-");
  const cases = [];
  for (const entry of entries) {
    const plan = buildSkinPlan(entry.analysis);
    if (entry.id === "live-010-replay") {
      // The allowlist omits inferred lower-body details. Isolate hair using the
      // actual returned outfit. The later paired-direction palette correction
      // is independently tested in current010PatternPalette, not a hair delta.
      expect(plan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
      const frozenUpper = structuredClone(plan.outfitPlan.upper);
      frozenUpper.pattern.color = live.analysis.skinPlan.outfitPlan.upper.pattern.color;
      // This is a hair-only historical counterfactual. The independently
      // tested button-shirt material fix adds exactly this collar property;
      // keep the actual historical outfit below instead of mixing deltas.
      expect(frozenUpper.collarColor).toBe(frozenUpper.baseColor);
      expect(live.analysis.skinPlan.outfitPlan.upper.collarColor).toBeUndefined();
      delete frozenUpper.collarColor;
      expect(frozenUpper).toEqual(live.analysis.skinPlan.outfitPlan.upper);
      plan.outfitPlan = structuredClone(live.analysis.skinPlan.outfitPlan);
    }
    const style = buildFaceStyle(entry.analysis, entry.features, plan.hairPlan);
    const atlas = buildProceduralFallbackAtlas(entry.features, style, plan);
    expect(atlas).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
    const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(craft.ok, `${entry.id}: ${craft.problems.join(";")}`).toBe(true);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const changed = [];
    if (baseline) {
      const prior = baseline.cases.find((c: { id: string }) => c.id === entry.id);
      const before = await decodePng(readFileSync(`${baselineRoot}/${entry.id}.png`));
      if (entry.id !== "live-010-replay") {
        expect(sha(JSON.stringify(plan)), entry.id).toBe(prior.planHash);
        expect(sha(atlas.rgba), entry.id).toBe(prior.rgbaHash);
      } else {
        expect(plan.hairPlan.surfaceOnly).toBe(true);
        expect(plan.facePixelPlan).toEqual(prior.plan.facePixelPlan);
        expect(plan.outfitPlan).toEqual(prior.plan.outfitPlan);
        expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
        for (const [x, y] of [[2, 5], [5, 5], [3, 7], [4, 7]]) {
          const at = ((8 + y) * 64 + 8 + x) * 4;
          expect(Array.from(atlas.rgba.slice(at, at + 4))).toEqual(Array.from(before.rgba.slice(at, at + 4)));
        }
        for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => atlas.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
          expect(y).toBeLessThan(16);
          const identityCell = plan.facePixelPlan.pixels.find(cell => cell.cluster !== "fringe" && cell.x + 8 === x && cell.y + 8 === y);
          expect(identityCell).toBeUndefined();
        }
        expect(changed.length).toBeGreaterThan(0);
      }
    } else if (entry.id === "live-010-replay") {
      expect(atlas.rgba).toEqual((await decodePng(livePng)).rgba);
      expect(plan.hairPlan.surfaceOnly).toBeUndefined();
    }
    writeFileSync(`${output}/${entry.id}.png`, await encodePng(atlas), { flag: "wx" });
    if (entry.id === "live-010-replay") for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "back"].includes(v.name))) {
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      if (view.name === "front") writeFileSync(`${output}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    cases.push({ id: entry.id, calibrated: entry.calibrated, planHash: sha(JSON.stringify(plan)), rgbaHash: sha(atlas.rgba),
      ...(entry.id === "live-010-replay" ? { plan } : {}), craft, changed });
  }
  writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, baselineRoot: baselineRoot ?? null, cases,
    liveSummarySha256: sha(liveBytes), livePngSha256: sha(livePng),
    limitation: "Same saved normalized allowlist and explicit helper context; counterfactual offline correction, not a new live PNG." }, null, 2), { flag: "wx" });
  expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(liveBytes);
  expect(readFileSync(`${liveRoot}/skin.png`)).toEqual(livePng);
  console.info(`SCALP_SHAVED_ARTIFACT ${output}`);
}, 60_000);
