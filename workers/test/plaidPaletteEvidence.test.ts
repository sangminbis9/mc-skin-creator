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
  ["Red shirt with a checkered pattern in red and yellow", "#d5af3f"],
  ["Green shirt with checks in green and cream", "#ded2b6"],
  ["Navy shirt with a plaid pattern in navy and beige", "#c5aa82"],
])("retains an explicit observed plaid palette: %s", (text, expected) => {
  expect(plan(text).upper.pattern.color).toBe(expected);
  expect(plan(text).upper.accentColor).toBe("#eeeae1");
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

it("retains frozen twelve and changes only pattern RGB in the fixed-context current replay", async () => {
  const beforeRoot = "evaluation-artifacts/close-cropped-evidence-20260927-k2LUlw";
  const baselineBytes = readFileSync(`${beforeRoot}/results.json`), liveBytes = readFileSync(livePath);
  const baseline = JSON.parse(baselineBytes.toString());
  // Independent measured-eye-axis repair has its own exact before/after test.
  const eyeAxisBaseline = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8"));
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
    const analysis = normalizeAnalysisForRendering(subject.analysis), afterPlan = buildSkinPlan(analysis);
    const current = subject.id === "current-source-fixed-context";
    const features = current ? live.features : refineFeatureColorsFromAnalysis(analysis,
      fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, afterPlan.hairPlan);
    const after = buildProceduralFallbackAtlas(features, style, afterPlan);
    expect(after, subject.id).not.toBeNull(); if (!after) throw new Error("atlas_rejected");
    const craft = validateAtlasCraft(after, style, afterPlan.facePixelPlan, afterPlan.hairPlan, afterPlan);
    expect(craft.ok, subject.id).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const previous = baseline.cases.find((row: { id: string }) => row.id === subject.id);
    const planHash = sha(JSON.stringify(afterPlan)), atlasHash = sha(after.rgba);
    const changed = [];
    if (!current) {
      const currentBaseline = eyeAxisBaseline.cases.find((row: { id: string }) => row.id === subject.id);
      expect(planHash, subject.id).toBe(currentBaseline.planHash); expect(atlasHash, subject.id).toBe(currentBaseline.atlasHash);
    } else {
      expect(afterPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
      const withOldPalette = structuredClone(afterPlan);
      withOldPalette.outfitPlan.upper.pattern.color = previous.plan.outfitPlan.upper.pattern.color;
      expect(withOldPalette).toEqual(previous.plan);
      const before = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
      for (let p = 0; p < 4096; p++) {
        expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
          // Only base torso / base right arm and base left arm UV regions.
          expect((x >= 16 && x < 56 && y >= 16 && y < 32)
            || (x >= 32 && x < 48 && y >= 48 && y < 64)).toBe(true);
        }
      }
      expect(changed.length).toBeGreaterThan(0);
      for (const [name, atlas] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
      }
    }
    cases.push({ id: subject.id, calibrated: subject.calibrated, planHash, atlasHash, craft, changed });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, cases,
    limitation: "Partial-context controlled replay; not a fresh live PNG or recovered complete provider analysis." }, null, 2), { flag: "wx" });
  expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(baselineBytes);
  expect(readFileSync(livePath)).toEqual(liveBytes);
  console.info(`PLAID_PALETTE_ROOT ${root}`);
}, 30_000);
