import { createHash } from "node:crypto";
import { historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";
import { assertAccessoryPaletteBoundary, historicalScarfBeltPlan } from "./historicalScarfBeltColors";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildPreFeedbackReferenceDesign } from "./preFeedbackReferenceDesign";
import { buildReferenceLooseHair } from "../src/referenceLooseHair";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { sourceAccessoryStencils } from "../src/referenceOutfitRetention";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
// Semantic design units, NOT invented photo annotations or measured coordinates.
function unit(length: "shoulder" | "chest" | "waist", texture: "straight" | "wavy" = "straight", front = true, rear = false) {
  const raw = makeAnalysis();
  raw.observed.hair = `${length}-length ${texture} hair with bangs${front ? " drapes over shoulders" : ""}`;
  raw.observed.accessories = "none"; raw.observed.clothing = "plain white top";
  raw.identityPrompt = raw.observed.hair; raw.outfitPrompt = raw.observed.clothing;
  raw.canonicalIdentity.overallImpression = raw.observed.hair;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair, raw.observed.clothing];
  raw.inferred.hairBack = { value: "continue visible length and material", rationale: "unseen completion, not observed" };
  raw.renderHints.overallHairLength = length; raw.renderHints.sideHairLength = "shoulder";
  raw.renderHints.bangs = "straight"; raw.renderHints.bangsLength = "short"; raw.renderHints.hairTexture = texture;
  raw.renderHints.hairBackShape = rear ? "long" : "tapered";
  raw.fallbackFeatures.hairstyle = "long"; raw.fallbackFeatures.hairColor = "brown";
  raw.fallbackFeatures.facialHair = "none"; raw.fallbackFeatures.glasses = "none";
  raw.fallbackFeatures.earrings = false; raw.fallbackFeatures.hat = "none";
  raw.fallbackFeatures.topType = "tshirt"; raw.fallbackFeatures.topColor = "white";
  raw.canonicalIdentity.features = [{ category: "hair", feature: raw.observed.hair, evidence: raw.observed.hair, confidence: "high", priority: 5, targetRegions: ["head.front", "head.back"] }];
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source);
  expect(baseline).not.toBeNull();
  return { raw, analysis, source, features, style, baseline: baseline!, design: buildReferenceStylePlan(analysis) };
}

describe("source-supported loose-hair length and rear completion", () => {
  it.each([["shoulder", 4], ["chest", 8], ["waist", 12]] as const)("keeps %s front locks at %i authored rows instead of a fixed four", (length, rows) => {
    const b = unit(length), immutable = JSON.stringify(b.source);
    const drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(drape.rows).toBe(rows); expect(drape.frontEvidence).toBe("observed_shoulder_drape");
    const front = drape.points.filter(p => p.face === "front");
    expect(front).toHaveLength(rows * 2);
    expect(Math.max(...front.map(p => p.y))).toBe(rows - 1);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.drapeCells).toBe(drape.points.length);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, result)).ok).toBe(true);
    expect(JSON.stringify(b.source)).toBe(immutable); expect(b.analysis.identityGeometry).toBeUndefined();
    expect(result.diagnostic.surfaces.filter(c => c.owner === "hair" && c.part !== "head").every(c => c.layer === "base" && c.part === "body")).toBe(true);
  });
  it("authors connected lower waves without widening upper shoulders", () => {
    const b = unit("waist", "wavy"), drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(drape.points.filter(p => p.face === "front" && p.y < 2).every(p => p.x === 0 || p.x === 7)).toBe(true);
    expect(drape.points.some(p => p.face === "front" && p.y >= 3 && [1, 6].includes(p.x))).toBe(true);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.constraints.violations).toEqual([]);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
  });
  it("keeps unseen rear completion separate from front observation and creates no front drape from length", () => {
    const b = unit("chest", "straight", false, true), drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(b.design.drape.eligible).toBe(false); expect(drape.frontEvidence).toBeNull();
    expect(drape.rearEvidence).toBe("source_supported_unseen_completion");
    expect(drape.points.every(p => p.face === "back")).toBe(true); expect(drape.points).toHaveLength(44);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.constraints.violations).toEqual([]);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, result)).ok).toBe(true);
  });
  it("requires rear completion, long structured shape and actual bottom-head roots", () => {
    const b = unit("chest", "straight", false, true);
    for (const completion of ["unknown", "unknown back", "no long rear hair", "short tapered back"]) {
      b.source.hiddenSurfaces.find(s => s.part === "head")!.completion = completion;
      expect(buildReferenceLooseHair(b.source, b.design, b.style).points).toEqual([]);
    }
    const c = unit("chest", "straight", false, true); c.style.hairBackShape = "tapered";
    expect(buildReferenceLooseHair(c.source, c.design, c.style).points).toEqual([]);
    const d = unit("chest", "straight", false, true);
    d.source.headIdentityPlan.ownership!.cells.find(c => c.layer === "base" && c.face === "back" && c.x === 3 && c.y === 7)!.owner = "face";
    expect(buildReferenceLooseHair(d.source, d.design, d.style).points).toEqual([]);
  });
  it("does not let inferred, negated or wrong-category words authorize front locks", () => {
    const b = unit("chest", "straight", false, false);
    b.design.drape.eligible = true; b.design.drape.maxShoulderColumns = 1;
    b.source.hiddenSurfaces.find(s => s.part === "head")!.completion = "drapes over shoulders";
    b.source.assignments.push({ ...b.source.assignments[0], category: "outfit", feature: "drapes over shoulders", evidence: "drapes over shoulders" });
    expect(buildReferenceLooseHair(b.source, b.design, b.style).points.filter(p => p.face === "front")).toEqual([]);
    for (const s of b.source.hiddenSurfaces.filter(s => s.part === "head")) s.evidence = "no shoulder drape";
    expect(buildReferenceLooseHair(b.source, b.design, b.style).points.filter(p => p.face === "front")).toEqual([]);
  });
  it("rejects missing/recolored locks even after rewriting all paint diagnostics", () => {
    const b = unit("chest", "straight", false, true);
    for (const mode of ["erase", "recolor"] as const) {
      const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
      const c = result.diagnostic.surfacePixels.find(c => c.part === "body" && c.owner === "hair" && c.face === "back" && c.x === 3 && c.y === 4)!;
      const r = CLASSIC_LAYOUT.body.base.back, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      result.atlas.rgba.set([230, 2, 245, 255], i); c.color = [230, 2, 245];
      if (mode === "erase") {
        c.owner = "garment";
        result.diagnostic.surfaces.find(p => p.part === c.part && p.face === c.face && p.layer === c.layer && p.x === c.x && p.y === c.y)!.owner = "garment";
        result.diagnostic.looseHair.points = result.diagnostic.looseHair.points.filter(p => !(p.face === c.face && p.x === c.x && p.y === c.y));
      }
      expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toContain("loose_hair_drape_invalid");
    }
  });
  it("retains source accessories without painting a detached fragment", () => {
    const b = unit("chest");
    b.source.outfitPlan.accessories.push({ kind: "bag_strap", color: "#d44681", side: "left", source: "observed", evidence: "semantic unit has an observed bag strap" });
    const paints = sourceAccessoryStencils(b.source.outfitPlan, b.style.skinTone!)[0].paints;
    const drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(drape.rearEvidence).toBe("source_supported_unseen_completion");
    expect(drape.points.some(p => p.face === "back")).toBe(true);
    expect(drape.occlusion.accessoryPixels).toBeGreaterThan(0);
    expect(drape.points.some(p => paints.some(c => c.part === "body" && c.face === p.face && c.x === p.x && c.y === p.y))).toBe(false);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.constraints.violations).toEqual([]);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
  });
  it.each([["chest", 40], ["waist", 42]] as const)("keeps root-connected %s rear hair above a belt (%i cells)", (length, count) => {
    const b = unit(length, "wavy", false, true);
    b.source.outfitPlan.lower.waistRow = 8;
    b.source.outfitPlan.accessories.push({ kind: "belt", color: "#68aa35", side: "center", source: "observed", evidence: "green waist belt" });
    const immutable = JSON.stringify(b.source);
    const drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(drape.rearEvidence).toBe("source_supported_unseen_completion");
    expect(drape.rows).toBe(length === "chest" ? 8 : 12);
    expect(drape.points).toHaveLength(count);
    expect(drape.points.every(p => p.face === "back" && p.y < 7)).toBe(true);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.constraints.violations).toEqual([]);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, result)).ok).toBe(true);
    expect(JSON.stringify(b.source)).toBe(immutable);
  });
  it("does not invent a connection below a fully blocked root row", () => {
    const b = unit("waist", "straight", false, true);
    b.source.outfitPlan.lower.waistRow = 1;
    b.source.outfitPlan.accessories.push({ kind: "belt", color: "#68aa35", side: "center", source: "observed", evidence: "authored root-row occlusion" });
    const drape = buildReferenceLooseHair(b.source, b.design, b.style);
    expect(drape.points).toEqual([]); expect(drape.roots).toEqual([]); expect(drape.rearEvidence).toBeNull();
  });
  it("encodes rear length through actual default generateSkin and saves front/back/side evidence without inference", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
    const root = mkdtempSync("evaluation-artifacts/reference-loose-hair-20261005-");
    const evidence = [];
    try {
      const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const length of ["shoulder", "chest", "waist"] as const) for (const texture of ["straight", "wavy"] as const) {
        const b = unit(length, texture, true, length !== "shoulder"), original = hash(JSON.stringify(b.source));
        runPrimary.mockResolvedValue({ ok: true, analysis: b.raw, neuronsSpent: 0, attempts: 1 });
        const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
        const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
        const response = await generateSkin(env, input);
        expect(response.status, `${texture}:${length}`).toBe(200); expect(response.body.ok).toBe(true);
        const expected = selectReferenceStyleAtlas(b.baseline, b.source, b.design, b.style).selected!;
        expect(expected).not.toBeNull();
        const atlas = await decodePng(base64ToBytes(response.body.skinPngBase64!));
        expect(atlas.rgba).toEqual(expected.composition.atlas.rgba);
        expect(hash(JSON.stringify(response.body.analysis!.skinPlan))).toBe(original);
        expect(response.body.analysis!.referenceStyle!.status).toBe("reference_style_accepted");
        expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        const id = `${texture}-${length}`;
        writeFileSync(`${root}/${id}-default.png`, await encodePng(atlas), { flag: "wx" });
        for (const [stage, image] of [["legacy", b.baseline], ["default", atlas]] as const) for (const view of renderSkinViews(image)) {
          writeFileSync(`${root}/${id}-${stage}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
        }
        evidence.push({ id, provenance: "semantic_unit_template_design", sourcePlanHash: original, defaultAtlasHash: hash(atlas.rgba), construction: expected.composition.diagnostic.looseHair, constraints: expected.composition.diagnostic.constraints, craft: validateReferenceAtlasCraft(atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, expected.design, expected.composition)), sourceContract: expected.quality });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, defaultPrimary: "mocked_semantic_unit", cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_LOOSE_HAIR ${root}`);
    } finally { runPrimary.mockRestore(); network.mockRestore(); }
  }, 180_000);
  it("isolates authorized rear drape from reviewed head material changes in the frozen twelve", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const previousRoot = "evaluation-artifacts/reference-primary-integration-20261005-27EbXW";
    // Preserve the pre-loose-hair comparison. Later hair material and exact
    // source singleton-iris pigment migrations have separate strict boundaries.
    const reviewedHeadRoot = "evaluation-artifacts/reference-primary-integration-20261005-NFFoTl";
    const headPixels = new Set<number>();
    for (const faces of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const r of Object.values(faces)) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) headPixels.add((r.y + y) * 64 + r.x + x);
    }
    const annotationBytes = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const annotations: AnnotatedCase[] = JSON.parse(annotationBytes.toString());
    const previous: { cases: Array<{ caseId: string; sourcePlanHash: string; geometryHash: string; legacyAtlasHash: string }> } = JSON.parse(readFileSync(`${previousRoot}/results.json`, "utf8"));
    const root = mkdtempSync("evaluation-artifacts/reference-loose-hair-frozen-20261005-"), evidence = [];
    try {
      for (const fixture of annotations) {
        const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        const analysis = normalizeAnalysisForRendering(raw), currentSource = buildSkinPlan(analysis);
        const source = historicalScarfBeltPlan(currentSource);
        const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
        const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
        const old = previous.cases.find(c => c.caseId === fixture.id)!;
        expect(hash(JSON.stringify(historicalHairMaterialPlan(source))), fixture.id).toBe(old.sourcePlanHash);
        expect(hash(JSON.stringify(analysis.identityGeometry ?? null)), fixture.id).toBe(old.geometryHash);
        const selected = selectReferenceStyleAtlas(baseline, source, buildPreFeedbackReferenceDesign(analysis), style).selected!;
        expect(selected, fixture.id).not.toBeNull();
        const historical = historicalHairMaterialReplay(features, style, source, selected.design, selected.composition);
        expect(hash(historical.baseline.rgba), fixture.id).toBe(old.legacyAtlasHash);
        const before = await decodePng(readFileSync(`${previousRoot}/${fixture.id}-default.png`));
        const currentBaseline = buildProceduralSourceAtlas(features, style, currentSource)!;
        const current = selectReferenceStyleAtlas(currentBaseline, currentSource, buildPreFeedbackReferenceDesign(analysis), style).selected!;
        expect(current, fixture.id).not.toBeNull();
        const after = current.composition.atlas;
        const intentionalAccessoryPixels = assertAccessoryPaletteBoundary(selected.composition.atlas, after, currentSource, style.skinTone!, true);
        const reviewedHead = await decodePng(readFileSync(`${reviewedHeadRoot}/${fixture.id}-default.png`));
        // Head-only projection: body/rear-drape changes retain their independent
        // allowlist below, rather than widening the singleton-iris boundary.
        const headProjection = { ...reviewedHead, rgba: reviewedHead.rgba.slice() };
        for (const pixel of headPixels) headProjection.rgba.set(historical.composition.atlas.rgba.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
        const intentionalIrisPixels = assertSingletonPigmentBoundary(headProjection, reviewedHead, source, style);
        const loose = selected.composition.diagnostic.looseHair;
        expect(loose.frontEvidence, fixture.id).toBeNull(); // Frozen evidence never explicitly observed a front shoulder drape.
        const allowed = new Set(loose.points.map(p => { const r = CLASSIC_LAYOUT.body.base[p.face]; return (r.y + p.y) * 64 + r.x + p.x; }));
        // Hair/torso material migrations have their own strict pixel/color/alpha
        // checks in historicalHairMaterialReplay. Compare rear drape under the
        // same historical material here, never authorize arbitrary torso edits.
        const drapeComparison = historical.composition.atlas;
        let changedPixels = 0, reviewedHeadChanges = 0;
        for (let i = 0; i < drapeComparison.rgba.length; i += 4) if ([0, 1, 2, 3].some(ch => before.rgba[i + ch] !== drapeComparison.rgba[i + ch])) {
          if (headPixels.has(i / 4)) { reviewedHeadChanges++; continue; }
          changedPixels++; expect(allowed.has(i / 4), `${fixture.id}: unexpected pixel ${i / 4}`).toBe(true);
        }
        if (loose.points.length) expect(changedPixels, fixture.id).toBeGreaterThan(0);
        const craft = validateReferenceAtlasCraft(after, currentBaseline, currentSource, style, buildReferenceCraftPlan(currentSource, current.design, current.composition));
        expect(craft.ok, fixture.id).toBe(true);
        writeFileSync(`${root}/${fixture.id}-default.png`, await encodePng(after), { flag: "wx" });
        if (changedPixels) for (const [stage, image] of [["before", before], ["after", after]] as const) for (const view of renderSkinViews(image).filter(v => ["front", "back", "right"].includes(v.name))) {
          writeFileSync(`${root}/${fixture.id}-${stage}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
        }
        evidence.push({ caseId: fixture.id, calibrated: !!fixture.existing, historicalMaterialProjectionEqualOutsideSingletonIris: true, intentionalIrisPixels, intentionalAccessoryPixels, intentionalMaterialPixels: historical.changedPixels, intentionalTorsoMaterialPixels: historical.torsoMaterialPixels, geometryEqual: true, changedPixels, drapeComparisonContext: "historical_material_on_both_sides", allowedRegion: "body.base.back", reviewedHeadChanges, reviewedHeadProjectionEqualOutsideSingletonIris: true, currentAtlasHash: hash(after.rgba), construction: loose, craft: craft.ok });
      }
      expect(evidence).toHaveLength(12); expect(network).not.toHaveBeenCalled();
      expect(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json")).toEqual(annotationBytes);
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, previousRoot, reviewedHeadRoot, annotationHash: hash(annotationBytes), cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_LOOSE_HAIR_FROZEN ${root}`);
    } finally { network.mockRestore(); }
  }, 180_000);
});
