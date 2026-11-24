/** A small material ramp, kept close to the validated photo pigment. The
 * dark steps lean cool; reflected steps lean warm without changing the dye. */
import { headMaterialPoint } from "./referenceMaterialDetail";
import type { FaceStyle } from "./skinPack";
import type { BoxUV } from "./uvLayout";

export type MaterialRgb = readonly [number, number, number];
export type MaterialRamp = readonly [MaterialRgb, MaterialRgb, MaterialRgb, MaterialRgb, MaterialRgb];
type HairCues = Pick<FaceStyle, "hairPart" | "hairTexture" | "hairStructure" | "fringeEdge">;
const byte = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

export function photoMaterialRamp(pigment: MaterialRgb, material: "hair" | "shoe"): MaterialRamp {
  const level = (offset: MaterialRgb, strength = 1): MaterialRgb =>
    pigment.map((v, i) => byte(v + offset[i] * strength)) as unknown as MaterialRgb;
  const lightness = (pigment[0] * 2 + pigment[1] * 5 + pigment[2]) / 8;
  const headroom = Math.max(.37, Math.min(1, (259 - Math.max(...pigment)) / 118));
  // Midnight/black pigments still have readable reflected light; pale
  // pigments instead rely on their lower steps to avoid clipping to white.
  return material === "hair"
    ? [level([-15, -15, -11], lightness < 18 ? .71 : 1), level([-7, -7, -4]), pigment,
      level([17, 14, 13], headroom), level([33, 29, 25], headroom)]
    : [level([-23, -23, -19]), level([-11, -11, -8]), pigment,
      level([13, 11, 10], headroom), level([25, 22, 19], headroom)];
}

/** UV indices are not physical coordinates. Torso is 4px deep, so its
 * last right-side column is the same boundary as front x=0 (not z=4).
 * y=0 of the drape shares the lighting phase of the bottom of the head. */
export function fixedHairMaterialPoint(part: "head" | "body", face: keyof BoxUV, x: number, y: number): [number, number, number] {
  if (part === "head") return headMaterialPoint(face, x, y);
  const depth = 7 / 3;
  switch (face) {
    case "front": return [x, 7 + y, 0];
    case "right": return [0, 7 + y, (3 - x) * depth];
    case "left": return [7, 7 + y, x * depth];
    case "back": return [7 - x, 7 + y, 7];
    case "top": return [x, 7, (3 - y) * depth];
    case "bottom": return [7 - x, 18, y * depth];
  }
}

/** Step the sheen along the flow in short clusters, not a tiled checker or
 * a bright strip around the entire crown. It cannot create or move strands. */
export function fixedHairTone(point: readonly [number, number, number], style: HairCues, raised: boolean, partHint?: FaceStyle["hairPart"]): 0 | 1 | 2 | 3 | 4 {
  const [u, v, z] = point;
  const part = partHint ?? style.hairPart;
  const parted = !!part && part !== "none";
  const root = part === "left" ? 2 : part === "right" ? 5 : 3.5;
  const width = Math.abs(u - root);
  const wavy = style.hairTexture === "wavy" && (!style.hairStructure || style.hairStructure === "loose");
  const bend = wavy ? [0, 0, 1, 1, 0, 0, -1, -1][v % 8] : 0;
  if (parted && v <= 1 && z <= 2 && width <= .65) return 0;
  const strand = (parted && v < 7 ? width * 1.25 : u) + z * .75 - v * .42 + bend;
  const lane = (Math.floor(strand + 30) % 6 + 6) % 6;
  const ridge = lane === 1 || lane === 2;
  // Half-step angular wrap: height and depth make the crown highlight turn
  // around the temple without repainting an entire face or flat perimeter.
  const arc = v + z * .55 - width * .24;
  if (v < 7) {
    const glint = arc >= 0.7 && arc <= (wavy ? 4.4 : 3.6) && z < 5.3;
    if (ridge && glint) return (raised || (lane === 2 && z <= 2)) ? 4 : 3;
    if (glint && (lane === 3 || lane === 4)) return 3;
    if (lane === 0) return v >= 4 ? 0 : 1;
    if (v >= 5 && z >= 5) return 1;
    return ridge && raised ? 3 : 2;
  }
  // The neck junction holds the midtone; stagger the lower reflection by
  // strand and side, leaving the ends dark rather than drawing pinstripes.
  const h = v - 7;
  const crestStart = 2 + (u >= 4 ? 1 : 0) + (z >= 4 ? 1 : 0);
  if (h >= 9) return lane <= 2 ? 1 : 2;
  if (h >= crestStart && h <= crestStart + (wavy ? 3 : 2)) {
    if (ridge) return raised && lane === 2 && z <= 4 ? 4 : 3;
    if (lane === 0 && h > crestStart) return 1;
  }
  return lane === 0 && h > 1 ? 1 : 2;
}
