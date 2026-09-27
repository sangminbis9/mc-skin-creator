import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observedFacialHairCategory } from "../src/facialHairEvidence";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex,
  normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { makeAnalysis } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const evidence = "Groomed dark mustache and goatee, oval face.";
const canonical = ["Groomed goatee and mustache"];
let root: string;
const results: Record<string, unknown> = { providerCalls: 0, evidenceMode: "offline_controlled_replay_not_new_provider_output" };
let fetchGuard: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  root = mkdtempSync("evaluation-artifacts/facial-hair-category-fix-20260926-");
  console.log(`FRESH_OFFLINE_ARTIFACT_ROOT=${root}`);
});
afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard.mockRestore();
  writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2), { flag: "wx" });
});

it.each(["goatee", "beard", "mustache", "stubble"])("recovers corroborated %s without changing explicit categories", category => {
  for (const cache of [undefined, "none"]) expect(observedFacialHairCategory(cache, `Visible ${category}`, [`Visible ${category}`], true)).toBe(category);
  expect(observedFacialHairCategory(category, evidence, canonical, true)).toBeUndefined();
});
it.each([
  ["Clean-shaven face, no goatee", canonical],
  ["No beard or mustache", ["beard"]],
  ["Possibly a goatee", canonical],
  ["Goatee-like shadow", canonical],
  ["Goatee hidden by a mask", canonical],
  ["Add a goatee", canonical],
  ["Facial hair", ["Facial hair"]],
  [evidence, ["No goatee"]],
  [evidence, ["Goatee", "Clean-shaven face"]],
  [evidence, ["Full beard"]],
  [evidence, []],
  ["No visible facial hair", []],
] as const)("does not fabricate a category from qualified/conflicting evidence: %s", (face, preserve) => {
  expect(observedFacialHairCategory("none", face, preserve, true)).toBeUndefined();
});
it("does not fix invalid cache tokens, hidden faces or unrelated positive text", () => {
  expect(observedFacialHairCategory("invalid", evidence, canonical, true)).toBeUndefined();
  expect(observedFacialHairCategory("none", evidence, canonical, false)).toBeUndefined();
  expect(observedFacialHairCategory("none", "Neutral face", ["Beard-shaped shirt logo"], true)).toBeUndefined();
});

function render(analysis: PhotoAnalysis) {
  const normalized = normalizeAnalysisForRendering(analysis);
  const plan = buildSkinPlan(normalized);
  const features = refineFeatureColorsFromAnalysis(normalized,
    fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  const style = buildFaceStyle(normalized, features);
  const atlas = buildProceduralFallbackAtlas(features, style, plan);
  if (!atlas) throw new Error("offline_atlas_rejected");
  return { plan, style, features, atlas, craft: validateAtlasCraft(atlas, style, undefined, undefined, plan) };
}

it.each(["#eec2a4", "#b57e5b", "#57392b"])("retains a visible chin category on %s without moving landmarks", async skinTone => {
  const base = makeAnalysis();
  const source = makeAnalysis({
    observed: { ...base.observed, face: evidence, accessories: "none" },
    canonicalIdentity: { ...base.canonicalIdentity, mustPreserve: [...canonical, "Short black hair", "Collared shirt"] },
    fallbackFeatures: { ...base.fallbackFeatures, skinTone, facialHair: "none", glasses: "none", expression: "neutral" },
    renderHints: { ...base.renderHints, mouthOpening: "closed", mouthShape: "small" },
  });
  const normalized = normalizeCompactPhotoAnalysisV3(wireFixture(source), { imageCount: 1 });
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error("normalization_failed");
  const after = render(normalized.analysis);
  const before = render({ ...normalized.analysis, fallbackFeatures: { ...normalized.analysis.fallbackFeatures, facialHair: "none" } });
  const front = CLASSIC_LAYOUT.head.base.front;
  const rgbaAt = (replay: ReturnType<typeof render>, x: number, y: number) => Array.from(replay.atlas.rgba.slice(((front.y + y) * 64 + front.x + x) * 4, ((front.y + y) * 64 + front.x + x) * 4 + 4));
  const landmarks = after.plan.facePixelPlan.pixels.filter(p => /eye|brow|mouth/.test(p.cluster));
  expect(landmarks).toEqual(before.plan.facePixelPlan.pixels.filter(p => /eye|brow|mouth/.test(p.cluster)));
  for (const pixel of landmarks) expect(rgbaAt(after, pixel.x, pixel.y)).toEqual(rgbaAt(before, pixel.x, pixel.y));
  for (const x of [3, 4]) expect(rgbaAt(after, x, 7)).not.toEqual(rgbaAt(before, x, 7));
  expect(after.craft.ok).toBe(true);
  expect(validateFinalAtlas(after.atlas).ok).toBe(true);
  for (const [name, replay] of [["before", before], ["after", after]] as const) {
    const view = renderSkinViews(replay.atlas).find(v => v.name === "front")!;
    const head = extractRenderedHeadView(view);
    writeFileSync(path.join(root, `${skinTone.slice(1)}-${name}-head.png`), await encodePng(scaleNearestNeighbor(head, 192, 192)), { flag: "wx" });
  }
  const rows = (results.complexions ??= []) as unknown[];
  rows.push({ skinTone, chinPixelsChanged: 2, identityLandmarkPixelsChanged: 0, craft: true, finalAtlas: true });
});

it.each(["none", "goatee", "beard", "mustache", "stubble"] as const)("keeps explicit existing %s render behavior idempotent", category => {
  const base = makeAnalysis();
  const face = category === "none" ? "Clean-shaven face" : `Visible ${category}`;
  const input = makeAnalysis({
    observed: { ...base.observed, face },
    canonicalIdentity: { ...base.canonicalIdentity, mustPreserve: [face, "Short black hair", "Collared shirt"] },
    fallbackFeatures: { ...base.fallbackFeatures, facialHair: category },
  });
  const first = normalizeCompactPhotoAnalysisV3(wireFixture(input), { imageCount: 1 });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first_normalization_failed");
  // Rich output includes portraitRegion; it is not a provider wire response.
  const second = validatePhotoAnalysis(first.analysis);
  expect(second.ok, second.ok ? "" : JSON.stringify(second)).toBe(true);
  if (!second.ok) throw new Error("second_normalization_failed");
  expect(first.analysis.fallbackFeatures.facialHair).toBe(category);
  expect(second.analysis).toEqual(first.analysis);
  expect(render(second.analysis).atlas).toEqual(render(first.analysis).atlas);
});

it("traces the repaired category through plans and the actual deterministic renderer", async () => {
  const base = makeAnalysis();
  const source = makeAnalysis({
    observed: { ...base.observed, face: evidence, accessories: "none" },
    canonicalIdentity: { ...base.canonicalIdentity, mustPreserve: [...canonical, "Short black hair", "Collared shirt"] },
    fallbackFeatures: { ...base.fallbackFeatures, facialHair: "none", glasses: "none" },
  });
  const restored = normalizeCompactPhotoAnalysisV3(wireFixture(source), { imageCount: 1 });
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error("normalization_failed");
  expect(validatePhotoAnalysis(restored.analysis).ok).toBe(true);
  // Isolate only the category: no unrelated normalization differences in this controlled replay.
  const beforeInput = { ...restored.analysis, fallbackFeatures: { ...restored.analysis.fallbackFeatures, facialHair: "none" } };
  const before = render(beforeInput), after = render(restored.analysis);
  expect(after.style.facialHair).toBe("goatee");
  expect(after.plan.hairPlan).toEqual(before.plan.hairPlan);
  expect(after.plan.outfitPlan).toEqual(before.plan.outfitPlan);
  expect(after.plan.facePixelPlan.layout).toEqual(before.plan.facePixelPlan.layout);
  expect(after.craft.ok).toBe(true); expect(validateFinalAtlas(after.atlas).ok).toBe(true);
  expect(render(restored.analysis).atlas).toEqual(after.atlas);
  const changed: { x: number; y: number }[] = [];
  for (let i = 0; i < 4096; i++) if (!after.atlas.rgba.slice(i * 4, i * 4 + 4).every((v, k) => v === before.atlas.rgba[i * 4 + k])) changed.push({ x: i % 64, y: Math.floor(i / 64) });
  results.categoryReplay = { before: before.style.facialHair, after: after.style.facialHair, changed,
    beforeAtlasHash: digest(before.atlas.rgba), afterAtlasHash: digest(after.atlas.rgba), craft: after.craft,
    finalAtlas: validateFinalAtlas(after.atlas), hairPlanEqual: true, outfitPlanEqual: true, layoutEqual: true };
  for (const [name, replay] of [["before", before], ["after", after]] as const) {
    writeFileSync(path.join(root, `${name}.png`), await encodePng(replay.atlas), { flag: "wx" });
    const view = renderSkinViews(replay.atlas).find(v => v.name === "front");
    if (view) writeFileSync(path.join(root, `${name}-front.png`), await encodePng(view.image), { flag: "wx" });
  }
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(p => p.y < 16)).toBe(true);
});

it("keeps twelve strict-boundary round trips exact and confines historical changes to evidenced repairs", async () => {
  const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const historical = JSON.parse(readFileSync("evaluation-artifacts/facial-hair-category-fix-20260926-zE10L8/results.json", "utf8")).frozen as Array<{ id: string; atlasHash: string }>;
  const browBaselineRoot = "evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-li8W2P";
  const browBaselines = JSON.parse(readFileSync(`${browBaselineRoot}/results.json`, "utf8")).cases as Array<{ id: string; baselinePlan: SkinPlan }>;
  const eyeAxisBaselines = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8")).cases as Array<{ id: string; plan: SkinPlan }>;
  const rows = [];
  for (const fixture of annotations) {
    const { analysis } = strictBoundaryAnalysisFromAnnotation(fixture);
    const restored = normalizeCompactPhotoAnalysisV3(wireFixture(analysis), { imageCount: 1 });
    expect(restored.ok, fixture.id).toBe(true);
    if (!restored.ok) throw new Error("strict_fixture_failed");
    if (fixture.existing) {
      const stored = JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8"));
      analysis.identityGeometry = parseIdentityGeometry(stored.sourceGeometryAfter)!;
      restored.analysis.identityGeometry = analysis.identityGeometry;
    }
    const before = render(analysis), after = render(restored.analysis);
    expect(after.plan, fixture.id).toEqual(before.plan);
    expect(after.atlas, fixture.id).toEqual(before.atlas);
    expect(after.craft.ok, fixture.id).toBe(true);
    expect(validateAtlasCraft(after.atlas, after.style, after.plan.facePixelPlan, after.plan.hairPlan, after.plan).ok, fixture.id).toBe(true);
    const historicalHash = historical.find(r => r.id === fixture.id)!.atlasHash;
    const historicalAtlasUnchanged = digest(after.atlas.rgba) === historicalHash;
    let historicalChangedPixels = 0;
    const collisionRepair = after.plan.facePixelPlan.mouthCollisionResolution;
    const browBaseline = await decodePng(readFileSync(`${browBaselineRoot}/${fixture.id}-before.png`));
    const browChanges = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => browBaseline.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) browChanges.push({ x: p % 64 - 8, y: Math.floor(p / 64) - 8, p });
    if (browChanges.length > 0) {
      // This baseline was frozen before the brow/eye/mouth paint repairs, after the
      // separate mouth/collar fixes. Do not replace historical PNGs or hashes.
      const priorPlan = browBaselines.find(row => row.id === fixture.id)!.baselinePlan;
      // Eye-axis mapping is independently constrained against its pre-fix
      // snapshot; keep the old paint baseline and its bounded pixel checks.
      expect(after.plan).toEqual(eyeAxisBaselines.find(row => row.id === fixture.id)!.plan);
      expect(after.plan.hairPlan).toEqual(priorPlan.hairPlan);
      expect(after.plan.outfitPlan).toEqual(priorPlan.outfitPlan);
      expect(after.plan.facePixelPlan.layout.geometryTarget).toEqual(priorPlan.facePixelPlan.layout.geometryTarget);
      const legacyXs = after.style.eyeSpacing === "wide" ? [0, 1, 7, 6] : after.style.eyeSpacing === "close" ? [1, 2, 5, 4] : [1, 2, 6, 5];
      const legacyMouth = (cell: { x: number; y: number }) => cell.x >= 2 && cell.x <= 5 && cell.y >= 5 && cell.y <= 7;
      const legacyStroke = (cell: { x: number; y: number }) => (legacyXs.includes(cell.x) && [2, 3, 4, 5].includes(cell.y)) || legacyMouth(cell);
      const seam = getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal.find(s => s.primary.every(p => p.y === 15))!;
      for (const cell of browChanges) {
        const seamIndex = seam.adjacent.findIndex(p => p.x === cell.x + 8 && p.y === cell.y + 8);
        if (seamIndex >= 0) {
          expect(legacyMouth({ x: seam.primary[seamIndex].x - 8, y: 7 })).toBe(true);
          expect(after.atlas.rgba[cell.p * 4 + 3]).toBe(browBaseline.rgba[cell.p * 4 + 3]);
          continue;
        }
        const contrastRole = after.plan.facePixelPlan.pixels.some(p => ["iris", "lip", "mouth_shadow"].includes(p.role) && p.x === cell.x && p.y === cell.y);
        // Removing a neighbouring obsolete stroke can alter the existing
        // local-contrast choice, but cannot move a landmark or change its role.
        expect(legacyStroke(cell) || (contrastRole && browChanges.some(b => legacyStroke(b) && Math.abs(b.x - cell.x) + Math.abs(b.y - cell.y) === 1)), fixture.id).toBe(true);
        expect(after.atlas.rgba[cell.p * 4 + 3]).toBe(browBaseline.rgba[cell.p * 4 + 3]);
      }
    } else if (!historicalAtlasUnchanged && collisionRepair) {
      expect(collisionRepair).toEqual({ fromRow: 5, toRow: 6, reason: "eye_pixel_collision" });
      const baseline = JSON.parse(readFileSync("evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-uXgimv/results.json", "utf8")).cases as Array<{ id: string; baselinePlan: SkinPlan }>;
      const legacy = baseline.find(row => row.id === fixture.id)!.baselinePlan;
      expect(after.plan.hairPlan).toEqual(legacy.hairPlan);
      expect(after.plan.outfitPlan).toEqual(legacy.outfitPlan);
      expect(after.plan.facePixelPlan.layout.geometryTarget).toEqual(legacy.facePixelPlan.layout.geometryTarget);
      const legacyAtlas = buildProceduralFallbackAtlas(after.features, after.style, legacy)!;
      expect(legacyAtlas).not.toBeNull();
      expect(digest(legacyAtlas.rgba), fixture.id).toBe(historicalHash);
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => legacyAtlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) {
        historicalChangedPixels++;
        expect(Math.floor(p / 64)).toBeLessThan(16);
        expect(after.atlas.rgba[p * 4 + 3]).toBe(legacyAtlas.rgba[p * 4 + 3]);
      }
    } else if (!historicalAtlasUnchanged) {
      expect(fixture.existing).toBeFalsy();
      expect(after.plan.outfitPlan.upper.neckline.kind).toBe("shirt_collar");
      expect(after.plan.outfitPlan.upper.neckline.innerVisible).toBe(false);
      const legacy = structuredClone(after.plan);
      legacy.outfitPlan.upper.neckline.innerVisible = true;
      legacy.outfitPlan.upper.collarColor = legacy.outfitPlan.upper.accentColor;
      legacy.outfitPlan.upper.colorBlocks.splice(1, 0, { id: "inner_panel", region: "front_center", color: legacy.outfitPlan.upper.accentColor, source: "observed", priority: 0.95 });
      const legacyAtlas = buildProceduralFallbackAtlas(after.features, after.style, legacy)!;
      expect(legacyAtlas).not.toBeNull();
      expect(digest(legacyAtlas.rgba), fixture.id).toBe(historicalHash);
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => legacyAtlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) {
        historicalChangedPixels++;
        const x = p % 64, y = Math.floor(p / 64);
        const collar = CLASSIC_LAYOUT.body.overlay.front;
        expect((y >= 20 && y < 32 && x >= 20 && x < 28) || (y === 19 && x >= 21 && x <= 25) ||
          (y >= collar.y && y < collar.y + 2 && x >= collar.x + 1 && x <= collar.x + 6), fixture.id).toBe(true);
      }
      for (const [name, atlas] of [["before", legacyAtlas], ["after", after.atlas]] as const) {
        const front = renderSkinViews(atlas).find(v => v.name === "front")!;
        writeFileSync(path.join(root, `${fixture.id}-${name}-front.png`), await encodePng(front.image), { flag: "wx" });
      }
    }
    rows.push({ id: fixture.id, calibrated: !!fixture.existing, atlasHash: digest(after.atlas.rgba), planHash: digest(after.plan), craft: true, atlasDiff: 0,
      historicalAtlasUnchanged, historicalChangedPixels: browChanges.length ? null : historicalChangedPixels,
      preBrowBaselineChangedPixels: browChanges.length,
      historicalChangeReason: historicalAtlasUnchanged ? null : browChanges.length ? "legacy_brow_eye_mouth_paint_removed_after_prior_repairs" : collisionRepair ? "eye_mouth_pixel_collision_resolved" : "unsupported_inner_panel_removed_and_shirt_collar_material_continued" });
  }
  expect(rows).toHaveLength(12); expect(rows.filter(r => r.calibrated)).toHaveLength(5);
  results.frozen = rows;
}, 30000);
