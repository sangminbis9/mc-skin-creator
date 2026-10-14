import { describe, expect, it } from "vitest";
import { CLASSIC_LAYOUT as L, getBoxUvSeams } from "../../shared/skinLayout";
import {
  analyzeHair,
  HAIR_FINISHES,
  preserveDrapedHair,
  varyOriginalHair,
} from "../../src/lib/hairVariations";
import { createSkinVariations } from "../../src/lib/skinVariations";
import { headThumbnailPixels } from "../../src/lib/headThumbnail";
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
            const r = L.head.base[node.face],
              bi = offset(r.x + node.x, r.y + node.y);
            if (
              node.layer === "base" ||
              (node.face === "front" && node.y >= 3) ||
              !analysis.mask.has(bi) ||
              (original[node.i + 3] && !analysis.mask.has(node.i))
            ) {
              expect(result.subarray(node.i, node.i + 4)).toEqual(
                original.subarray(node.i, node.i + 4),
              );
            }
            if (result[node.i + 3] !== original[node.i + 3]) {
              expect(node.layer).toBe("overlay");
              expect(analysis.mask.has(bi)).toBe(true);
            }
          }
          const seams = getBoxUvSeams(L.head.overlay);
          for (const seam of [...seams.vertical, ...seams.horizontal])
            seam.primary.forEach((p, k) => {
              const q = seam.adjacent[k],
                a = offset(p.x, p.y),
                b = offset(q.x, q.y);
              const changed = [a, b].some((i) =>
                Array.from(result.subarray(i, i + 4)).some(
                  (v, c) => v !== original[i + c],
                ),
              );
              if (changed)
                expect(result.subarray(a, a + 4)).toEqual(
                  result.subarray(b, b + 4),
                );
            });
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
  it("changes actual front and side shell occupancy, not only colour", () => {
    const original = portrait(),
      analysis = analyzeHair(original);
    const alpha = (
      finish: (typeof HAIR_FINISHES)[number]["id"],
      face: "front" | "right" | "left",
    ) => {
      const result = varyOriginalHair(original, finish, analysis),
        r = L.head.overlay[face];
      return Array.from(
        { length: 64 },
        (_, p) => result[offset(r.x + (p % 8), r.y + Math.floor(p / 8)) + 3],
      );
    };
    const difference = (a: number[], b: number[]) =>
      a.filter((v, i) => v !== b[i]).length;
    expect(
      difference(alpha("defined", "front"), alpha("soft", "front")),
    ).toBeGreaterThanOrEqual(5);
    for (const face of ["right", "left"] as const)
      expect(
        difference(alpha("silky", face), alpha("tidy", face)),
      ).toBeGreaterThanOrEqual(10);
    const patterns = HAIR_FINISHES.map(({ id }) =>
      ["front", "right", "left", "top"]
        .map((face) => {
          const r = L.head.overlay[face as keyof typeof L.head.overlay],
            pixels = varyOriginalHair(original, id, analysis);
          return Array.from(
            { length: 64 },
            (_, p) =>
              pixels[offset(r.x + (p % 8), r.y + Math.floor(p / 8)) + 3],
          ).join(",");
        })
        .join("|"),
    );
    expect(new Set(patterns).size).toBe(6);
  });
  it("keeps overlay-only locks, parting grooves and eye-row accessories", () => {
    const original = portrait();
    // Connected 2px front parting groove with hair in the base underneath.
    const f = L.head.overlay.front;
    for (let y = 0; y < 2; y++)
      for (const x of [4, 6])
        original.set([29, 25, 23, 255], offset(f.x + x, f.y + y));
    const lock = offset(f.x + 3, f.y + 2); // skin below an open parting
    original.set([29, 25, 23, 255], lock);
    const analysis = analyzeHair(original);
    for (const { id } of HAIR_FINISHES) {
      const result = varyOriginalHair(original, id, analysis);
      for (let y = 0; y < 2; y++)
        expect(result[offset(f.x + 5, f.y + y) + 3]).toBe(0);
      expect(result.subarray(lock, lock + 4)).toEqual(
        original.subarray(lock, lock + 4),
      );
    }
  });
  it("shows shell depth in thumbnails, including visible silhouette differences", () => {
    const original = portrait(),
      analysis = analyzeHair(original);
    for (const view of ["front", "right", "back"] as const) {
      const full = headThumbnailPixels(
        varyOriginalHair(original, "volume", analysis),
        view,
      );
      const light = headThumbnailPixels(
        varyOriginalHair(original, "matte", analysis),
        view,
      );
      expect(full.data.length).toBe(128 * 128 * 4);
      const changed = Array.from(full.data).filter(
        (v, i) => i % 4 === 3 && v !== light.data[i],
      ).length;
      expect(changed).toBeGreaterThan(25);
      expect(
        headThumbnailPixels(
          varyOriginalHair(original, "volume", analysis),
          view,
        ),
      ).toEqual(full);
    }
  });
  it("never adds shell in slimming variants and explains unavailable changes", () => {
    const original = portrait(),
      analysis = analyzeHair(original);
    for (const id of ["soft", "matte", "tidy"] as const) {
      const result = varyOriginalHair(original, id, analysis);
      for (const n of analysis.nodes.filter((n) => n.layer === "overlay"))
        expect(result[n.i + 3]).toBeLessThanOrEqual(original[n.i + 3]);
    }
    for (const r of Object.values(L.head.overlay))
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          original.fill(
            0,
            offset(r.x + x, r.y + y),
            offset(r.x + x, r.y + y) + 4,
          );
    const options = createSkinVariations(original, original).head;
    for (const id of ["soft", "matte", "tidy"])
      expect(options.find((o) => o.id === id)?.disabledReason).toBeTruthy();
    expect(
      options.find((o) => o.id === "volume")?.disabledReason,
    ).toBeUndefined();
  });
  it("does not fill a two-pixel-wide authored parting groove", () => {
    const original = portrait(),
      f = L.head.overlay.front;
    for (let y = 0; y < 2; y++)
      for (const x of [4, 7])
        original.set([29, 25, 23, 255], offset(f.x + x, f.y + y));
    const result = varyOriginalHair(original, "volume", analyzeHair(original));
    for (let y = 0; y < 2; y++)
      for (const x of [5, 6])
        expect(result[offset(f.x + x, f.y + y) + 3]).toBe(0);
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
