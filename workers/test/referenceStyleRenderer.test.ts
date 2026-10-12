import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildReferenceStylePlan, HAIR_STYLE_TEMPLATES, OUTFIT_STYLE_TEMPLATES, type HairStyleFamily } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BodyPart } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { makeAnalysis } from "./helpers";
import type { PhotoAnalysis } from "../src/analysis";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { measureReferenceAccessoryRetention } from "../src/referenceOutfitRetention";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { hasReferenceHairVolume, referenceHairVolumeGroups } from "../src/referenceHairVolume";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function build(raw: PhotoAnalysis) {
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const plan = buildSkinPlan(analysis), style = buildFaceStyle(analysis, features, plan.hairPlan);
  const before = buildProceduralFallbackAtlas(features, style, plan);
  if (!before) throw new Error("baseline_atlas_rejected");
  return { analysis, plan, style, before, design: buildReferenceStylePlan(analysis) };
}
function fixture(hair: string, outfit: string, length: PhotoAnalysis["renderHints"]["overallHairLength"] = "ear") {
  const a = makeAnalysis(); a.observed = { ...a.observed, hair, clothing: outfit, accessories: "none" };
  a.renderHints.overallHairLength = length; a.renderHints.sideHairLength = length === "ear" ? "short" : length === "jaw" ? "jaw" : "shoulder";
  a.renderHints.bangs = "straight"; a.renderHints.bangsLength = "short"; a.renderHints.eyeShape = "almond";
  a.renderHints.neckAccessory = /ribbon|bow/.test(outfit) ? "bow" : "none";
  a.renderHints.hairTexture = /wavy/.test(hair) ? "wavy" : "straight";
  a.fallbackFeatures.glasses = "none"; a.fallbackFeatures.facialHair = "none";
  a.fallbackFeatures.hairstyle = /twin tails/.test(hair) ? "twintails" : length === "ear" ? "short" : "long";
  a.fallbackFeatures.topType = /hoodie/.test(outfit) ? "hoodie" : /cardigan|sweater|sweatshirt/.test(outfit) ? "sweater" : "tshirt";
  a.fallbackFeatures.topColor = /black/.test(outfit) ? "black" : /pink/.test(outfit) ? "pink" : "white";
  a.fallbackFeatures.topAccentColor = /red/.test(outfit) ? "red" : "pink";
  a.canonicalIdentity.features = [
    { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: hair, targetRegions: ["head.front", "head.back"] },
    { feature: outfit, category: "outfit", priority: 5, confidence: "high", evidence: outfit, targetRegions: ["torso.front", "arm.left", "arm.right"] },
  ];
  a.identityPrompt = hair; a.outfitPrompt = outfit;
  return a;
}
function protectsEyes(before: RawImage, after: RawImage, analysis: ReturnType<typeof build>, composed?: ReturnType<typeof composeReferenceStyleAtlas>) {
  const front = CLASSIC_LAYOUT.head.base.front;
  for (const p of analysis.plan.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "glasses"].includes(p.cluster) || p.role === "brow")) {
    const at = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    const finish = composed?.diagnostic.faceFinish;
    const target = at + ((p.cluster === "left_eye" || p.cluster === "right_eye") && p.role !== "brow" ? (finish?.eyeRowOffset ?? 0) * 256 : 0);
    const pigment = finish && [...finish.irisPigmentCells, ...finish.irisGlintCells].find(c => c.x === p.x && c.y === p.y);
    const projection = composed?.diagnostic.headProportion;
    const authored = projection?.paints.find(c => c.face === "front" && ((8 + c.y) * 64 + 8 + c.x) * 4 === target);
    if (authored) {
      expect(after.rgba.slice(target, target + 4)).toEqual(new Uint8Array([...authored.color, before.rgba[at + 3]]));
      // Exact independent reconstruction plus anti-tampering tests cover the
      // new display contract; source coordinates remain immutable.
      expect(measureReferenceRenderedQuality(composed!, analysis.before, analysis.plan, analysis.design, analysis.style).violations).toEqual([]);
      continue;
    }
    expect(after.rgba.slice(target, target + 4)).toEqual(pigment ? new Uint8Array([...pigment.color, before.rgba[at + 3]]) : before.rgba.slice(at, at + 4));
  }
}

function seamDiagnostic(composed: ReturnType<typeof composeReferenceStyleAtlas>) {
  const result = { alphaBreaks: 0, colorBreaks: 0, protectedAccessoryPairs: 0, checkedPairs: 0 };
  const accessories = new Set(composed.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === "overlay" && c.owner === "accessory").map(c => {
    const r = CLASSIC_LAYOUT.head.overlay[c.face]; return `${r.x + c.x}:${r.y + c.y}`;
  }));
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) {
    const seams = getBoxUvSeams(CLASSIC_LAYOUT[part].overlay);
    for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, i) => {
      const q = seam.adjacent[i];
      // Eyewear/jewelry retains its pre-existing authored boundary; do not fill
      // a protected lens window with hair to manufacture a seam PASS.
      if (part === "head" && (accessories.has(`${p.x}:${p.y}`) || accessories.has(`${q.x}:${q.y}`))) { result.protectedAccessoryPairs++; return; }
      const a = (p.y * 64 + p.x) * 4, b = (q.y * 64 + q.x) * 4, rgba = composed.atlas.rgba;
      result.checkedPairs++;
      if (!!rgba[a + 3] !== !!rgba[b + 3]) result.alphaBreaks++;
      if (rgba[a + 3] && rgba[b + 3] && [0, 1, 2].some(c => rgba[a + c] !== rgba[b + c])) result.colorBreaks++;
    });
  }
  return result;
}

const hairSources: Array<[HairStyleFamily, string, PhotoAnalysis["renderHints"]["overallHairLength"], string]> = [
  ["short_shaggy_masculine", "short shaggy straight hair", "ear", "plain white top"],
  ["short_soft_feminine", "short soft straight hair", "ear", "plain white top"],
  ["medium_layered", "jaw length layered straight hair", "jaw", "plain white top"],
  ["long_straight_with_bangs", "long straight hair with bangs", "chest", "plain white top"],
  ["long_wavy_with_bangs", "long wavy hair with bangs", "chest", "plain white top"],
  ["twin_braids", "two long braids with bangs", "chest", "plain white top"],
  ["twin_tails", "twin tails with bangs", "chest", "plain white top"],
  ["long_pastel_straight", "pastel pink long straight hair with bangs", "chest", "plain white top"],
  ["hoodie_beanie_compatible", "short soft straight hair", "ear", "black hoodie with the hood worn over the head"],
];
describe("reference-style actual atlas composition", () => {
  it.each(hairSources)("selects and renders source-owned %s accents without forcing a family onto unrelated long hair", (family, hair, length, outfit) => {
    const raw = fixture(hair, outfit, length);
    raw.renderHints.fringeEdge = family === "short_shaggy_masculine" ? "staggered" : "blunt";
    if (family === "long_pastel_straight") raw.fallbackFeatures.hairColor = "pink";
    const b = build(raw), design = b.design;
    expect(Object.hasOwn(HAIR_STYLE_TEMPLATES, family)).toBe(true);
    expect(design.hair.family).toBe(family);
    const result = composeReferenceStyleAtlas(b.before, b.plan, design, b.style);
    expect(result.diagnostic.constraints.ok).toBe(true); expect(result.diagnostic.constraints.baseHairCells).toBeGreaterThan(result.diagnostic.constraints.outerHairCells);
    // Legacy perimeter plus explicitly authored connected crown bundles, not
    // an arbitrary filled cap. Ineligible/legacy styles keep the old boundary.
    const crown = hasReferenceHairVolume(b.plan, b.design, b.style)
      ? new Set(referenceHairVolumeGroups(b.style).flat().filter(p => p.face === "top").map(p => `${p.x}:${p.y}`)) : new Set<string>();
    expect(result.diagnostic.surfaces.filter(c => c.owner === "hair" && c.layer === "overlay" && c.face === "top").every(c => c.x === 0 || c.x === 7 || c.y === 0 || c.y === 7 || crown.has(`${c.x}:${c.y}`))).toBe(true);
    expect(seamDiagnostic(result).alphaBreaks).toBe(0); expect(seamDiagnostic(result).colorBreaks).toBe(0);
    protectsEyes(b.before, result.atlas, b, result); expect(validateFinalAtlas(result.atlas).ok).toBe(true);
  });
  it.each([
    ["casual_knit_cardigan", "brown knit cardigan with white neck scarf"],
    ["clean_sweatshirt_casual", "black sweatshirt"],
    ["pastel_cute_top", "pastel lavender blouse"],
    ["ribbon_top_skirt", "white top with pink neck bow and skirt"],
    ["school_cardigan_uniform", "school uniform cardigan with pink neck bow and skirt"],
    ["dark_hoodie_streetwear", "black hoodie"],
    ["black_floral_streetwear", "black sweater with red floral sleeves"],
    ["pastel_hoodie_streetwear", "pastel pink hoodie"],
  ] as const)("renders %s with readable source garment base and budgeted structural groups", (family, outfit) => {
    expect(Object.hasOwn(OUTFIT_STYLE_TEMPLATES, family)).toBe(true);
    const b = build(fixture("short straight hair", outfit));
    const design = b.design; expect(design.outfit.family).toBe(family);
    const result = composeReferenceStyleAtlas(b.before, b.plan, design, b.style);
    expect(result.diagnostic.constraints.ok).toBe(true); expect(result.diagnostic.bodyGroups.length).toBeGreaterThan(0);
    expect(seamDiagnostic(result).alphaBreaks).toBe(0); expect(seamDiagnostic(result).colorBreaks).toBe(0);
    for (const accessory of b.plan.outfitPlan.accessories) expect(result.diagnostic.bodyGroups.some(g => g.id === `accessory:${accessory.kind}`)).toBe(true);
    const accessoryRetention = measureReferenceAccessoryRetention(result.atlas, b.plan.outfitPlan, b.style.skinTone!);
    expect(accessoryRetention.violations, JSON.stringify(accessoryRetention.cues)).toEqual([]);
    const baseArea = Object.values(CLASSIC_LAYOUT.body.base).reduce((n, r) => n + r.w * r.h, 0);
    expect(result.diagnostic.surfaces.filter(c => c.part === "body" && c.layer === "base").length).toBe(baseArea);
  });
  it("rebuilds a poisoned upper shoulder by garment ownership, not hair color heuristics", () => {
    const b = build(fixture("short dark brown hair", "brown knit sweater"));
    const poison = { ...b.before, rgba: b.before.rgba.slice() };
    for (const part of ["body", "rightArm", "leftArm"] as const) {
      for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) for (let y = 0; y < Math.min(2, rect.h); y++) for (let x = 0; x < rect.w; x++) poison.rgba.set([57, 42, 33, 255], ((rect.y + y) * 64 + rect.x + x) * 4);
    }
    const clean = composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style);
    const repaired = composeReferenceStyleAtlas(poison, b.plan, b.design, b.style);
    expect(repaired.atlas.rgba).toEqual(clean.atlas.rgba);
    expect(repaired.diagnostic.surfaces.some(c => c.owner === "hair" && c.part !== "head")).toBe(false);
  });
  it("does not fabricate a body hair drape from length alone", () => {
    const b = build(fixture("long straight hair with bangs", "white top", "chest"));
    expect(composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style).diagnostic.drapeCells).toBe(0);
  });
  it("does not manufacture a bottom head lock just because drape was described", () => {
    const b = build(fixture("long straight hair with bangs drapes over shoulders", "white top", "chest"));
    // Explicit unsupported unit mask: valid shoulder-length source hints now
    // correctly create bottom locks, so their absence must be supplied as
    // ownership evidence, not obtained by feeding an invalid 'long' enum.
    for (const c of b.plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.face === "front" && c.y === 7 && [0, 7].includes(c.x))) {
      c.owner = "face";
      const r = CLASSIC_LAYOUT.head.base.front;
      b.before.rgba.set([215, 179, 145, 255], ((r.y + c.y) * 64 + r.x + c.x) * 4);
    }
    const composed = composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style);
    expect(b.design.drape.eligible).toBe(true);
    expect(composed.diagnostic.drapeCells).toBe(0);
  });
  it("connects an authored bottom-lock ownership fixture to a narrow base drape", () => {
    const b = build(fixture("long straight hair with bangs drapes over shoulders", "white top", "chest"));
    // Explicit unit-test mask, not a frozen source annotation or new source
    // measurement. Supply a real painted foundation to exercise connectivity.
    const head = b.plan.headIdentityPlan.ownership!;
    for (const x of [0, 7]) {
      const c = head.cells.find(c => c.layer === "base" && c.face === "front" && c.x === x && c.y === 7);
      if (c) c.owner = "hair_base";
      else head.cells.push({ layer: "base", face: "front", x, y: 7, owner: "hair_base", sourceGroupId: "unit-test-bottom-lock", provenance: "observed" });
      const r = CLASSIC_LAYOUT.head.base.front;
      b.before.rgba.set([57, 42, 33, 255], ((r.y + 7) * 64 + r.x + x) * 4);
    }
    const composed = composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style);
    expect(composed.diagnostic.drapeCells).toBe(16); // Chest length, no longer truncated to a shoulder-length 4-row lock.
    expect(composed.diagnostic.constraints.ok).toBe(true);
    expect(composed.diagnostic.surfaces.filter(c => c.part !== "head" && c.owner === "hair").every(c => c.layer === "base" && c.drapeGroup && c.face === "front")).toBe(true);
  });
  it("compares twelve saved source atlases and records actual coverage, geometry and craft", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const input = "evaluation-artifacts/generalization-20260905/annotations.json";
      const bytes = readFileSync(input); const annotations: AnnotatedCase[] = JSON.parse(bytes.toString());
      const root = mkdtempSync("evaluation-artifacts/reference-style-composition-20261005-"); const cases = [];
      for (const fixture of annotations) {
        const { analysis: raw } = strictBoundaryAnalysisFromAnnotation(fixture);
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        const b = build(raw), planHash = hash(JSON.stringify(b.plan));
        let composed: ReturnType<typeof composeReferenceStyleAtlas>;
        try { composed = composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style); }
        catch (error) { throw new Error(`${fixture.id}: ${String(error)}`); }
        expect(hash(JSON.stringify(b.plan))).toBe(planHash); protectsEyes(b.before, composed.atlas, b, composed);
        for (const p of facialHairBaseFootprint(b.style)) {
          const i = ((8 + p.y) * 64 + 8 + p.x) * 4;
          expect(composed.atlas.rgba.slice(i, i + 4), `${fixture.id}: actual facial-hair footprint`).toEqual(b.before.rgba.slice(i, i + 4));
        }
        expect(validateFinalAtlas(composed.atlas).ok).toBe(true);
        const seams = seamDiagnostic(composed);
        expect(seams.alphaBreaks, `${fixture.id}: physical overlay alpha seams`).toBe(0);
        expect(seams.colorBreaks, `${fixture.id}: physical overlay color seams`).toBe(0);
        expect(composeReferenceStyleAtlas(b.before, b.plan, b.design, b.style).atlas.rgba).toEqual(composed.atlas.rgba);
        const beforeBytes = await encodePng(b.before), afterBytes = await encodePng(composed.atlas);
        writeFileSync(`${root}/${fixture.id}-before.png`, beforeBytes, { flag: "wx" }); writeFileSync(`${root}/${fixture.id}-styled.png`, afterBytes, { flag: "wx" });
        expect((await decodePng(afterBytes)).rgba).toEqual(composed.atlas.rgba);
        for (const [name, atlas] of [["before", b.before], ["styled", composed.atlas]] as const) {
          const front = renderSkinViews(atlas).find(v => v.name === "front")!;
          writeFileSync(`${root}/${fixture.id}-${name}-front.png`, await encodePng(scaleNearestNeighbor(front.image, front.image.width * 4, front.image.height * 4)), { flag: "wx" });
        }
        const craft = validateAtlasCraft(composed.atlas, b.style, b.plan.facePixelPlan, b.plan.hairPlan, b.plan);
        const baselineCraft = validateAtlasCraft(b.before, b.style, b.plan.facePixelPlan, b.plan.hairPlan, b.plan);
        expect(baselineCraft.ok, `${fixture.id}: unchanged default craft`).toBe(true);
        const renderedQuality = measureReferenceRenderedQuality(composed, b.before, b.plan, b.design, b.style);
        expect(renderedQuality.faceContract.violations, `${fixture.id}: independently derived mouthless/lower-eye presentation contract`).toEqual([]);
        expect(renderedQuality.violations, `${fixture.id}: executable paint/source contract`).toEqual([]);
        const referencePlan = buildReferenceCraftPlan(b.plan, b.design, composed);
        const referenceCraft = validateReferenceAtlasCraft(composed.atlas, b.before, b.plan, b.style, referencePlan);
        expect(referenceCraft.ok, `${fixture.id}: reference craft`).toBe(true);
        expect(referenceCraft.construction?.violations, `${fixture.id}: independent executable craft source contract`).toEqual([]);
        for (const problem of referenceCraft.foundation!.problems) expect(craft.problems).toContain(problem);
        if (fixture.id === "headscarf-color-blocks") {
          const reordered = structuredClone(b.plan); reordered.headIdentityPlan.ownership!.cells.reverse();
          const repeated = composeReferenceStyleAtlas(b.before, reordered, b.design, b.style);
          expect(repeated.atlas.rgba).toEqual(composed.atlas.rgba);
          expect(measureReferenceRenderedQuality(repeated, b.before, reordered, b.design, b.style).violations).toEqual([]);
        }
        const selection = selectReferenceStyleAtlas(b.before, b.plan, b.design, b.style);
        expect(selection.selected, `${fixture.id}: no source-safe rendered candidate`).not.toBeNull();
        expect(selection.renderAttempts).toBeLessThanOrEqual(27);
        expect(hash(JSON.stringify(b.plan))).toBe(planHash);
        const chosen = selection.selected!;
        expect(chosen.foundation.ok).toBe(true);
        const selectedCraft = validateReferenceAtlasCraft(chosen.composition.atlas, b.before, b.plan, b.style, buildReferenceCraftPlan(b.plan, chosen.design, chosen.composition));
        expect(selectedCraft.ok, `${fixture.id}: selected reference craft`).toBe(true);
        protectsEyes(b.before, chosen.composition.atlas, { ...b, design: chosen.design }, chosen.composition);
        writeFileSync(`${root}/${fixture.id}-selected.png`, await encodePng(chosen.composition.atlas), { flag: "wx" });
        const basePaletteFaces = Object.entries(CLASSIC_LAYOUT).flatMap(([part, uv]) => Object.entries(uv.base).map(([face, r]) => {
          const colors = new Set<string>();
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            const i = ((r.y + y) * 64 + r.x + x) * 4;
            colors.add([0, 1, 2].map(ch => composed.atlas.rgba[i + ch] >> 4).join(":"));
          }
          return { part, face, colors: colors.size };
        }));
        const renderedFront = renderSkinViews(composed.atlas)[0].image;
        const eyeEvidence = b.plan.facePixelPlan.pixels.filter(p => p.role === "iris" || p.role === "sclera").map(p => {
          const sample = (image: RawImage, layer: "base" | "overlay") => {
            const r = CLASSIC_LAYOUT.head[layer].front, i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
            return [...image.rgba.slice(i, i + 4)];
          };
          const scale = 28 / renderedFront.width;
          const sx = Math.round(renderedFront.width / 2 + (p.x - 3.5) / scale - 0.5), sy = Math.round((2 + p.y + 0.5) / scale - 0.5);
          const screenOffset = (sy * renderedFront.width + sx) * 4;
          if (p.role === "iris" && sample(composed.atlas, "overlay")[3] === 0) {
            expect([...renderedFront.rgba.slice(screenOffset, screenOffset + 4)], `${fixture.id}: iris actually visible in 3D`).toEqual(sample(composed.atlas, "base"));
          }
          return { ...p, renderedAtCenter: [...renderedFront.rgba.slice(screenOffset, screenOffset + 4)], baseBefore: sample(b.before, "base"), baseAfter: sample(composed.atlas, "base"), outerBefore: sample(b.before, "overlay"), outerAfter: sample(composed.atlas, "overlay"),
            owners: b.plan.headIdentityPlan.ownership?.cells.filter(c => c.face === "front" && c.x === p.x && c.y === p.y) };
        });
        for (const layer of ["base", "overlay"] as const) {
          const r = CLASSIC_LAYOUT.head[layer].front, rgba = new Uint8Array(8 * 8 * 4);
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const i = ((r.y + y) * 64 + r.x + x) * 4;
            rgba.set(composed.atlas.rgba.slice(i, i + 4), (y * 8 + x) * 4);
          }
          writeFileSync(`${root}/${fixture.id}-${layer}-face.png`, await encodePng(scaleNearestNeighbor({ width: 8, height: 8, rgba }, 192, 192)), { flag: "wx" });
        }
        cases.push({ caseId: fixture.id, calibrated: !!fixture.existing, style: b.design, eyeEvidence, sourceOutfitPlan: b.plan.outfitPlan, basePaletteFaces, geometryHash: hash(JSON.stringify(raw.identityGeometry ?? null)), planHash, referencePlanHash: hash(JSON.stringify(referencePlan)), baselineHash: hash(b.before.rgba), styledHash: hash(composed.atlas.rgba), diagnostic: composed.diagnostic, renderedQuality, seams, baselineCraft, craft, referenceCraft,
          selection: { renderAttempts: selection.renderAttempts, design: chosen.design, selectedHash: hash(chosen.composition.atlas.rgba), quality: chosen.quality, craft: selectedCraft, candidates: selection.candidates } });
      }
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, status: "offline_composition_not_default_activation", annotationHash: hash(bytes), cases }, null, 2), { flag: "wx" });
      // A source's semantic-first choice may now legitimately be the best
      // rendered choice. The ability to replace a worse initial choice is
      // tested independently on a controlled candidate set, not required to
      // damage one of these frozen subjects just to manufacture a difference.
      for (const c of cases) {
        const valid = c.selection.candidates.filter(candidate => candidate.quality?.constructionValid && candidate.foundation?.ok);
        expect(c.selection.quality.score).toBe(Math.max(...valid.map(candidate => candidate.quality!.score)));
      }
      expect(readFileSync(input)).toEqual(bytes); expect(network).not.toHaveBeenCalled(); console.info(`REFERENCE_STYLE_COMPOSITION ${root}`);
    } finally { network.mockRestore(); }
  }, 180_000);
});
