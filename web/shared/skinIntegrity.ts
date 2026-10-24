/** Structural repairs only. Color discontinuities need material ownership;
 * eyes, garment openings, sleeve cuffs and asymmetric cues must not be blurred. */
import { ALL_PARTS, CLASSIC_LAYOUT, SLIM_LAYOUT, getBoxUvSeams, type SkinGeometry } from "./skinLayout";
export interface AtlasImage { width: number; height: number; rgba: Uint8Array }
export function repairSkinIntegrity(input: AtlasImage, reference?: AtlasImage, geometry: SkinGeometry = "classic") {
  if (input.width !== 64 || input.height !== 64 || input.rgba.length !== 16384) throw new Error("Invalid skin dimensions");
  if (reference && (reference.width !== 64 || reference.height !== 64 || reference.rgba.length !== 16384)) throw new Error("Invalid reference dimensions");
  const atlas = { ...input, rgba: input.rgba.slice() }, zones = new Uint8Array(4096);
  const layout = geometry === "slim" ? SLIM_LAYOUT : CLASSIC_LAYOUT;
  for (const part of ALL_PARTS) for (const layer of ["base", "overlay"] as const)
    for (const r of Object.values(layout[part][layer])) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) zones[(r.y + y) * 64 + r.x + x] = layer === "base" ? 1 : 2;
  let outside = 0, baseHoles = 0, alpha = 0, unresolved = 0;
  for (let p = 0; p < 4096; p++) {
    const i = p * 4, a = atlas.rgba[i + 3];
    if (!zones[p]) {
      if (atlas.rgba.subarray(i, i + 4).some(v => v !== 0)) { atlas.rgba.fill(0, i, i + 4); outside++; }
    } else if (zones[p] === 1 && a !== 255) {
      if (a === 0) {
        if (reference?.rgba[i + 3] === 255) { atlas.rgba.set(reference.rgba.subarray(i, i + 4), i); baseHoles++; }
        else unresolved++;
      } else { atlas.rgba[i + 3] = 255; alpha++; }
    } else if (zones[p] === 2 && a !== 0 && a !== 255) { atlas.rgba[i + 3] = a >= 128 ? 255 : 0; alpha++; }
  }
  let seamPairs = 0, colorEdges = 0, alphaEdges = 0;
  for (const part of ALL_PARTS) for (const layer of ["base", "overlay"] as const) {
    const edges = getBoxUvSeams(layout[part][layer]);
    for (const s of [...edges.vertical, ...edges.horizontal]) s.primary.forEach((p, n) => {
      const q = s.adjacent[n], a = (p.y * 64 + p.x) * 4, b = (q.y * 64 + q.x) * 4; seamPairs++;
      if (!!atlas.rgba[a + 3] !== !!atlas.rgba[b + 3]) alphaEdges++;
      if (atlas.rgba[a + 3] && atlas.rgba[b + 3] && [0, 1, 2].some(c => atlas.rgba[a + c] !== atlas.rgba[b + c])) colorEdges++;
    });
  }
  return { atlas, report: { valid: unresolved === 0, repaired: outside + baseHoles + alpha,
    outside, baseHoles, alpha, unresolved, seamPairs, colorEdges, alphaEdges } };
}
