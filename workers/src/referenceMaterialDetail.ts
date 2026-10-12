/** Authored material shading, not new photographic evidence. Coordinates are
 * physical cuboid coordinates, so a lock cannot restart at a UV seam. No RNG,
 * request state, extra geometry, inferred accessories or provider calls. */
import type { BoxUV } from "./uvLayout";
import type { FaceStyle } from "./skinPack";

type Rgb = [number, number, number];
export type HairMaterialPolicy = "clustered_material_v1" | "tapered_material_v2";
export function headMaterialPoint(face: keyof BoxUV, x: number, y: number): [number, number, number] {
  switch (face) {
    case "front": return [x, y, 0];
    case "right": return [0, y, 7 - x];
    case "left": return [7, y, x];
    case "back": return [7 - x, y, 7];
    case "top": return [x, 0, 7 - y];
    case "bottom": return [7 - x, 7, y];
  }
}

/** Four connected tones: root, broad midtone, reflected ridge, tapered tip.
 * Dark pigments need a bounded neutral reflection; multiplication alone makes
 * black hair a featureless cap. Light pigments instead retain shadow headroom.
 * Use only on explicitly owned loose hair; scalp/curls/accessories keep their
 * existing specialized grammar. */
export function referenceHairMaterial(color: Rgb, face: keyof BoxUV, x: number, y: number,
  style: Pick<FaceStyle, "hairPart" | "hairTexture">, outer = false, policy: HairMaterialPolicy = "clustered_material_v1"): Rgb {
  const [u, v, z] = headMaterialPoint(face, x, y);
  const root = style.hairPart === "left" ? 2 : style.hairPart === "right" ? 5 : 3.5;
  const sweep = Math.floor(Math.abs(u - root) + z);
  const wave = style.hairTexture === "wavy" ? Math.floor(v / 3) : 0;
  const lane = (sweep + wave) % 4;
  // Broad bands, not isolated salt-and-pepper highlights. The same function
  // shades top/front/profile/nape and both layers without changing occupancy.
  const rootShadow = v === 0 && Math.abs(u - root) < 1;
  if (policy === "tapered_material_v2") {
    // A lock has a broad midtone and a short reflected ridge, not a bright
    // stripe from crown to nape. Stagger the ridge's endpoints by physical
    // strand so profile/back transitions retain the exact same material.
    const strand = Math.floor(sweep / 4);
    const start = 1 + strand % 2, end = 4 + strand % 2;
    const reflected = lane === 1 && v >= start && v <= end;
    const tapered = lane === 2 && v === end;
    const factor = rootShadow ? 0.80 : reflected ? 1.08 : tapered ? 1.03 : lane === 0 ? 0.88 : lane === 3 ? 0.94 : 0.99;
    const tip = v >= 6 ? 0.94 : 1;
    const reflection = reflected ? Math.max(0, 8 - Math.max(...color) * 0.025) : 0;
    return color.map(c => Math.max(0, Math.min(255, Math.round(c * factor * tip + reflection + (outer ? 2 : 0))))) as Rgb;
  }
  const factor = rootShadow ? 0.76 : lane === 0 ? 0.82 : lane === 1 ? 1.16 : lane === 2 ? 1.02 : 0.93;
  const tip = v >= 6 ? 0.92 : v >= 2 && v <= 4 ? 1.04 : 1;
  const reflection = lane === 1 && !rootShadow ? Math.max(0, 12 - Math.max(...color) * 0.035) : 0;
  return color.map(c => Math.max(0, Math.min(255, Math.round(c * factor * tip + reflection + (outer ? 3 : 0))))) as Rgb;
}

/** Continue the nape/side material onto already-authorized torso locks. Never
 * decides whether a lock exists or how long it is. Braids retain their own
 * interlacing grammar and are not routed through this loose-hair function. */
export function referenceLooseHairMaterial(color: Rgb, p: {face: "front" | "back"; x: number; y: number; shade: number},
  style: Pick<FaceStyle, "hairPart" | "hairTexture">, clustered: boolean | HairMaterialPolicy): Rgb {
  const material = clustered ? referenceHairMaterial(color, p.face, p.x, 7 + p.y, style, false,
    typeof clustered === "string" ? clustered : "clustered_material_v1") : color;
  return material.map(c => Math.min(255, Math.round(c * p.shade))) as Rgb;
}
