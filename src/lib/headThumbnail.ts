import { CLASSIC_LAYOUT as L, type BoxUV } from "../../shared/skinLayout";

export type HeadView = "front" | "right" | "back";
type Point = [number, number, number];
const SIZE = 128;

/** Small orthographic rasterizer: real 8px base / 9px shell, no WebGL contexts.
 * Uses the same face orientation as getBoxUvSeams and the 3D skin renderer.
 */
export function headThumbnailPixels(skin: Uint8ClampedArray, view: HeadView) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depths = new Float32Array(SIZE * SIZE).fill(-Infinity);
  const yaw =
    view === "front" ? -0.38 : view === "right" ? -1.18 : Math.PI - 0.38;
  const pitch = 0.3,
    sy = Math.sin(yaw),
    cy = Math.cos(yaw);
  const sp = Math.sin(pitch),
    cp = Math.cos(pitch);
  const camera: Point = [sy * cp, sp, cy * cp];
  const project = ([x, y, z]: Point): Point => [
    64 + (x * cy - z * sy) * 9,
    64 - (-x * sy * sp + y * cp - z * cy * sp) * 9,
    x * camera[0] + y * camera[1] + z * camera[2],
  ];
  const point = (face: keyof BoxUV, u: number, v: number, h: number): Point => {
    const a = (u / 4 - 1) * h,
      b = (1 - v / 4) * h;
    switch (face) {
      case "front":
        return [a, b, h];
      case "back":
        return [-a, b, -h];
      case "right":
        return [-h, b, a];
      case "left":
        return [h, b, -a];
      case "top":
        return [a, h, -b];
      case "bottom":
        return [-a, -h, -b];
    }
  };
  const normals: Record<keyof BoxUV, Point> = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    right: [-1, 0, 0],
    left: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
  };
  const quads: { points: Point[]; i: number; light: number }[] = [];
  for (const layer of ["base", "overlay"] as const) {
    const h = layer === "base" ? 4 : 4.5;
    for (const face of Object.keys(normals) as (keyof BoxUV)[]) {
      if (normals[face].reduce((sum, n, k) => sum + n * camera[k], 0) <= 0)
        continue;
      const r = L.head[layer][face];
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = ((r.y + y) * 64 + r.x + x) * 4;
          if (!skin[i + 3]) continue;
          quads.push({
            i,
            light:
              face === "top"
                ? 1.08
                : face === "right" || face === "left"
                  ? 0.8
                  : 1,
            points: [
              [x, y],
              [x + 1, y],
              [x + 1, y + 1],
              [x, y + 1],
            ].map(([u, v]) => project(point(face, u, v, h))),
          });
        }
    }
  }
  quads.sort(
    (a, b) =>
      a.points.reduce((s, p) => s + p[2], 0) -
      b.points.reduce((s, p) => s + p[2], 0),
  );
  for (const { points: p, i, light } of quads) {
    const ax = p[1][0] - p[0][0],
      ay = p[1][1] - p[0][1];
    const bx = p[3][0] - p[0][0],
      by = p[3][1] - p[0][1];
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 0.00001) continue;
    const minX = Math.max(0, Math.floor(Math.min(...p.map((v) => v[0]))));
    const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(...p.map((v) => v[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...p.map((v) => v[1]))));
    const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(...p.map((v) => v[1]))));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - p[0][0],
          dy = y + 0.5 - p[0][1];
        const u = (dx * by - dy * bx) / det,
          v = (ax * dy - ay * dx) / det;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const depth =
          p[0][2] + u * (p[1][2] - p[0][2]) + v * (p[3][2] - p[0][2]);
        const index = y * SIZE + x;
        if (depth < depths[index] - 0.0001) continue;
        depths[index] = depth;
        const a = skin[i + 3] / 255,
          previous = data[index * 4 + 3] / 255;
        const out = a + previous * (1 - a);
        for (let c = 0; c < 3; c++)
          data[index * 4 + c] =
            (Math.min(255, skin[i + c] * light) * a +
              data[index * 4 + c] * previous * (1 - a)) /
            out;
        data[index * 4 + 3] = out * 255;
      }
  }
  return { width: SIZE, height: SIZE, data };
}
