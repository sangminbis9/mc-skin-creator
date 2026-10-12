import { createHash } from "node:crypto";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";
import { historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";
import { historicalScarfBeltPlan } from "./historicalScarfBeltColors";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferenceScarfFinish, observedScarfFall } from "../src/referenceScarfFinish";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { sourceAccessoryStencils } from "../src/referenceOutfitRetention";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
// Semantic construction units, not new photo annotations or measured regions.
function unit(fall = "long white neck scarf", garment = "brown knit cardigan") {
  const raw = makeAnalysis();
  raw.observed.clothing = `${garment} with ${fall}`;
  raw.observed.accessories = fall;
  raw.identityPrompt = raw.observed.hair; raw.outfitPrompt = raw.observed.clothing;
  raw.canonicalIdentity.overallImpression = `${raw.observed.hair}, ${raw.observed.clothing}`;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair, raw.observed.clothing];
  raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "accessory" && f.category !== "outfit");
  raw.canonicalIdentity.features.push({ category: "outfit", feature: raw.observed.clothing, evidence: raw.observed.clothing, confidence: "high", priority: 5, targetRegions: ["torso.front", "torso.overlay"] });
  raw.renderHints.neckAccessory = "scarf"; raw.renderHints.necklace = "none";
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.earrings = false;
  raw.fallbackFeatures.topType = /hoodie/.test(garment) ? "hoodie" : "sweater";
  raw.fallbackFeatures.topColor = /black/.test(garment) ? "black" : /pastel/.test(garment) ? "pink" : "brown";
  raw.fallbackFeatures.topAccentColor = "white";
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
  const design = buildReferenceStylePlan(analysis);
  expect(baseline).not.toBeNull();
  return { raw, analysis, source, features, style, baseline, design };
}

describe("source-supported long scarf construction", () => {
  it.each([
    "short brown hair white neck scarf",
    "short brown hair with white neck scarf",
    "short brown hair and a white scarf around the neck",
  ])("does not manufacture head covering from independent hair/neck evidence: %s", impression => {
    const b = unit();
    b.raw.canonicalIdentity.overallImpression = impression;
    const a = normalizeAnalysisForRendering(b.raw), plan = buildSkinPlan(a);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, colors, plan.hairPlan);
    expect(style.hat).toBe("none");
    expect(style.neckAccessory).toBe("scarf");
    expect(style.hairColor).toBe(colors.hairColor);
  });
  it.each(["white headscarf", "white hijab", "white scarf wrapped around the head", "white scarf covering the hair"])("retains an explicit covering relationship: %s", covering => {
    const b = unit();
    b.raw.observed.accessories = covering;
    b.raw.canonicalIdentity.overallImpression = covering;
    const a = normalizeAnalysisForRendering(b.raw), plan = buildSkinPlan(a);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    expect(buildFaceStyle(a, colors, plan.hairPlan)).toMatchObject({ hat: "headscarf", hatColor: "#f2f2f2" });
  });
  it.each(["no headscarf", "without a hijab", "not wearing a head wrap"])("keeps negated covering evidence negative: %s", covering => {
    const b = unit();
    b.raw.observed.accessories = covering;
    b.raw.canonicalIdentity.overallImpression = covering;
    const a = normalizeAnalysisForRendering(b.raw), plan = buildSkinPlan(a);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    expect(buildFaceStyle(a, colors, plan.hairPlan).hat).toBe("none");
  });
  it.each(["long white neck scarf", "hanging cream knit scarf", "scarf hangs over the chest"])("binds %s to its actual accessory noun", text => {
    expect(observedScarfFall(text)).toBe("long");
  });
  it.each(["long hair and a neck scarf", "long cardigan with neck scarf", "no long scarf", "unknown long scarf", "possibly long scarf", "short scarf and long jeans", "short neck scarf"])("does not infer a long scarf from %s", text => {
    expect(observedScarfFall(text)).toBeNull();
    expect(buildReferenceScarfFinish(unit(text).source, "#d39e80").paints).toEqual([]);
  });
  it("reproduces the earliest seven-cell loss and connects a restrained tail without editing source geometry", () => {
    const b = unit(), original = JSON.stringify(b.source);
    const scarf = sourceAccessoryStencils(b.source.outfitPlan, b.style.skinTone!).find(s => s.id.startsWith("accessory:scarf:"))!;
    expect(scarf.paints).toHaveLength(7); expect(Math.max(...scarf.paints.map(p => p.y))).toBe(2);
    const authored = buildReferenceScarfFinish(b.source, b.style.skinTone!);
    expect(authored.status).toBe("authored"); expect(authored.paints).toHaveLength(10);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    const quality = measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style);
    expect(quality.violations).toEqual([]); expect(quality.garmentFoundation.designedScarfPixels).toBe(10);
    expect(quality.accessoryRetention.cues.every(c => c.retainedPixels === c.visibleSourcePixels)).toBe(true);
    for (const p of authored.paints) {
      expect(result.diagnostic.surfacePixels.filter(c => c.part === p.part && c.face === p.face && c.x === p.x && c.y === p.y)).toMatchObject([{ layer: "base", owner: "accessory" }]);
    }
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, result)).ok).toBe(true);
    expect(JSON.stringify(b.source)).toBe(original); expect(b.analysis.identityGeometry).toBeUndefined();
  });
  it("ends explicit waist-length tails before the observed waist and never occupies shoulders/arms/legs", () => {
    const b = unit("waist-length cream neck scarf");
    const scarf = buildReferenceScarfFinish(b.source, b.style.skinTone!);
    expect(scarf.observedFall).toBe("waist"); expect(scarf.paints.length).toBeGreaterThan(10);
    expect(scarf.paints.every(p => p.part === "body" && p.face === "front" && [3, 4].includes(p.x) && p.y >= 3 && p.y < b.source.outfitPlan.lower.waistRow)).toBe(true);
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
  });
  it("does not promote mixed accessory evidence, inferred completion, wrong categories or low confidence", () => {
    const b = unit("short neck scarf");
    b.source.outfitPlan.accessories.find(a => a.kind === "scarf")!.evidence += ". long white neck scarf";
    b.source.hiddenSurfaces.forEach(s => { s.completion = "long white neck scarf"; });
    b.source.assignments.push({ ...b.source.assignments[0], category: "hair", feature: "long white neck scarf", evidence: "long white neck scarf" });
    b.source.assignments.push({ ...b.source.assignments[0], category: "outfit", confidence: "low", feature: "long white neck scarf", evidence: "long white neck scarf" });
    expect(buildReferenceScarfFinish(b.source, b.style.skinTone!).paints).toEqual([]);
    const c = unit("short neck scarf");
    if (!c.raw.inferred.lowerBody) throw new Error("fixture_missing_lower_completion");
    c.raw.outfitPrompt = "long cream neck scarf"; c.raw.inferred.lowerBody.value += ", long cream neck scarf";
    expect(buildReferenceScarfFinish(buildSkinPlan(normalizeAnalysisForRendering(c.raw)), c.style.skinTone!).paints).toEqual([]);
  });
  it("can use a high-confidence existing canonical accessory claim without changing historical annotations", () => {
    const b = unit("neck scarf");
    b.source.assignments.push({ ...b.source.assignments[0], category: "accessory", confidence: "high", feature: "long white neck scarf", evidence: "long white neck scarf visible over chest" });
    expect(buildReferenceScarfFinish(b.source, b.style.skinTone!).status).toBe("authored");
  });
  it("omits the entire extension when another source accessory occupies the attachment/tail", () => {
    const b = unit();
    b.source.outfitPlan.accessories.push({ kind: "necklace", color: "#aaaaaa", side: "center", source: "observed", evidence: "observed necklace" });
    expect(buildReferenceScarfFinish(b.source, b.style.skinTone!)).toMatchObject({ status: "source_conflict", paints: [] });
    const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
  });
  it("rejects erased/recolored tails even if the candidate rewrites every paint and scarf diagnostic", () => {
    const b = unit();
    for (const mode of ["erase", "recolor"] as const) {
      const result = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
      const c = result.diagnostic.surfacePixels.find(p => p.owner === "accessory" && p.layer === "base" && p.part === "body" && p.x === 3 && p.y === 5)!;
      const r = CLASSIC_LAYOUT.body.base.front, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      result.atlas.rgba.set([230, 2, 245, 255], i); c.color = [230, 2, 245];
      result.diagnostic.scarfFinish.paints.find(p => p.x === c.x && p.y === c.y)!.color = c.color;
      if (mode === "erase") {
        c.owner = "garment";
        result.diagnostic.surfaces.find(p => p.part === c.part && p.layer === c.layer && p.face === c.face && p.x === c.x && p.y === c.y)!.owner = "garment";
        result.diagnostic.scarfFinish.paints = [];
      }
      expect(measureReferenceRenderedQuality(result, b.baseline, b.source, b.design, b.style).violations).toContain("source_scarf_tail_missing");
    }
  });
  it("encodes source-supported tails through the actual default PNG path without inference", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
    const root = mkdtempSync("evaluation-artifacts/reference-scarf-20261005-"), evidence = [];
    try {
      const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const [id, garment, fall] of [["knit-long", "brown knit cardigan", "long white neck scarf"], ["pastel-waist", "pastel pink hoodie", "waist-length cream neck scarf"], ["dark-long", "black hoodie", "long white neck scarf"]]) {
        const b = unit(fall, garment), original = hash(JSON.stringify(b.source));
        runPrimary.mockResolvedValue({ ok: true, analysis: b.raw, neuronsSpent: 0, attempts: 1 });
        const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
        const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
        const response = await generateSkin(env, input);
        expect(response.status, id).toBe(200); expect(response.body.ok).toBe(true);
        const selected = selectReferenceStyleAtlas(b.baseline, b.source, b.design, b.style).selected!;
        expect(selected, id).not.toBeNull();
        const atlas = await decodePng(base64ToBytes(response.body.skinPngBase64!));
        expect(atlas.rgba).toEqual(selected.composition.atlas.rgba);
        expect(hash(JSON.stringify(response.body.analysis!.skinPlan))).toBe(original);
        expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        const previous = structuredClone(b.source);
        previous.outfitPlan.observedConstruction = "neck scarf";
        previous.assignments = previous.assignments.filter(a => !["outfit", "accessory"].includes(a.category));
        const before = composeReferenceStyleAtlas(b.baseline, previous, b.design, b.style).atlas;
        const authorized = new Set(selected.composition.diagnostic.scarfFinish.paints.map(p => { const r = CLASSIC_LAYOUT.body.base.front; return ((r.y + p.y) * 64 + r.x + p.x) * 4; }));
        let changed = 0;
        for (let i = 0; i < atlas.rgba.length; i += 4) if ([0, 1, 2, 3].some(ch => atlas.rgba[i + ch] !== before.rgba[i + ch])) {
          changed++; expect(authorized.has(i), `${id}:${i}`).toBe(true);
        }
        expect(changed).toBe(authorized.size);
        writeFileSync(`${root}/${id}-default.png`, await encodePng(atlas), { flag: "wx" });
        for (const [stage, image] of [["before", before], ["after", atlas]] as const) for (const view of renderSkinViews(image).filter(v => ["front", "back", "right"].includes(v.name))) {
          writeFileSync(`${root}/${id}-${stage}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
        }
        evidence.push({ id, provenance: "semantic_unit_template_design", sourcePlanHash: original, defaultAtlasHash: hash(atlas.rgba), changedPixels: changed, scarf: selected.composition.diagnostic.scarfFinish, sourceContract: selected.quality, craft: selected.foundation });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, primaryStage: "mocked_semantic_unit", cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_SCARF ${root}`);
    } finally { runPrimary.mockRestore(); network.mockRestore(); }
  }, 180_000);
  it("preserves frozen scarf construction and calibrated geometry across the hair material migration", async () => {
    // Keep the reviewed iris palette and explicitly isolate the later material
    // change; never replace historical PNGs or label current atlas diff as zero.
    const previousRoot = "evaluation-artifacts/reference-primary-integration-20261005-NFFoTl";
    const annotationBytes = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const annotations: AnnotatedCase[] = JSON.parse(annotationBytes.toString());
    const previous: { cases: Array<{ caseId: string; sourcePlanHash: string; geometryHash: string; legacyAtlasHash: string }> } = JSON.parse(readFileSync(`${previousRoot}/results.json`, "utf8"));
    const root = mkdtempSync("evaluation-artifacts/reference-scarf-frozen-20261005-"), evidence = [];
    for (const fixture of annotations) {
      const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
      if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      // Preserve the historical material migration assertion; current accessory
      // colors are independently checked by observedScarfBeltFrozen.test.ts.
      const analysis = normalizeAnalysisForRendering(raw), source = historicalScarfBeltPlan(buildSkinPlan(analysis));
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
      const old = previous.cases.find(c => c.caseId === fixture.id)!;
      expect(hash(JSON.stringify(historicalHairMaterialPlan(source))), fixture.id).toBe(old.sourcePlanHash);
      expect(hash(JSON.stringify(analysis.identityGeometry ?? null)), fixture.id).toBe(old.geometryHash);
      const selected = selectReferenceStyleAtlas(baseline, source, buildReferenceStylePlan(analysis), style).selected!;
      expect(selected, fixture.id).not.toBeNull();
      const before = await decodePng(readFileSync(`${previousRoot}/${fixture.id}-default.png`)), after = selected.composition.atlas;
      const historical = historicalHairMaterialReplay(features, style, source, selected.design, selected.composition);
      expect(hash(historical.baseline.rgba), fixture.id).toBe(old.legacyAtlasHash);
      const irisPixels = assertSingletonPigmentBoundary(historical.composition.atlas, before, source, style);
      const craft = validateReferenceAtlasCraft(after, baseline, source, style, buildReferenceCraftPlan(source, selected.design, selected.composition));
      expect(craft.ok, fixture.id).toBe(true);
      evidence.push({ caseId: fixture.id, calibrated: !!fixture.existing, historicalMaterialProjectionEqualOutsideSingletonIris: true, intentionalIrisPixels: irisPixels, intentionalMaterialPixels: historical.changedPixels, geometryEqual: true, currentAtlasHash: hash(after.rgba), scarf: selected.composition.diagnostic.scarfFinish, craft: craft.ok });
    }
    expect(evidence).toHaveLength(12); expect(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json")).toEqual(annotationBytes);
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, previousRoot, annotationHash: hash(annotationBytes), cases: evidence }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_SCARF_FROZEN ${root}`);
  }, 180_000);
});
