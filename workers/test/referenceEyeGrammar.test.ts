import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { applyReferenceFaceFinish, referenceIrisGlintCells } from "../src/referenceFaceFinish";
import { buildReferenceStylePlan, FACE_STYLE_TEMPLATES, type FaceStyleFamily } from "../src/referenceStyleTemplates";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture() {
  const a = normalizeAnalysisForRendering(makeAnalysis());
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const plan = buildSkinPlan(a), style = buildFaceStyle(a, features, plan.hairPlan);
  const atlas = buildProceduralFallbackAtlas(features, style, plan)!;
  const face = structuredClone(plan.facePixelPlan);
  // Authored unit topology, never a new photo measurement or frozen annotation.
  face.pixels = [
    { x: 2, y: 3, role: "iris", cluster: "left_eye" }, { x: 2, y: 4, role: "iris", cluster: "left_eye" },
    { x: 5, y: 3, role: "iris", cluster: "right_eye" }, { x: 5, y: 4, role: "iris", cluster: "right_eye" },
  ];
  return { atlas, face, design: buildReferenceStylePlan(a) };
}

describe("curated narrow two-row eye grammar", () => {
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("renders %s light catches only inside existing paired iris coordinates", family => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const { atlas, face, design } = fixture(); design.face.family = family;
      const source = JSON.stringify(face), before = atlas.rgba.slice(), front = CLASSIC_LAYOUT.head.base.front;
      const eye = [74, 55, 40] as const;
      // Isolate this eye grammar from independently tested rim/cheek accents.
      const protectedAccents = Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8) }))
        .filter(p => !face.pixels.some(q => p.x === q.x && p.y === q.y));
      const glints = referenceIrisGlintCells(face, design, eye, []);
      expect(glints.map(p => [p.x, p.y])).toEqual([[2, 3], [5, 3]]);
      const result = applyReferenceFaceFinish(atlas, face, design, { skinMid: [215, 179, 145], skinShade: [135, 99, 79], lip: [134, 79, 74], eye }, protectedAccents);
      expect(result.irisGlintCells).toEqual(glints); expect(result.irisPigmentCells).toHaveLength(2);
      expect(JSON.stringify(face)).toBe(source);
      for (const p of glints) {
        const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
        expect([...atlas.rgba.slice(i, i + 3)]).toEqual(eye.map((v, c) => Math.round(v * (1 - FACE_STYLE_TEMPLATES[family].irisGlint) + [248, 246, 240][c] * FACE_STYLE_TEMPLATES[family].irisGlint)));
        const lower = result.irisPigmentCells.find(q => q.x === p.x)!;
        expect(p.color.reduce((sum, v, c) => sum + Math.abs(v - lower.color[c]), 0)).toBeGreaterThan(200);
      }
      for (let i = 0; i < 4096; i++) {
        expect(atlas.rgba[i * 4 + 3]).toBe(before[i * 4 + 3]);
        const x = i % 64 - front.x, y = Math.floor(i / 64) - front.y;
        if (!face.pixels.some(p => p.x === x && p.y === y)) expect(atlas.rgba.slice(i * 4, i * 4 + 4)).toEqual(before.slice(i * 4, i * 4 + 4));
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it.each(["singleton", "wide", "sclera", "tilt", "asymmetric", "duplicate", "glasses", "fringe"] as const)("retains %s source grammar rather than manufacturing a highlight pair", kind => {
    const { face, design } = fixture();
    if (kind === "singleton" || kind === "asymmetric") face.pixels = face.pixels.filter(p => kind === "singleton" ? p.y === 3 : !(p.cluster === "right_eye" && p.y === 4));
    if (kind === "wide") face.pixels.push({ x: 3, y: 3, role: "iris", cluster: "left_eye" });
    if (kind === "sclera") face.pixels.push({ x: 1, y: 3, role: "sclera", cluster: "left_eye" });
    if (kind === "tilt") face.pixels.filter(p => p.cluster === "right_eye").forEach(p => p.y++);
    if (kind === "duplicate") face.pixels[1].y = 3;
    if (kind === "glasses") face.pixels.push({ x: 2, y: 4, role: "glasses", cluster: "glasses" });
    if (kind === "fringe") face.pixels.push({ x: 5, y: 3, role: "hair_mid", cluster: "fringe" });
    expect(referenceIrisGlintCells(face, design, [74, 55, 40], [])).toEqual([]);
  });
  it("never makes one half of a blocked pair or invents a missing source color", () => {
    const { face, design } = fixture();
    for (const p of face.pixels) expect(referenceIrisGlintCells(face, design, [74, 55, 40], [p])).toEqual([]);
    for (const eye of [undefined, [], [NaN, 1, 2], [1, 2, 256]]) expect(referenceIrisGlintCells(face, design, eye, [])).toEqual([]);
  });
  it("treats actual eye-cluster brow instructions as protected brows, not extra iris pixels", () => {
    const { atlas, face, design } = fixture(), front = CLASSIC_LAYOUT.head.base.front;
    face.pixels.push({ x: 2, y: 2, role: "brow", cluster: "left_eye" }, { x: 5, y: 2, role: "brow", cluster: "right_eye" });
    const before = atlas.rgba.slice();
    const result = applyReferenceFaceFinish(atlas, face, design, { skinMid: [215, 179, 145], skinShade: [135, 99, 79], lip: [134, 79, 74], eye: [74, 55, 40] }, []);
    expect(result.irisGlintCells).toHaveLength(2);
    for (const x of [2, 5]) {
      const i = ((front.y + 2) * 64 + front.x + x) * 4;
      expect(atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
    }
  });
});

describe("reference eye grammar review", () => {
  it.skipIf(!process.env.REFERENCE_STYLE_ATLAS_PATH)("enlarges the optional supplied reference without changing its pixels", async () => {
    const input = readFileSync(process.env.REFERENCE_STYLE_ATLAS_PATH!);
    const atlas = await decodePng(input);
    expect([atlas.width, atlas.height]).toEqual([64, 64]);
    const root = mkdtempSync("evaluation-artifacts/reference-eye-grammar-review-20261005-");
    writeFileSync(`${root}/reference-atlas.png`, await encodePng(scaleNearestNeighbor(atlas, 768, 768)), { flag: "wx" });
    writeFileSync(`${root}/reference-front.png`, await encodePng(scaleNearestNeighbor(renderSkinViews(atlas).find(v => v.name === "front")!.image, 384, 576)), { flag: "wx" });
    expect(readFileSync(process.env.REFERENCE_STYLE_ATLAS_PATH!)).toEqual(input);
    console.info(`REFERENCE_EYE_GRAMMAR_REVIEW ${root}`);
  });
});
