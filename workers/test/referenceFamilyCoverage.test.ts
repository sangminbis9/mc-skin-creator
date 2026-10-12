/** Authored semantic coverage, not new photo annotations/provider evidence. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan, FACE_STYLE_TEMPLATES, HAIR_STYLE_TEMPLATES, OUTFIT_STYLE_TEMPLATES, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng, bytesToBase64, base64ToBytes, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import type { PhotoAnalysis } from "../src/analysis";
import type { Env } from "../src/types";
import { CLASSIC_LAYOUT, type BodyPart } from "../src/uvLayout";

type Unit = { axis: "face" | "hair" | "outfit"; family: string; hair?: string; clothing?: string; face?: string; hints?: Partial<PhotoAnalysis["renderHints"]> };
const units: Unit[] = [
  { axis: "face", family: "soft_feminine_calm", hints: { faceShape: "oval" } },
  { axis: "face", family: "soft_feminine_doll", hints: { eyeShape: "round", eyeSize: "large" } },
  { axis: "face", family: "cute_pastel", clothing: "pastel pink blouse" },
  { axis: "face", family: "clean_masculine_soft", face: "smooth complexion and soft jaw" },
  { axis: "face", family: "cool_androgynous" },
  { axis: "face", family: "dark_stylish", clothing: "black sweatshirt" },
  { axis: "hair", family: "short_shaggy_masculine", hints: { fringeEdge: "staggered" } },
  { axis: "hair", family: "short_soft_feminine", hints: { fringeEdge: "blunt" } },
  { axis: "hair", family: "medium_layered", hair: "jaw length layered brown straight hair", hints: { overallHairLength: "jaw", sideHairLength: "jaw" } },
  { axis: "hair", family: "long_straight_with_bangs", hair: "long straight brown hair with bangs drapes over shoulders", hints: { overallHairLength: "chest", sideHairLength: "shoulder", hairBackShape: "long" } },
  { axis: "hair", family: "long_wavy_with_bangs", hair: "long wavy brown hair with bangs drapes over shoulders", hints: { overallHairLength: "chest", sideHairLength: "shoulder", hairBackShape: "long", hairTexture: "wavy" } },
  { axis: "hair", family: "twin_braids", hair: "two brown braids drape over shoulders", hints: { overallHairLength: "chest", sideHairLength: "shoulder", hairBackShape: "long" } },
  { axis: "hair", family: "twin_tails", hair: "brown twin tails drape over shoulders", hints: { overallHairLength: "chest", sideHairLength: "shoulder", hairBackShape: "long" } },
  { axis: "hair", family: "long_pastel_straight", hair: "pastel pink long straight hair with bangs drapes over shoulders", hints: { overallHairLength: "chest", sideHairLength: "shoulder", hairBackShape: "long" } },
  { axis: "hair", family: "hoodie_beanie_compatible", clothing: "black hoodie with the hood worn over the head" },
  { axis: "outfit", family: "casual_knit_cardigan", clothing: "brown knit cardigan with white neck scarf", hints: { neckAccessory: "scarf" } },
  { axis: "outfit", family: "clean_sweatshirt_casual", clothing: "black sweatshirt" },
  { axis: "outfit", family: "pastel_cute_top", clothing: "pastel lavender blouse" },
  { axis: "outfit", family: "ribbon_top_skirt", clothing: "white top with pink neck bow and gray skirt", hints: { neckAccessory: "bow" } },
  { axis: "outfit", family: "school_cardigan_uniform", clothing: "school uniform cardigan with pink neck bow and gray skirt", hints: { neckAccessory: "bow" } },
  { axis: "outfit", family: "dark_hoodie_streetwear", clothing: "black hoodie" },
  { axis: "outfit", family: "black_floral_streetwear", clothing: "black sweater with red floral sleeves" },
  { axis: "outfit", family: "pastel_hoodie_streetwear", clothing: "pastel pink hoodie" },
];
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function analysisUnit(u: Unit): PhotoAnalysis {
  const a = makeAnalysis(), hair = u.hair ?? "short brown straight hair with bangs", clothing = u.clothing ?? "gray sweatshirt";
  const face = u.face ?? "neutral expression";
  a.observed = { face, hair, clothing, accessories: "none", colorPalette: [/pink/.test(hair) ? "pink" : "brown", /black/.test(clothing) ? "black" : /pink/.test(clothing) ? "pink" : "gray"] };
  a.identityPrompt = hair; a.outfitPrompt = clothing;
  a.canonicalIdentity.overallImpression = `${hair}; ${clothing}`;
  a.canonicalIdentity.mustPreserve = [hair, clothing, /pink/.test(hair) ? "pink hair color" : "brown hair color"];
  a.canonicalIdentity.features = [
    { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: hair, targetRegions: ["head.front", "head.back"] },
    { feature: /pink/.test(hair) ? "pink hair color" : "brown hair color", category: "hair", priority: 4, confidence: "high", evidence: hair, targetRegions: ["head.front"] },
    { feature: clothing, category: "outfit", priority: 4, confidence: "high", evidence: clothing, targetRegions: ["torso.front", "arm.left", "arm.right"] },
    { feature: face, category: "face", priority: 3, confidence: "high", evidence: face, targetRegions: ["head.front"] },
  ];
  Object.assign(a.renderHints, { faceShape: "angular", eyeShape: "almond", eyeSize: "average", mouthShape: "small", mouthOpening: "closed", bangs: "straight", bangsLength: "short", fringeOpening: "none", fringeEdge: "wispy", hairTexture: "straight", hairBackShape: "tapered", overallHairLength: "ear", sideHairLength: "short", neckAccessory: "none", ...u.hints } satisfies Partial<PhotoAnalysis["renderHints"]>);
  Object.assign(a.fallbackFeatures, { glasses: "none", facialHair: "none", hat: "none", earrings: false, expression: "neutral", hairColor: /pink/.test(hair) ? "dyed-pink" : "brown", hairstyle: /twin tails/.test(hair) ? "twintails" : u.hints?.overallHairLength && u.hints.overallHairLength !== "ear" ? "long" : "short", topType: /hoodie/.test(clothing) ? "hoodie" : /blouse/.test(clothing) ? "tshirt" : "sweater", topColor: /black/.test(clothing) ? "black" : /pink/.test(clothing) ? "pink" : /lavender/.test(clothing) ? "purple" : /white/.test(clothing) ? "white" : /brown/.test(clothing) ? "brown" : "gray", topAccentColor: /floral/.test(clothing) ? "red" : /bow/.test(clothing) ? "pink" : "white", bottomType: /skirt/.test(clothing) ? "skirt" : "pants" });
  a.inferred.hairBack = { value: u.hints?.hairBackShape === "long" ? "long back hair matching the observed sides" : "short tapered back matching the sides", rationale: "authored semantic example completion, not measured geometry" };
  return a;
}
function sheet(fronts: RawImage[], columns = 4): RawImage {
  const w = fronts[0].width, h = fronts[0].height, rows = Math.ceil(fronts.length / columns);
  const out = { width: w * columns, height: h * rows, rgba: new Uint8Array(w * columns * h * rows * 4) };
  fronts.forEach((front, index) => { for (let y = 0; y < h; y++) out.rgba.set(front.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(index / columns) * h + y) * out.width + index % columns * w) * 4); });
  return out;
}

/** Actual alpha counts on legal cuboid surfaces, independent of paint labels. */
function outerCoverage(atlas: RawImage): Record<BodyPart, number> {
  const coverage = {} as Record<BodyPart, number>;
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) {
    let occupied = 0, area = 0;
    for (const r of Object.values(CLASSIC_LAYOUT[part].overlay)) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        area++;
        if (atlas.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3]) occupied++;
      }
    }
    coverage[part] = occupied / area;
  }
  return coverage;
}

describe("complete named reference-family executable coverage", () => {
  it("renders all 6/9/8 families and encodes the actual source-gated default selection without inference", async () => {
    for (const [axis, library] of [["face", FACE_STYLE_TEMPLATES], ["hair", HAIR_STYLE_TEMPLATES], ["outfit", OUTFIT_STYLE_TEMPLATES]] as const) {
      expect(units.filter(u => u.axis === axis).map(u => u.family).sort()).toEqual(Object.keys(library).sort());
    }
    const root = mkdtempSync("evaluation-artifacts/reference-family-coverage-20261005-"), entries = [], fronts: RawImage[] = [], baselineFronts: RawImage[] = [];
    const viewSheets = new Map<string, { before: RawImage[]; after: RawImage[] }>();
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
    try {
      const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const u of units) {
        const raw = analysisUnit(u);
        const richInput = primary.validatePhotoAnalysis(raw);
        expect(richInput.ok, `${u.family}: valid authored rich input (${JSON.stringify(richInput.ok ? [] : richInput.errors)})`).toBe(true);
        const a = normalizeAnalysisForRendering(raw), source = buildSkinPlan(a), sourceHash = hash(JSON.stringify(source));
        const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
        if (u.family === "long_pastel_straight") expect(colors.hairColor).toBe("#e58bb6");
        const style = buildFaceStyle(a, colors, source.hairPlan), baseline = buildProceduralSourceAtlas(colors, style, source)!;
        expect(baseline, u.family).not.toBeNull();
        // These units have categorical hat=none. The hood-compatible hair unit
        // explicitly describes a worn hood, but family selection must not itself
        // invent a hat mask or change that existing categorical input.
        expect(style.hat, `${u.family}: source head category`).toBe("none");
        if (raw.renderHints.neckAccessory === "scarf") expect(style.neckAccessory).toBe("scarf");
        const design = buildReferenceStylePlan(a);
        expect(design.candidates[u.axis].some(c => c.family === u.family), `${u.family}: source eligibility`).toBe(true);
        const authored: ReferenceStylePlan = structuredClone(design);
        // Test an eligible named family without overriding the actual default selector.
        Object.assign(authored[u.axis], design.candidates[u.axis].find(c => c.family === u.family)!);
        const composition = composeReferenceStyleAtlas(baseline, source, authored, style);
        const quality = measureReferenceRenderedQuality(composition, baseline, source, authored, style);
        expect(quality.violations, `${u.family}: named renderer`).toEqual([]);
        expect(validateReferenceAtlasCraft(composition.atlas, baseline, source, style, buildReferenceCraftPlan(source, authored, composition)).ok, u.family).toBe(true);
        const selected = selectReferenceStyleAtlas(baseline, source, design, style).selected!;
        expect(selected, u.family).not.toBeNull();
        expect(selected.design[u.axis].family, `${u.family}: actual selected family`).toBe(u.family);
        runPrimary.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
        const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
        const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
        const result = await generateSkin(env, input);
        expect(result.status, `${u.family}: default PNG`).toBe(200);
        const decoded = await decodePng(base64ToBytes(result.body.skinPngBase64!));
        expect(decoded.rgba).toEqual(selected.composition.atlas.rgba);
        expect(validateFinalAtlas(decoded).ok).toBe(true);
        expect(result.body.analysis!.referenceStyle!.status).toBe("reference_style_accepted");
        expect(outerCoverage(decoded)).toEqual(selected.quality.metrics.outerCoverage);
        expect(hash(JSON.stringify(source))).toBe(sourceHash);
        expect(hash(JSON.stringify(result.body.analysis!.skinPlan))).toBe(sourceHash);
        expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        const id = `${u.axis}-${u.family}`;
        writeFileSync(`${root}/${id}-baseline.png`, await encodePng(baseline), { flag: "wx" });
        writeFileSync(`${root}/${id}-named.png`, await encodePng(composition.atlas), { flag: "wx" });
        writeFileSync(`${root}/${id}-default.png`, await encodePng(decoded), { flag: "wx" });
        const beforeViews = renderSkinViews(baseline), afterViews = renderSkinViews(decoded);
        for (const view of afterViews) {
          writeFileSync(`${root}/${id}-default-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
          const views = viewSheets.get(view.name) ?? { before: [], after: [] };
          views.before.push(beforeViews.find(v => v.name === view.name)!.image); views.after.push(view.image);
          viewSheets.set(view.name, views);
        }
        const beforeFront = beforeViews.find(v => v.name === "front")!.image;
        const afterFront = afterViews.find(v => v.name === "front")!.image;
        fronts.push(afterFront); baselineFronts.push(beforeFront);
        const comparison = sheet([beforeFront, afterFront], 2);
        writeFileSync(`${root}/${id}-before-after.png`, await encodePng(scaleNearestNeighbor(comparison, comparison.width * 4, comparison.height * 4)), { flag: "wx" });
        const changedPixels = Array.from({ length: 4096 }, (_, i) => i).filter(i => [0, 1, 2, 3].some(ch => baseline.rgba[i * 4 + ch] !== decoded.rgba[i * 4 + ch])).length;
        // Inspect actual eye/material adjacency, not merely the presence of an
        // iris role in a valid plan. This is authored coverage, not new source
        // evidence or permission to adjust measured geometry.
        const pixel = (x: number, y: number, layer: "base" | "overlay") => {
          const r = CLASSIC_LAYOUT.head[layer].front, offset = ((r.y + y) * 64 + r.x + x) * 4;
          return [...decoded.rgba.slice(offset, offset + 4)];
        };
        const renderedEyeCenter = (x: number, y: number) => {
          const scale = 28 / afterFront.width;
          const px = Math.round(afterFront.width / 2 + (x - 3.5) / scale - 0.5);
          const py = Math.round((2.5 + y) / scale - 0.5);
          const offset = (py * afterFront.width + px) * 4;
          const rgba = [...afterFront.rgba.slice(offset, offset + 4)];
          expect(pixel(x, y, "overlay")[3], `${id}: no overlay at authored eye center`).toBe(0);
          expect(rgba, `${id}: real front-view eye sample matches atlas base`).toEqual(pixel(x, y, "base"));
          return { x: px, y: py, rgba };
        };
        const faceReadability = {
          sourceEyeColor: style.eyeColor, sourceHairColor: style.hairColor,
          layout: source.facePixelPlan.layout,
          presentation: selected.composition.diagnostic.faceFinish.eyePresentation,
          headMaskSource: source.hairPlan.headMask.source,
          sideWidthFamily: source.hairPlan.headMask.semanticSilhouette?.sideWidthFamily,
          plannedEyes: source.facePixelPlan.pixels.filter(p => p.role === "iris" || p.role === "sclera").map(p => ({
            ...p, base: pixel(p.x, p.y, "base"), overlay: pixel(p.x, p.y, "overlay"),
            renderedCenter: renderedEyeCenter(p.x, p.y),
            neighbors: [-1, 1].map(dx => ({ x: p.x + dx, y: p.y,
              base: pixel(p.x + dx, p.y, "base"), overlay: pixel(p.x + dx, p.y, "overlay"),
              owner: source.headIdentityPlan.ownership?.cells.find(c => c.face === "front" && c.layer === "base" && c.x === p.x + dx && c.y === p.y)?.owner,
            })),
          })),
        };
        writeFileSync(`${root}/${id}-face-readability.json`, JSON.stringify(faceReadability, null, 2), { flag: "wx" });
        entries.push({ id, provenance: "authored_semantic_unit", richInputValidated: true, sourceHairColor: a.fallbackFeatures.hairColor, renderedHairColor: style.hairColor, sourceHeadCategory: a.fallbackFeatures.hat, renderedHeadCategory: style.hat, renderedNeckAccessory: style.neckAccessory, targetAxis: u.axis, eligibleFamily: u.family, baselineAtlasHash: hash(baseline.rgba), baselineOuterCoverage: outerCoverage(baseline), changedPixels, namedAtlasHash: hash(composition.atlas.rgba), defaultAtlasHash: hash(decoded.rgba), selected: selected.design, sourceHash, constraints: selected.composition.diagnostic.constraints, sourceContract: selected.quality, bodyGroups: selected.composition.diagnostic.bodyGroups, defaultPngAccepted: true });
      }
      const gallery = sheet(fronts);
      writeFileSync(`${root}/default-gallery.png`, await encodePng(scaleNearestNeighbor(gallery, gallery.width * 3, gallery.height * 3)), { flag: "wx" });
      const baselineGallery = sheet(baselineFronts);
      writeFileSync(`${root}/baseline-gallery.png`, await encodePng(scaleNearestNeighbor(baselineGallery, baselineGallery.width * 3, baselineGallery.height * 3)), { flag: "wx" });
      for (const [name, views] of viewSheets) {
        expect(views.before).toHaveLength(units.length); expect(views.after).toHaveLength(units.length);
        for (const [label, images] of [["baseline", views.before], ["default", views.after]] as const) {
          const allAngles = sheet(images);
          writeFileSync(`${root}/${label}-${name}-gallery.png`, await encodePng(scaleNearestNeighbor(allAngles, allAngles.width * 3, allAngles.height * 3)), { flag: "wx" });
        }
      }
      // A family label alone is not a changed renderer or reduced outer shell.
      expect(entries.every(e => e.changedPixels > 0)).toBe(true);
      expect(entries.some(e => e.sourceContract.metrics.outerCoverage.head < e.baselineOuterCoverage.head)).toBe(true);
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, primaryStage: "mocked_authored_semantics", requiredFamilies: { face: 6, hair: 9, outfit: 8 }, cases: entries }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_FAMILY_COVERAGE ${root}`);
    } finally { runPrimary.mockRestore(); network.mockRestore(); }
  }, 180_000);
});
