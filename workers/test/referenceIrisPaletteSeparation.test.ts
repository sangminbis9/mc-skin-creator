import { describe, expect, it } from "vitest";
import { applyReferenceFaceFinish } from "../src/referenceFaceFinish";
import { buildSkinPlan } from "../src/skinPlan";
import { buildReferenceStylePlan, FACE_STYLE_TEMPLATES, type FaceStyleFamily } from "../src/referenceStyleTemplates";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function fixture() {
  const analysis = makeAnalysis(), face = structuredClone(buildSkinPlan(analysis).facePixelPlan);
  face.pixels = [
    { x: 2, y: 3, cluster: "left_eye", role: "iris" }, { x: 2, y: 4, cluster: "left_eye", role: "iris" },
    { x: 5, y: 3, cluster: "right_eye", role: "iris" }, { x: 5, y: 4, cluster: "right_eye", role: "iris" },
  ];
  const protectedCells = Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8) }))
    .filter(p => !face.pixels.some(q => p.x === q.x && p.y === q.y));
  return { face, atlas: makeSyntheticAtlas(), design: buildReferenceStylePlan(analysis), protectedCells };
}
const distance = (a: readonly number[], b: readonly number[]) => a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0);

describe("iris shade retains source-palette identity instead of blending into complexion", () => {
  it("reproduces the brown-skin/dark-eye collision without moving an eye or changing skin tone", () => {
    const b = fixture(); b.design.face.family = "dark_stylish";
    const before = b.atlas.rgba.slice(), plan = JSON.stringify(b.face), eye = [74, 55, 40] as const;
    const result = applyReferenceFaceFinish(b.atlas, b.face, b.design,
      { skinMid: [141, 90, 58], skinShade: [110, 70, 45], lip: [123, 45, 13], eye }, b.protectedCells);
    expect(result.irisPigmentCells.map(p => p.color)).toEqual([[...eye], [...eye]]);
    expect(JSON.stringify(b.face)).toBe(plan);
    const front = CLASSIC_LAYOUT.head.base.front;
    for (let i = 0; i < 4096; i++) {
      expect(b.atlas.rgba[i * 4 + 3]).toBe(before[i * 4 + 3]);
      const x = i % 64 - front.x, y = Math.floor(i / 64) - front.y;
      if (!b.face.pixels.some(p => p.x === x && p.y === y))
        expect(b.atlas.rgba.slice(i * 4, i * 4 + 4)).toEqual(before.slice(i * 4, i * 4 + 4));
    }
  });
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("keeps %s highlights when their pigment remains closer to the eye palette", family => {
    for (const skin of [[232, 185, 143], [141, 90, 58], [78, 49, 35]] as const)
      for (const eye of [[74, 55, 40], [38, 73, 104], [156, 181, 198]] as const) {
        const b = fixture(); b.design.face.family = family;
        const candidate = eye.map(v => Math.min(255, Math.round(v * FACE_STYLE_TEMPLATES[family].irisPigment)));
        const expected = distance(candidate, skin) <= distance(candidate, eye) ? [...eye] : candidate;
        const result = applyReferenceFaceFinish(b.atlas, b.face, b.design,
          { skinMid: skin, skinShade: [40, 30, 20], lip: [100, 40, 40], eye }, b.protectedCells);
        expect(result.irisPigmentCells.map(p => p.color)).toEqual([expected, expected]);
        expect(result.irisGlintCells).toHaveLength(2);
      }
  });
  it("never repaints a protected eye cell to improve contrast", () => {
    const b = fixture(), protectedCell = { x: 2, y: 4 };
    const result = applyReferenceFaceFinish(b.atlas, b.face, b.design,
      { skinMid: [141, 90, 58], skinShade: [110, 70, 45], lip: [123, 45, 13], eye: [74, 55, 40] },
      [...b.protectedCells, protectedCell]);
    expect(result.irisPigmentCells.some(p => p.x === 2 && p.y === 4)).toBe(false);
    expect(result.irisGlintCells).toEqual([]);
  });
});
