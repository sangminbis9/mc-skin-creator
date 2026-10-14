import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyReferenceFaceFinish, referenceIrisPigmentCells } from "../src/referenceFaceFinish";
import { FACE_STYLE_TEMPLATES, type FaceStyleFamily } from "../src/referenceStyleTemplates";
import { buildPreFeedbackReferenceDesign as buildReferenceStylePlan } from "./preFeedbackReferenceDesign";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { validateFinalAtlas } from "../src/skinPost";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { scaleNearestNeighbor } from "../src/skinRender";

const palette = { skinMid: [215, 179, 145], skinShade: [135, 99, 79], lip: [134, 79, 74] } as const;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function setup() {
  const a = normalizeAnalysisForRendering(makeAnalysis());
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const plan = buildSkinPlan(a);
  const atlas = buildProceduralFallbackAtlas(features, buildFaceStyle(a, features, plan.hairPlan), plan)!;
  expect(atlas).not.toBeNull();
  return { a, plan, atlas, design: buildReferenceStylePlan(a) };
}

function verifyScope(before: RawImage, after: RawImage, protectedCells: { x: number; y: number }[]) {
  const front = CLASSIC_LAYOUT.head.base.front;
  for (let p = 0; p < 4096; p++) {
    expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
    const x = p % 64 - front.x, y = Math.floor(p / 64) - front.y;
    if (x < 0 || y < 0 || x >= 8 || y >= 8 || protectedCells.some(c => c.x === x && c.y === y)) {
      expect(after.rgba.slice(p * 4, p * 4 + 4)).toEqual(before.rgba.slice(p * 4, p * 4 + 4));
    }
  }
}

describe("reference face finish: simplified complexion, not fabricated geometry", () => {
  it("adds a short hair-contact shadow that fades without darkening an exposed forehead", () => {
    const { atlas, plan, design } = setup();
    const face = structuredClone(plan.facePixelPlan);
    face.layout.hairlineDepthByColumn = [1, 1, 1, 1, 1, 1, 1, 1];
    face.pixels = face.pixels.filter(p => p.cluster === "mouth");
    const front = CLASSIC_LAYOUT.head.base.front;
    const red = (image: RawImage, x: number, y: number) => image.rgba[((front.y + y) * 64 + front.x + x) * 4];
    applyReferenceFaceFinish(atlas, face, design, palette, []);
    expect(red(atlas, 1, 2)).toBeLessThan(red(atlas, 1, 3));
    expect(red(atlas, 1, 3)).toBeLessThan(red(atlas, 1, 4));
    expect(red(atlas, 1, 4)).toBe(palette.skinMid[0]);
    face.layout.hairlineDepthByColumn = Array(8).fill(-1);
    applyReferenceFaceFinish(atlas, face, design, palette, []);
    for (const y of [1, 2, 3, 4]) expect(red(atlas, 1, y)).toBe(palette.skinMid[0]);
  });
  it("clears an inherited unplanned nose stripe only inside the source skin window", () => {
    const { atlas, plan, design } = setup();
    const face = structuredClone(plan.facePixelPlan), front = CLASSIC_LAYOUT.head.base.front;
    face.layout.hairlineDepthByColumn = [1, 1, 1, 1, 1, 1, 1, 1];
    face.pixels = [
      { x: 2, y: 3, role: "iris", cluster: "left_eye" },
      { x: 5, y: 3, role: "iris", cluster: "right_eye" },
      { x: 3, y: 6, role: "lip", cluster: "mouth" },
      { x: 4, y: 6, role: "lip", cluster: "mouth" },
    ];
    face.layout.mouthCornerOffsets = [0, 0];
    if (face.renderContract.mouth) face.renderContract.mouth.preserveAsymmetry = false;
    // Deliberate inherited painter artifact, not a source nose instruction.
    for (const x of [3, 4]) for (const y of [3, 4, 5]) atlas.rgba.set([230, 145, 77], ((front.y + y) * 64 + front.x + x) * 4);
    const material = [{ x: 0, y: 4 }, { x: 7, y: 4 }, { x: 1, y: 7 }];
    const before = { ...atlas, rgba: atlas.rgba.slice() }, source = JSON.stringify(face);
    const result = applyReferenceFaceFinish(atlas, face, design, palette, material);
    for (const x of [3, 4]) for (const y of [3, 4, 5]) {
      const i = ((front.y + y) * 64 + front.x + x) * 4;
      const shadow = y === 3 ? .16 : 0;
      expect([...atlas.rgba.slice(i, i + 3)]).toEqual(palette.skinMid.map((v, c) => Math.round(v * (1 - shadow) + palette.skinShade[c] * shadow)));
      expect(result.skinWindowCells).toContainEqual({ x, y });
    }
    verifyScope(before, atlas, [...material, ...face.pixels.filter(p => p.role === "iris"), ...Array.from({ length: 16 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8) }))]);
    expect(result.skinWindowCells.some(p => material.some(q => p.x === q.x && p.y === q.y))).toBe(false);
    expect(JSON.stringify(face)).toBe(source);
  });
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("renders %s without touching measured eyes/accessories/body/alpha", family => {
    const { atlas, plan, design } = setup(); const original = { ...atlas, rgba: atlas.rgba.slice() };
    const protectedCells = plan.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "fringe", "glasses"].includes(p.cluster) || p.role === "brow");
    const planBefore = JSON.stringify(plan); design.face.family = family;
    const result = applyReferenceFaceFinish(atlas, plan.facePixelPlan, design, palette, [{ x: 3, y: 7 }]);
    expect(result.changedCells.length).toBeGreaterThan(0);
    verifyScope(original, atlas, [...protectedCells, { x: 3, y: 7 }]);
    expect(JSON.stringify(plan)).toBe(planBefore); expect(validateFinalAtlas(atlas).ok).toBe(true);
  });
  it("preserves observed teeth/open mouth and explicit facial-hair protected cells", () => {
    const { atlas, plan, design } = setup(); const original = { ...atlas, rgba: atlas.rgba.slice() };
    // Synthetic conflict: a protected facial-hair cell also has a nasal paint
    // instruction. The ordinary source fixture has no nose instruction at all.
    const beardCell = { x: 3, y: 4 };
    plan.facePixelPlan.pixels.push({ ...beardCell, role: "nose_tip", cluster: "nose" });
    const protectedCells = [beardCell, ...plan.facePixelPlan.pixels.filter(p => p.role === "teeth" || p.role === "mouth_shadow")];
    const result = applyReferenceFaceFinish(atlas, plan.facePixelPlan, design, palette, [beardCell]);
    expect(result.expressionException).toBe(true); verifyScope(original, atlas, protectedCells);
  });
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("keeps a readable two-cell closed mouth for %s without dark lip outlines", family => {
    const { atlas, plan, design } = setup(); design.face.family = family;
    const face = structuredClone(plan.facePixelPlan);
    face.layout.mouthCornerOffsets = [0, 0]; face.layout.mouthCenterX = 3.5;
    // This synthetic fixture explicitly models an ordinary, unprotected mouth.
    // Protected source width has a separate retention regression below.
    if (face.renderContract.mouth) Object.assign(face.renderContract.mouth,
      { preserveAsymmetry: false, protected: false, minimumPerceptualWidth: 2, opening: "closed" });
    face.pixels = face.pixels.filter(p => p.cluster !== "mouth" && !["3:6", "4:6", "2:6", "5:6"].includes(`${p.x}:${p.y}`));
    face.pixels.push(...[2, 3, 4, 5].map(x => ({ x, y: 6, role: "lip" as const, cluster: "mouth" as const })));
    applyReferenceFaceFinish(atlas, face, design, palette, []);
    const front = CLASSIC_LAYOUT.head.base.front;
    const excluded = new Set(face.pixels.filter(p => p.cluster !== "complexion").map(p => `${p.x}:${p.y}`));
    const distance = (x: number) => {
      const neighbors = [[x - 1, 6], [x + 1, 6], [x, 5], [x, 7]].filter(([px, py]) => !excluded.has(`${px}:${py}`));
      const background = [0, 1, 2].map(c => neighbors.reduce((sum, [px, py]) => sum + atlas.rgba[((front.y + py) * 64 + front.x + px) * 4 + c], 0) / neighbors.length);
      const i = ((front.y + 6) * 64 + front.x + x) * 4;
      return background.reduce((n, v, c) => n + Math.abs(v - atlas.rgba[i + c]), 0);
    };
    const target = 255 * FACE_STYLE_TEMPLATES[family].lipContrast;
    for (const x of [3, 4]) expect(Math.abs(distance(x) - target)).toBeLessThanOrEqual(1.5);
    for (const x of [2, 5]) {
      const i = ((front.y + 6) * 64 + front.x + x) * 4;
      expect([...atlas.rgba.slice(i, i + 3)]).toEqual(palette.skinMid);
    }
    expect(distance(3)).toBeGreaterThanOrEqual(30);
    expect(distance(3)).toBeLessThan(50);
  });
  it.each((Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[]).flatMap(family =>
    [false, true].map(protectedMouth => ({ family, protectedMouth }))))("retains closed-mouth width in $family (protected=$protectedMouth) without adding cells", ({ family, protectedMouth }) => {
    const { atlas, plan, design } = setup(); design.face.family = family;
    const face = structuredClone(plan.facePixelPlan);
    face.layout.mouthCornerOffsets = [0, 0]; face.layout.mouthCenterX = 3.5;
    expect(face.renderContract.mouth).toBeDefined();
    Object.assign(face.renderContract.mouth!,
      { preserveAsymmetry: false, protected: protectedMouth, minimumPerceptualWidth: 4, opening: "closed" });
    const mouth = [2, 3, 4, 5].map(x => ({ x, y: 6, role: "lip" as const, cluster: "mouth" as const }));
    face.pixels = face.pixels.filter(p => p.cluster !== "mouth" && !mouth.some(q => p.x === q.x && p.y === q.y));
    face.pixels.push(...mouth);
    const source = JSON.stringify(face), before = { ...atlas, rgba: atlas.rgba.slice() };
    const result = applyReferenceFaceFinish(atlas, face, design, palette, []);
    expect(result.mouthPresentation).toBe("retain_source");
    expect(result.expressionException).toBe(false);
    for (const p of mouth) {
      const i = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect([...atlas.rgba.slice(i, i + 3)], `${family}:${p.x}`).not.toEqual(palette.skinMid);
    }
    verifyScope(before, atlas, face.pixels.filter(p => ["left_eye", "right_eye", "fringe", "glasses"].includes(p.cluster) || p.role === "brow"));
    expect(JSON.stringify(face)).toBe(source);
  });
  it("preserves lip-only source expression corners instead of forcing a neutral two-cell mouth", () => {
    const { atlas, plan, design } = setup(); const face = structuredClone(plan.facePixelPlan);
    face.pixels = face.pixels.filter(p => p.cluster !== "mouth");
    const mouth = [{ x: 2, y: 5 }, { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 5, y: 6 }];
    face.pixels.push(...mouth.map(p => ({ ...p, role: "lip" as const, cluster: "mouth" as const })));
    face.layout.mouthCornerOffsets = [-1, 0];
    const result = applyReferenceFaceFinish(atlas, face, design, palette, []);
    expect(result.expressionException).toBe(true);
    for (const p of mouth) {
      const i = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect([...atlas.rgba.slice(i, i + 3)]).not.toEqual(palette.skinMid);
    }
  });
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("authors paired %s eye/cheek finishing without changing source eyes", family => {
    const { atlas, plan, design } = setup(); design.face.family = family;
    const face = structuredClone(plan.facePixelPlan);
    face.pixels = [
      { x: 2, y: 3, role: "iris", cluster: "left_eye" },
      { x: 5, y: 3, role: "iris", cluster: "right_eye" },
      { x: 3, y: 6, role: "lip", cluster: "mouth" },
      { x: 4, y: 6, role: "lip", cluster: "mouth" },
    ];
    face.layout.hairlineDepthByColumn = [0, 0, 0, 0, 0, 0, 0, 0]; face.layout.mouthRow = 6;
    const before = { ...atlas, rgba: atlas.rgba.slice() };
    const result = applyReferenceFaceFinish(atlas, face, design, palette, []);
    expect(result.eyeAccentCells).toHaveLength(FACE_STYLE_TEMPLATES[family].eyeFinish === "clean" ? 0 : 2);
    expect(result.blushCells).toHaveLength(FACE_STYLE_TEMPLATES[family].blush ? 2 : 0);
    verifyScope(before, atlas, face.pixels.filter(p => p.role === "iris"));
    const blocked = { ...before, rgba: before.rgba.slice() };
    const decorated = [...result.eyeAccentCells, ...result.blushCells];
    const guarded = applyReferenceFaceFinish(blocked, face, design, palette, decorated);
    expect(guarded.eyeAccentCells).toHaveLength(0); expect(guarded.blushCells).toHaveLength(0);
  });
  it("rejects non-atlas input rather than inventing missing pixels", () => {
    const { plan, design } = setup();
    expect(() => applyReferenceFaceFinish({ width: 8, height: 8, rgba: new Uint8Array(256) }, plan.facePixelPlan, design, palette, [])).toThrow("reference_face_atlas_invalid");
  });
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("gives existing two-row %s irises source pigment without enlarging an eye", family => {
    const { atlas, plan, design } = setup(); design.face.family = family;
    const face = structuredClone(plan.facePixelPlan);
    face.pixels = [
      { x: 2, y: 3, role: "iris", cluster: "left_eye" }, { x: 2, y: 4, role: "iris", cluster: "left_eye" },
      { x: 5, y: 3, role: "iris", cluster: "right_eye" }, { x: 5, y: 4, role: "iris", cluster: "right_eye" },
      { x: 1, y: 3, role: "sclera", cluster: "left_eye" }, { x: 6, y: 3, role: "sclera", cluster: "right_eye" },
    ];
    const source = JSON.stringify(face);
    for (const eye of [[74, 55, 40], [36, 91, 135], [45, 99, 60]] as const) {
      const before = { ...atlas, rgba: atlas.rgba.slice() };
      const expected = referenceIrisPigmentCells(face, design, eye, []);
      const result = applyReferenceFaceFinish(atlas, face, design, { ...palette, eye }, []);
      expect(result.irisPigmentCells).toEqual(expected);
      expect(expected.map(p => [p.x, p.y])).toEqual([[2, 4], [5, 4]]);
      for (const p of expected) {
        expect(p.color).toEqual(eye.map(v => Math.min(255, Math.round(v * FACE_STYLE_TEMPLATES[family].irisPigment))));
        expect([...atlas.rgba.slice(((8 + p.y) * 64 + 8 + p.x) * 4, ((8 + p.y) * 64 + 8 + p.x) * 4 + 3)]).toEqual(p.color);
      }
      verifyScope(before, atlas, face.pixels.filter(p => p.role === "sclera" || p.y === 3));
      expect(JSON.stringify(face)).toBe(source);
    }
  });
  it("does not create pigment from missing color, singleton eyes, or a protected material collision", () => {
    const { plan, design } = setup(); const face = structuredClone(plan.facePixelPlan);
    face.pixels = [
      { x: 2, y: 3, role: "iris", cluster: "left_eye" }, { x: 2, y: 4, role: "iris", cluster: "left_eye" },
      { x: 5, y: 3, role: "iris", cluster: "right_eye" },
    ];
    expect(referenceIrisPigmentCells(face, design, undefined, [])).toEqual([]);
    expect(referenceIrisPigmentCells(face, design, [74, 55, 40], []).map(p => [p.x, p.y])).toEqual([[2, 4]]);
    expect(referenceIrisPigmentCells(face, design, [74, 55, 40], [{ x: 2, y: 4 }])).toEqual([]);
    face.pixels.push({ x: 2, y: 4, role: "hair_mid", cluster: "fringe" });
    expect(referenceIrisPigmentCells(face, design, [74, 55, 40], [])).toEqual([]);
  });
  it("rejects malformed palette/coordinates before modifying an atlas", () => {
    const { atlas, plan, design } = setup(); const before = atlas.rgba.slice();
    expect(() => applyReferenceFaceFinish(atlas, plan.facePixelPlan, design, { ...palette, skinMid: [NaN, 0, 0] }, [])).toThrow("reference_face_palette_invalid");
    plan.facePixelPlan.pixels.push({ x: 8, y: 0, role: "skin_mid", cluster: "complexion" });
    expect(() => applyReferenceFaceFinish(atlas, plan.facePixelPlan, design, palette, [])).toThrow("reference_face_coordinate_invalid");
    expect(atlas.rgba).toEqual(before);
  });
  it("captures twelve saved-source baselines and face-only previews in a fresh root, with zero provider calls", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const path = "evaluation-artifacts/generalization-20260905/annotations.json";
      const annotationBytes = readFileSync(path);
      const annotations: AnnotatedCase[] = JSON.parse(annotationBytes.toString()); expect(annotations).toHaveLength(12);
      const root = mkdtempSync("evaluation-artifacts/reference-style-face-preview-20261005-");
      const sheet: RawImage = { width: 256, height: 12 * 128, rgba: new Uint8Array(256 * 12 * 128 * 4) };
      const cases = [];
      for (const [row, fixture] of annotations.entries()) {
        const { analysis: raw } = strictBoundaryAnalysisFromAnnotation(fixture);
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        const analysis = normalizeAnalysisForRendering(raw);
        const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
        const plan = buildSkinPlan(analysis), faceStyle = buildFaceStyle(analysis, features, plan.hairPlan);
        const before = buildProceduralFallbackAtlas(features, faceStyle, plan)!; expect(before).not.toBeNull();
        const after = { ...before, rgba: before.rgba.slice() }; const design = buildReferenceStylePlan(analysis);
        // Explicit test protection: existing facial-hair grammar may own lower
        // face cells not present in FacePixelPlan. Never erase it for a preview.
        const beard = facialHairBaseFootprint(faceStyle);
        const material = plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
        const protectedSource = [...beard, ...material];
        const skin = String(features.skinTone);
        const rgb = [1, 3, 5].map(i => Number.parseInt(skin.slice(i, i + 2), 16)) as [number, number, number];
        const localPalette = { skinMid: rgb, skinShade: rgb.map(v => Math.max(0, v - 28)) as [number, number, number], lip: rgb.map((v, i) => Math.max(0, v - (i === 0 ? 18 : 45))) as [number, number, number] };
        const result = applyReferenceFaceFinish(after, plan.facePixelPlan, design, localPalette, protectedSource);
        verifyScope(before, after, [...protectedSource, ...plan.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "fringe", "glasses"].includes(p.cluster) || p.role === "brow")]);
        expect(validateFinalAtlas(after).ok, fixture.id).toBe(true);
        const repeated = { ...before, rgba: before.rgba.slice() };
        applyReferenceFaceFinish(repeated, plan.facePixelPlan, design, localPalette, protectedSource);
        expect(repeated.rgba).toEqual(after.rgba);
        const files = [`${fixture.id}-before.png`, `${fixture.id}-preview.png`];
        for (const [column, atlas] of [before, after].entries()) {
          const png = await encodePng(atlas); writeFileSync(`${root}/${files[column]}`, png, { flag: "wx" });
          expect((await decodePng(png)).rgba).toEqual(atlas.rgba);
          const head: RawImage = { width: 8, height: 8, rgba: new Uint8Array(256) };
          for (let y = 0; y < 8; y++) head.rgba.set(atlas.rgba.subarray(((8 + y) * 64 + 8) * 4, ((8 + y) * 64 + 16) * 4), y * 32);
          const expanded = scaleNearestNeighbor(head, 128, 128);
          for (let y = 0; y < 128; y++) sheet.rgba.set(expanded.rgba.subarray(y * 512, (y + 1) * 512), ((row * 128 + y) * 256 + column * 128) * 4);
        }
        cases.push({ caseId: fixture.id, calibrated: !!fixture.existing, stylePlan: design, changedCells: result.changedCells, eyesUnchanged: true, baselineRgbaHash: sha(before.rgba), previewRgbaHash: sha(after.rgba), planHash: sha(JSON.stringify(plan)), finalAtlasValid: true });
      }
      writeFileSync(`${root}/head-before-preview.png`, await encodePng(sheet), { flag: "wx" });
      writeFileSync(`${root}/results.json`, JSON.stringify({ status: "offline_face_finish_preview_not_default_production", providerCalls: 0, sourceAnnotationHash: sha(annotationBytes), cases, remaining: ["hair/outfit template rendering", "surface ownership integration", "rendered candidate scoring", "craft/retention acceptance of intentional style differences"] }, null, 2), { flag: "wx" });
      expect(readFileSync(path)).toEqual(annotationBytes); expect(network).not.toHaveBeenCalled();
      console.info(`REFERENCE_FACE_PREVIEW ${root}`);
    } finally { network.mockRestore(); }
  }, 60_000);
});
