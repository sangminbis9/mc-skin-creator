import { describe, expect, it } from "vitest";
import { convertClassicRgbaToSlim } from "../../src/lib/slimSkin";

const SIZE = 64;
const offset = (x: number, y: number) => (y * SIZE + x) * 4;

function markerAtlas(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      rgba.set([x, y, (x * 7 + y * 11) % 256, 255], offset(x, y));
    }
  }
  return rgba;
}

function pixel(rgba: Uint8ClampedArray, x: number, y: number): number[] {
  return Array.from(rgba.slice(offset(x, y), offset(x, y) + 4));
}

describe("Java slim atlas conversion", () => {
  it("maps all four classic arm nets onto Mojang's 3px layout", () => {
    const source = markerAtlas();
    const slim = convertClassicRgbaToSlim(source);

    for (const [u, v] of [
      [40, 16],
      [40, 32],
      [32, 48],
      [48, 48],
    ] as const) {
      for (const [targetX, sourceX] of [
        [0, 0],
        [1, 1],
        [2, 3],
      ] as const) {
        expect(pixel(slim, u + 4 + targetX, v)).toEqual(
          pixel(source, u + 4 + sourceX, v),
        );
        expect(pixel(slim, u + 7 + targetX, v)).toEqual(
          pixel(source, u + 8 + sourceX, v),
        );
        expect(pixel(slim, u + 4 + targetX, v + 8)).toEqual(
          pixel(source, u + 4 + sourceX, v + 8),
        );
        expect(pixel(slim, u + 11 + targetX, v + 8)).toEqual(
          pixel(source, u + 12 + sourceX, v + 8),
        );
      }
      for (let depth = 0; depth < 4; depth++) {
        expect(pixel(slim, u + depth, v + 8)).toEqual(
          pixel(source, u + depth, v + 8),
        );
        expect(pixel(slim, u + 7 + depth, v + 8)).toEqual(
          pixel(source, u + 8 + depth, v + 8),
        );
      }
    }
  });

  it("clears unused slim cells and preserves every pixel outside arm allocations", () => {
    const source = markerAtlas();
    const slim = convertClassicRgbaToSlim(source);
    const armAllocations = [
      [40, 16],
      [40, 32],
      [32, 48],
      [48, 48],
    ] as const;
    for (const [u, v] of armAllocations) {
      expect(pixel(slim, u + 15, v + 15)).toEqual([0, 0, 0, 0]);
      expect(pixel(slim, u + 14, v + 4)).toEqual([0, 0, 0, 0]);
    }
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inArm = armAllocations.some(
          ([u, v]) => x >= u && x < u + 16 && y >= v && y < v + 16,
        );
        if (!inArm) expect(pixel(slim, x, y)).toEqual(pixel(source, x, y));
      }
    }
  });

  it("rejects non-64x64 RGBA input", () => {
    expect(() => convertClassicRgbaToSlim(new Uint8Array(16))).toThrow(
      "64x64 RGBA",
    );
  });
});
