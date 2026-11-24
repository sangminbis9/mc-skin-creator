/** Display-only finish. The legacy candidate renderer owns the shape;
 * neither style choice nor texture detail can vote on a new hair/eye mask. */
import type { ReferenceCompositionDiagnostic } from "./referenceStyleRenderer";
import type { SkinPresentation } from "./referenceStyleTemplates";
import type { RawImage } from "./png";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import { CLASSIC_LAYOUT, type BoxUV, type Rect } from "./uvLayout";
import { facialHairBaseFootprint } from "./facialHairFootprint";
import { headwearVisibleLandmarks } from "./headwearFootprint";
import { buildHeadwearPaint } from "../../shared/headwear";
import { headMaterialPoint, referenceHairMaterial } from "./referenceMaterialDetail";

const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
const offset = (r: Rect, p: { x: number; y: number }) => ((r.y + p.y) * 64 + r.x + p.x) * 4;
const rgb = (value: string | undefined): [number, number, number] | undefined =>
  /^#[\da-f]{6}$/i.test(value ?? "") ? [1, 3, 5].map(i => parseInt(value!.slice(i, i + 2), 16)) as [number, number, number] : undefined;
const byte = (v: number) => Math.round(Math.min(255, Math.max(0, v)));

export const LEGACY_LOCKED_HEAD_FINISH = "fixed_eye_hair_no_mouth_nose_v1" as const;
export const LOCKED_HEAD_FINISH = "fixed_eye_hair_no_mouth_nose_v2" as const;
export type LockedHeadFinishPolicy = typeof LEGACY_LOCKED_HEAD_FINISH | typeof LOCKED_HEAD_FINISH;

type HairCell = { face: keyof BoxUV; x: number; y: number; raised: boolean };

/** Discrete pixel clusters on the physical head, not independently drawn UV
 * stripes. Support a visible part, a broken wispy fringe, or a long wave
 * without making up a part on photos where no scalp division is visible. */
export function lockedHairLight(cell: HairCell, style: FaceStyle): number {
  const [u, v, z] = headMaterialPoint(cell.face, cell.x, cell.y);
  const part = style.hairPart;
  const parted = part === "left" || part === "right" || part === "center";
  const root = part === "left" ? 2 : part === "right" ? 5 : 3.5;
  const across = u - root;
  const waved = style.hairTexture === "wavy" && (!style.hairStructure || style.hairStructure === "loose");
  const wispy = style.bangs === "wispy" || style.fringeEdge === "wispy";
  const wave = waved ? [0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, -1][v % 12] : 0;
  const sweep = parted ? Math.abs(across) * 1.15 + z * .69 - v * .40
    : u + z * .78 - v * (wispy ? .73 : .46);
  const lane = (Math.floor(sweep + wave) % 6 + 6) % 6;
  const distance = Math.abs(across);
  if (parted && distance < .65 && v < 2 && z < 4) return -13;
  const arc = v + z * .58 - distance * .19;
  const crest = waved && v > 7 ? (v + Math.floor(u / 2)) % 7 <= 2
    : arc >= 0.3 && arc <= 4.0 + (waved ? .9 : 0);
  const ridge = lane === 1 || lane === 2;
  const fineTip = wispy && z <= 1 && v >= 2 && v <= 4;
  const taper = v >= 5 && (u <= 1 || u >= 6)
    && ["tapered", "undercut", "ear_hugging"].includes(style.sideHairShape ?? "");
  if (fineTip) return [-12, 18, 11, 2, -5, -9][lane];
  if (taper) return lane === 1 ? 2 : -7;
  if (crest && ridge) return 30;
  if (lane === 0) return -11;
  if (crest && (lane === 3 || lane === 4)) return 13;
  if (ridge) return waved ? 10 : 7;
  return arc > 7 ? -8 : -3;
}

export function applyLockedHeadFinish(input: RawImage, source: SkinPlan, style: FaceStyle,
  presentation: SkinPresentation, diagnostic?: ReferenceCompositionDiagnostic,
  policy: LockedHeadFinishPolicy = LOCKED_HEAD_FINISH): RawImage {
  const rgba = input.rgba.slice(), plan = source.facePixelPlan;
  const skin = rgb(style.skinTone) ?? [211, 158, 128];
  const pigment = rgb(style.hairColor);
  const held = new Set<number>();
  const accessories = new Set<number>();
  const eyes = new Set<number>();
  const protectEye = (p: { x: number; y: number }) => { eyes.add(offset(front, p)); eyes.add(offset(outer, p)); };
  for (const p of plan.pixels) if (["left_eye", "right_eye", "glasses"].includes(p.cluster)) {
    protectEye(p);
    if (p.role !== "brow" && diagnostic?.faceFinish.eyeRowOffset && p.y < 7) protectEye({ ...p, y: p.y + diagnostic.faceFinish.eyeRowOffset });
  }
  for (const p of plan.glassesPlan.framePixels) accessories.add(offset(CLASSIC_LAYOUT.head.overlay[p.face], p));
  for (const p of facialHairBaseFootprint(style)) accessories.add(offset(front, p));
  for (const p of buildHeadwearPaint(style.hat, style.hatColor ?? "#303030", style.hatVisor, headwearVisibleLandmarks(plan))) {
    accessories.add(offset(CLASSIC_LAYOUT.head[p.layer][p.face], p));
  }
  for (const i of accessories) held.add(i);
  const material = new Map<number, HairCell>();
  if (diagnostic) {
    for (const p of diagnostic.surfaces) {
      if (p.owner !== "hair" && (p.part !== "head" || p.owner === "face")) continue;
      const i = offset(CLASSIC_LAYOUT[p.part][p.layer][p.face], p);
      held.add(i);
      if (p.owner === "hair") material.set(i, { ...p, y: p.part === "body" ? 7 + p.y : p.y, raised: p.layer === "overlay" });
    }
    for (const p of diagnostic.faceFinish.hairSpaceCells) {
      const i = offset(front, p);
      held.add(i); material.set(i, { ...p, face: "front", raised: false });
    }
    for (const p of [...diagnostic.faceFinish.eyeAccentCells, ...diagnostic.faceFinish.eyePresentation.cells]) {
      protectEye(p);
      const y = p.y + diagnostic.faceFinish.eyeRowOffset;
      if (y < 8) protectEye({ x: p.x, y });
    }
    for (const p of diagnostic.headProportion?.paints ?? []) {
      const i = offset(CLASSIC_LAYOUT.head[p.layer ?? "base"][p.face], p);
      if (p.role === "hair") {
        held.add(i); material.set(i, { ...p, raised: p.layer === "overlay" });
      } else {
        if (material.delete(i) && (policy === LEGACY_LOCKED_HEAD_FINISH || !accessories.has(i))) held.delete(i);
        if (p.face === "front" && (p.role === "iris" || p.role === "sclera")) protectEye(p);
      }
    }
  } else {
    // Unknown/complex grammar is not a license to recolor or erase hair.
    for (const p of source.headIdentityPlan.ownership?.cells ?? []) {
      if (["clear", "face"].includes(p.owner)) continue;
      held.add(offset(CLASSIC_LAYOUT.head[p.layer === "outer" ? "overlay" : "base"][p.face], p));
    }
  }
  for (const i of eyes) held.add(i);

  // RGB-only: strong, bounded reflectance on dark photo pigments; reuse the
  // existing palette/material so the source tint and strand paint survive.
  if (pigment && !source.hairPlan.surfaceOnly) for (const [i, p] of material) {
    if (rgba[i + 3] !== 255 || eyes.has(i)) continue;
    if (policy === LOCKED_HEAD_FINISH) {
      if (accessories.has(i)) continue;
      const light = lockedHairLight(p, style);
      const headroom = 1 - Math.max(0, Math.max(...pigment) - 80) / 330;
      const delta = light > 0 ? light * headroom : light;
      const authoredTexture = style.hairStructure && style.hairStructure !== "loose"
        || style.hairTexture === "curly" || style.hairTexture === "coily";
      // For defined curls and braids retain more of the authored interlace.
      const amount = authoredTexture ? .48 : 1;
      for (let c = 0; c < 3; c++) {
        const old = input.rgba[i + c];
        const target = (p.raised ? .68 : .77) * pigment[c] + (p.raised ? .32 : .23) * old
          + delta + (p.raised ? 2 : -2);
        rgba[i + c] = byte(old + amount * (target - old));
      }
      continue;
    }
    const ridge = referenceHairMaterial(pigment, p.face, p.x, p.y, style, p.raised, "seam_swept_locks_v5");
    const light = (ridge[0] + ridge[1] + ridge[2] - pigment[0] - pigment[1] - pigment[2]) / 3;
    const delta = Math.min(p.raised ? 19 : 16, Math.max(-11, light * .85));
    for (let c = 0; c < 3; c++) rgba[i + c] = byte(rgba[i + c] + delta);
  }

  // The old face painter can leave nose/philtrum/lip accents on BOTH layers.
  // Only its known detail footprint, never material or existing eye pixels.
  const omitted = plan.pixels.filter(p => p.cluster === "mouth" || p.cluster === "nose");
  const authored = new Map<string, { x: number; y: number }>();
  for (const p of omitted) authored.set(`${p.x}:${p.y}`, p);
  for (const x of [3, 4]) for (const y of [5, 6]) authored.set(`${x}:${y}`, { x, y });
  for (const [x, y] of [[2, 6], [5, 6], ...(style.mouthOpening === "teeth_visible" ? [[2, 5], [5, 5]] : [])]) {
    authored.set(`${x}:${y}`, { x, y });
  }
  const plane = (x: number, y: number) => {
    const edge = Math.min(x, 7 - x);
    const shade = edge < 2 ? (presentation === "masculine" ? .92 : .96) : y === 7 ? .98 : 1;
    return skin.map(v => byte(v * shade));
  };
  // Base cleanup strictly follows planned nose/mouth plus the central legacy
  // complexion anchors (whose original author was the nose painter).
  const baseDetails = [...omitted, ...[3, 4].flatMap(x => [3, 4, 5, 6].map(y => ({x, y})))];
  for (const p of baseDetails) {
    const i = offset(front, p);
    if (!held.has(i) && rgba[i + 3] === 255) rgba.set(plane(p.x, p.y), i);
  }
  for (const p of authored.values()) {
    const i = offset(outer, p);
    if (!held.has(i)) rgba.fill(0, i, i + 4);
  }
  if (policy === LEGACY_LOCKED_HEAD_FINISH && presentation !== "source") for (const x of [0, 1, 6, 7]) for (const y of [6, 7]) {
    const p = { x, y }, i = offset(front, p);
    if (held.has(i) || rgba[i + 3] !== 255 || rgba[offset(outer, p) + 3] !== 0) continue;
    const target = plane(x, y);
    if (presentation === "feminine" && y === 6) { target[1] -= 10; target[2] -= 6; }
    for (let c = 0; c < 3; c++) rgba[i + c] = byte(rgba[i + c] * .35 + target[c] * .65);
  }
  if (policy === LOCKED_HEAD_FINISH && diagnostic) {
    const hairAt = (x: number, y: number) => {
      if (x < 0 || x > 7 || y < 0 || y > 7) return false;
      const i = offset(outer, { x, y }), j = rgba[i + 3] === 0 ? offset(front, { x, y }) : i;
      return rgba[j + 3] === 255 && material.has(j) && !accessories.has(j) && !eyes.has(j);
    };
    for (let y = 1; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = { x, y }, i = offset(front, p);
      if (held.has(i) || rgba[i + 3] !== 255 || rgba[offset(outer, p) + 3] !== 0) continue;
      const edge = Math.min(x, 7 - x), complexion = plane(x, y);
      const sideContact = edge <= 2 && (hairAt(x - 1, y) || hairAt(x + 1, y));
      const rim = hairAt(x, y - 1) ? 14 : sideContact ? 9 : 0;
      const jaw = y >= 6 ? (edge === 0 ? 14 : edge === 1 ? 8 : y === 7 ? 5 : 0) : 0;
      const cheek = y === 5 && edge >= 1 && edge <= 2 ? 5 : 0;
      // Broad soft planes with the same complexion for all presentations;
      // avoid a dark or bright isolated pixel at the omitted nose and lips.
      const shade = Math.min(17, Math.max(rim, jaw));
      const flush = presentation === "feminine" && y === 5 && edge >= 1 && edge <= 2 && !rim ? 3 : 0;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = byte(complexion[c] - shade * (c === 0 ? .85 : 1) + cheek - (c === 1 ? flush : 0));
      }
    }
  }
  return { ...input, rgba };
}
