// Authored semantic units: verify material direction, not a photo measurement.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { assertHairMaterialPixelBoundary, historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture(texture: "straight" | "wavy" | "curly" | "coily", length: "ear" | "jaw" | "chest") {
  const raw = makeAnalysis();
  const hair = `${length} length brown ${texture} hair with a center part and visible forehead opening`;
  raw.observed.hair = hair; raw.observed.accessories = "none";
  raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "hair" && f.category !== "accessory");
  raw.canonicalIdentity.features.push({ category: "hair", feature: hair, evidence: hair, priority: 5, confidence: "high", targetRegions: ["head.front", "head.back"] });
  Object.assign(raw.renderHints, { hairTexture: texture, overallHairLength: length, sideHairLength: length === "ear" ? "short" : length === "jaw" ? "jaw" : "shoulder",
    hairBackShape: length === "chest" ? "long" : "rounded", hairPart: "center", fringeOpening: "center", hairAccessory: "none", neckAccessory: "none" });
  Object.assign(raw.fallbackFeatures, { hairColor: "brown", hairstyle: length === "ear" ? "short" : "long", glasses: "none", hat: "none", earrings: false, facialHair: "none" });
  return normalizeAnalysisForRendering(raw);
}

it.each(["ear", "jaw", "chest"] as const)("straight %s foundation follows downward locks, not repeated horizontal material stripes", length => {
  const plan = buildSkinPlan(fixture("straight", length));
  expect(plan.hairPlan.structure.grammar).toBe("straight_bands");
  for (const face of ["left", "right", "back"] as const) {
    const group = plan.hairPlan.structure.groups.find(g => g.id === `foundation-${face}`)!;
    expect(group.direction).toBe("down");
    for (const x of new Set(group.points.map(p => p.x))) {
      const column = group.points.filter(p => p.x === x);
      if (column.length >= 3) expect(new Set(column.map(p => p.role)).size, `${face}:${x}`).toBe(1);
    }
    // Still shaded; replacing the bands with a single flat bucket is not a fix.
    expect(new Set(group.points.map(p => p.role)).size).toBeGreaterThan(1);
  }
});

it.each(["ear", "jaw", "chest"] as const)("wavy %s keeps a quiet foundation under independent curved texture groups", length => {
  const plan = buildSkinPlan(fixture("wavy", length));
  expect(plan.hairPlan.structure.grammar).toBe("wavy_bands");
  for (const group of plan.hairPlan.structure.groups.filter(g => g.kind === "foundation" && g.id !== "foundation-top")) {
    expect(group.direction).toBe("down");
    for (const p of group.points) expect(p.role, `${group.id}:${p.x},${p.y}`).toBe(p.x === 0 || p.x === 7 ? "shadow" : "mid");
  }
  const waves = plan.hairPlan.structure.groups.filter(g => g.id.startsWith("wavy_bands-") && g.kind === "strand_band");
  expect(waves.length).toBeGreaterThan(0);
  expect(waves.some(g => new Set(g.points.map(p => p.x)).size > 1)).toBe(true);
});

it.each(["curly", "coily"] as const)("does not reinterpret existing %s texture foundations", texture => {
  const plan = buildSkinPlan(fixture(texture, "chest"));
  for (const group of plan.hairPlan.structure.groups.filter(g => g.kind === "foundation"))
    for (const p of group.points) expect(p.role).toBe(p.y % 3 === 0 ? "mid" : "shadow");
});

it.each(["straight", "wavy"] as const)("%s historical comparison rejects invented roles and arbitrary RGB even inside a changed hair cell", texture => {
  const a = fixture(texture, "chest"), plan = buildSkinPlan(a);
  const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, colors, plan.hairPlan), baseline = buildProceduralSourceAtlas(colors, style, plan)!;
  const selected = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(a), style).selected!;
  expect(historicalHairMaterialReplay(colors, style, plan, selected.design, selected.composition).changedPixels.length).toBeGreaterThan(0);
  const brokenPlan = structuredClone(plan);
  brokenPlan.hairPlan.structure.groups.find(g => g.id === "foundation-back")!.points[0].role = "light";
  expect(() => historicalHairMaterialPlan(brokenPlan)).toThrow();
  for (const rect of [CLASSIC_LAYOUT.head.base.back, CLASSIC_LAYOUT.body.base.front]) {
    const bad = structuredClone(selected.composition), i = ((rect.y + 1) * 64 + rect.x + 1) * 4;
    bad.atlas.rgba.set([255, 0, 255], i);
    expect(() => historicalHairMaterialReplay(colors, style, plan, selected.design, bad)).toThrow();
  }
});

it("records actual source-owned material and complete selected PNG views with no provider stage", async () => {
  const root = mkdtempSync("evaluation-artifacts/hair-foundation-direction-20261008-");
  const cases = [];
  for (const texture of ["straight", "wavy"] as const) for (const length of ["ear", "jaw", "chest"] as const) {
    const a = fixture(texture, length), plan = buildSkinPlan(a);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, colors, plan.hairPlan), baseline = buildProceduralSourceAtlas(colors, style, plan)!;
    const selected = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(a), style).selected!;
    expect(selected, length).toBeTruthy(); expect(selected.foundation.ok).toBe(true);
    const atlas = selected.composition.atlas;
    const oldPlan = historicalHairMaterialPlan(plan);
    const oldBaseline = buildProceduralSourceAtlas(colors, style, oldPlan)!;
    const before = composeReferenceStyleAtlas(oldBaseline, oldPlan, selected.design, style);
    const changedPixels = assertHairMaterialPixelBoundary(atlas, before.atlas, plan);
    expect(changedPixels.length).toBeGreaterThan(0);
    expect(plan.hairPlan.structure.groups.filter(g => g.kind !== "foundation")).toEqual(oldPlan.hairPlan.structure.groups.filter(g => g.kind !== "foundation"));
    expect(plan.hairPlan.headMask).toEqual(oldPlan.hairPlan.headMask);
    expect(selected.composition.diagnostic.surfaces).toEqual(before.diagnostic.surfaces);
    const id = texture === "straight" ? length : `${texture}-${length}`;
    writeFileSync(`${root}/${id}.png`, await encodePng(atlas), { flag: "wx" });
    writeFileSync(`${root}/${id}-before.png`, await encodePng(before.atlas), { flag: "wx" });
    for (const [label, rendered] of [["after", atlas], ["before", before.atlas]] as const)
      for (const view of renderSkinViews(rendered)) writeFileSync(`${root}/${id}-${label}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    cases.push({ length, texture, changedPixels, sourcePlan: plan, selectedFamily: selected.design.hair.family, craft: selected.foundation.ok,
      beforeAtlasHash: createHash("sha256").update(before.atlas.rgba).digest("hex"),
      atlasHash: createHash("sha256").update(atlas.rgba).digest("hex") });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ provenance: "authored_semantic_units", providerCalls: 0, cases }, null, 2), { flag: "wx" });
  console.info("HAIR_FOUNDATION_DIRECTION", root);
}, 60000);
