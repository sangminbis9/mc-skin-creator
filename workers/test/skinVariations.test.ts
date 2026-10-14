import { describe, expect, it } from "vitest";
import { CLASSIC_LAYOUT as L, getBoxUvSeams } from "../../shared/skinLayout";
import {
  createSkinVariations,
  replaceSkinRegion,
  VARIATION_PARTS,
  type VariationRegion,
} from "../../src/lib/skinVariations";

function fixture(seed: number) {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < data.length; i += 4)
    data.set([(i + seed) % 255, (i * 7 + seed) % 255, seed, 255], i);
  return data;
}
const original = fixture(40),
  current = fixture(90);
const regions: VariationRegion[] = ["head", "upper", "lower"];
const offset = (p: { x: number; y: number }) => (p.y * 64 + p.x) * 4;

describe("mix and match atlas", () => {
  it("has original/current plus six hair finishes and ten outfits per clothing region", () => {
    const options = createSkinVariations(original, current);
    for (const region of regions) {
      const count = region === "head" ? 8 : 12;
      expect(options[region]).toHaveLength(count);
      expect(new Set(options[region].map((o) => o.id)).size).toBe(count);
      expect(options[region][0].pixels).toEqual(current);
      expect(options[region][1].pixels).toEqual(original);
      expect(options[region][0].pixels).not.toBe(current);
    }
    expect(createSkinVariations(original, current)).toEqual(options);
  });
  for (const region of regions)
    it(`${region}: replaces every base/overlay face and no other pixels`, () => {
      const expected = new Set<number>();
      for (const part of VARIATION_PARTS[region])
        for (const layer of Object.values(L[part]))
          for (const r of Object.values(layer)) {
            for (let y = r.y; y < r.y + r.h; y++)
              for (let x = r.x; x < r.x + r.w; x++)
                for (let c = 0; c < 4; c++) expected.add((y * 64 + x) * 4 + c);
          }
      const result = replaceSkinRegion(current, original, region);
      for (let i = 0; i < result.length; i++)
        expect(result[i]).toBe(expected.has(i) ? original[i] : current[i]);
      expect(current).toEqual(fixture(90));
      expect(original).toEqual(fixture(40));
    });
  it("clears old overlays, keeps all base pixels opaque, and never damages unused atlas pixels", () => {
    const options = createSkinVariations(original, current);
    for (const region of regions)
      for (const option of options[region].slice(2)) {
        const result = replaceSkinRegion(current, option.pixels, region);
        for (const part of VARIATION_PARTS[region])
          for (const r of Object.values(L[part].base))
            for (let y = r.y; y < r.y + r.h; y++)
              for (let x = r.x; x < r.x + r.w; x++)
                expect(result[(y * 64 + x) * 4 + 3]).toBe(255);
        expect(result.subarray(0, 4)).toEqual(current.subarray(0, 4));
      }
    const upper = replaceSkinRegion(current, options.upper[2].pixels, "upper");
    expect(
      upper[
        offset({ x: L.body.overlay.front.x, y: L.body.overlay.front.y + 4 }) + 3
      ],
    ).toBe(0);
  });
  it("preserves front facial pixels and accessories below the hair editing zone", () => {
    for (const option of createSkinVariations(original, current).head.slice(2))
      for (const layer of [L.head.base, L.head.overlay]) {
        const r = layer.front;
        for (let y = 2; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const i = offset({ x: r.x + x, y: r.y + y });
            expect(option.pixels.subarray(i, i + 4)).toEqual(
              current.subarray(i, i + 4),
            );
          }
      }
  });
  it("does not introduce changes at original hair front/side seams", () => {
    for (const option of createSkinVariations(original, current).head.slice(2))
      for (const seam of getBoxUvSeams(L.head.overlay).vertical.slice(0, 2)) {
        for (let y = 0; y < 2; y++) {
          const a = offset(seam.primary[y]),
            b = offset(seam.adjacent[y]);
          expect(option.pixels.subarray(a, a + 4)).toEqual(
            original.subarray(a, a + 4),
          );
          expect(option.pixels.subarray(b, b + 4)).toEqual(
            original.subarray(b, b + 4),
          );
        }
      }
  });
  it("selection order does not matter and original restoration is exact", () => {
    const options = createSkinVariations(original, current);
    const select = (order: VariationRegion[]) =>
      order.reduce(
        (p, r) => replaceSkinRegion(p, options[r][3].pixels, r),
        current,
      );
    const combined = select(regions);
    expect(select([...regions].reverse())).toEqual(combined);
    expect(
      regions.reduce((p, r) => replaceSkinRegion(p, original, r), combined),
    ).toEqual(
      regions.reduce((p, r) => replaceSkinRegion(p, original, r), current),
    );
    expect(
      replaceSkinRegion(combined, options.upper[3].pixels, "upper"),
    ).toEqual(combined);
  });
  it("rejects incorrectly sized data", () => {
    expect(() =>
      createSkinVariations(new Uint8ClampedArray(4), current),
    ).toThrow();
    expect(() =>
      replaceSkinRegion(current, new Uint8ClampedArray(4), "head"),
    ).toThrow();
  });
});
