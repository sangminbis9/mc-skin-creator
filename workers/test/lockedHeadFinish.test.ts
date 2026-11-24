import { expect, it } from "vitest";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { applyLockedHeadFinish, lockedHairLight } from "../src/lockedHeadFinish";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { encodePng } from "../src/png";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { repairSkinIntegrity } from "../../shared/skinIntegrity";
import { makeAnalysis } from "./helpers";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const offset = (r: Rect, p: { x: number; y: number }) => ((r.y + p.y) * 64 + r.x + p.x) * 4;
const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
const choices = ["source", "feminine", "masculine"] as const;

function context(withGlasses = false) {
  const raw = makeAnalysis();
  if (!withGlasses) {
    raw.fallbackFeatures.glasses = "none";
    raw.observed.accessories = "none";
    raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "accessory");
    raw.canonicalIdentity.mustPreserve = raw.canonicalIdentity.mustPreserve.filter(f => !f.includes("glasses"));
  }
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone);
  const style = buildFaceStyle(analysis, features, source.hairPlan);
  const base = buildProceduralSourceAtlas(features, style, source)!;
  expect(base).not.toBeNull();
  return { analysis, source, style, base };
}

it.each([false, true])("keeps exact eye pixels and hair alpha across all preferences (eyewear=%s)", async withGlasses => {
  const { analysis, source, style, base } = context(withGlasses);
  const original = renderReferencePrimaryAtlas(base, source, analysis, style, 5);
  if (!original.ok || !original.craftPlan) throw new Error("expected a validated pre-finish atlas");
  const execution = original.craftPlan.execution;
  const previous = repairSkinIntegrity(original.atlas, base).atlas;
  const planBefore = structuredClone(source);
  const eyeCells = [...source.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "glasses"].includes(p.cluster)),
    ...execution.faceFinish.eyeAccentCells, ...execution.faceFinish.eyePresentation.cells];
  const eyeChecks = [...eyeCells, ...(execution.headProportion?.eyePixels ?? []), ...eyeCells.filter(p => p.y < 7 && execution.faceFinish.eyeRowOffset > 0 && (!("role" in p) || p.role !== "brow"))
    .map(p => ({ ...p, y: p.y + execution.faceFinish.eyeRowOffset }))];
  const hairChecks = [...execution.surfaces.filter(p => p.owner === "hair").map(p => offset(CLASSIC_LAYOUT[p.part][p.layer][p.face], p)),
    ...(execution.headProportion?.paints ?? []).filter(p => p.role === "hair").map(p => offset(CLASSIC_LAYOUT.head[p.layer ?? "base"][p.face], p))];
  const hairMask = new Set(hairChecks);
  const results = choices.map(p => applyLockedHeadFinish(previous, source, style, p, execution));
  for (const atlas of results) {
    for (const point of eyeChecks) for (const r of [front, outer]) {
      const i = offset(r, point);
      expect(atlas.rgba.slice(i, i + 4), `${r === front ? "base" : "overlay"} eye (${point.x}, ${point.y})`).toEqual(previous.rgba.slice(i, i + 4));
    }
    for (const i of hairMask) expect(atlas.rgba[i + 3]).toBe(previous.rgba[i + 3]);
    expect([...hairMask].filter(i => atlas.rgba[i] !== previous.rgba[i]).length).toBeGreaterThan(10);
    for (let i = 16 * 64 * 4; i < previous.rgba.length; i++) {
      if (!hairMask.has(i - i % 4)) expect(atlas.rgba[i]).toBe(previous.rgba[i]);
    }
  }
  expect(source).toEqual(planBefore);
  const artifactDir = process.env.SKIN_LOCK_ARTIFACT_DIR;
  if (artifactDir && !withGlasses) {
    const images = [previous, ...results]
      .map(a => renderSkinViews(a).find(v => v.name === "front")!.image);
    const { width, height } = images[0], w = width * images.length;
    const comparison = { width: w, height, rgba: new Uint8Array(w * height * 4) };
    images.forEach((a, col) => { for (let y = 0; y < height; y++) {
      comparison.rgba.set(a.rgba.subarray(y * width * 4, (y + 1) * width * 4), (y * w + col * width) * 4);
    }});
    await writeFile(join(artifactDir, "locked-head-comparison.png"), await encodePng(scaleNearestNeighbor(comparison, w * 4, height * 4)));
  }
}, 30_000);

it("removes nose, lip and tooth paint from both layers even when the legacy branch is preserved", () => {
  const { source, style, base } = context();
  // A representative painted centre and brow; avoid relying on an exact
  // custom provider's mouth measurements for this safety boundary test.
  source.facePixelPlan.pixels.push({ x: 3, y: 6, role: "teeth", cluster: "mouth" }, { x: 4, y: 5, role: "nose_tip", cluster: "nose" });
  const points = [{ x: 3, y: 6 }, { x: 4, y: 5 }];
  for (const p of points) for (const r of [front, outer]) base.rgba.set([250, 5, 7, 255], offset(r, p));
  for (const presentation of choices) {
    const output = applyLockedHeadFinish(base, source, style, presentation);
    for (const p of points) {
      expect(output.rgba.slice(offset(front, p), offset(front, p) + 4)).not.toEqual(Uint8Array.of(250, 5, 7, 255));
      expect(output.rgba.slice(offset(outer, p), offset(outer, p) + 4)).toEqual(Uint8Array.of(0, 0, 0, 0));
    }
  }
});

it("shades exact shared head seams continuously in part, fringe and wave patterns", () => {
  const { style } = context();
  const cases = [
    { ...style, hairPart: "right", bangs: "side", hairTexture: "straight" },
    { ...style, hairPart: "none", bangs: "wispy", hairTexture: "straight" },
    { ...style, hairPart: "left", bangs: "none", hairTexture: "wavy" },
  ] as const;
  const frontPatterns = cases.map(s => Array.from({ length: 48 }, (_, i) =>
    lockedHairLight({ face: "front", x: i % 8, y: Math.floor(i / 8), raised: true }, s)));
  expect(new Set(frontPatterns.map(p => JSON.stringify(p))).size).toBe(cases.length);
  for (const s of cases) {
    for (let i = 0; i < 8; i++) {
      const l = (face: keyof typeof CLASSIC_LAYOUT.head.base, x: number, y: number) =>
        lockedHairLight({ face, x, y, raised: true }, s);
      expect(l("front", i, 0)).toBe(l("top", i, 7));
      expect(l("front", 0, i)).toBe(l("right", 7, i));
      expect(l("front", 7, i)).toBe(l("left", 0, i));
      expect(l("left", 7, i)).toBe(l("back", 0, i));
      expect(l("right", 0, i)).toBe(l("back", 7, i));
    }
  }
});

it("keeps a scoped silver stud and muted olive instead of unrelated accessory or generic green colors", () => {
  const raw = makeAnalysis();
  raw.observed.accessories = "single, silver, earring, viewer-left; gold necklace";
  raw.observed.clothing = "An olive green zip-up hoodie over a plain white crewneck shirt.";
  raw.fallbackFeatures.earrings = true;
  raw.fallbackFeatures.topType = "hoodie";
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, buildSkinPlan(analysis).hairPlan);
  expect(style.earringColor).toBe("#c7cbd2");
  expect(style.earringSide).toBe("viewer_left");
  expect(features.topColor).toBe("#667047");
});

it("uses the visible zip hoodie, not its inner tee, for sleeves unless the photo explicitly describes a short hoodie", () => {
  const raw = makeAnalysis();
  raw.visibleRegions.upperBody = true;
  Object.assign(raw.fallbackFeatures, { topType: "hoodie", sleeveLength: "short" });
  raw.observed.clothing = "Dark green zip-up hoodie with a visible silver zipper, worn over a white crewneck undershirt.";
  const inferred = buildOutfitPlan(raw).upper;
  expect([inferred.leftSleeve.length, inferred.rightSleeve.length]).toEqual(["long", "long"]);
  expect(inferred.leftSleeve.source).toBe("strongly_implied");
  raw.observed.clothing = "Dark green short-sleeved zip-up hoodie worn over a white crewneck undershirt.";
  const observed = buildOutfitPlan(raw).upper;
  expect([observed.leftSleeve.length, observed.rightSleeve.length]).toEqual(["short", "short"]);
});
