import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferencePairedHair, buildReferencePairedDrape } from "../src/referencePairedHair";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { sourceAccessoryStencils } from "../src/referenceOutfitRetention";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import type { Env } from "../src/types";
import { historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";
import { assertAccessoryPaletteBoundary, historicalScarfBeltPlan } from "./historicalScarfBeltColors";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const lengths = [["shoulder", 4], ["chest", 8], ["waist", 12], ["hip", 12]] as const;
// Authored semantic design units. No invented measurement or new photo annotation.
function unit(kind: "braids" | "tails", length: typeof lengths[number][0]) {
  const raw = makeAnalysis();
  raw.observed.hair = `${length}-length brown ${kind === "braids" ? "two braids" : "twin tails"} with straight bangs drapes over shoulders`;
  raw.observed.accessories = "none"; raw.observed.clothing = "plain white top";
  raw.identityPrompt = raw.observed.hair; raw.outfitPrompt = raw.observed.clothing;
  raw.canonicalIdentity.overallImpression = raw.observed.hair;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair, "brown hair", raw.observed.clothing];
  raw.canonicalIdentity.features = [
    { feature: raw.observed.hair, category: "hair", priority: 5, confidence: "high", evidence: raw.observed.hair, targetRegions: ["head.front", "head.back"] },
    { feature: "brown hair", category: "hair", priority: 4, confidence: "high", evidence: "visible brown hair", targetRegions: ["head.front"] },
    { feature: "straight bangs", category: "hair", priority: 4, confidence: "high", evidence: "visible straight bangs", targetRegions: ["head.front"] },
    { feature: raw.observed.clothing, category: "outfit", priority: 3, confidence: "high", evidence: raw.observed.clothing, targetRegions: ["torso.front"] },
  ];
  raw.inferred.hairBack = { value: "continue the paired silhouette", rationale: "unseen template completion, not observed geometry" };
  raw.renderHints.overallHairLength = length; raw.renderHints.sideHairLength = "shoulder";
  raw.renderHints.hairTexture = "straight"; raw.renderHints.hairBackShape = "long";
  raw.renderHints.bangs = "straight"; raw.renderHints.bangsLength = "short"; raw.renderHints.fringeEdge = "blunt";
  raw.fallbackFeatures.hairstyle = kind === "tails" ? "twintails" : "long";
  raw.fallbackFeatures.hairColor = "brown"; raw.fallbackFeatures.glasses = "none";
  raw.fallbackFeatures.facialHair = "none"; raw.fallbackFeatures.hat = "none"; raw.fallbackFeatures.earrings = false;
  raw.fallbackFeatures.topType = "tshirt"; raw.fallbackFeatures.topColor = "white";
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
  expect(baseline).not.toBeNull();
  return { raw, analysis, source, style, baseline, design: buildReferenceStylePlan(analysis) };
}

describe("paired endpoint fidelity and accessory protection", () => {
  for (const kind of ["braids", "tails"] as const) it.each(lengths)(`${kind}: retains %s at %i body-base rows, never the legacy fixed six`, (length, rows) => {
    const b = unit(kind, length), original = JSON.stringify(b.source), baseline = b.baseline.rgba.slice();
    expect(b.source.hairPlan.headMask.semanticSilhouette?.endpointCue).toBe(length);
    expect(buildReferencePairedHair(b.source, b.design).status).toBe("authored");
    const points = buildReferencePairedDrape(b.source, b.design, b.style);
    for (const group of ["left_lock", "right_lock"] as const) {
      const lock = points.filter(p => p.drapeGroup === group);
      expect([...new Set(lock.map(p => p.y))]).toEqual(Array.from({ length: rows }, (_, i) => i));
      expect(lock).toHaveLength(kind === "braids" ? (rows / 2) * 3 - 1 : rows * 2 - 3);
    }
    expect(points.filter(p => p.y < 2).every(p => p.x === 0 || p.x === 7)).toBe(true);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(result.diagnostic.drapeCells).toBe(points.length);
    expect(result.diagnostic.constraints.violations).toEqual([]);
    expect(result.diagnostic.surfaces.filter(p => p.owner === "hair" && p.part !== "head").every(p => p.part === "body" && p.layer === "base")).toBe(true);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, result)).ok).toBe(true);
    expect(JSON.stringify(b.source)).toBe(original); expect(b.baseline.rgba).toEqual(baseline);
    expect(b.analysis.identityGeometry).toBeUndefined();
  });
  it("uses the immutable source endpoint, not a candidate's longer style diagnostic", () => {
    const b = unit("braids", "chest"); b.style.overallHairLength = "hip";
    expect(Math.max(...buildReferencePairedDrape(b.source, b.design, b.style).map(p => p.y))).toBe(7);
    delete b.source.hairPlan.headMask.semanticSilhouette;
    expect(buildReferencePairedDrape(b.source, b.design, b.style)).toEqual([]);
  });
  it.each(["braids", "tails"] as const)("preserves an observed strap instead of fragmenting %s or overwriting the accessory", kind => {
    const b = unit(kind, "waist");
    b.source.outfitPlan.accessories.push({ kind: "bag_strap", color: "#d44681", side: "left", source: "observed", evidence: "semantic unit has an observed bag strap" });
    const reserved = sourceAccessoryStencils(b.source.outfitPlan, b.style.skinTone!)[0].paints;
    const points = buildReferencePairedDrape(b.source, b.design, b.style);
    expect(points.filter(p => p.drapeGroup === "right_lock")).toEqual([]);
    expect(points.filter(p => p.drapeGroup === "left_lock")).not.toHaveLength(0);
    expect(points.some(p => reserved.some(c => c.part === "body" && c.face === "front" && c.x === p.x && c.y === p.y))).toBe(false);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
    expect(result.diagnostic.surfaces.filter(p => p.part === "head" && p.drapeGroup === "right_lock")).toEqual([]);
  });
  it("rejects a shortened lower lock even after its paint and ownership diagnostics are rewritten", () => {
    const b = unit("tails", "waist"), result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    const p = result.diagnostic.surfacePixels.find(p => p.part === "body" && p.face === "front" && p.owner === "hair" && p.y === 11)!;
    const r = CLASSIC_LAYOUT.body.base.front, offset = ((r.y + p.y) * 64 + r.x + p.x) * 4;
    result.atlas.rgba.set([220, 3, 230], offset); p.color = [220, 3, 230]; p.owner = "garment"; delete p.drapeGroup;
    const c = result.diagnostic.surfaces.find(c => c.part === p.part && c.face === p.face && c.layer === p.layer && c.x === p.x && c.y === p.y)!;
    c.owner = "garment"; delete c.drapeGroup;
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toContain("paired_hair_drape_invalid");
  });
  it("encodes all eight endpoints through actual default generation and saves fresh front/back/profile evidence", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis"), evidence = [];
    const root = mkdtempSync("evaluation-artifacts/reference-paired-length-20261005-");
    try {
      const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const kind of ["braids", "tails"] as const) for (const [length, rows] of lengths) {
        const b = unit(kind, length), original = hash(JSON.stringify(b.source));
        runPrimary.mockResolvedValue({ ok: true, analysis: b.raw, neuronsSpent: 0, attempts: 1 });
        const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
        const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
        const response = await generateSkin(env, input);
        expect(response.status, `${kind}:${length}`).toBe(200);
        const selected = selectReferenceStyleAtlas(b.baseline, b.source, b.design, b.style).selected!;
        expect(selected).not.toBeNull();
        expect(selected.design.hair.family).toBe(kind === "braids" ? "twin_braids" : "twin_tails");
        const atlas = await decodePng(base64ToBytes(response.body.skinPngBase64!));
        expect(atlas.rgba).toEqual(selected.composition.atlas.rgba); expect(validateFinalAtlas(atlas).ok).toBe(true);
        expect(hash(JSON.stringify(response.body.analysis!.skinPlan))).toBe(original);
        expect(response.body.analysis!.referenceStyle!.status).toBe("reference_style_accepted");
        expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        const id = `${kind}-${length}`;
        writeFileSync(`${root}/${id}-default.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${id}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
        evidence.push({ id, provenance: "semantic_unit_template_design", endpointCue: length, bodyRows: rows, sourcePlanHash: original, atlasHash: hash(atlas.rgba), pairedHair: selected.composition.diagnostic.pairedHair, constraints: selected.composition.diagnostic.constraints, craft: validateReferenceAtlasCraft(atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, selected.design, selected.composition)).ok });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, primaryStage: "mocked_semantic_units", cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_PAIRED_LENGTH ${root}`);
    } finally { network.mockRestore(); runPrimary.mockRestore(); }
  }, 180_000);
  it("retains frozen-twelve structure and calibrated geometry across the explicit material migration", async () => {
    // Preserve the reviewed PNG/hash. The later singleton-pigment migration
    // may change only the paired iris cells to the exact source eye color.
    const previousRoot = "evaluation-artifacts/reference-primary-integration-20261005-NFFoTl";
    const frozen = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const fixtures: AnnotatedCase[] = JSON.parse(frozen.toString());
    const previous: { cases: Array<{ caseId: string; sourcePlanHash: string; geometryHash: string; defaultAtlasHash: string }> } = JSON.parse(readFileSync(`${previousRoot}/results.json`, "utf8"));
    const root = mkdtempSync("evaluation-artifacts/reference-paired-length-frozen-20261005-"), evidence = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      for (const fixture of fixtures) {
        const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        const analysis = normalizeAnalysisForRendering(raw), currentSource = buildSkinPlan(analysis);
        const source = historicalScarfBeltPlan(currentSource);
        const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
        const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
        const selected = selectReferenceStyleAtlas(baseline, source, buildReferenceStylePlan(analysis), style).selected!;
        expect(selected, fixture.id).not.toBeNull();
        const old = previous.cases.find(c => c.caseId === fixture.id)!;
        expect(hash(JSON.stringify(historicalHairMaterialPlan(source))), fixture.id).toBe(old.sourcePlanHash);
        expect(hash(JSON.stringify(analysis.identityGeometry ?? null)), fixture.id).toBe(old.geometryHash);
        const before = await decodePng(readFileSync(`${previousRoot}/${fixture.id}-default.png`));
        const historical = historicalHairMaterialReplay(features, style, source, selected.design, selected.composition);
        expect(hash(before.rgba), fixture.id).toBe(old.defaultAtlasHash);
        const intentionalIrisPixels = assertSingletonPigmentBoundary(historical.composition.atlas, before, source, style);
        const currentBaseline = buildProceduralSourceAtlas(features, style, currentSource)!;
        const current = selectReferenceStyleAtlas(currentBaseline, currentSource, buildReferenceStylePlan(analysis), style).selected!;
        expect(current, fixture.id).not.toBeNull();
        const intentionalAccessoryPixels = assertAccessoryPaletteBoundary(selected.composition.atlas, current.composition.atlas, currentSource, style.skinTone!, true);
        const craft = validateReferenceAtlasCraft(current.composition.atlas, currentBaseline, currentSource, style, buildReferenceCraftPlan(currentSource, current.design, current.composition));
        expect(craft.ok, fixture.id).toBe(true);
        evidence.push({ caseId: fixture.id, calibrated: !!fixture.existing, historicalMaterialProjectionEqualOutsideSingletonIris: true, intentionalIrisPixels, intentionalAccessoryPixels, intentionalMaterialPixels: historical.changedPixels, intentionalTorsoMaterialPixels: historical.torsoMaterialPixels, intentionalRetainedMouthPixels: historical.retainedMouthPixels, geometryEqual: true, currentAtlasHash: hash(current.composition.atlas.rgba), craft: true });
      }
      expect(evidence).toHaveLength(12); expect(evidence.filter(c => c.calibrated)).toHaveLength(5);
      expect(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json")).toEqual(frozen);
      expect(network).not.toHaveBeenCalled();
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, previousRoot, cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_PAIRED_LENGTH_FROZEN ${root}`);
    } finally { network.mockRestore(); }
  }, 180_000);
});
