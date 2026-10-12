import { createHash } from "node:crypto";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildPreFeedbackReferenceDesign } from "./preFeedbackReferenceDesign";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceShortFringe } from "../src/referenceShortFringe";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import type { Env } from "../src/types";
import { historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";
import { historicalScarfBeltPlan } from "./historicalScarfBeltColors";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
// Authored design units inspired by short fringe construction, not annotations
// or fabricated measurements of any reference photograph/person.
const units = [
  { id: "shaggy-side", fringeEdge: "staggered", bangs: "side", length: "ear" },
  { id: "shaggy-straight", fringeEdge: "staggered", bangs: "straight", length: "ear" },
  { id: "soft-blunt", fringeEdge: "blunt", bangs: "straight", length: "ear" },
  { id: "soft-cropped", fringeEdge: "wispy", bangs: "side", length: "cropped" },
] as const;
function unit(u: typeof units[number]) {
  const raw = makeAnalysis();
  const hair = `short brown straight hair with ${u.bangs} bangs and ${u.fringeEdge} fringe`;
  raw.observed = { ...raw.observed, hair, face: "smooth complexion and neutral expression", clothing: "black sweatshirt", accessories: "none" };
  raw.identityPrompt = hair; raw.outfitPrompt = raw.observed.clothing;
  raw.canonicalIdentity.overallImpression = hair;
  raw.canonicalIdentity.mustPreserve = [hair, "brown hair", "black sweatshirt"];
  raw.canonicalIdentity.features = [
    { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: hair, targetRegions: ["head.front", "head.back"] },
    { feature: "brown hair", category: "hair", priority: 4, confidence: "high", evidence: "visible brown hair", targetRegions: ["head.front"] },
    { feature: raw.observed.face, category: "face", priority: 4, confidence: "high", evidence: raw.observed.face, targetRegions: ["head.front"] },
    { feature: raw.observed.clothing, category: "outfit", priority: 3, confidence: "high", evidence: raw.observed.clothing, targetRegions: ["torso.front"] },
  ];
  Object.assign(raw.renderHints, { overallHairLength: u.length, sideHairLength: "short", hairTexture: "straight", hairBackShape: "tapered", bangs: u.bangs, bangsLength: "short", fringeEdge: u.fringeEdge, fringeOpening: "none", neckAccessory: "none" });
  Object.assign(raw.fallbackFeatures, { hairstyle: "short", hairColor: "brown", glasses: "none", facialHair: "none", hat: "none", earrings: false, topType: "sweater", topColor: "black", expression: "neutral" });
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
  expect(baseline).not.toBeNull();
  return { raw, analysis, source, style, baseline, features, design: buildReferenceStylePlan(analysis) };
}

describe("short reference hair: source silhouette and actual default PNG", () => {
  it("gives categorical short fringes distinct inner silhouettes without touching explicit source fringe", () => {
    const expectedWindows = { "shaggy-side": [4], "shaggy-straight": [3, 4], "soft-blunt": [], "soft-cropped": [3] };
    const signatures = [];
    for (const u of units) {
      const b = unit(u), immutable = JSON.stringify(b.source);
      const construction = buildReferenceShortFringe(b.source, b.design, b.style);
      expect(construction.status, JSON.stringify({ id: u.id, construction })).toBe("authored");
      expect(construction.windows.map(p => p.x), u.id).toEqual(expectedWindows[u.id]);
      expect(construction.windows.every(p => p.y === 1 && [3, 4].includes(p.x))).toBe(true);
      const rendered = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
      expect(measureReferenceRenderedQuality(rendered, b.baseline, b.source, b.design, b.style).violations).toEqual([]);
      const frontHair = rendered.diagnostic.surfaces.filter(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.owner === "hair");
      signatures.push(JSON.stringify(frontHair.map(p => [p.x, p.y]).sort()));
      for (const p of b.source.facePixelPlan.pixels.filter(p => p.cluster === "fringe")) {
        expect(construction.windows.some(c => c.x === p.x && c.y === p.y)).toBe(false);
      }
      expect(JSON.stringify(b.source)).toBe(immutable);
      expect(rendered.diagnostic.constraints.outerHairCells).toBeLessThan(rendered.diagnostic.constraints.baseHairCells);
    }
    expect(new Set(signatures).size).toBe(4);
  });
  it("keeps measured masks, reserved facial cells, split fringes and accessories authoritative", () => {
    const mutate = [
      (b: ReturnType<typeof unit>) => { b.source.hairPlan.headMask.source = "identity_geometry"; },
      (b: ReturnType<typeof unit>) => { b.source.facePixelPlan.layout.geometryUsage.hairline = true; },
      (b: ReturnType<typeof unit>) => { b.source.facePixelPlan.pixels.push({ x: 4, y: 1, role: "hair_shadow", cluster: "fringe" }); },
      (b: ReturnType<typeof unit>) => { b.style.hat = "beanie"; },
      (b: ReturnType<typeof unit>) => { b.style.hairAccessory = "clip"; },
      (b: ReturnType<typeof unit>) => { b.style.fringeOpening = "center"; },
      (b: ReturnType<typeof unit>) => { b.style.bangsLength = "brow"; },
      (b: ReturnType<typeof unit>) => { b.source.headIdentityPlan.ownership!.cells.find(c => c.layer === "base" && c.face === "front" && c.x === 4 && c.y === 1)!.owner = "face"; },
      (b: ReturnType<typeof unit>) => { b.source.facePixelPlan.pixels.push({ x: 4, y: 1, role: "brow", cluster: "left_eye" }); },
      (b: ReturnType<typeof unit>) => { b.source.headIdentityPlan.ownership!.cells.find(c => c.layer === "outer" && c.face === "front" && c.x === 4 && c.y === 1)!.owner = "other_p5"; },
    ];
    for (const change of mutate) {
      const b = unit(units[0]);
      expect(buildReferenceShortFringe(b.source, b.design, b.style).status).toBe("authored");
      change(b);
      expect(buildReferenceShortFringe(b.source, b.design, b.style).status).toBe("source_preserved");
      expect(buildReferenceShortFringe(b.source, b.design, b.style).windows).toEqual([]);
    }
  });
  it("rejects a filled or recolored forehead opening even if the paint diagnostic is rewritten", () => {
    const b = unit(units[0]);
    for (const color of [[32, 25, 20], [255, 0, 230]] as const) {
      const rendered = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
      const p = rendered.diagnostic.shortFringe.windows[0], r = CLASSIC_LAYOUT.head.base.front;
      expect(p).toBeDefined();
      const i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
      rendered.atlas.rgba.set(color, i);
      const declared = rendered.diagnostic.surfacePixels.find(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)!;
      declared.color = [...color];
      expect(measureReferenceRenderedQuality(rendered, b.baseline, b.source, b.design, b.style).violations).toContain("short_fringe_window_invalid");
    }
    const rendered = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    rendered.diagnostic.shortFringe.windows = [];
    expect(measureReferenceRenderedQuality(rendered, b.baseline, b.source, b.design, b.style).violations).toContain("short_fringe_contract_changed");
  });
  it("keeps frozen source plans/geometry and constrains atlas changes to head hair", async () => {
    const previousRoot = "evaluation-artifacts/reference-primary-integration-20261005-rpJfzp";
    const beforeFringeRoot = "evaluation-artifacts/reference-primary-integration-20261005-NFFoTl";
    const frozen = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const fixtures: AnnotatedCase[] = JSON.parse(frozen.toString());
    const previous: { cases: Array<{ caseId: string; sourcePlanHash: string; geometryHash: string; defaultAtlasHash: string }> } = JSON.parse(readFileSync(`${previousRoot}/results.json`, "utf8"));
    const root = mkdtempSync("evaluation-artifacts/reference-short-hair-frozen-20261005-"), evidence = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      for (const fixture of fixtures) {
        const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        // Isolate this historical hair comparison from the separately tested
        // scarf/belt palette migration. Current colors have their own frozen
        // boundary test; old artifacts remain read-only.
        const analysis = normalizeAnalysisForRendering(raw), source = historicalScarfBeltPlan(buildSkinPlan(analysis));
        const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
        const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
        const selected = selectReferenceStyleAtlas(baseline, source, buildPreFeedbackReferenceDesign(analysis), style).selected!;
        expect(selected, fixture.id).not.toBeNull();
        const old = previous.cases.find(c => c.caseId === fixture.id)!;
        expect(hash(JSON.stringify(historicalHairMaterialPlan(source))), fixture.id).toBe(old.sourcePlanHash);
        expect(hash(JSON.stringify(analysis.identityGeometry ?? null)), fixture.id).toBe(old.geometryHash);
        const before = await decodePng(readFileSync(`${previousRoot}/${fixture.id}-default.png`));
        const beforeFringe = await decodePng(readFileSync(`${beforeFringeRoot}/${fixture.id}-default.png`));
        const historical = historicalHairMaterialReplay(features, style, source, selected.design, selected.composition);
        const irisPixels = assertSingletonPigmentBoundary(historical.composition.atlas, beforeFringe, source, style);
        const allowed = new Set(source.headIdentityPlan.ownership!.cells.filter(c => ["hair_base", "hair_outer"].includes(c.owner)).map(c => {
          const r = CLASSIC_LAYOUT.head[c.layer === "outer" ? "overlay" : "base"][c.face]; return ((r.y + c.y) * 64 + r.x + c.x) * 4;
        }));
        const differences = [];
        for (let i = 0; i < before.rgba.length; i += 4) if ([0, 1, 2, 3].some(ch => before.rgba[i + ch] !== historical.composition.atlas.rgba[i + ch])) {
          // The separately reviewed iris-palette fix is frozen exactly by
          // beforeFringe above; it is not part of the hair edit.
          const front = CLASSIC_LAYOUT.head.base.front;
          const reviewedIris = selected.composition.diagnostic.faceFinish.irisPigmentCells.some(p => ((front.y + p.y) * 64 + front.x + p.x) * 4 === i);
          expect(allowed.has(i) || reviewedIris, `${fixture.id}: unrelated pixel changed at ${i}`).toBe(true);
          differences.push({ x: (i / 4) % 64, y: Math.floor(i / 256) });
        }
        const craft = validateReferenceAtlasCraft(selected.composition.atlas, baseline, source, style, buildReferenceCraftPlan(source, selected.design, selected.composition));
        expect(craft.ok, fixture.id).toBe(true);
        expect(selected.quality.violations).toEqual([]);
        writeFileSync(`${root}/${fixture.id}-default.png`, await encodePng(selected.composition.atlas), { flag: "wx" });
        evidence.push({ caseId: fixture.id, calibrated: !!fixture.existing, historicalMaterialProjectionEqualOutsideSingletonIris: true, intentionalIrisPixels: irisPixels, intentionalMaterialPixels: historical.changedPixels, geometryEqual: true, atlasEqual: !differences.length, changedPixels: differences, selectedHair: selected.design.hair.family, craft: true });
      }
      expect(evidence).toHaveLength(12); expect(evidence.filter(c => c.calibrated)).toHaveLength(5);
      expect(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json")).toEqual(frozen);
      expect(network).not.toHaveBeenCalled();
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, previousRoot, beforeFringeRoot, cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_SHORT_HAIR_FROZEN ${root}`);
    } finally { network.mockRestore(); }
  }, 180_000);
  it("records family differences without rewriting the source mask or facial measurements", async () => {
    const root = mkdtempSync("evaluation-artifacts/reference-short-hair-20261005-");
    const beforeRoot = "evaluation-artifacts/reference-short-hair-20261005-fUleYs";
    const previous: { cases: Array<{ id: string; sourceHash: string; atlasHash: string }> } = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8"));
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis"), evidence = [];
    try {
      const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const u of units) {
        const b = unit(u), sourceHash = hash(JSON.stringify(b.source));
        const alternatives = [];
        for (const family of ["short_shaggy_masculine", "short_soft_feminine"] as const) {
          const design = structuredClone(b.design); design.hair = { ...design.hair, family };
          const rendered = composeReferenceStyleAtlas(b.baseline, b.source, design, b.style);
          expect(measureReferenceRenderedQuality(rendered, b.baseline, b.source, design, b.style).violations).toEqual([]);
          const frontAccents = rendered.diagnostic.surfaces.filter(c => c.owner === "hair" && c.layer === "overlay" && c.face === "front");
          expect(frontAccents.length).toBeGreaterThan(0);
          const crown = frontAccents.filter(c => c.y === 0).map(c => c.x).sort();
          expect(crown).toEqual(family === "short_shaggy_masculine" ? [1, 2, 5, 6] : [2, 3, 4, 5]);
          expect(rendered.diagnostic.constraints.outerHairCells).toBeLessThan(rendered.diagnostic.constraints.baseHairCells);
          alternatives.push({ family, atlasHash: hash(rendered.atlas.rgba), hair: rendered.diagnostic.surfaces.filter(c => c.owner === "hair"), constraints: rendered.diagnostic.constraints });
          for (const view of renderSkinViews(rendered.atlas)) writeFileSync(`${root}/${u.id}-${family}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
        }
        runPrimary.mockResolvedValue({ ok: true, analysis: b.raw, neuronsSpent: 0, attempts: 1 });
        const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
        const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
        const result = await generateSkin(env, input);
        expect(result.status, u.id).toBe(200);
        const chosen = selectReferenceStyleAtlas(b.baseline, b.source, b.design, b.style).selected!;
        expect(chosen).not.toBeNull();
        expect(chosen.design.hair.family).toBe(u.fringeEdge === "staggered" ? "short_shaggy_masculine" : "short_soft_feminine");
        expect(chosen.composition.diagnostic.hairAccentCells).toBeGreaterThan(0);
        const atlas = await decodePng(base64ToBytes(result.body.skinPngBase64!));
        expect(atlas.rgba).toEqual(chosen.composition.atlas.rgba);
        const prior = previous.cases.find(c => c.id === u.id)!;
        // The immutable outfit implementation recovers all four old full-plan
        // hashes with exactly these five sweatshirt evidence/provenance deltas
        // (shortHairHistoricalPlanAudit.test.ts). Never exempt garment geometry.
        const historicalPlan = historicalHairMaterialPlan(b.source);
        const outfit = historicalPlan.outfitPlan;
        for (const sleeve of [outfit.upper.leftSleeve, outfit.upper.rightSleeve]) {
          expect(sleeve.length).toBe("long"); expect(sleeve.source).toBe("strongly_implied");
          sleeve.source = "observed";
        }
        expect(outfit.upper.pattern.evidence).toBe("black sweatshirt");
        outfit.upper.pattern.evidence = "";
        const provenance = outfit.provenance.find(p => p.target === "upper.sleeves")!;
        expect(provenance.source).toBe("strongly_implied"); expect(provenance.confidence).toBe(0.58);
        provenance.source = "observed"; provenance.confidence = 0.85;
        expect(hash(JSON.stringify(historicalPlan))).toBe(prior.sourceHash);
        const legacyChoice = selectReferenceStyleAtlas(b.baseline, b.source, buildPreFeedbackReferenceDesign(b.analysis), b.style).selected!;
        const historical = historicalHairMaterialReplay(b.features, b.style, b.source, legacyChoice.design, legacyChoice.composition);
        const before = await decodePng(readFileSync(`${beforeRoot}/${u.id}-default.png`));
        expect(hash(before.rgba)).toBe(prior.atlasHash);
        const front = CLASSIC_LAYOUT.head.base.front;
        const allowedChanges = chosen.composition.diagnostic.shortFringe.windows.map(p => ((front.y + p.y) * 64 + front.x + p.x) * 4);
        const changedPixels = [];
        for (let i = 0; i < atlas.rgba.length; i += 4) if ([0, 1, 2, 3].some(ch => historical.composition.atlas.rgba[i + ch] !== before.rgba[i + ch])) {
          expect(allowedChanges, `${u.id}: unauthorized before/after change ${i}`).toContain(i);
          changedPixels.push({ x: (i / 4) % 64, y: Math.floor(i / 256) });
        }
        expect(changedPixels).toHaveLength(allowedChanges.length);
        expect(validateFinalAtlas(atlas).ok).toBe(true);
        expect(validateReferenceAtlasCraft(atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, chosen.design, chosen.composition)).ok).toBe(true);
        expect(chosen.composition.diagnostic.constraints.violations).toEqual([]);
        expect(chosen.composition.diagnostic.surfaces.filter(c => c.owner === "hair").every(c => c.part === "head")).toBe(true);
        expect(hash(JSON.stringify(b.source))).toBe(sourceHash);
        expect(hash(JSON.stringify(result.body.analysis!.skinPlan))).toBe(sourceHash);
        expect(b.analysis.identityGeometry).toBeUndefined();
        expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        writeFileSync(`${root}/${u.id}-default.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${u.id}-default-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
        const beforeFront = renderSkinViews(before).find(v => v.name === "front")!.image;
        writeFileSync(`${root}/${u.id}-before-front.png`, await encodePng(scaleNearestNeighbor(beforeFront, beforeFront.width * 4, beforeFront.height * 4)), { flag: "wx" });
        evidence.push({ id: u.id, provenance: "authored_semantic_design_unit", sourceHash, historicalPlanHashRecovered: true, intentionalSweatshirtEvidenceFields: 5, beforeAtlasHash: prior.atlasHash, changedPixels, intentionalMaterialPixels: historical.changedPixels, sourceHairMask: b.source.hairPlan.headMask, semanticFirst: b.design.hair, selected: chosen.design.hair, shortFringe: chosen.composition.diagnostic.shortFringe, alternatives, atlasHash: hash(atlas.rgba), quality: chosen.quality, constraints: chosen.composition.diagnostic.constraints });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, primaryStage: "mocked_semantic_units", beforeRoot, cases: evidence }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_SHORT_HAIR ${root}`);
    } finally { network.mockRestore(); runPrimary.mockRestore(); }
  }, 180_000);
});
