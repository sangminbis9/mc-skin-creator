import { describe, expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferencePairedDrapePlan } from "../src/referencePairedHair";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

// Authored semantic units: no photo identity, expected live answer or measurement.
function unit(kind: "braids" | "tails" = "braids") {
  const raw = makeAnalysis();
  raw.observed.hair = `Long chest-length brown hair with chin-length face-framing locks. Two ${kind === "braids" ? "small braids" : "ponytails"} drape over the chest.`;
  raw.observed.accessories = "none"; raw.observed.clothing = "plain white top";
  raw.identityPrompt = raw.observed.hair; raw.outfitPrompt = raw.observed.clothing;
  raw.canonicalIdentity.overallImpression = raw.observed.hair;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair, raw.observed.clothing];
  raw.inferred.hairBack = { value: "continue the paired silhouette", rationale: "unseen semantic completion" };
  raw.canonicalIdentity.features = [{ feature: raw.observed.hair, category: "hair", priority: 5, confidence: "high", evidence: raw.observed.hair, targetRegions: ["head.front", "head.back"] }];
  Object.assign(raw.renderHints, { overallHairLength: "chest", sideHairLength: "jaw", sideHairShape: "face_framing", hairTexture: "straight",
    hairBackShape: "long", bangs: "straight", bangsLength: "brow", hairPart: "center", fringeOpening: "center" });
  Object.assign(raw.fallbackFeatures, { hairstyle: "long", hairColor: "brown", glasses: "none", facialHair: "none", hat: "none", earrings: false });
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
  return { plan, style, design, baseline: buildProceduralSourceAtlas(features, style, plan)! };
}
function evidence(b: ReturnType<typeof unit>, text: string) {
  for (const s of b.plan.hiddenSurfaces.filter(s => s.part === "head")) s.evidence = text;
  for (const s of b.plan.assignments.filter(s => s.category === "hair")) { s.feature = text; s.evidence = text; }
}

describe("independent paired-lock and face-framing endpoints", () => {
  it.each(["braids", "tails"] as const)("authors connected inner %s without lengthening the source jaw cue", kind => {
    const b = unit(kind), frozen = JSON.stringify(b.plan), result = buildReferencePairedDrapePlan(b.plan, b.design, b.style);
    expect(result.junctions).toEqual([{ face: "front", x: 0, y: 7, drapeGroup: "left_lock" }, { face: "front", x: 7, y: 7, drapeGroup: "right_lock" }]);
    expect(result.points).toHaveLength(kind === "braids" ? 22 : 26);
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(composed.diagnostic.drapeCells).toBe(result.points.length);
    expect(measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
    expect(validateReferenceAtlasCraft(composed.atlas, b.baseline, b.plan, b.style, buildReferenceCraftPlan(b.plan, b.design, composed)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style).atlas.rgba).toEqual(composed.atlas.rgba);
    expect(JSON.stringify(b.plan)).toBe(frozen);
    expect(b.plan.hairPlan.headMask.semanticSilhouette?.sideEndpointCue).toBe("jaw");
    expect(composed.diagnostic.surfaces.filter(c => c.owner === "hair" && c.part !== "head").every(c => c.part === "body" && c.face === "front" && c.layer === "base")).toBe(true);
  });

  it.each([
    "two small braids; unrelated loose hair drapes over the chest",
    "two small braids drape behind the back at chest level",
    "two small braids possibly drape over the chest",
    "two small braids do not drape over the chest",
    "two small braids drape over the shoulders",
    "two small braids drape at an unknown length",
    "two small braids drape over the chest but are hidden",
    "long loose hair drapes over the chest",
  ])("cannot promote unrelated, contradictory or uncertain evidence: %s", text => {
    const b = unit(); evidence(b, text);
    expect(buildReferencePairedDrapePlan(b.plan, b.design, b.style)).toEqual({ points: [], junctions: [] });
  });

  it.each(["beard", "landmark", "accessory", "explicit_window", "base_face", "no_upper_root", "short_endpoint", "measured", "covering", "low_confidence"] as const)("preserves %s boundaries", reason => {
    const b = unit(), head = b.plan.headIdentityPlan.ownership!;
    if (reason === "beard") b.style.facialHair = "beard";
    if (reason === "landmark") b.plan.facePixelPlan.pixels.push({ ...b.plan.facePixelPlan.pixels.find(p => p.cluster === "left_eye")!, x: 0, y: 7 });
    if (reason === "accessory" || reason === "explicit_window" || reason === "base_face") head.cells.push({ face: "front", x: 0, y: 7,
      layer: reason === "base_face" ? "base" : "outer", owner: reason === "accessory" ? "other_p5" : reason === "base_face" ? "face" : "clear", provenance: "observed", sourceGroupId: "semantic_test_boundary" });
    if (reason === "no_upper_root") head.cells = head.cells.filter(c => !(c.face === "front" && c.x === 0 && c.y === 6 && c.layer === "base"));
    if (reason === "short_endpoint") b.plan.hairPlan.headMask.semanticSilhouette!.sideEndpointCue = "cheek";
    if (reason === "measured") b.plan.hairPlan.headMask.source = "identity_geometry";
    if (reason === "covering") head.covering = true;
    if (reason === "low_confidence") {
      for (const s of b.plan.hiddenSurfaces.filter(s => s.part === "head")) s.confidence = "low";
      for (const s of b.plan.assignments.filter(s => s.category === "hair")) s.confidence = "low";
    }
    expect(buildReferencePairedDrapePlan(b.plan, b.design, b.style)).toEqual({ points: [], junctions: [] });
  });

  it("removes a whole conflicting lock and its junction instead of severing or overwriting a strap", () => {
    const b = unit();
    b.plan.hairPlan.headMask.semanticSilhouette!.endpointCue = "waist";
    evidence(b, "two small braids drape over the waist");
    b.plan.outfitPlan.accessories.push({ kind: "bag_strap", color: "#d44681", side: "left", source: "observed", evidence: "observed diagonal strap" });
    const result = buildReferencePairedDrapePlan(b.plan, b.design, b.style);
    expect(result.points.some(c => c.drapeGroup === "right_lock")).toBe(false);
    expect(result.junctions).toEqual([{ face: "front", x: 0, y: 7, drapeGroup: "left_lock" }]);
    const composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
  });

  it.each(["erase", "recolor", "relabel"] as const)("independently rejects junction tampering: %s", mode => {
    const b = unit(), composed = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + 7) * 64 + r.x) * 4;
    const atJunction = (p: { part: string; face: string; layer: string; x: number; y: number }) => p.part === "head" && p.face === "front" && p.layer === "base" && p.x === 0 && p.y === 7;
    if (mode === "erase") {
      composed.atlas.rgba.set([242, 214, 192, 255], i);
      composed.diagnostic.surfacePixels = composed.diagnostic.surfacePixels.filter(c => !atJunction(c));
      composed.diagnostic.surfaces = composed.diagnostic.surfaces.filter(c => !atJunction(c));
    } else if (mode === "recolor") {
      composed.atlas.rgba.set([220, 3, 230], i);
      composed.diagnostic.surfacePixels.find(atJunction)!.color = [220, 3, 230];
    } else {
      composed.diagnostic.surfacePixels.find(atJunction)!.owner = "face";
      composed.diagnostic.surfaces.find(atJunction)!.owner = "face";
    }
    expect(measureReferenceRenderedQuality(composed, b.baseline, b.plan, b.design, b.style).violations).toContain("paired_hair_junction_invalid");
  });
});
