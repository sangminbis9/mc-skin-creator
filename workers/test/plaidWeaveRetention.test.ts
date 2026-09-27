import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

const saved = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
let guard: ReturnType<typeof vi.spyOn>;
beforeAll(() => { guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterAll(() => { expect(guard).not.toHaveBeenCalled(); guard.mockRestore(); });

function analysisFor(clothing: string) {
  const base = makeAnalysis();
  return makeAnalysis({ observed: { ...base.observed, clothing, accessories: "none" }, outfitPrompt: clothing,
    fallbackFeatures: { ...base.fallbackFeatures, topType: "shirt", topColor: "blue", topAccentColor: "beige", sleeveLength: "long" },
    renderHints: { ...base.renderHints, outerGarment: "none", garmentTexture: "patterned" },
  });
}

it.each([
  ["Blue plaid shirt with tan stripes", "crossed_bands"],
  ["Navy and tan plaid collared shirt", "crossed_bands"],
  ["Blue checked shirt", undefined],
  ["Blue checkered shirt", undefined],
  ["Blue striped shirt with no plaid pattern", undefined],
  ["Striped shirt with plaid pants", undefined],
  ["Blue shirt over a plaid blouse", undefined],
] as const)("preserves only the observed owning plaid construction: %s", (text, expected) => {
  expect(buildOutfitPlan(analysisFor(text)).upper.pattern.construction).toBe(expected);
});

it("renders continuous bands and a crossing thread, not disconnected dots", () => {
  const plan = buildOutfitPlan(analysisFor("Blue plaid long-sleeve shirt with tan stripes"));
  const atlas = makeSyntheticAtlas();
  applyOutfitPlan(atlas, plan, "#633a23");
  for (const part of ["body", "leftArm", "rightArm"] as const) for (const face of ["front", "back", "left", "right"] as const) {
    const rect = CLASSIC_LAYOUT[part].base[face];
    const pixel = (x: number, y: number) => Array.from(atlas.rgba.slice(((rect.y + y) * 64 + rect.x + x) * 4, ((rect.y + y) * 64 + rect.x + x) * 4 + 3));
    const base = pixel(0, 4);
    for (let x = 0; x < rect.w; x++) expect(pixel(x, 5), `${part}.${face}:horizontal:${x}`).not.toEqual(base);
    for (const y of [3, 4, 6, 7]) expect(pixel(1, y), `${part}.${face}:vertical:${y}`).not.toEqual(pixel(0, y));
  }
});

it("keeps existing checked/striped/solid material rendering byte-identical", () => {
  for (const text of ["Blue checked shirt", "Blue striped shirt", "Solid blue shirt"]) {
    const plan = buildOutfitPlan(analysisFor(text));
    const legacy = structuredClone(plan);
    delete legacy.upper.pattern.construction;
    const current = makeSyntheticAtlas(), previous = makeSyntheticAtlas();
    applyOutfitPlan(current, plan, "#633a23"); applyOutfitPlan(previous, legacy, "#633a23");
    expect(current).toEqual(previous);
  }
});

it("retains the saved plaid construction in the final atlas with head and lower body unchanged", async () => {
  const base = makeAnalysis();
  const analysis = normalizeAnalysisForRendering(makeAnalysis({ observed: saved.observed, renderHints: saved.renderHints,
    fallbackFeatures: saved.fallbackFeatures, canonicalIdentity: saved.canonicalIdentity,
    identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing, inferred: base.inferred }));
  const afterPlan = buildSkinPlan(analysis), beforePlan = structuredClone(afterPlan);
  delete beforePlan.outfitPlan.upper.pattern.construction;
  expect(afterPlan.outfitPlan.upper.pattern.construction).toBe("crossed_bands");
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  const allowed = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
    .flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
    const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
    expect(allowed.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
    expect(before.rgba[p * 4 + 3]).toBe(after.rgba[p * 4 + 3]);
  }
  expect(changed.length).toBeGreaterThan(0);
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/plaid-weave-retention-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_pattern_construction_ablation_not_new_live", providerCalls: 0,
    observedPattern: "plaid", beforeConstruction: "disconnected_check_blocks", afterConstruction: "crossed_bands",
    changed, headPixelsChanged: 0, lowerPixelsChanged: 0, occupancyChanged: 0, craft: true, finalAtlas: true,
    limitations: "Coarse Minecraft grammar, not a measurement of exact source band width/frequency. Missing live analysis context is synthetic.",
  }, null, 2), { flag: "wx" });
});
