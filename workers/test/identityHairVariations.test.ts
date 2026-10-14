import { describe, expect, it } from "vitest";
import { CLASSIC_LAYOUT as L, getBoxUvSeams } from "../../shared/skinLayout";
import {
  analyzeHair,
  HAIR_FINISHES,
  preserveDrapedHair,
  varyOriginalHair,
} from "../../src/lib/hairVariations";
import { createSkinVariations } from "../../src/lib/skinVariations";
import {
  TOP_STYLES,
  BOTTOM_STYLES,
  makeWardrobe,
} from "../../src/lib/wardrobeVariations";

const offset = (x: number, y: number) => (y * 64 + x) * 4;
const skin: [number, number, number] = [221, 179, 149];
function portrait(long = false, hair: [number, number, number] = [29, 25, 23]) {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (const [part, layout] of Object.entries(L))
    for (const [face, r] of Object.entries(layout.base)) {
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          let c = part === "head" ? skin : [75, 106, 139];
          const depth =
            face === "front" ? [3, 2, 1, 0, 2, 3, 3, 2][x] : long ? 8 : 5;
          if (
            part === "head" &&
            face !== "bottom" &&
            (face === "top" || y < depth)
          )
            c = hair.map((v) => v + (x % 3) * 3);
          data.set([...c, 255], offset(r.x + x, r.y + y));
        }
    }
  // Lower face and glasses-like accessory: immutable even if dark like hair.
  data.set(
    [12, 12, 12, 255],
    offset(L.head.overlay.front.x + 2, L.head.overlay.front.y + 3),
  );
  data.set(
    [200, 30, 50, 255],
    offset(L.head.overlay.right.x + 3, L.head.overlay.right.y + 3),
  );
  // Partial top/side shell to exercise both additions and tightening.
  for (const face of ["top", "left", "right", "back"] as const) {
    const r = L.head.overlay[face];
    for (let y = 0; y < (face === "top" ? 8 : 3); y++)
      for (let x = 0; x < 8; x++) {
        if (face === "top" && x > 2 && x < 5 && y > 2 && y < 5) continue;
        if (face === "right" && x === 3 && y === 3) continue;
        data.set([...hair, 255], offset(r.x + x, r.y + y));
      }
  }
  return data;
}

describe("identity-preserving hair", () => {
  for (const long of [false, true])
    for (const color of [
      [29, 25, 23],
      [128, 52, 30],
      [225, 211, 116],
    ] as [number, number, number][]) {
      it(`keeps silhouette, parting and face for ${long ? "long" : "short"} ${color}`, () => {
        const original = portrait(long, color),
          analysis = analyzeHair(original);
        expect(analysis.reason).toBeUndefined();
        for (const { id } of HAIR_FINISHES) {
          const result = varyOriginalHair(original, id, analysis);
          for (const node of analysis.nodes) {
            if (
              !analysis.mask.has(node.i) &&
              !(id === "volume" && node.layer === "overlay")
            )
              expect(result.subarray(node.i, node.i + 4)).toEqual(
                original.subarray(node.i, node.i + 4),
              );
            if (node.layer === "base" || node.face === "front" || node.edge)
              expect(result[node.i + 3]).toBe(original[node.i + 3]);
            if (node.face === "front" && node.y >= 2)
              expect(result.subarray(node.i, node.i + 4)).toEqual(
                original.subarray(node.i, node.i + 4),
              );
            if (
              id === "volume" &&
              result[node.i + 3] !== original[node.i + 3]
            ) {
              expect(node.layer).toBe("overlay");
              const r = L.head.base[node.face];
              const bi = offset(r.x + node.x, r.y + node.y);
              expect(
                [bi, bi - 4, bi + 4, bi - 256, bi + 256].every((i) =>
                  analysis.mask.has(i),
                ),
              ).toBe(true);
            }
          }
          for (const layer of [L.head.base, L.head.overlay]) {
            const seams = getBoxUvSeams(layer);
            for (const seam of [...seams.vertical, ...seams.horizontal])
              for (const p of [...seam.primary, ...seam.adjacent]) {
                const i = offset(p.x, p.y);
                expect(result.subarray(i, i + 4)).toEqual(
                  original.subarray(i, i + 4),
                );
              }
          }
        }
      });
    }
  it("makes six distinct deterministic finishes without cumulative drift", () => {
    const original = portrait(),
      options = createSkinVariations(original, original).head.slice(2);
    expect(
      new Set(options.map((o) => Array.from(o.pixels).join(","))).size,
    ).toBe(6);
    for (const option of options) {
      const repeated = createSkinVariations(original, option.pixels).head.find(
        (o) => o.id === option.id,
      )!;
      expect(repeated.pixels).toEqual(option.pixels);
    }
  });
  it("disables uncertain, bald or covered hair instead of inventing a haircut", () => {
    const lowContrastBlond = portrait(false, [216, 208, 165]);
    const blondAnalysis = analyzeHair(lowContrastBlond);
    expect(blondAnalysis.reason).toBeTruthy();
    for (const { id } of HAIR_FINISHES)
      expect(varyOriginalHair(lowContrastBlond, id, blondAnalysis)).toEqual(
        lowContrastBlond,
      );
    const original = portrait(false, skin);
    for (const hints of [
      {},
      { hairstyle: "bald" },
      { hat: "cap" },
      { hat: "hood" },
    ]) {
      const analysis = analyzeHair(original, hints);
      expect(analysis.reason).toBeTruthy();
      for (const { id } of HAIR_FINISHES)
        expect(varyOriginalHair(original, id, analysis)).toEqual(original);
    }
  });
  it("retains confident long-hair overlays when changing tops", () => {
    const original = portrait(true),
      r = L.body.overlay.back;
    for (let y = 0; y < 7; y++)
      original.set([29, 25, 23, 255], offset(r.x + 3, r.y + y));
    const analysis = analyzeHair(original);
    const target = makeWardrobe(original, "upper", TOP_STYLES[3], skin);
    preserveDrapedHair(target, original, analysis);
    for (let y = 0; y < 7; y++) {
      const i = offset(r.x + 3, r.y + y);
      expect(target.subarray(i, i + 4)).toEqual(original.subarray(i, i + 4));
    }
  });
});

describe("detailed wardrobe", () => {
  it("has ten distinct designs per clothing region", () => {
    const original = portrait();
    for (const [region, options] of [
      ["upper", TOP_STYLES],
      ["lower", BOTTOM_STYLES],
    ] as const) {
      expect(options).toHaveLength(10);
      const outputs = options.map((style) =>
        makeWardrobe(original, region, style, skin),
      );
      expect(new Set(outputs.map((p) => Array.from(p).join(","))).size).toBe(
        10,
      );
      const layers =
        region === "upper"
          ? [L.body, L.leftArm, L.rightArm]
          : [L.leftLeg, L.rightLeg];
      for (const result of outputs)
        for (const layout of layers) {
          for (const seam of getBoxUvSeams(layout.base).vertical)
            for (let k = 1; k < seam.primary.length; k++) {
              const a = seam.primary[k],
                b = seam.adjacent[k];
              const ai = offset(a.x, a.y),
                bi = offset(b.x, b.y);
              expect(result.subarray(ai, ai + 4)).toEqual(
                result.subarray(bi, bi + 4),
              );
            }
        }
    }
  });
});
