import { describe, expect, it, vi } from "vitest";
import * as uv from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { measureReferenceAccessoryRetention, measureReferenceGarmentFoundation, measureReferenceGarmentStructure, sourceAccessoryStencils } from "../src/referenceOutfitRetention";
import { applyOutfitPlan } from "../src/outfitRenderer";
import type { OutfitAccessoryKind } from "../src/outfitIdentity";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture(kind: OutfitAccessoryKind, color = "#da426a") {
  const raw = makeAnalysis();
  raw.observed.hair = "short straight hair"; raw.observed.clothing = "white school cardigan with long sleeves";
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "none";
  raw.renderHints.overallHairLength = "ear"; raw.renderHints.sideHairLength = "short";
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const plan = buildSkinPlan(analysis), style = buildFaceStyle(analysis, features, plan.hairPlan);
  // Explicit authored unit source contract, not a patched frozen annotation.
  plan.outfitPlan.accessories = [{ kind, color, side: "left", source: "observed", evidence: `unit source visibly has ${kind}` }];
  plan.outfitPlan.outerLayer.regions = ["collar", "cuffs", "hem", "skirt_pleats", "pocket", "legwear", "lower_accent", "lower_fold", "shoe_depth"];
  const baseline = buildProceduralFallbackAtlas(features, style, plan)!;
  const design = buildReferenceStylePlan(analysis);
  return { plan, style, baseline, design };
}
const kinds: OutfitAccessoryKind[] = ["bag_strap", "scarf", "bow", "tie", "necklace", "suspenders", "belt", "large_pocket", "hood_string", "thigh_accessory"];
describe("independent source accessory retention", () => {
  it("reuses only immutable UV pairs, never source paints or prior validation results", () => {
    const b = fixture("scarf"), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const seams = vi.spyOn(uv, "getBoxUvSeams");
    const measure = () => measureReferenceGarmentStructure(composed.atlas, b.plan.outfitPlan,
      b.style.skinTone!, b.design, composed.diagnostic.bodyGroups);
    try {
      const original = measure();
      expect(original.valid).toBe(true);
      expect(original.cues.some(c => c.coveredBySourceConstruction > 0)).toBe(true);
      expect(seams).not.toHaveBeenCalled();
      // Returned diagnostics and source inputs cannot poison a shared UV graph.
      const expected = structuredClone(original);
      original.cues.length = 0; original.violations.push("mutated_result");
      expect(measure()).toEqual(expected);
      b.plan.outfitPlan.outerLayer.regions = []; b.plan.outfitPlan.accessories = [];
      expect(measure().violations).toContain("source_structure_unproven:structure:collar");
      expect(seams).not.toHaveBeenCalled();
    } finally { seams.mockRestore(); }
  });
  it("retains budget-routed actual legwear and earlier pleats without inventing a cue over pants", () => {
    const b = fixture("thigh_accessory");
    // A regions[] entry alone is not legwear evidence. Author real occupied
    // cloth with enough depth to exercise budget routing, not phantom socks.
    b.plan.outfitPlan.lower.garmentRows = 1; b.plan.outfitPlan.lower.shoeRows = 1;
    b.plan.outfitPlan.lower.legwear = { kind: "stockings", color: "#eeeae1", asymmetry: "both", source: "observed" };
    const source = buildProceduralFallbackAtlas({}, b.style, b.plan)!;
    const composed = composeReferenceStyleAtlas(source, b.plan, b.design, b.style);
    const quality = measureReferenceRenderedQuality(composed, source, b.plan, b.design, b.style);
    expect(quality.violations, JSON.stringify(quality.garmentStructure)).toEqual([]);
    const cue = quality.garmentStructure.cues.find(c => c.id === "structure:legwear")!;
    expect(cue.visibleSourcePixels).toBeGreaterThan(0);
    expect(cue.retainedPixels).toBe(cue.visibleSourcePixels);
    expect(composed.diagnostic.bodyGroups.find(g => g.id === "structure:legwear")!.placement).toBe("base_anchor");
    const pleats = quality.garmentStructure.cues.find(c => c.id === "structure:skirt_pleats")!;
    expect(pleats.visibleSourcePixels).toBeGreaterThan(0);
    expect(pleats.retainedPixels).toBe(pleats.visibleSourcePixels);
    expect(quality.garmentFoundation.valid).toBe(true);
  });
  it("rejects a complete source collar deletion even if its entire executable diagnostic is removed", () => {
    const b = fixture("thigh_accessory"), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const clean = measureReferenceGarmentStructure(composed.atlas, b.plan.outfitPlan, b.style.skinTone!, b.design, composed.diagnostic.bodyGroups);
    expect(clean.violations, JSON.stringify(clean.cues)).toEqual([]);
    const bare = { ...composed.atlas, rgba: composed.atlas.rgba.slice() };
    applyOutfitPlan(bare, { ...b.plan.outfitPlan, accessories: [], outerLayer: { ...b.plan.outfitPlan.outerLayer, regions: [] } }, b.style.skinTone!);
    const collar = { ...bare, rgba: bare.rgba.slice() };
    applyOutfitPlan(collar, { ...b.plan.outfitPlan, accessories: [], outerLayer: { ...b.plan.outfitPlan.outerLayer, regions: ["collar"] } }, b.style.skinTone!);
    const removed = new Set<string>();
    for (const face of Object.keys(CLASSIC_LAYOUT.body.overlay) as Array<keyof typeof CLASSIC_LAYOUT.body.overlay>) {
      const outer = CLASSIC_LAYOUT.body.overlay[face], base = CLASSIC_LAYOUT.body.base[face];
      for (let y = 0; y < outer.h; y++) for (let x = 0; x < outer.w; x++) {
        const o = ((outer.y + y) * 64 + outer.x + x) * 4, i = ((base.y + y) * 64 + base.x + x) * 4;
        if (!collar.rgba[o + 3]) continue;
        // Remove both possible render routes, including the base route after
        // budget demotion. Erasing only outer would leave the real cue intact.
        composed.atlas.rgba.fill(0, o, o + 4);
        composed.atlas.rgba.set(bare.rgba.slice(i, i + 4), i);
        removed.add(`${face}:${x}:${y}`);
      }
    }
    composed.diagnostic.bodyGroups = composed.diagnostic.bodyGroups.filter(g => g.id !== "structure:collar");
    composed.diagnostic.surfaces = composed.diagnostic.surfaces.filter(c => !(c.part === "body" && removed.has(`${c.face}:${c.x}:${c.y}`)));
    composed.diagnostic.surfacePixels = composed.diagnostic.surfacePixels.filter(c => !(c.part === "body" && removed.has(`${c.face}:${c.x}:${c.y}`)));
    const quality = measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style);
    expect(quality.violations).toContain("source_structure_route_missing:structure:collar");
    expect(quality.violations).toContain("source_structure_missing:structure:collar");
  });
  it.each(kinds)("keeps the actual %s source footprint visible through selective construction", kind => {
    const b = fixture(kind), before = JSON.stringify(b.plan);
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const retention = measureReferenceAccessoryRetention(composed.atlas, b.plan.outfitPlan, b.style.skinTone!);
    expect(retention.violations, JSON.stringify(retention.cues)).toEqual([]);
    expect(retention.cues[0].sourcePixels).toBeGreaterThan(0);
    expect(retention.cues[0].retainedPixels).toBe(retention.cues[0].visibleSourcePixels);
    // Not every source accessory intersects a garment structure. Overlap is
    // exercised separately below; all ten must retain their full visible cue.
    expect(composed.diagnostic.bodyGroups.every(g => g.cells + g.coveredByAccessoryCells === g.sourceCells)).toBe(true);
    expect(JSON.stringify(b.plan)).toBe(before);
  });
  it("retains scarf/bow colors even where the collar source stencil overlaps", () => {
    for (const kind of ["scarf", "bow"] as const) {
      const b = fixture(kind), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
      const blocked = composed.diagnostic.bodyGroups.find(g => g.id === "structure:collar")!;
      expect(blocked.coveredByAccessoryCells).toBeGreaterThan(0);
      expect(blocked.cells + blocked.coveredByAccessoryCells).toBe(blocked.sourceCells);
      expect(measureReferenceAccessoryRetention(composed.atlas, b.plan.outfitPlan, b.style.skinTone!).valid).toBe(true);
    }
  });
  it("does not accept a hidden base scarf under opaque garment paint", () => {
    const b = fixture("scarf"), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const stencil = sourceAccessoryStencils(b.plan.outfitPlan, b.style.skinTone!)[0];
    for (const p of stencil.paints) {
      const o = CLASSIC_LAYOUT[p.part].overlay[p.face], base = CLASSIC_LAYOUT[p.part].base[p.face];
      composed.atlas.rgba.set([...p.color, 255], ((base.y + p.y) * 64 + base.x + p.x) * 4);
      composed.atlas.rgba.set([20, 90, 160, 255], ((o.y + p.y) * 64 + o.x + p.x) * 4);
    }
    const retention = measureReferenceAccessoryRetention(composed.atlas, b.plan.outfitPlan, b.style.skinTone!);
    expect(retention.valid).toBe(false); expect(retention.cues[0].retainedPixels).toBe(0);
  });
  it("rejects erased source accessories even when candidate diagnostics are rewritten to match", () => {
    const b = fixture("bow"), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const without = { ...composed.atlas, rgba: composed.atlas.rgba.slice() };
    applyOutfitPlan(without, { ...b.plan.outfitPlan, accessories: [], outerLayer: { ...b.plan.outfitPlan.outerLayer, regions: [] } }, b.style.skinTone!);
    const front = CLASSIC_LAYOUT.body.overlay.front;
    for (const p of sourceAccessoryStencils(b.plan.outfitPlan, b.style.skinTone!)[0].paints.filter(p => p.face === "front")) {
      const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
      composed.atlas.rgba.set([20, 90, 160, 255], i);
      for (const c of composed.diagnostic.surfacePixels) if (c.part === "body" && c.layer === "overlay" && c.face === p.face && c.x === p.x && c.y === p.y) c.color = [20, 90, 160];
    }
    const quality = measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style);
    expect(quality.violations).toContain("source_accessory_missing:accessory:bow:0");
  });
  it("records source-on-source occlusion without pretending both complete stencils remain visible", () => {
    const b = fixture("scarf");
    b.plan.outfitPlan.accessories.push({ kind: "necklace", color: "#9fa7b6", side: "center", source: "observed", evidence: "unit pendant layered over source scarf" });
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const retention = measureReferenceAccessoryRetention(composed.atlas, b.plan.outfitPlan, b.style.skinTone!);
    expect(retention.valid, JSON.stringify(retention)).toBe(true);
    expect(retention.cues[0].coveredByLaterSourceAccessory).toBeGreaterThan(0);
    expect(retention.cues[0].visibleSourcePixels).toBeLessThan(retention.cues[0].sourcePixels);
    expect(retention.cues[1].coveredByLaterSourceAccessory).toBe(0);
  });
  it("detects a garment material replacement even if the candidate paint contract agrees", () => {
    const b = fixture("bow"), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const c = composed.diagnostic.surfacePixels.find(c => c.part === "body" && c.face === "front" && c.layer === "base" && c.owner === "garment")!;
    const r = CLASSIC_LAYOUT[c.part].base[c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
    c.color = [250, 0, 239]; composed.atlas.rgba.set(c.color, i);
    const quality = measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style);
    expect(quality.violations).toContain("source_garment_foundation_changed:body");
    expect(quality.violations).not.toContain("paint_contract_mismatch:garment");
  });
  it("keeps wrap stripe colors and source sleeve/exposure boundaries", () => {
    const b = fixture("necklace");
    b.plan.outfitPlan.upper.pattern = { kind: "horizontal_stripe", placement: "wrap", color: "#bfa89d", stripeColors: ["#bfa89d", "#6a7896"], anchor: "center", frequency: 2, source: "observed", evidence: "authored unit source has alternating wrap stripes" };
    b.plan.outfitPlan.upper.rightSleeve.terminationRow = 4; b.plan.outfitPlan.upper.rightSleeve.length = "short";
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const foundation = measureReferenceGarmentFoundation(composed.atlas, b.plan.outfitPlan, b.style.skinTone!, b.design, composed.diagnostic.bodyGroups, composed.diagnostic.surfaces);
    expect(foundation.valid, JSON.stringify(foundation)).toBe(true);
    expect(foundation.unchangedBasePixels + foundation.materialFoldPixels + foundation.authorizedConstructionPixels + foundation.connectedHairDrapePixels + foundation.designedFloralPixels).toBe(foundation.sourceBasePixels);
    // Erase one source stripe and extend one sleeve into visible skin. Even
    // a fabricated base-route declaration cannot authorize either change.
    for (const [part, x, y] of [["body", 0, 2], ["rightArm", 0, 7]] as const) {
      const damaged = { ...composed.atlas, rgba: composed.atlas.rgba.slice() }, r = CLASSIC_LAYOUT[part].base.front;
      damaged.rgba.set([20, 30, 90, 255], ((r.y + y) * 64 + r.x + x) * 4);
      const verified = measureReferenceGarmentFoundation(damaged, b.plan.outfitPlan, b.style.skinTone!, b.design, [{ id: "structure:collar", placement: "base_anchor" }], composed.diagnostic.surfaces);
      expect(verified.valid).toBe(false); expect(verified.violations).toContain(`source_garment_foundation_changed:${part}`);
    }
  });
});
