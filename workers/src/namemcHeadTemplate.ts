/** Geometry traced from NameMC skin 6c13a4b6c3d74499. Only semantic coordinates:
 * no source PNG, source RGB, clothes, ribbons, or hair ornaments ship with it.
 * Coordinates are face-local in standard Java/Bedrock 64x64 UV orientation. */
import { buildHeadwearPaint, isStructuredHeadwear } from "../../shared/headwear";
import { facialHairBaseFootprint } from "./facialHairFootprint";
import { lockedHairLight } from "./lockedHeadFinish";
import { fixedHairMaterialPoint, fixedHairTone, photoMaterialRamp } from "./fixedMaterialPalette";
import { classifyPhotoHair, photoHairTone, type PhotoDrapeCell, type PhotoHairProfile } from "./photoHairFinish";
import { buildPhotoHeadGeometry } from "./photoHeadGeometry";
import { hairTreatment, sculptStylizedHair, sculptWrappedHair, stylizedHairRamp, stylizedHairTone, wrappedHairTone } from "./stylizedHairArt";
import { bytesToBase64, type RawImage } from "./png";
import type { FaceStyle } from "./skinPack";
import type { SkinPlan } from "./skinPlan";
import type { SkinPresentation } from "./referenceStyleTemplates";
import { CLASSIC_LAYOUT, type BoxUV, type Rect } from "./uvLayout";

export const PREVIOUS_NAMEMC_HEAD_FINISH = "namemc_6c13a4b6c3d74499_no_eyewear_v2" as const;
export const MATERIAL_NAMEMC_HEAD_FINISH = "namemc_6c13a4b6c3d74499_material_ramps_v3" as const;
export const DRAPE_NAMEMC_HEAD_FINISH = "namemc_6c13a4b6c3d74499_photo_drape_v4" as const;
export const ADAPTIVE_NAMEMC_HEAD_FINISH = "namemc_fixed_eyes_photo_hair_shape_v5" as const;
export const STYLIZED_NAMEMC_HEAD_FINISH = "namemc_fixed_eyes_stylized_photo_hair_v6" as const;
export const NAMEMC_HEAD_FINISH = "namemc_fixed_eyes_wrapped_hair_v7" as const;
export type NameMcFinishPolicy = typeof PREVIOUS_NAMEMC_HEAD_FINISH | typeof MATERIAL_NAMEMC_HEAD_FINISH | typeof DRAPE_NAMEMC_HEAD_FINISH | typeof ADAPTIVE_NAMEMC_HEAD_FINISH | typeof STYLIZED_NAMEMC_HEAD_FINISH | typeof NAMEMC_HEAD_FINISH;
export const usesAdaptiveHeadPolicy = (policy: NameMcFinishPolicy) => policy === NAMEMC_HEAD_FINISH || policy === STYLIZED_NAMEMC_HEAD_FINISH || policy === ADAPTIVE_NAMEMC_HEAD_FINISH;
export const usesPhotoDrapePolicy = (policy: NameMcFinishPolicy) => usesAdaptiveHeadPolicy(policy) || policy === DRAPE_NAMEMC_HEAD_FINISH;
export const isNameMcFinishPolicy = (policy: unknown): policy is NameMcFinishPolicy =>
  policy === NAMEMC_HEAD_FINISH || policy === STYLIZED_NAMEMC_HEAD_FINISH || policy === ADAPTIVE_NAMEMC_HEAD_FINISH || policy === DRAPE_NAMEMC_HEAD_FINISH
    || policy === MATERIAL_NAMEMC_HEAD_FINISH || policy === PREVIOUS_NAMEMC_HEAD_FINISH;

const defaultGeometry = (style: FaceStyle, profile: PhotoHairProfile, drape: readonly PhotoDrapeCell[],
  policy: NameMcFinishPolicy, presentation: SkinPresentation = "source") => {
  if (!usesAdaptiveHeadPolicy(policy)) return undefined;
  const g = buildPhotoHeadGeometry(style, profile, "", drape);
  return policy === NAMEMC_HEAD_FINISH ? sculptWrappedHair(g, profile, presentation)
    : policy === STYLIZED_NAMEMC_HEAD_FINISH ? sculptStylizedHair(g, profile, presentation) : g;
};
const full = Array<string>(8).fill("########"), empty = Array<string>(8).fill("........");
export const NAMEMC_HEAD_HAIR = {
  base: {
    top: full, right: full, left: full, back: full,
    front: ["########", "########", "########", "##....##", "#......#", "#......#", "#......#", "#......#"],
    bottom: ["########", "########", "########", "########", "##....##", "#......#", "#......#", "#......#"],
  },
  overlay: {
    top: empty,
    front: ["........", "..####..", ".######.", ".######.", "##.##.##", "#...#..#", "#......#", ".#....#."],
    right: ["........", "........", "#.......", "#.......", "#......#", "#......#", "#......#", "........"],
    left: ["........", "........", ".......#", ".......#", "#......#", "#......#", "#......#", "........"],
    back: ["........", "........", "#......#", "#......#", "#......#", "#......#", "#......#", ".#....#."],
    bottom: [".#....#.", "........", "........", "........", "........", "........", "........", ".#....#."],
  },
} as const;

/** Paired front locks / nape overhang. Colored torso interior in the example
 * cannot be separated from its black top, so only the traced relief and a
 * conservative continuous foundation are used, not the original torso paint. */
const DRAPE = {
  base: {
    front: ["###..###", ...Array<string>(10).fill("##....##"), ".#....#."],
    back: [...Array<string>(10).fill(".######."), ".######.", "..####.."],
    left: [...Array<string>(11).fill("#..."), "...."],
    right: [...Array<string>(11).fill("...#"), "...."],
  },
  overlay: {
    front: ["........", "........", "........", ".#....#.", ".#....#.", ".#....#.", ".#....#.", "##....##", "##....##", "#......#", ".#....#.", "........"],
    back: ["........", "........", "........", "........", ".#....#.", "........", "........", "........", "........", "........", ".....#..", "........"],
    left: [...Array<string>(7).fill("...."), "#...", "#...", "#...", "....", "...."],
    right: [...Array<string>(7).fill("...."), "...#", "...#", "...#", "....", "...."],
  },
} as const;

export const NAMEMC_EYES = [
  { x: 1, y: 5, role: "sclera_shadow" }, { x: 2, y: 5, role: "iris_shadow" },
  { x: 5, y: 5, role: "iris_shadow" }, { x: 6, y: 5, role: "sclera_shadow" },
  { x: 1, y: 6, role: "sclera" }, { x: 2, y: 6, role: "iris" },
  { x: 5, y: 6, role: "iris" }, { x: 6, y: 6, role: "sclera" },
] as const;

const layers = ["base", "overlay"] as const;
const faces = Object.keys(CLASSIC_LAYOUT.head.base) as (keyof BoxUV)[];
type Rgb = [number, number, number];
const rgb = (hex: string | undefined, fallback: Rgb): Rgb => /^#[0-9a-f]{6}$/i.test(hex ?? "")
  ? [1, 3, 5].map(i => parseInt(hex!.slice(i, i + 2), 16)) as Rgb : fallback;
const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const mix = (a: Rgb, b: Rgb, ratio: number): Rgb => a.map((v, c) => byte(v + ratio * (b[c] - v))) as Rgb;
const at = (r: Rect, x: number, y: number) => ((r.y + y) * 64 + r.x + x) * 4;
const has = (rows: readonly string[], x: number, y: number) => rows[y]?.[x] === "#";
const drapeOffsets = new Set(DRAPE.base.front.flatMap((row, y) => [...row].flatMap((v, x) =>
  v === "#" ? [at(CLASSIC_LAYOUT.body.overlay.front, x, y)] : [])));
export const namemcDrapeReservation: ReadonlySet<number> = drapeOffsets;
export const namemcDrapeReliefCount = DRAPE.overlay.front.join("").split("#").length - 1;

export function usesNameMcHead(source: SkinPlan, style: FaceStyle): boolean {
  // A required head covering is source material, not a hairstyle variant.
  return !source.headIdentityPlan.ownership?.covering && !["headscarf", "hood", "full_helmet"].includes(style.hat);
}

/** Public wardrobe mask: one bit per atlas coordinate, no colours or photo. */
export function nameMcHairMask(style: FaceStyle, drape: readonly PhotoDrapeCell[] = [], policy: NameMcFinishPolicy = NAMEMC_HEAD_FINISH,
  geometry = defaultGeometry(style, classifyPhotoHair(style, ""), drape, policy)): string {
  const bits = new Uint8Array(512);
  const mark = (offset: number, include: boolean) => {
    const pixel = offset / 4, flag = 1 << (pixel % 8), bucket = Math.floor(pixel / 8);
    if (include) bits[bucket] |= flag; else bits[bucket] &= ~flag;
  };
  for (const part of ["head", "body"] as const) for (const layer of layers) for (const face of faces) {
    if (part === "body" && usesPhotoDrapePolicy(policy)) continue;
    const r = CLASSIC_LAYOUT[part][layer][face];
    const rows = part === "head" ? (geometry ?? NAMEMC_HEAD_HAIR)[layer][face]
      : (DRAPE[layer] as Partial<Record<keyof BoxUV, readonly string[]>>)[face] ?? [];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (has(rows, x, y)) mark(at(r, x, y), true);
  }
  if (usesPhotoDrapePolicy(policy)) for (const p of drape) mark(at(CLASSIC_LAYOUT.body[p.layer][p.face], p.x, p.y), true);
  for (const p of hatPaint(style)) {
    mark(at(CLASSIC_LAYOUT.head.base[p.face], p.x, p.y), false);
    mark(at(CLASSIC_LAYOUT.head.overlay[p.face], p.x, p.y), false);
  }
  return bytesToBase64(bits);
}

const hatPaint = (style: FaceStyle) => buildHeadwearPaint(style.hat, style.hatColor ?? "#303030", style.hatVisor,
  NAMEMC_EYES.map(e => ({ ...e, face: "front" as const })));

export function applyNameMcHead(input: RawImage, garment: RawImage, source: SkinPlan, style: FaceStyle,
  presentation: SkinPresentation = "source", policy: NameMcFinishPolicy = NAMEMC_HEAD_FINISH,
  drape: readonly PhotoDrapeCell[] = [], profile: PhotoHairProfile = classifyPhotoHair(style, ""),
  geometry = defaultGeometry(style, profile, drape, policy, presentation)): RawImage {
  const rgba = input.rgba.slice();
  const skin = rgb(style.skinTone, [211, 158, 128]);
  const hair = rgb(style.hairColor, [39, 32, 30]);
  const hairRamp = photoMaterialRamp(geometry?.cut === "buzz" ? mix(hair, skin, .34) : hair, "hair");
  const masks = geometry ?? NAMEMC_HEAD_HAIR;
  const cut = policy === NAMEMC_HEAD_FINISH || policy === STYLIZED_NAMEMC_HEAD_FINISH ? geometry?.cut : undefined;
  const hairTone = policy === NAMEMC_HEAD_FINISH ? wrappedHairTone : stylizedHairTone;
  const treatment = cut && hairTreatment(cut, profile, presentation);
  const headRamp = treatment && cut !== "buzz" ? stylizedHairRamp(hair, treatment) : hairRamp;
  const iris = rgb(style.eyeColor, [67, 45, 37]);
  const deep: Rgb = [18, 14, 19];
  const put = (r: Rect, x: number, y: number, c: readonly [number, number, number]) => rgba.set([...c, 255], at(r, x, y));
  const hairPaint = (part: "head" | "body", face: keyof BoxUV, x: number, y: number, raised: boolean) => {
    const point = fixedHairMaterialPoint(part, face, x, y);
    if (usesPhotoDrapePolicy(policy)) {
      const tone = photoHairTone(point, style, profile, raised);
      return part === "head" && cut && treatment ? headRamp[hairTone(point, cut, profile, treatment, raised, tone)] : hairRamp[tone];
    }
    if (policy === MATERIAL_NAMEMC_HEAD_FINISH) return hairRamp[fixedHairTone(point, style, raised)];
    const shade = lockedHairLight({ face, x, y: part === "body" ? y + 7 : y, raised }, style) * (raised ? .57 : .46) + (raised ? 5 : 0);
    return hair.map(v => byte(v + shade)) as Rgb;
  };
  for (const layer of layers) for (const face of faces) {
    const r = CLASSIC_LAYOUT.head[layer][face], rows = masks[layer][face];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      if (has(rows, x, y)) put(r, x, y, hairPaint("head", face, x, y, layer === "overlay"));
      else if (layer === "overlay") rgba.fill(0, at(r, x, y), at(r, x, y) + 4);
      else {
        const contact = face === "front" && (has(masks.overlay.front, x, y - 1) || has(rows, x, y - 1));
        const contactShade = presentation === "masculine" ? .18 : presentation === "feminine" ? .09 : .12;
        const edgeShade = face === "front" && (x <= 2 || x >= 5) && y === 7 ? contactShade / 2 : .05;
        put(r, x, y, mix(skin, [98, 53, 53], face === "bottom" ? .22 : contact ? contactShade : y === 7 ? edgeShade : 0));
      }
    }
  }

  const front = CLASSIC_LAYOUT.head.base.front;
  // Preserve the two observed 2x2 eye windows and their one-row lash line.
  for (const x of [1, 2, 5, 6]) put(front, x, 4, mix(deep, iris, .14));
  for (const { x, y, role } of NAMEMC_EYES) {
    put(front, x, y, role === "sclera" ? mix([248, 243, 242], skin, .08)
      : role === "sclera_shadow" ? mix([227, 220, 223], deep, .17)
        : role === "iris" ? mix(iris, deep, .21) : mix(iris, deep, .64));
  }
  for (const p of facialHairBaseFootprint(style)) {
    if (NAMEMC_EYES.some(e => p.x === e.x && p.y === e.y) || has(masks.base.front, p.x, p.y)) continue;
    const i = at(front, p.x, p.y);
    if (input.rgba[i + 3] === 255) rgba.set(input.rgba.subarray(i, i + 4), i);
  }

  // Source ornaments, never the reference's side ribbons. Hair always wins
  // its pre-authored layer cells; real hats may physically cover the template.
  for (const p of source.headIdentityPlan.ownership?.cells ?? []) {
    if (p.layer !== "outer" || p.owner !== "other_p5" || has(masks.overlay[p.face], p.x, p.y)
      || (p.face === "front" && NAMEMC_EYES.some(e => e.x === p.x && e.y === p.y))) continue;
    const i = at(CLASSIC_LAYOUT.head.overlay[p.face], p.x, p.y);
    rgba.set(input.rgba.subarray(i, i + 4), i);
  }
  if (style.earrings && style.earrings !== "none") {
    const jewel = rgb(style.earringColor, [180, 185, 191]);
    const side = style.earringSide ?? "both";
    for (const [sideName, x, face, sideX] of [["viewer_left", 0, "right", 7], ["viewer_right", 7, "left", 0]] as const) {
      if (side !== "both" && side !== sideName) continue;
      put(CLASSIC_LAYOUT.head.overlay.front, x, 7, jewel);
      put(CLASSIC_LAYOUT.head.overlay[face], sideX, 7, jewel);
    }
  }
  if (isStructuredHeadwear(style.hat)) {
    for (const p of hatPaint(style)) {
      if (p.layer === "base") rgba.fill(0, at(CLASSIC_LAYOUT.head.overlay[p.face], p.x, p.y), at(CLASSIC_LAYOUT.head.overlay[p.face], p.x, p.y) + 4);
      put(CLASSIC_LAYOUT.head[p.layer][p.face], p.x, p.y, p.color);
    }
  }

  // Start from a garment-only torso so an old candidate cannot leave a
  // detached, longer or wrong-side lock. Keep the old fixed drape for replay.
  const photoCells = new Map(drape.map(p => [at(CLASSIC_LAYOUT.body[p.layer][p.face], p.x, p.y), p]));
  for (const layer of layers) for (const face of faces) {
    const r = CLASSIC_LAYOUT.body[layer][face];
    const rows = (DRAPE[layer] as Partial<Record<keyof BoxUV, readonly string[]>>)[face] ?? [];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = at(r, x, y);
      if (usesPhotoDrapePolicy(policy)) {
        const p = photoCells.get(i);
        if (p) put(r, x, y, hairRamp[p.tone]);
        else if (layer === "overlay" && photoCells.has(at(CLASSIC_LAYOUT.body.base[face], x, y))) rgba.fill(0, i, i + 4);
        else rgba.set(garment.rgba.subarray(i, i + 4), i);
      }
      else if (has(rows, x, y)) put(r, x, y, hairPaint("body", face, x, y, layer === "overlay"));
      else if (layer === "overlay" && has((DRAPE.base as Partial<Record<keyof BoxUV, readonly string[]>>)[face] ?? [], x, y)) rgba.fill(0, i, i + 4);
      else rgba.set(garment.rgba.subarray(i, i + 4), i);
    }
  }
  return { ...input, rgba };
}
