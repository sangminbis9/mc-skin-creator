import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const saved = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
let fetchGuard: ReturnType<typeof vi.spyOn>;
beforeAll(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterAll(() => { expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard.mockRestore(); });

function outfit(clothing: string) {
  const base = makeAnalysis();
  return buildOutfitPlan(makeAnalysis({
    observed: { ...base.observed, clothing, accessories: "none" }, outfitPrompt: clothing,
    fallbackFeatures: { ...base.fallbackFeatures, topType: "shirt", topColor: "blue" },
    renderHints: { ...base.renderHints, outerGarment: "none" },
  }));
}

it.each([
  ["Dark blue long-sleeve shirt", "#273954"],
  ["Dark-blue collared shirt", "#273954"],
  ["Navy shirt", "#273954"],
  ["Blue shirt", "#416b9d"],
  ["Light blue shirt", "#416b9d"],
  ["Dark green shirt", "#284c38"],
  ["Blue shirt with dark blue pants", "#416b9d"],
  ["Blue shirt over dark blue undershirt", "#416b9d"],
  ["White shirt and dark blue shoes", "#eeeae1"],
] as const)("retains garment-owned palette distinction: %s", (clothing, expected) => {
  const plan = outfit(clothing);
  expect(plan.upper.baseColor).toBe(expected);
  expect(plan.upper.leftSleeve.color).toBe(expected);
  expect(plan.upper.rightSleeve.color).toBe(expected);
});

it("retains the dark-blue cue in saved primary observation without changing its vocabulary", () => {
  expect(saved.observed.clothing).toContain("dark blue");
  expect(outfit(saved.observed.clothing).upper.baseColor).toBe("#273954");
});

it.each([
  ["Dark blue collared shirt", "#273954"],
  ["Blue shirt with a white collar", "#eeeae1"],
  ["White shirt with dark blue collar", "#273954"],
  ["Blue shirt with tan collar", "#c5aa82"],
  ["Blue shirt with contrasting collar", "#eeeae1"],
  ["Blue shirt with no white collar", "#416b9d"],
  ["Blue shirt with possibly white collar", "#416b9d"],
  ["Blue collared shirt over a white collared blouse", "#416b9d"],
  ["Blue collared shirt with white pants", "#416b9d"],
] as const)("uses garment-owned collar evidence: %s", (clothing, expected) => {
  const plan = outfit(clothing);
  expect(plan.upper.collarColor).toBe(expected);
  expect(plan.upper.accentColor).toBe("#eeeae1");
});

it("does not create paired-collar metadata for outerwear", () => {
  const base = makeAnalysis();
  const plan = buildOutfitPlan(makeAnalysis({
    observed: { ...base.observed, clothing: "Open black jacket over a white inner shirt" },
    renderHints: { ...base.renderHints, outerGarment: "open_jacket" },
  }));
  expect(plan.upper.collar).toBe("lapel");
  expect(plan.upper.collarColor).toBeUndefined();
});

it("does not mistake an inner-layer color for the collar, while preserving legacy plans", async () => {
  const base = makeAnalysis();
  const analysis = normalizeAnalysisForRendering(makeAnalysis({
    observed: saved.observed, renderHints: saved.renderHints, fallbackFeatures: saved.fallbackFeatures,
    canonicalIdentity: saved.canonicalIdentity, identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, inferred: base.inferred,
  }));
  const afterPlan = buildSkinPlan(analysis), beforePlan = structuredClone(afterPlan);
  delete beforePlan.outfitPlan.upper.collarColor;
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  beforePlan.outfitPlan.upper.collarColor = beforePlan.outfitPlan.upper.accentColor;
  expect(buildProceduralFallbackAtlas(features, style, beforePlan)).toEqual(before);
  const changed = [];
  const front = CLASSIC_LAYOUT.body.overlay.front;
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
    const x = p % 64, y = Math.floor(p / 64);
    changed.push({ x, y });
    const collarPixel = [[1, 0], [2, 0], [2, 1], [5, 0], [6, 0], [5, 1]].some(([cx, cy]) => x === front.x + cx && y === front.y + cy);
    // Existing outer UV seam repair propagates the collar top row into its
    // adjacent torso top edge. It must not affect any other surface.
    const adjacentTopSeam = y === front.y - 1 && [1, 2, 5, 6].some(cx => x === front.x + cx);
    expect(collarPixel || adjacentTopSeam, JSON.stringify({ x, y })).toBe(true);
    expect(before.rgba[p * 4 + 3]).toBe(after.rgba[p * 4 + 3]);
  }
  // Final overlay cleanup retains the two inner collar columns, plus their
  // top seams; the wider raw collar endpoints are removed in both atlases.
  expect(changed).toEqual([[-1, 2], [-1, 5], [0, 2], [0, 5], [1, 2], [1, 5]]
    .map(([cy, cx]) => ({ x: front.x + cx, y: front.y + cy })));
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/collar-material-retention-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_collar_color_ablation_not_new_live", providerCalls: 0,
    beforeCollar: beforePlan.outfitPlan.upper.accentColor, afterCollar: afterPlan.outfitPlan.upper.collarColor,
    basis: "continuation of existing shirt material without an observed contrasting collar",
    changed, occupancyChanged: 0, headPixelsChanged: 0, craft: true, finalAtlas: true,
  }, null, 2), { flag: "wx" });
});

it("changes only garment material pixels in the deterministic atlas", async () => {
  const base = makeAnalysis();
  // This is a controlled replay of the persisted projection with synthetic
  // missing context, not a reconstruction of an unrecorded live response.
  const analysis = normalizeAnalysisForRendering(makeAnalysis({
    observed: saved.observed, renderHints: saved.renderHints, fallbackFeatures: saved.fallbackFeatures,
    canonicalIdentity: saved.canonicalIdentity, identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, inferred: base.inferred,
  }));
  const afterPlan = buildSkinPlan(analysis), beforePlan = structuredClone(afterPlan);
  const upper = beforePlan.outfitPlan.upper;
  upper.baseColor = "#416b9d";
  upper.leftSleeve.color = "#416b9d"; upper.rightSleeve.color = "#416b9d";
  upper.colorBlocks.find(b => b.id === "upper_base")!.color = "#416b9d";
  expect(afterPlan.outfitPlan.upper.baseColor).toBe("#273954");
  expect(afterPlan.facePixelPlan).toEqual(beforePlan.facePixelPlan);
  expect(afterPlan.hairPlan).toEqual(beforePlan.hairPlan);
  expect(afterPlan.headIdentityPlan).toEqual(beforePlan.headIdentityPlan);
  expect(afterPlan.outfitPlan.lower).toEqual(beforePlan.outfitPlan.lower);
  expect(afterPlan.outfitPlan.upper.pattern).toEqual(beforePlan.outfitPlan.upper.pattern);
  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, "warm"), skinTone: "#633a23" };
  const style = buildFaceStyle(analysis, features);
  const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
  const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  const allowed = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
    .flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
  const changed: { x: number; y: number }[] = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
    const x = p % 64, y = Math.floor(p / 64);
    changed.push({ x, y });
    expect(allowed.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
  }
  expect(changed.length).toBeGreaterThan(0);
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, afterPlan).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/garment-dark-blue-retention-20260926-");
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_material_color_ablation_not_new_live", providerCalls: 0,
    beforeBase: upper.baseColor, afterBase: afterPlan.outfitPlan.upper.baseColor,
    paletteBasis: "existing navy Minecraft palette; qualitative dark-blue retention, not exact photo RGB",
    beforeAtlasRgbaHash: createHash("sha256").update(before.rgba).digest("hex"),
    afterAtlasRgbaHash: createHash("sha256").update(after.rgba).digest("hex"),
    changed, headPixelsChanged: 0, lowerPixelsChanged: 0, craft: true, finalAtlas: true,
  }, null, 2), { flag: "wx" });
});
