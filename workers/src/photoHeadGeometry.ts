/** Authored 8x8 hairstyles, chosen from validated hair observations. Geometry
 * and pigment are independent: a different dye never selects a different cut. */
import type { FaceStyle } from "./skinPack";
import type { PhotoDrapeCell, PhotoHairProfile } from "./photoHairFinish";
import type { AppearanceDetail } from "./appearanceDetail";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "./uvLayout";

export type PhotoHeadCut = "bald" | "buzz" | "crew" | "crop" | "spiky" | "slick" | "side_part" | "curtain"
  | "bowl" | "pixie" | "bob" | "shag" | "long" | "wave" | "curls" | "coils" | "braids" | "locs" | "tied";
export type PhotoHeadGeometry = {
  cut: PhotoHeadCut;
  base: Record<keyof BoxUV, string[]>;
  overlay: Record<keyof BoxUV, string[]>;
};
const faceKeys = Object.keys(CLASSIC_LAYOUT.head.base) as (keyof BoxUV)[];
const longLength = (s: FaceStyle) => ["shoulder", "chest", "waist", "hip"].includes(s.overallHairLength ?? "") || s.hairstyle === "long";
const hasCue = (text: string, cue: RegExp): boolean => text.toLowerCase().split(/[.;\n]/).some(clause =>
  cue.test(clause) && !/\b(?:no|not|without|appears? neither)\b/.test(clause));

export function classifyPhotoHeadCut(style: FaceStyle, p: PhotoHairProfile, text: string): PhotoHeadCut {
  if (style.hairstyle === "bald") return "bald";
  if (style.hairstyle === "buzz" || hasCue(text, /\b(?:buzz(?:ed)? cut|clipper[- ]close cropped|very short shaven)\b/)) return "buzz";
  if (p.type === "braided") return "braids";
  if (p.type === "locs") return "locs";
  if (p.type === "tied") return "tied";
  if (p.type === "coily") return "coils";
  if (p.type === "curly" && p.fringe !== "curtain") return "curls";
  if (hasCue(text, /\b(?:pixie(?: cut)?|bixie)\b/)) return "pixie";
  if (hasCue(text, /\b(?:bob(?: cut)?|lob)\b/)) return "bob";
  if (hasCue(text, /\b(?:wolf cut|shag(?: cut)?|mullet)\b/)) return "shag";
  if (longLength(style)) return p.type === "wavy" ? "wave" : "long";
  if (hasCue(text, /\b(?:slicked[- ]back|comb(?:ed)?[- ]back|pompadour|quiff|swept (?:straight )?back)\b/)) return "slick";
  if (style.hairSilhouette === "spiky" || hasCue(text, /\b(?:spiky|spiked)\b/)) return "spiky";
  if (hasCue(text, /\b(?:crew cut|ivy league)\b/) || style.sideHairShape === "undercut" && p.fringe === "none" && p.part === "none") return "crew";
  if (hasCue(text, /\b(?:bowl cut|mushroom cut)\b/)) return "bowl";
  if (p.part === "left" || p.part === "right") return "side_part";
  if (p.fringe === "curtain" || p.part === "center" && ["side", "none"].includes(p.fringe)) return "curtain";
  if (p.fringe === "side") return "side_part";
  if (style.overallHairLength === "jaw" || style.hairstyle === "medium") return "bob";
  if (p.fringe === "none" && style.sideHairShape === "tapered") return "crew";
  return "crop";
}

/** Last hair row per front column; two sides remain independent. */
function fringeRows(cut: PhotoHeadCut, style: FaceStyle, profile: PhotoHairProfile): number[] {
  const rightPart = profile.part === "right" || profile.part === "none" && profile.sweep === "left";
  const mirror = (a: number[]) => rightPart ? a.reverse() : a;
  const opening = profile.part === "none" ? style.fringeOpening : profile.part;
  let rows: number[];
  switch (cut) {
    case "bald": return Array<number>(8).fill(-1);
    case "buzz": return [2, 1, 1, 1, 1, 1, 1, 2];
    case "crew": return [2, 1, 1, 1, 0, 1, 1, 2];
    case "slick": return [3, 1, 1, 0, 0, 1, 1, 3];
    case "spiky": return [2, 2, 1, 2, 1, 1, 2, 2];
    case "side_part": return mirror([3, 2, 0, 1, 2, 3, 3, 4]);
    case "curtain": return [4, 3, 2, 0, 0, 2, 3, 4];
    case "bowl": return [4, 3, 3, 3, 3, 3, 3, 4];
    case "pixie": return mirror([2, 2, 1, 2, 2, 3, 3, 3]);
    case "curls": rows = [4, 2, 3, 2, 3, 3, 2, 4]; break;
    case "coils": rows = [3, 2, 3, 3, 2, 3, 2, 3]; break;
    case "crop": rows = [3, 3, 2, 3, 2, 3, 3, 3]; break;
    case "tied": rows = [3, 1, 0, 0, 0, 0, 1, 3]; break;
    default: rows = [7, 2, 1, 0, 0, 1, 2, 7];
  }
  if (profile.fringe === "straight") rows = rows.map((v, x) => x === 0 || x === 7 ? v : 3);
  if (profile.fringe === "wispy") rows = rows.map((v, x) => x === 0 || x === 7 ? v : [0, 2, 3, 1, 3, 1, 2, 0][x]);
  if (profile.fringe === "textured") rows = rows.map((v, x) => x === 0 || x === 7 ? v : [0, 2, 3, 2, 3, 3, 2, 0][x]);
  if (profile.fringe === "curtain" || profile.fringe === "side") {
    const authored = opening === "center" ? [4, 3, 2, 0, 0, 2, 3, 4] : mirror([3, 2, 0, 1, 2, 3, 3, 4]);
    rows = rows.map((v, x) => x === 0 || x === 7 ? Math.max(v, authored[x]) : authored[x]);
  }
  if ((cut === "long" || cut === "wave" || cut === "bob") && profile.fringe === "none" && (opening === "left" || opening === "right")) {
    const sweep = opening === "right" ? [3, 2, 2, 1, 0, 0, 1, 3] : [3, 1, 0, 0, 1, 2, 2, 3];
    rows = rows.map((v, x) => x === 0 || x === 7 ? v : sweep[x]);
  }
  // A root/forehead opening is resolved before painting; it is not a stripe
  // of synthetic scalp pigment laid across an opaque fringe.
  if (opening === "left" || opening === "right") rows[opening === "left" ? 2 : 5] = Math.min(rows[opening === "left" ? 2 : 5], 1);
  if (opening === "center" && profile.fringe !== "straight") { rows[3] = Math.min(rows[3], 1); rows[4] = Math.min(rows[4], 1); }
  // Loose waves leave a broader, stepped temple group; braids and pin-straight
  // hair keep cleaner sides instead of sharing the same head cut in another dye.
  if (cut === "wave" || cut === "shag") {
    const [lead, following] = rightPart ? [6, 1] : [1, 6];
    rows[lead] = Math.max(3, rows[lead]); rows[following] = Math.max(2, rows[following]);
    const bend = rightPart ? 5 : 2;
    if (opening === "none" || opening === "center" || (opening === "right" ? 5 : 2) !== bend) rows[bend] = Math.max(3, rows[bend]);
  }
  return rows;
}

export function buildPhotoHeadGeometry(style: FaceStyle, profile: PhotoHairProfile, observed: string,
  drape: readonly PhotoDrapeCell[] = [], detail?: Pick<AppearanceDetail, "templeLeft" | "templeRight">): PhotoHeadGeometry {
  const cut = classifyPhotoHeadCut(style, profile, observed);
  const fringe = fringeRows(cut, style, profile);
  const short = ["buzz", "crew", "crop", "spiky", "slick", "pixie", "side_part", "curtain", "bowl", "tied"].includes(cut);
  const curls = ["curls", "coils"].includes(cut), long = !short && cut !== "bald";
  const isTapered = short && ["tapered", "undercut", "ear_hugging"].includes(style.sideHairShape ?? "");
  const tiedBun = cut === "tied" && style.hairstyle === "bun";
  const ends = { above_ear: 3, at_ear: 4, cheek: 5, jaw: 6, below_jaw: 7, unknown: 7 } as const;
  const limitTemple = (left: boolean) => {
    const endpoint = left ? detail?.templeLeft : detail?.templeRight;
    if (!detail) return 7; // preserve historical atlases
    if (endpoint && endpoint !== "unknown") return ends[endpoint];
    if (style.overallHairLength === "cropped" || style.overallHairLength === "ear") return 4;
    if (style.overallHairLength === "jaw") return 5;
    if (["none", "short"].includes(style.sideHairLength ?? "") && short) return 4;
    return 7;
  };
  const tucked = (view: string) => /\bboth sides (?:are )?tucked\b/i.test(observed)
    || new RegExp(`\\bviewer(?:'s)?[- ]${view}[^.;]{0,35}\\btuck\\w*\\b`, "i").test(observed);
  const behindEarJoin = new Set<string>();
  for (const [x, view] of [[0, "left"], [7, "right"]] as const) {
    const hasFrontLock = drape.some(p => p.face === "front" && p.layer === "base" && p.x === x && p.y === 0);
    const isTucked = tucked(view);
    const temple = view === "left" ? detail?.templeLeft : detail?.templeRight;
    if (hasFrontLock && detail && (isTucked || temple && temple !== "unknown" && temple !== "below_jaw")) behindEarJoin.add(view);
    if (hasFrontLock && !behindEarJoin.has(view)) fringe[x] = 7;
    else if (isTucked) fringe[x] = Math.min(fringe[x], 3);
    else fringe[x] = Math.min(fringe[x], limitTemple(view === "left"));
  }
  const topTrim = (x: number, y: number) => (x <= 1 || x >= 6) && (y <= 1 || y >= 6);
  const baseCell = (face: keyof BoxUV, x: number, y: number) => {
    if (cut === "bald") return false;
    if (face === "top") return cut !== "buzz" || !(x === 0 && (y === 0 || y === 7) || x === 7 && (y === 0 || y === 7));
    if (face === "front") return y <= fringe[x] && (y <= 3 || x === 0 || x === 7);
    if (face === "back") {
      const nape = cut === "buzz" ? 5 : long || cut === "tied" ? 7 : 6;
      return y <= nape - (x <= 1 || x >= 6 ? 1 : 0);
    }
    if (face === "bottom") return (x === 0 && behindEarJoin.has("left") || x === 7 && behindEarJoin.has("right")) && (y === 2 || y === 3)
      || long && (y >= 5 || (x === 0 || x === 7) && y >= 2);
    const depth = face === "right" ? 7 - x : x;
    const frontSide = face === "right" ? 0 : 7;
    const sideTuck = tucked(face === "right" ? "left" : "right");
    const rear = long || cut === "tied" ? 6 : cut === "buzz" ? 4 : 5;
    if (depth === 0) return y <= fringe[frontSide];
    // Keep the cheek edge and fixed eyes intact; take the long lock around
    // the side behind the ear instead of extending the front temple down.
    if (behindEarJoin.has(face === "right" ? "left" : "right") && (depth === 2 || depth === 3)) return true;
    const taper = isTapered ? (depth <= 4 ? 1 : 0) : 0;
    const limit = sideTuck && depth <= 4 ? 2 : depth >= 6 ? rear : long ? 6 : depth <= 2 ? Math.min(4, fringe[frontSide] + 1) - taper : rear - 1 - taper;
    return y <= (depth <= 2 && fringe[frontSide] < 7 ? Math.min(limit, limitTemple(face === "right") + 1) : limit);
  };
  const base = Object.fromEntries(faceKeys.map(face => [face, Array.from({length: 8}, (_, y) =>
    Array.from({length: 8}, (_, x) => baseCell(face, x, y) ? "#" : ".").join(""))])) as PhotoHeadGeometry["base"];
  // Raised pixels are distinct clusters, not a full expanded helmet.
  const relief = new Set<string>();
  const key = (face: keyof BoxUV, x: number, y: number) => `${face}:${x},${y}`;
  const raise = (face: keyof BoxUV, x: number, y: number) => {
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && baseCell(face, x, y)) relief.add(key(face, x, y));
  };
  if (!["bald", "buzz"].includes(cut)) {
    for (let x = 1; x <= 6; x++) for (let y = 0; y <= Math.min(3, fringe[x]); y++) {
      const atPart = (profile.part === "left" && x === 2 || profile.part === "right" && x === 5 || profile.part === "center" && (x === 3 || x === 4)) && y <= 1;
      const wisps = profile.fringe === "wispy" && y >= 2 && x % 2 !== 0;
      const compact = cut === "crew" || cut === "slick";
      if (!atPart && !wisps && (y > 0 && !compact || y === 0 && x >= 2 && x <= 5 && cut !== "bowl")) raise("front", x, y);
    }
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) {
      const crest = tiedBun ? x >= 3 && x <= 5 && y <= 3
        : cut === "tied" ? x >= 2 && x <= 5 && y <= 4
        : curls ? (x + Math.floor(y / 2)) % 4 !== 0 && !topTrim(x, y)
        : cut === "wave" || cut === "shag" ? (x + Math.floor(y / 2)) % 5 < 4 && !topTrim(x, y)
        : cut === "braids" ? (x <= 2 || x >= 5) && y <= 5
        : cut === "spiky" ? (x + y) % 3 !== 0 && !topTrim(x, y)
        : (cut === "crew" || cut === "slick") ? x >= 2 && x <= 5 : !topTrim(x, y);
      if (crest) raise("top", x, y);
    }
    for (const [face, end] of [["right", 7], ["left", 0]] as const) {
      const sideTuck = tucked(face === "right" ? "left" : "right");
      for (let y = 1; y <= (long && !sideTuck ? 6 : 2); y++) {
        const inner = end + (end === 7 ? -1 : 1);
        if (!isTapered || y === 1) raise(face, inner, y);
        if (long && !sideTuck && y >= 3 && (y % 2 === 0 || cut === "long")) raise(face, end, y);
        if (cut === "wave" && !sideTuck && [3, 4, 6].includes(y)) raise(face, inner + (end === 7 ? -1 : 1), y);
      }
    }
    for (let y = tiedBun ? 0 : 2; y <= (long ? 6 : 4); y++) for (let x = 1; x < 7; x++) {
      if (tiedBun ? x >= 3 && x <= 5 && y <= 3 : (long && (x <= 2 || x >= 5)) || (curls && (x + y) % 3 !== 0)) raise("back", x, y);
    }
    for (const x of [0, 7]) for (let y = 3; y <= fringe[x]; y++) if (long || curls) raise("front", x, y);
  }
  const box = CLASSIC_LAYOUT.head.overlay;
  const locate = (p: {x: number; y: number}) => {
    const f = faceKeys.find(face => { const r = box[face]; return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h; })!;
    return [f, p.x - box[f].x, p.y - box[f].y] as const;
  };
  const seams = getBoxUvSeams(box);
  const boundary = [...seams.vertical, ...seams.horizontal].flatMap(s => s.primary.map((p, i) => [locate(p), locate(s.adjacent[i])] as const));
  // Only close raised seams supported by both base materials. The front's
  // eye windows are all outside the hair mask and cannot gain opaque pixels.
  for (let i = 0; i < 3; i++) for (const [a, b] of boundary) if (baseCell(...a) && baseCell(...b) && (relief.has(key(...a)) || relief.has(key(...b)))) {
    raise(...a); raise(...b);
  }
  const overlay = Object.fromEntries(faceKeys.map(face => [face, Array.from({length: 8}, (_, y) =>
    Array.from({length: 8}, (_, x) => relief.has(key(face, x, y)) ? "#" : ".").join(""))])) as PhotoHeadGeometry["overlay"];
  return { cut, base, overlay };
}
