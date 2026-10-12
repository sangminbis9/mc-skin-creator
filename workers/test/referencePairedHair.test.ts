import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferencePairedHair, buildReferencePairedDrape } from "../src/referencePairedHair";
import { composeReferenceStyleAtlas, referenceBaseHairColor } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { encodePng, decodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

// Explicit semantic design units, not fabricated frozen photo measurements.
function unit(kind: "braids" | "tails" | "ordinary", drape = false) {
  const raw = makeAnalysis();
  const hair = kind === "braids" ? "two long braids with bangs" : kind === "tails" ? "twin tails with bangs" : "long straight hair with bangs";
  raw.observed.hair = hair + (drape ? " drapes over shoulders" : ""); raw.observed.accessories = "none";
  raw.observed.clothing = "plain white top";
  raw.identityPrompt = raw.observed.hair; raw.outfitPrompt = raw.observed.clothing;
  raw.renderHints.overallHairLength = "chest"; raw.renderHints.sideHairLength = "shoulder";
  raw.renderHints.hairTexture = "straight"; raw.renderHints.bangs = "straight"; raw.renderHints.bangsLength = "short"; raw.renderHints.fringeEdge = "blunt";
  raw.fallbackFeatures.hairstyle = kind === "tails" ? "twintails" : "long";
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "none";
  raw.canonicalIdentity.features = [{ feature: raw.observed.hair, category: "hair", priority: 5, confidence: "high", evidence: raw.observed.hair, targetRegions: ["head.front", "head.back"] }];
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), baseline = buildProceduralFallbackAtlas(features, style, plan)!;
  expect(baseline).not.toBeNull();
  return { plan, style, baseline, design: buildReferenceStylePlan(analysis) };
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function headSheet(atlas: RawImage, face: "back" | "front", layer: "base" | "overlay") {
  const r = CLASSIC_LAYOUT.head[layer][face], image: RawImage = { width: 8, height: 8, rgba: new Uint8Array(256) };
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) image.rgba.set(atlas.rgba.slice(((r.y + y) * 64 + r.x + x) * 4, ((r.y + y) * 64 + r.x + x) * 4 + 4), (y * 8 + x) * 4);
  return scaleNearestNeighbor(image, 256, 256);
}

describe("source-supported paired rear silhouettes", () => {
  it.each(["braids", "tails"] as const)("authors %s from positive source evidence with immutable identity and legal craft", kind => {
    const b = unit(kind), identity = JSON.stringify(b.plan), baseline = b.baseline.rgba.slice();
    const construction = buildReferencePairedHair(b.plan, b.design);
    expect(construction.status, JSON.stringify({ construction, lengthClass: b.plan.hairPlan.lengthClass, source: b.plan.hairPlan.headMask.source, structure: b.plan.hairPlan.structure.source, head: { covering: b.plan.headIdentityPlan.ownership!.covering, tiedMass: b.plan.headIdentityPlan.ownership!.tiedMass, derived: b.plan.headIdentityPlan.ownership!.cells.some(c => c.provenance === "validated_derived") } })).toBe("authored"); expect(construction.provenance).toBe("template_design");
    expect(construction.nape.length).toBeGreaterThan(0);
    const result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(result.diagnostic.pairedHair).toEqual(construction);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(result.atlas, b.baseline, b.plan, b.style, buildReferenceCraftPlan(b.plan, b.design, result)).ok).toBe(true);
    expect(JSON.stringify(b.plan)).toBe(identity); expect(b.baseline.rgba).toEqual(baseline);
    expect(result.diagnostic.drapeCells).toBe(0);
    expect(result.diagnostic.constraints.outerHairCells).toBeLessThan(result.diagnostic.constraints.baseHairCells);
    for (const p of b.plan.facePixelPlan.pixels.filter(p => p.role === "brow")) {
      const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
      expect(result.atlas.rgba.slice(i, i + 4)).toEqual(b.baseline.rgba.slice(i, i + 4));
    }
    for (const p of b.plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.face === "front" && c.owner === "hair_base")) {
      const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
      expect(result.diagnostic.surfaces.some(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y && c.owner === "hair")).toBe(true);
      const expected = referenceBaseHairColor([...b.baseline.rgba.slice(i, i + 3)] as [number, number, number], p, b.plan, b.design, b.style);
      expect([...result.atlas.rgba.slice(i, i + 3)]).toEqual(expected);
    }
    expect(composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style).atlas.rgba).toEqual(result.atlas.rgba);
  });
  it("changes the actual base ownership mask, not just strand color", () => {
    const braid = unit("braids"), tail = unit("tails");
    const masks = [braid, tail].map(b => buildReferencePairedHair(b.plan, b.design).nape.map(p => `${p.x}:${p.y}`));
    expect(masks[0]).not.toEqual(masks[1]); expect(masks.map(m => m.length)).toEqual([16, 14]);
    expect(masks[0]).toContain("2:4"); expect(masks[1]).not.toContain("2:4");
    expect(masks[1]).toContain("3:3"); expect(masks[0]).not.toContain("3:3");
  });
  it("does not manufacture paired hair from inferred, negated or wrong-category words", () => {
    const b = unit("ordinary"); b.design.hair.family = "twin_braids";
    b.plan.hiddenSurfaces.find(s => s.part === "head")!.completion = "two braids";
    b.plan.assignments.push({ ...b.plan.assignments[0], category: "outfit", feature: "two braids", evidence: "two braids" });
    expect(buildReferencePairedHair(b.plan, b.design).reason).toBe("observed_pair_missing");
    for (const s of b.plan.hiddenSurfaces.filter(s => s.part === "head")) s.evidence = "no twin braids";
    expect(buildReferencePairedHair(b.plan, b.design).status).toBe("source_preserved");
  });
  it.each(["measured", "covering", "accessory", "missing_foundation"] as const)("preserves %s source contracts rather than pruning to fit", reason => {
    const b = unit("braids"), p = buildReferencePairedHair(b.plan, b.design).nape[0];
    if (reason === "measured") b.plan.hairPlan.headMask.source = "identity_geometry";
    if (reason === "covering") b.plan.headIdentityPlan.ownership!.covering = true;
    if (reason === "accessory") b.plan.headIdentityPlan.ownership!.cells.push({ ...p, layer: "outer", owner: "other_p5", sourceGroupId: "unit_accessory", provenance: "observed" });
    if (reason === "missing_foundation") b.plan.headIdentityPlan.ownership!.cells = b.plan.headIdentityPlan.ownership!.cells.filter(c => !(c.layer === "base" && c.face === p.face && c.x === p.x && c.y === p.y));
    expect(buildReferencePairedHair(b.plan, b.design).status).toBe("source_preserved");
    expect(buildReferencePairedHair(b.plan, b.design).nape).toEqual([]);
  });
  it("rejects rewritten diagnostics that try to erase a rear lock or repaint the nape", () => {
    const b = unit("braids");
    for (const owner of ["hair", "face"] as const) {
      const result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
      const c = result.diagnostic.surfacePixels.find(c => c.part === "head" && c.layer === "base" && c.face === "back" && c.owner === owner && c.y >= 4)!;
      const r = CLASSIC_LAYOUT.head.base.back, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      result.atlas.rgba.set([220, 3, 230], i); c.color = [220, 3, 230];
      if (owner === "hair") result.diagnostic.pairedHair.nape.push({ face: "back", x: c.x, y: c.y });
      const q = measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style);
      expect(q.constructionValid).toBe(false);
      expect(q.violations).toContain(owner === "hair" ? "paired_hair_contract_changed" : "paired_hair_nape_invalid");
    }
  });
  it("rejects erased paired accents even if executable paint diagnostics are removed", () => {
    const b = unit("tails"), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const p = result.diagnostic.pairedHair.accents[0], r = CLASSIC_LAYOUT.head.overlay.back;
    result.atlas.rgba.fill(0, ((r.y + p.y) * 64 + r.x + p.x) * 4, ((r.y + p.y) * 64 + r.x + p.x) * 4 + 4);
    result.diagnostic.surfaces = result.diagnostic.surfaces.filter(c => !(c.part === "head" && c.layer === "overlay" && c.face === "back" && c.x === p.x && c.y === p.y));
    result.diagnostic.surfacePixels = result.diagnostic.surfacePixels.filter(c => !(c.part === "head" && c.layer === "overlay" && c.face === "back" && c.x === p.x && c.y === p.y));
    expect(measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style).violations).toContain("paired_hair_accent_missing");
  });
  it.each(["braids", "tails"] as const)("allows %s shoulder drape only from explicit evidence and bottom-lock connectivity", kind => {
    const b = unit(kind, true), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(result.diagnostic.drapeCells).toBe(kind === "braids" ? 22 : 26); expect(result.diagnostic.constraints.ok).toBe(true);
    expect(result.diagnostic.surfaces.filter(c => c.owner === "hair" && c.part !== "head").every(c => c.layer === "base" && !!c.drapeGroup)).toBe(true);
    expect(buildReferencePairedDrape(b.plan, b.design, b.style).filter(c => c.y < 2).every(c => c.x === 0 || c.x === 7)).toBe(true);
    expect(measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
  });
  it("does not accept fake shoulder evidence or an erased braid junction", () => {
    const b = unit("braids"); b.design.drape = { eligible: true, maxShoulderColumns: 1, evidence: ["fabricated diagnostic"] };
    expect(buildReferencePairedDrape(b.plan, b.design, b.style)).toEqual([]);
    expect(composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style).diagnostic.drapeCells).toBe(0);
    const actual = unit("braids", true), result = composeReferenceStyleAtlas(actual.baseline, actual.plan, actual.design, actual.style);
    const p = buildReferencePairedDrape(actual.plan, actual.design, actual.style).find(c => c.x === 1 && c.y === 3)!;
    const r = CLASSIC_LAYOUT.body.base.front, i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
    result.atlas.rgba.set([150, 140, 130], i);
    result.diagnostic.surfacePixels.find(c => c.part === "body" && c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)!.color = [150, 140, 130];
    expect(measureReferenceRenderedQuality(result, actual.baseline, actual.plan, actual.design, actual.style).violations).toContain("paired_hair_drape_invalid");
  });
  it.each(["braids", "tails"] as const)("does not rank a generic curtain above supported %s identity", kind => {
    const b = unit(kind, true), selection = selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(selection.selected, JSON.stringify(selection.candidates)).not.toBeNull();
    expect(selection.selected!.design.hair.family).toBe(kind === "braids" ? "twin_braids" : "twin_tails");
    expect(selection.candidates.filter(c => !c.id.includes(kind === "braids" ? "twin_braids" : "twin_tails")).every(c => c.quality?.violations.includes("source_paired_hair_missing"))).toBe(true);
  });
  it("saves genuine front/back/side atlas comparisons in a fresh offline-only root", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const root = mkdtempSync("evaluation-artifacts/reference-paired-hair-20261005-");
      const evidence = [];
      for (const kind of ["braids", "tails"] as const) {
        const b = unit(kind, true), result = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
        const png = await encodePng(result.atlas); expect((await decodePng(png)).rgba).toEqual(result.atlas.rgba);
        writeFileSync(`${root}/${kind}.png`, png, { flag: "wx" });
        for (const [stage, atlas] of [["before", b.baseline], ["styled", result.atlas]] as const) {
          for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${kind}-${stage}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
          for (const layer of ["base", "overlay"] as const) writeFileSync(`${root}/${kind}-${stage}-${layer}-back.png`, await encodePng(headSheet(atlas, "back", layer)), { flag: "wx" });
        }
        evidence.push({ kind, provenance: "semantic_unit_template_design", sourcePlanHash: hash(JSON.stringify(b.plan)), baselineHash: hash(b.baseline.rgba), styledHash: hash(result.atlas.rgba), construction: result.diagnostic.pairedHair, quality: measureReferenceRenderedQuality(result, b.baseline, b.plan, b.design, b.style), constraints: result.diagnostic.constraints, drapeCells: result.diagnostic.drapeCells });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, cases: evidence }, null, 2), { flag: "wx" });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
