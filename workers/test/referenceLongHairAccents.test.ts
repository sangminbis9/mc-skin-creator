// Authored semantic units, not new annotations or provider observations.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { PhotoAnalysis } from "../src/analysis";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { historicalHairMaterialPlan, historicalHairMaterialReplay, withHistoricalCalmMouth } from "./historicalHairMaterial";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const beforeRoot = "evaluation-artifacts/reference-long-hair-accents-20261008-dij1r8";
const units = [
  { id: "jaw-layered", length: "jaw", texture: "straight", part: "none" },
  { id: "chest-straight", length: "chest", texture: "straight", part: "none" },
  { id: "chest-wavy", length: "chest", texture: "wavy", part: "none" },
  { id: "chest-parted", length: "chest", texture: "straight", part: "center" },
] as const;

function setup(u: typeof units[number]) {
  const a = makeAnalysis();
  const hair = `${u.length} length brown ${u.texture} hair with ${u.part === "center" ? "center part and forehead opening" : "straight bangs"}${u.length === "chest" ? " drapes over shoulders" : ""}`;
  a.observed = { face: "neutral expression", hair, accessories: "none", clothing: "gray sweatshirt", colorPalette: ["brown", "gray"] };
  a.identityPrompt = hair; a.outfitPrompt = "gray sweatshirt";
  a.canonicalIdentity.overallImpression = hair;
  a.canonicalIdentity.mustPreserve = [hair, "brown hair", "gray sweatshirt"];
  a.canonicalIdentity.features = [
    { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: hair, targetRegions: ["head.front", "head.back"] },
    { feature: "brown hair", category: "hair", priority: 4, confidence: "high", evidence: "brown hair", targetRegions: ["head.front"] },
    { feature: "neutral face", category: "face", priority: 3, confidence: "high", evidence: "neutral expression", targetRegions: ["head.front"] },
    { feature: "gray sweatshirt", category: "outfit", priority: 3, confidence: "high", evidence: "gray sweatshirt", targetRegions: ["torso.front"] },
  ];
  Object.assign(a.renderHints, { bangs: "straight", bangsLength: "short", bangsDensity: "balanced", fringeEdge: "wispy", fringeOpening: u.part,
    hairPart: u.part, hairTexture: u.texture, hairVolume: "normal", hairSilhouette: "rounded", overallHairLength: u.length,
    sideHairLength: u.length === "jaw" ? "jaw" : "shoulder", hairBackShape: u.length === "jaw" ? "rounded" : "long",
    mouthOpening: "closed", mouthShape: "small", neckAccessory: "none" } satisfies Partial<PhotoAnalysis["renderHints"]>);
  Object.assign(a.fallbackFeatures, { hairColor: "brown", hairstyle: "long", glasses: "none", hat: "none", facialHair: "none", earrings: false, expression: "neutral", topType: "sweater", topColor: "gray" });
  a.inferred.hairBack = { value: `${u.length === "jaw" ? "rounded" : "long"} back hair matching the observed sides`, rationale: "authored unseen completion" };
  const analysis = normalizeAnalysisForRendering(a), source = buildSkinPlan(analysis);
  const colors = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, colors, source.hairPlan);
  const baseline = buildProceduralSourceAtlas(colors, style, source)!;
  return { source, style, baseline, colors, design: buildReferenceStylePlan(analysis) };
}

it("breaks the categorical long-hair outer helmet rim without changing the inner foundation", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const root = mkdtempSync("evaluation-artifacts/reference-long-hair-accents-20261008-");
  const records = [];
  try {
    for (const u of units) {
      const b = setup(u), sourceHash = sha(JSON.stringify(b.source));
      const composition = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
      const selected = selectReferenceStyleAtlas(b.baseline, b.source, b.design, b.style).selected!;
      expect(selected).not.toBeNull();
      expect(selected.design.hair.family).toBe(b.design.hair.family);
      expect(selected.composition.atlas.rgba).toEqual(composition.atlas.rgba);
      const craft = validateReferenceAtlasCraft(composition.atlas, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, b.design, composition));
      expect(craft.ok, u.id).toBe(true);
      expect(sha(JSON.stringify(b.source))).toBe(sourceHash);
      const crown = composition.diagnostic.surfaces.filter(c => c.part === "head" && c.owner === "hair" && c.layer === "overlay" && c.face === "front" && c.y === 0).map(c => c.x).sort();
      const oldCases = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8")).cases as Array<{ id: string; sourceHash: string }>;
      // This authored gray-sweatshirt unit predates the explicit implied-
      // sleeve provenance repair. Reverse only its metadata for the old pin;
      // current geometry/material and all other plan fields remain checked.
      const historicalPlan = historicalHairMaterialPlan(b.source);
      writeFileSync(`${root}/${u.id}-source-plan.json`, JSON.stringify(historicalPlan, null, 2), { flag: "wx" });
      for (const sleeve of [historicalPlan.outfitPlan.upper.leftSleeve, historicalPlan.outfitPlan.upper.rightSleeve]) {
        expect(sleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied", evidence: "gray sweatshirt" });
        sleeve.source = "observed";
      }
      const sleeveProvenance = historicalPlan.outfitPlan.provenance.find(p => p.target === "upper.sleeves")!;
      expect(sleeveProvenance).toEqual({ target: "upper.sleeves", source: "strongly_implied", evidence: "gray sweatshirt", confidence: 0.58 });
      sleeveProvenance.source = "observed"; sleeveProvenance.confidence = 0.85;
      expect(historicalPlan.outfitPlan.upper.pattern.evidence).toBe("gray sweatshirt");
      historicalPlan.outfitPlan.upper.pattern.evidence = "";
      expect(sha(JSON.stringify(historicalPlan))).toBe(oldCases.find(c => c.id === u.id)!.sourceHash);
      // Isolate historical outer-hair/material changes from later neutral face presentation.
      const historical = withHistoricalCalmMouth(() => historicalHairMaterialReplay(b.colors, b.style, b.source, b.design,
        composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style)));
      const before = await decodePng(readFileSync(`${beforeRoot}/${u.id}.png`));
      const headOuter = new Set(Object.values(CLASSIC_LAYOUT.head.overlay).flatMap(r => Array.from({ length: r.w * r.h }, (_, i) => ((r.y + Math.floor(i / r.w)) * 64 + r.x + i % r.w) * 4)));
      let changed = 0;
      for (let i = 0; i < before.rgba.length; i += 4) if ([0, 1, 2, 3].some(ch => before.rgba[i + ch] !== historical.composition.atlas.rgba[i + ch])) {
        expect(headOuter.has(i), `${u.id}: non-head-overlay change at ${i}`).toBe(true);
        expect(before.rgba[i + 3]).toBe(255);
        expect(composition.atlas.rgba[i + 3]).toBe(0); // removal only, no invented raised mass
        changed++;
      }
      expect(changed).toBeGreaterThan(0);
      expect(crown).toEqual(u.part === "center" ? [1, 2, 5, 6] : [1, 2, 3, 4, 5, 6]);
      records.push({ id: u.id, sourceHash, historicalPlanHash: sha(JSON.stringify(historicalPlan)),
        sweatshirtMetadataDelta: ["outfitPlan.upper.leftSleeve.source", "outfitPlan.upper.rightSleeve.source", "outfitPlan.upper.pattern.evidence", "outfitPlan.provenance[upper.sleeves].source", "outfitPlan.provenance[upper.sleeves].confidence"],
        intentionalMaterialPixels: historical.changedPixels, family: b.design.hair.family, crown, accents: composition.diagnostic.hairAccentCells,
        baseHair: composition.diagnostic.constraints.baseHairCells, outerHair: composition.diagnostic.constraints.outerHairCells,
        atlasSha: sha(composition.atlas.rgba), craft: craft.ok });
      writeFileSync(`${root}/${u.id}.png`, await encodePng(composition.atlas), { flag: "wx" });
      for (const view of renderSkinViews(composition.atlas)) writeFileSync(`${root}/${u.id}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ provenance: "authored_semantic_units", providerCalls: 0, cases: records }, null, 2), { flag: "wx" });
    console.info("LONG_HAIR_ACCENTS", root, JSON.stringify(records));
    for (const row of records) {
      expect(row.crown.length, row.id).toBeGreaterThan(0);
      expect(row.crown.length, row.id).toBeLessThan(8);
      expect(row.outerHair, row.id).toBeLessThan(row.baseHair);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 60000);

it("protects measured masks, flat silhouettes and the covering gate; part alone never invents an opening", () => {
  for (const mutate of [
    (b: ReturnType<typeof setup>) => { b.style.hairSilhouette = "flat"; },
    (b: ReturnType<typeof setup>) => { b.source.hairPlan.headMask.source = "identity_geometry"; },
    (b: ReturnType<typeof setup>) => { b.source.facePixelPlan.layout.geometryUsage.hairline = true; },
    (b: ReturnType<typeof setup>) => { b.source.headIdentityPlan.ownership!.covering = true; },
  ]) {
    const b = setup(units[0]); mutate(b);
    const output = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    const crown = output.diagnostic.surfaces.filter(c => c.part === "head" && c.owner === "hair" && c.layer === "overlay" && c.face === "front" && c.y === 0);
    expect(crown).toHaveLength(8);
  }
  const parted = setup(units[3]); parted.style.fringeOpening = "none";
  const output = composeReferenceStyleAtlas(parted.baseline, parted.source, parted.design, parted.style);
  const crown = output.diagnostic.surfaces.filter(c => c.part === "head" && c.owner === "hair" && c.layer === "overlay" && c.face === "front" && c.y === 0).map(c => c.x).sort();
  expect(crown).toEqual([1, 2, 3, 4, 5, 6]);
});

it("varies only the raised root opening for independent source part parameters within one family", () => {
  const crowns = [];
  for (const part of ["none", "left", "center", "right"] as const) {
    const b = setup(units[3]);
    b.source.hairPlan.part = part; b.style.hairPart = part;
    b.style.fringeOpening = part;
    const source = JSON.stringify(b.source);
    const output = composeReferenceStyleAtlas(b.baseline, b.source, b.design, b.style);
    const crown = output.diagnostic.surfaces.filter(c => c.part === "head" && c.owner === "hair" && c.layer === "overlay" && c.face === "front" && c.y === 0).map(c => c.x).sort();
    const absent = part === "center" ? [3, 4] : part === "left" ? [2] : part === "right" ? [5] : [];
    expect(crown).toEqual([1, 2, 3, 4, 5, 6].filter(x => !absent.includes(x)));
    crowns.push(JSON.stringify(crown));
    expect(JSON.stringify(b.source)).toBe(source);
  }
  expect(new Set(crowns).size).toBe(4);
});
