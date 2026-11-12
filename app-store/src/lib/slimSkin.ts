import { ATLAS_SIZE, type Rect } from "./skinAtlas";

const RGBA_LENGTH = ATLAS_SIZE * ATLAS_SIZE * 4;

function pixelOffset(x: number, y: number): number {
  return (y * ATLAS_SIZE + x) * 4;
}

function clearRect(rgba: Uint8ClampedArray, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    rgba.fill(0, pixelOffset(rect.x, y), pixelOffset(rect.x + rect.w, y));
  }
}

function copyFace(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  from: Rect,
  toX: number,
  toY: number,
  keepColumns: readonly number[] = Array.from(
    { length: from.w },
    (_, index) => index,
  ),
): void {
  for (let y = 0; y < from.h; y++) {
    for (let targetX = 0; targetX < keepColumns.length; targetX++) {
      const sourceX = keepColumns[targetX];
      const fromOffset = pixelOffset(from.x + sourceX, from.y + y);
      const toOffset = pixelOffset(toX + targetX, toY + y);
      target.set(source.subarray(fromOffset, fromOffset + 4), toOffset);
    }
  }
}

/** Convert one classic 4px arm net at (u,v) to Mojang's 3px slim layout. */
function convertArm(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  u: number,
  v: number,
): void {
  clearRect(target, { x: u, y: v, w: 16, h: 16 });
  const narrowColumns = [0, 1, 3] as const;
  copyFace(
    target,
    source,
    { x: u + 4, y: v, w: 4, h: 4 },
    u + 4,
    v,
    narrowColumns,
  );
  copyFace(
    target,
    source,
    { x: u + 8, y: v, w: 4, h: 4 },
    u + 7,
    v,
    narrowColumns,
  );
  copyFace(
    target,
    source,
    { x: u, y: v + 4, w: 4, h: 12 },
    u,
    v + 4,
  );
  copyFace(
    target,
    source,
    { x: u + 4, y: v + 4, w: 4, h: 12 },
    u + 4,
    v + 4,
    narrowColumns,
  );
  copyFace(
    target,
    source,
    { x: u + 8, y: v + 4, w: 4, h: 12 },
    u + 7,
    v + 4,
  );
  copyFace(
    target,
    source,
    { x: u + 12, y: v + 4, w: 4, h: 12 },
    u + 11,
    v + 4,
    narrowColumns,
  );
}

/**
 * Convert all right/left base and outer arm nets to Java slim geometry.
 * Every non-arm texel stays byte-for-byte identical; unused cells in each
 * 16×16 arm allocation are transparent as required by the slim layout.
 */
export function convertClassicRgbaToSlim(
  input: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  if (input.length !== RGBA_LENGTH) {
    throw new Error("Slim conversion requires one 64x64 RGBA atlas");
  }
  const source = new Uint8ClampedArray(input);
  const target = source.slice();
  for (const [u, v] of [
    [40, 16],
    [40, 32],
    [32, 48],
    [48, 48],
  ] as const) {
    convertArm(target, source, u, v);
  }
  return target;
}
