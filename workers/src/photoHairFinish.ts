/** Photo-led classification and below-head paint. No demographic inputs. */
import type { PhotoAnalysis } from "./analysis";
import { observedFrontHairDrape, observedFrontHairPlacement } from "./observedFrontHairDrape";
import { sourceAccessoryStencils } from "./referenceOutfitRetention";
import { buildReferenceScarfFinish } from "./referenceScarfFinish";
import type { FaceStyle } from "./skinPack";
import type { SkinPlan } from "./skinPlan";
import { fixedHairTone } from "./fixedMaterialPalette";

export type PhotoHairType = "compact" | "straight" | "wavy" | "curly" | "coily" | "braided" | "locs" | "tied";
export type PhotoHairProfile = {
  type: PhotoHairType;
  part: NonNullable<FaceStyle["hairPart"]>;
  fringe: NonNullable<FaceStyle["bangs"]> | "textured";
  sweep: "left" | "right" | "none";
};
export type PhotoDrapeCell = { face: "front" | "back"; layer: "base" | "overlay"; x: number; y: number; tone: 0 | 1 | 2 | 3 | 4 };

function explicitPart(text: string): PhotoHairProfile["part"] | undefined {
  const hits = new Set<PhotoHairProfile["part"]>();
  for (const clause of text.toLowerCase().split(/[.;\n]/)) {
    if (/\b(?:no|not|unknown|unclear|maybe|possibly)\b[^,]{0,24}\b(?:part(?:ed|ing)?|division)\b/.test(clause)) continue;
    const root = clause.split(/\b(?:sweep(?:s|ing|t)?|fall(?:s|ing)?|flow(?:s|ing)?)\s+(?:across |toward(?:s)? |to )/)[0];
    for (const side of ["left", "right"] as const) {
      const viewer = `(?:viewer(?:'s)?[- ]|(?:image|screen)[- ])${side}`;
      if (new RegExp(`\\b(?:part(?:ed|ing)?|division)\\b(?: (?:on|at|near|toward|to|of|the|a|slightly)){0,5} ${viewer}\\b|\\b${viewer}(?:[- ]side)?[- ]part(?:ing)?\\b`).test(root)) hits.add(side);
    }
    if (/\b(?:cent(?:er|re)|middle)[- ]part(?:ed|ing)?\b|\bpart(?:ed|ing)? (?:in|at) the (?:cent(?:er|re)|middle)\b/.test(root)) hits.add("center");
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

export function classifyPhotoHair(style: FaceStyle, observed: string, explicitStructure = false): PhotoHairProfile {
  const affirmative = observed.toLowerCase().split(/[.;\n]/).filter(s => !/\b(?:no|not|without|uncertain|possibly)\b/.test(s)).join(";");
  const braids = explicitStructure && /\b(?:(?:two|twin|paired|box|side) braids?|braided (?:hair|pigtails?|pony(?:tail)?s?)|cornrows?)\b/.test(affirmative);
  const locs = explicitStructure && /\b(?:locs|dreadlocks?|dread[- ]locks?)\b/.test(affirmative);
  const type = ["buzz", "bald"].includes(style.hairstyle) ? "compact"
    : style.hairStructure === "braids" || braids ? "braided" : style.hairStructure === "locs" || locs ? "locs"
      : ["bun", "ponytail", "twintails"].includes(style.hairstyle) ? "tied"
        : style.hairTexture ?? "straight";
  const part = type === "compact" ? "none" : explicitPart(observed) ?? style.hairPart ?? "none";
  const irregularFringe = style.bangs === "straight" && style.fringeEdge === "staggered"
    && (style.hairSilhouette === "tousled" || /\b(?:textured|tousled|messy|ruffled)\b/i.test(observed));
  const fringe = type === "compact" ? "none" : style.fringeEdge === "wispy" && style.bangs !== "none" ? "wispy"
    : irregularFringe ? "textured" : style.bangs ?? "none";
  const sweep = /\b(?:sweep\w*|flow\w*)\b[^.;]{0,42}\b(?:toward(?:s)?|to) (?:the )?viewer(?:'s)?[- ](left|right)\b/i.exec(observed)?.[1] as "left" | "right" | undefined;
  return { type, part, fringe, sweep: sweep ?? (part === "left" ? "right" : part === "right" ? "left" : "none") };
}

export function photoHairTone(p: readonly [number, number, number], style: FaceStyle, profile: PhotoHairProfile, raised: boolean): PhotoDrapeCell["tone"] {
  const [x, y, z] = p;
  const root = profile.part === "left" ? 2 : profile.part === "right" ? 5 : 3.5;
  if (profile.type === "compact") return y < 2 && z < 5 ? (raised ? 3 : 2) : y > 4 ? 1 : 2;
  if (profile.part !== "none" && y <= 4 && z <= 5.5) {
    const diagonal = profile.part === "center" ? 0 : (profile.sweep === "right" ? 1 : -1) * Math.max(0, y - 1) * .34;
    const distance = Math.abs(x - root - diagonal);
    const partedFringe = ["side", "curtain"].includes(profile.fringe) || style.bangs === "none";
    if (y <= (partedFringe ? 3 : 2) && distance <= .65) return 0;
    if (distance <= 1.55 && y <= 3 && z < 4) return raised && (y === 1 || y === 2) ? 4 : 3;
  }
  if (profile.type === "braided" || profile.type === "locs") {
    const lane = (Math.floor(x + z * .7) + (profile.type === "braided" ? Math.floor(y / 2) % 2 : 0)) % 4;
    return lane === 0 ? 1 : lane === 1 && y % 4 < 3 ? 3 : 2;
  }
  if (profile.type === "curly" || profile.type === "coily") {
    const width = profile.type === "curly" ? 4 : 3;
    const u = Math.floor(x + z * .75), row = y + Math.floor(u / width);
    const turn = (u + Math.floor(row / width)) % width;
    return turn === 0 ? 1 : turn === 1 && row % width < 2 ? (raised ? 4 : 3) : 2;
  }
  if (profile.type === "tied" && z >= 3 && y <= 5) {
    const flow = Math.abs(x - 3.5) - z * .42 + y * .38;
    return flow < -.6 ? 1 : flow < .8 ? 3 : 2;
  }
  if (profile.fringe === "wispy" && z <= .1 && y >= 2 && y <= 4) {
    return ([1, 3, 2, 0, 2, 3, 1, 2] as const)[(x + (y === 4 ? 1 : 0)) % 8];
  }
  if (profile.fringe === "textured" && y >= 1 && y <= 4 && z <= 2) {
    // Stagger small diagonal pairs; do not thin a dense fringe into wisps.
    const lane = (Math.floor(x + z) + (y >= 3 ? 1 : 0)) % 5;
    return lane === 0 ? 1 : lane <= 2 && y < 4 ? 3 : 2;
  }
  return fixedHairTone(p, style, raised, profile.part);
}

export function buildPhotoDrape(plan: SkinPlan, a: PhotoAnalysis, style: FaceStyle, explicitStructure = false): PhotoDrapeCell[] {
  const observed = a.observed.hair;
  const profile = classifyPhotoHair(style, observed, explicitStructure);
  const rows = style.overallHairLength === "shoulder" ? 4 : style.overallHairLength === "chest" ? 8
    : ["waist", "hip"].includes(style.overallHairLength ?? "") ? 12 : 0;
  const detail = a.visibleRegions.upperBody ? a.appearanceDetail : undefined;
  if ((!rows && !detail) || !a.visibleRegions.hair || style.hairstyle === "bun" || profile.type === "compact") return [];
  const parsedText = observed.replace(/\bviewer(?:'s)?-(left|right)\b/gi, "viewer $1");
  const evidence = observedFrontHairDrape(parsedText);
  const placement = observedFrontHairPlacement(parsedText);
  // A description can name the overlap once and specify the side in a later
  // clause. A fuller temple alone does not mean the hair is in front of clothes.
  const forward = /\bviewer(?:'s)?[- ](left|right)(?: side)?\b[^.;]{0,55}\b(?:flows?|hangs?|falls?|drapes?)\s+forward\b/i.exec(observed)?.[1];
  const chestOverlap = observed.split(/[.;\n]|\b(?:while|whereas)\b/i).some(clause =>
    !/\b(?:no|not|behind|hidden|unknown|possibly|printed)\b/i.test(clause) &&
    /\b(?:hair|locks?|strands?|braids?|locs)\b[^.;]{0,35}\b(?:over|across|in front of)\b[^.;]{0,36}\b(?:chest|top|cardigan|shirt|hoodie|jacket|clothing|waist)\b/i.test(clause));
  const pluralFaceFrame = explicitStructure && observed.split(/[.;\n]/).some(clause =>
    !/\b(?:no|not|behind|hidden|unknown|possibly|printed)\b/i.test(clause) &&
    /\b(?:side |front )?(?:locks|strands|braids)\s+(?:framing (?:the |her |his |their )?face and |that frame (?:the |her |his |their )?face and )?(?:reach(?:ing)?|fall(?:ing)?|extend(?:ing)?)\s+(?:down )?(?:to )?(?:the )?(?:chest|waist|hips?)\b/i.test(clause));
  const frontWitness = evidence !== null || chestOverlap || pluralFaceFrame;
  const both = /\b(?:both|each) (?:sides?|shoulders?)\b/i.test(observed)
    || /\b(?:twin[- ]?tails|pigtails|(?:two|twin|paired) braids)\b[^.;]{0,36}\b(?:over|across|in front of)\b/i.test(observed);
  const front: PhotoDrapeCell[] = [];
  for (const [side, x, inward] of [["left", 0, 1], ["right", 7, -1]] as const) {
    const verified = side === "left" ? detail?.frontHairLeft : detail?.frontHairRight;
    if (verified && verified !== "unknown") {
      if (verified === "not_in_front") continue;
      const temple = side === "left" ? detail?.templeLeft : detail?.templeRight;
      const observedOnSide = !!placement[side] || frontWitness && (forward === side || both || pluralFaceFrame) && !placement[side === "left" ? "right" : "left"];
      // A short cut or an ear/cheek/jaw endpoint cannot independently turn a
      // contradictory shoulder label into a head-to-torso lock. Longer hair
      // behind the neck is also not evidence of front overlap.
      if (!rows && !(temple === "below_jaw" && observedOnSide)) continue;
      if (!observedOnSide && (temple && temple !== "below_jaw" && temple !== "unknown" || rows === 4 && temple !== "below_jaw")) continue;
      const length = Math.min(rows || 4, { shoulder: 4, chest: 8, waist: 11 }[verified]);
      const texture = detail?.frontHairTexture === "unknown" ? profile.type : detail?.frontHairTexture;
      for (let y = 0; y < length; y++) {
        const bend = texture === "wavy" && [3, 4, 7, 8, 9].includes(y) || texture === "braided" && y >= 5;
        // Underlay stays attached to its temple; relief traces the outside of
        // a wave or the alternating facing lobes of a braid, never a shell.
        const anchor = x + (bend ? inward : 0);
        const edge = x + (bend ? 2 * inward : inward);
        front.push({ face: "front", layer: "base", x: anchor, y, tone: y < 2 || y === length - 1 ? 1 : 2 });
        if (y < length - 1) {
          front.push({ face: "front", layer: "base", x: edge, y, tone: texture === "braided" && y % 3 === 1 ? 1 : 2 });
          if (y >= 1 && (texture === "braided" ? y % 3 !== 1 : y % 4 === 2 || bend && y % 2 === 0))
            front.push({ face: "front", layer: "overlay", x: edge, y, tone: 3 });
        }
      }
      continue;
    }
    if (!frontWitness || !rows) continue;
    const endpoint = placement[side];
    const explicitSide = placement.left || placement.right || forward;
    if (explicitSide && !endpoint && forward !== side) continue;
    if (!explicitSide && (!both && evidence !== "observed_front_lock_endpoint" && !pluralFaceFrame || style.hairstyle === "ponytail")) continue;
    const length = Math.min(rows, endpoint === "shoulder" || evidence === "observed_front_shoulder_endpoint" && !endpoint ? 4
      : endpoint === "chest" ? 8 : rows);
    for (let y = 0; y < length; y++) {
      const wide = y > 0 && y < length - 1 && (profile.type === "straight" || y % 4 !== 1);
      front.push({ face: "front", layer: "base", x, y, tone: y < 2 || y === length - 1 ? 1 : 2 });
      if (wide) front.push({ face: "front", layer: "base", x: x + inward, y, tone: profile.type === "braided" && y % 2 === 0 ? 1 : 2 });
      if (wide && y >= 2 && (profile.type === "braided" ? y % 3 !== 0 : y % 5 === 2 || y % 5 === 3)) {
        front.push({ face: "front", layer: "overlay", x: x + inward, y, tone: 3 });
      }
    }
  }
  const rear: PhotoDrapeCell[] = [];
  const rearText = a.inferred.hairBack.value;
  const rearSupported = style.hairBackShape === "long" && /\b(?:long|shoulders?|chest|waist|drap\w*|flow\w*)\b/i.test(rearText)
    && !/\b(?:unknown|unseen|no|not|cropped|short|bun)\b/i.test(rearText);
  const tiedRear = style.hairstyle === "ponytail" && /\bponytail\b[^.;]{0,45}\b(?:down|over|along) (?:the )?back\b/i.test(observed);
  const pairedRear = style.hairstyle === "twintails" && /\b(?:twin[- ]?tails|pigtails|two ponytails)\b[^.;]{0,45}\b(?:down|over|along) (?:the )?back\b/i.test(observed);
  if ((profile.type !== "tied" && rearSupported) || tiedRear || pairedRear) for (let y = 0; y < rows; y++) {
    const taper = y >= rows - 2;
    const columns = pairedRear ? taper ? [2, 5] : [1, 2, 5, 6]
      : tiedRear ? [3, 4] : taper ? [2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
    for (const x of columns) {
      const bend = ["wavy", "curly", "coily"].includes(profile.type) ? Math.floor(y / 2) % 2 : 0;
      rear.push({ face: "back", layer: "base", x, y, tone: y < 2 || y >= rows - 1 ? 1 : (x + bend) % 3 === 0 ? 3 : 2 });
    }
  }
  if (!front.length && !rear.length) return [];
  const skin = style.skinTone ?? "#d39e80";
  const key = (p: {face: string; x: number; y: number}) => `${p.face}:${p.x},${p.y}`;
  const reserved = new Set([...sourceAccessoryStencils(plan.outfitPlan, skin).flatMap(s => s.paints),
    ...buildReferenceScarfFinish(plan, skin).paints].filter(p => p.part === "body").map(key));
  const candidates = [...front, ...rear].filter(p => !reserved.has(key(p)));
  const baseCells = new Map(candidates.filter(p => p.layer === "base").map(p => [key(p), p]));
  const queue = [...baseCells.values()].filter(p => p.y === 0), connected = new Set<string>();
  for (const p of queue) {
    if (connected.has(key(p))) continue;
    connected.add(key(p));
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const q = baseCells.get(key({ ...p, x: p.x + dx, y: p.y + dy }));
      if (q && !connected.has(key(q))) queue.push(q);
    }
  }
  return candidates.filter(p => connected.has(key(p)));
}
