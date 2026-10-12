import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, fallbackFeaturesToHex, normalizeAnalysisForRendering, buildProceduralFallbackAtlas } from "../src/generate";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews } from "../src/skinRender";

const saved = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
function plan(clothing: string) {
  const base = makeAnalysis();
  return buildOutfitPlan(makeAnalysis({
    observed: { ...base.observed, clothing, accessories: "none" }, outfitPrompt: clothing,
    renderHints: { ...base.renderHints, garmentTexture: "patterned", outerGarment: "none" },
    fallbackFeatures: { ...base.fallbackFeatures, topType: "shirt" },
  }));
}
it("does not flatten the saved plaid with crossing colored stripes into a single-axis stripe", () => {
  expect(plan(saved.observed.clothing).upper.pattern.kind).toBe("checker_block");
});

it("preserves the two-axis pattern in the rendered atlas without touching the head", async () => {
  const base = makeAnalysis();
  const analysis = normalizeAnalysisForRendering(makeAnalysis({ observed: saved.observed, renderHints: saved.renderHints,
    canonicalIdentity: saved.canonicalIdentity, fallbackFeatures: saved.fallbackFeatures,
    identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing, inferred: base.inferred }));
  const afterPlan = buildSkinPlan(analysis);
  // Isolate the pattern grammar independently of the subsequent color recovery.
  afterPlan.outfitPlan.upper.pattern.color = afterPlan.outfitPlan.upper.accentColor;
  const beforePlan = structuredClone(afterPlan);
  beforePlan.outfitPlan.upper.pattern = { ...beforePlan.outfitPlan.upper.pattern, kind: "horizontal_stripe", frequency: 3 };
  beforePlan.outfitPlan.upper.colorBlocks.push({ id: "stripe_band", region: "horizontal_band", color: beforePlan.outfitPlan.upper.accentColor, source: "observed", priority: 0.88 });
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(p => p.y >= 16)).toBe(true);
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/plaid-retention-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_pattern_ablation_not_new_live", providerCalls: 0,
    beforePattern: beforePlan.outfitPlan.upper.pattern.kind, afterPattern: afterPlan.outfitPlan.upper.pattern.kind,
    changed, headPixelsChanged: 0, craft: true, finalAtlas: true,
    patternColorFrozenForIsolation: afterPlan.outfitPlan.upper.pattern.color,
  }, null, 2), { flag: "wx" });
});

it.each([
  [saved.observed.clothing, "#c5aa82"],
  ["Blue shirt with yellow horizontal stripes", "#d5af3f"],
  ["Blue shirt with tan lines", "#c5aa82"],
  ["Blue shirt with no tan stripes", "#eeeae1"],
  ["Blue shirt with possibly tan stripes", "#eeeae1"],
  ["Blue shirt with plain pants and tan striped shoes", "#eeeae1"],
  ["Blue shirt with pants with tan stripes", "#eeeae1"],
  ["Blue shirt over a tan striped undershirt", "#eeeae1"],
] as const)("binds observed pattern color only to the owning upper garment: %s", (clothing, expected) => {
  const outfit = plan(clothing);
  expect(outfit.upper.pattern.color).toBe(expected);
  expect(outfit.upper.accentColor).toBe("#eeeae1");
});

it("does not source pattern colors from inferred prompts or hidden clothing", () => {
  const base = makeAnalysis();
  for (const visible of [true, false]) {
    const analysis = makeAnalysis({ ...base,
      observed: { ...base.observed, clothing: visible ? "Blue shirt" : "Blue shirt with tan stripes" },
      visibleRegions: { ...base.visibleRegions, upperBody: visible },
      outfitPrompt: "Blue shirt with tan stripes",
      fallbackFeatures: { ...base.fallbackFeatures, topAccentColor: "white" },
    });
    expect(buildOutfitPlan(analysis).upper.pattern.color).toBe("#eeeae1");
  }
});

it.each([
  ["Dark blue shirt with dark blue, tan, and thin yellow stripes/plaid", "Dark blue shirt with stripes in dark blue, tan and yellow", "#c5aa82"],
  ["Red shirt with red, cream and thin blue stripes", "Red shirt with stripes in red, cream and blue", "#ded2b6"],
  ["Green shirt with green and white checks", "Green shirt with checks in green and white", "#eeeae1"],
  ["Navy shirt with navy, tan and yellow bands", "Navy shirt with bands in navy, tan and yellow", "#c5aa82"],
] as const)("retains coordinated palette precedence in %s", (beforeNoun, afterNoun, expected) => {
  expect(plan(beforeNoun).upper.pattern.color).toBe(expected);
  expect(plan(beforeNoun).upper.pattern.color).toBe(plan(afterNoun).upper.pattern.color);
});

it.each([
  "Blue shirt with no blue, tan and yellow stripes",
  "Blue shirt with possibly blue, tan and yellow stripes",
  "Blue shirt over a blue, tan and yellow striped undershirt",
  "Blue shirt with pants with blue, tan and yellow stripes",
  "Blue shirt with tan buttons and yellow stripes",
] as const)("does not merge an uncertain, foreign or interrupted color list: %s", clothing => {
  expect(plan(clothing).upper.pattern.color).toBe(clothing.includes("buttons") ? "#d5af3f" : "#eeeae1");
});

it("preserves coordinated color precedence instead of choosing the last color nearest stripes", () => {
  expect(plan("A collared button-up shirt with a plaid pattern featuring dark blue, brown, and tan stripes").upper.pattern.color).toBe("#684b38");
});

it.each([
  ["A long-sleeved button-up shirt with a plaid pattern consisting of navy blue, tan, and dark blue horizontal and vertical stripes.", "#c5aa82"],
  ["Navy blue shirt with navy blue, tan and dark blue vertical and horizontal stripes", "#c5aa82"],
  ["Navy-blue shirt with navy-blue, tan and dark-blue horizontal & vertical bands", "#c5aa82"],
  ["Red shirt with red, cream and blue horizontal and vertical checks", "#ded2b6"],
  ["Green shirt with green and yellow vertical and horizontal lines", "#d5af3f"],
  ["Blue shirt with tan horizontal and vertical stripes", "#c5aa82"],
] as const)("retains a palette across paired pattern directions: %s", (text, expected) => {
  expect(plan(text).upper.pattern.color).toBe(expected);
});
it.each([
  "Navy blue shirt with no navy blue, tan and dark blue horizontal and vertical stripes",
  "Navy blue shirt with possibly navy blue, tan and dark blue horizontal and vertical stripes",
  "Navy blue shirt over pants with navy blue, tan and dark blue horizontal and vertical stripes",
  "Navy blue shirt over a blouse with navy blue, tan and dark blue horizontal and vertical stripes",
  "Navy blue shirt with tan buttons and horizontal and vertical seams",
  "Navy blue shirt with tan horizontal buttons and vertical stripes",
])("does not bridge uncertain or foreign palette evidence across paired directions: %s", text => {
  expect(plan(text).upper.pattern.color).toBe("#eeeae1");
});

it("carries observed tan pattern pixels into the atlas without changing head or other plan fields", async () => {
  const base = makeAnalysis();
  const analysis = normalizeAnalysisForRendering(makeAnalysis({ observed: saved.observed, renderHints: saved.renderHints,
    canonicalIdentity: saved.canonicalIdentity, fallbackFeatures: saved.fallbackFeatures,
    identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing, inferred: base.inferred }));
  const afterPlan = buildSkinPlan(analysis), beforePlan = structuredClone(afterPlan);
  beforePlan.outfitPlan.upper.pattern.color = beforePlan.outfitPlan.upper.accentColor;
  expect(afterPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(p => p.y >= 16)).toBe(true);
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/pattern-color-retention-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_pattern_color_ablation_not_new_live", providerCalls: 0,
    beforeColor: beforePlan.outfitPlan.upper.pattern.color, afterColor: afterPlan.outfitPlan.upper.pattern.color,
    colorProvenance: "observed garment-owned tan stripes mapped to existing beige palette; not photo-sampled RGB",
    changed, headPixelsChanged: 0, craft: true, finalAtlas: true,
  }, null, 2), { flag: "wx" });
});

it.each([
  [saved.observed.clothing, false],
  ["Long-sleeved blue collared shirt", false],
  ["Blue shirt over a white t-shirt", true],
  ["Blue shirt with a visible white undershirt", true],
  ["Blue shirt with no undershirt", false],
  ["Blue shirt over dark pants", false],
] as const)("does not invent an inner garment from the collar: %s", (clothing, expected) => {
  const outfit = plan(clothing);
  expect(outfit.upper.neckline.innerVisible).toBe(expected);
  expect(outfit.upper.colorBlocks.some(b => b.id === "inner_panel")).toBe(expected);
});

it("removes the unsupported full-height inner panel without changing the head or sleeves", async () => {
  const base = makeAnalysis();
  const analysis = normalizeAnalysisForRendering(makeAnalysis({ observed: saved.observed, renderHints: saved.renderHints,
    canonicalIdentity: saved.canonicalIdentity, fallbackFeatures: saved.fallbackFeatures,
    identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing, inferred: base.inferred }));
  const afterPlan = buildSkinPlan(analysis), beforePlan = structuredClone(afterPlan);
  beforePlan.outfitPlan.upper.neckline.innerVisible = true;
  beforePlan.outfitPlan.upper.colorBlocks.push({ id: "inner_panel", region: "front_center", color: beforePlan.outfitPlan.upper.accentColor, source: "observed", priority: 0.95 });
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  // Existing seam continuity copies the neckline to the adjacent torso top
  // edge; no head, arm, leg or unrelated outer pixels may change.
  expect(changed.filter(p => !((p.y >= 20 && p.y < 32 && p.x >= 20 && p.x < 28) ||
    (p.y === 19 && p.x >= 21 && p.x <= 25)))).toEqual([]);
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/collar-inner-evidence-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_inner_layer_ablation_not_new_live", providerCalls: 0,
    beforeInnerVisible: true, afterInnerVisible: afterPlan.outfitPlan.upper.neckline.innerVisible,
    changed, headPixelsChanged: 0, changedOnlyTorsoFrontAndAdjacentTopSeam: true, craft: true, finalAtlas: true,
  }, null, 2), { flag: "wx" });
});
it.each([
  ["Checked shirt formed by blue and tan stripes", "checker_block"],
  ["Horizontal striped shirt with no plaid pattern", "horizontal_stripe"],
  ["Vertical striped shirt", "vertical_stripe"],
  ["Striped shirt with plaid pants", "horizontal_stripe"],
  ["Plaid shirt with vertically striped pants", "checker_block"],
] as const)("preserves garment-owned pattern in %s", (clothing, expected) => {
  expect(plan(clothing).upper.pattern.kind).toBe(expected);
});
