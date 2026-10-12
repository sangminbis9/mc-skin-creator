import { expect } from "vitest";
import type { RawImage } from "../src/png";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { referenceEyePresentation, referenceIrisPigmentCells } from "../src/referenceFaceFinish";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

/** A strict historical boundary, not a renderer shim or golden rewrite.
 * Current output must already pass production validation. Require the exact
 * declared current colors, historical skin/contour colors, unchanged alpha,
 * and bit equality everywhere except the two singleton irises + upper catches.
 */
export function assertHistoricalSingletonEyePresentation(
  current: RawImage, historical: RawImage, baseline: RawImage,
  plan: SkinPlan, style: FaceStyle, design: ReferenceStylePlan,
) {
  const rgb = (hex: string) => {
    expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  };
  const eye = rgb(style.eyeColor!), skin = rgb(style.skinTone!);
  const material = plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.face === "front"
    && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
  const protectedCells = [...facialHairBaseFootprint(style), ...material];
  const pigment = referenceIrisPigmentCells(plan.facePixelPlan, design, eye, protectedCells, skin);
  const presentation = referenceEyePresentation(plan.facePixelPlan, design, eye, protectedCells, baseline);
  expect(pigment).toHaveLength(2);
  expect(presentation.kind).toBe("paired_upper_catch"); expect(presentation.cells).toHaveLength(2);
  const front = CLASSIC_LAYOUT.head.base.front;
  const index = (p: { x: number; y: number }) => (front.y + p.y) * 64 + front.x + p.x;
  const expected = new Map([
    ...pigment.map(p => [index(p), { ...p, previous: [...baseline.rgba.slice(index(p) * 4, index(p) * 4 + 3)] }] as const),
    ...presentation.cells.map(p => [index(p), { ...p, previous: skin }] as const),
  ]);
  expect(expected.size).toBe(4);
  const changed = [];
  for (let i = 0; i < 4096; i++) {
    expect(current.rgba[i * 4 + 3], `alpha:${i}`).toBe(historical.rgba[i * 4 + 3]);
    const cell = expected.get(i);
    if (!cell) {
      expect(current.rgba.slice(i * 4, i * 4 + 4), `outside-eye-presentation:${i}`).toEqual(historical.rgba.slice(i * 4, i * 4 + 4));
      continue;
    }
    expect([...current.rgba.slice(i * 4, i * 4 + 3)]).toEqual(cell.color);
    expect([...historical.rgba.slice(i * 4, i * 4 + 3)]).toEqual(cell.previous);
    expect(cell.color).not.toEqual(cell.previous);
    changed.push({ x: cell.x, y: cell.y, before: cell.previous, after: cell.color });
  }
  return changed;
}

/** The later fallback-brow presentation may change two cells, not a whole
 * face. Old brow pixels must equal the unchanged pre-finish baseline, while
 * current colors must equal the independently derived presentation contract.
 */
export function assertHistoricalFallbackBrowPresentation(
  current: RawImage, historical: RawImage, baseline: RawImage,
  plan: SkinPlan, style: FaceStyle, design: ReferenceStylePlan,
) {
  const eye = [1, 3, 5].map(i => Number.parseInt(style.eyeColor!.slice(i, i + 2), 16));
  const material = plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.face === "front"
    && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
  const presentation = referenceEyePresentation(plan.facePixelPlan, design, eye, [...facialHairBaseFootprint(style), ...material], baseline);
  expect(presentation.kind).toBe("paired_upper_catch_unmeasured_brow"); expect(presentation.cells).toHaveLength(2);
  const front = CLASSIC_LAYOUT.head.base.front;
  const expected = new Map(presentation.cells.map(p => [(front.y + p.y) * 64 + front.x + p.x, p]));
  for (let i = 0; i < 4096; i++) {
    expect(current.rgba[i * 4 + 3]).toBe(historical.rgba[i * 4 + 3]);
    const p = expected.get(i);
    if (!p) expect(current.rgba.slice(i * 4, i * 4 + 4), `non-fallback-brow:${i}`).toEqual(historical.rgba.slice(i * 4, i * 4 + 4));
    else {
      expect([...current.rgba.slice(i * 4, i * 4 + 3)]).toEqual(p.color);
      expect(historical.rgba.slice(i * 4, i * 4 + 4)).toEqual(baseline.rgba.slice(i * 4, i * 4 + 4));
      expect(current.rgba.slice(i * 4, i * 4 + 4)).not.toEqual(historical.rgba.slice(i * 4, i * 4 + 4));
    }
  }
  return presentation.cells;
}
