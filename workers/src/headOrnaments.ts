/** Observed accessories -> bounded, shared paint/ownership footprints.
 * No demographics, reference bitmap copying, inferred back-view accessories,
 * new geometry, network calls or persistent observation text. */
import type { PhotoAnalysis } from "./analysis";
import type { RawImage } from "./png";
import { CLASSIC_LAYOUT, type BoxUV } from "./uvLayout";
import { hairRibbonFootprint } from "./hairRibbonFootprint";
import { hairFlowerFootprint } from "./hairFlowerFootprint";

export type HeadOrnamentKind = "clip" | "bow" | "ribbon" | "flower" | "headband" | "headphones" | "earmuffs" | "crown" | "tiara" | "animal_ears" | "horns" | "goggles";
export interface HeadOrnamentCell { face: keyof BoxUV; x: number; y: number; color: [number, number, number] }
export interface HeadOrnament { kind: HeadOrnamentKind; side: "left" | "right" | "center" | "both"; cells: HeadOrnamentCell[] }
const colors: Record<string, [number, number, number]> = {
  black: [34, 33, 39], white: [232, 229, 225], silver: [176, 182, 194], gray: [116, 115, 125], gold: [202, 164, 75],
  brown: [107, 71, 51], red: [178, 52, 64], orange: [219, 129, 55], yellow: [229, 204, 89], green: [86, 146, 103],
  blue: [86, 124, 187], purple: [147, 105, 172], pink: [218, 149, 177],
};
const rules: Array<[HeadOrnamentKind, RegExp]> = [
  ["headphones", /\b(?:headphones|headset)\b/], ["earmuffs", /\bearmuffs\b/],
  ["animal_ears", /\b(?:cat|bunny|rabbit|fox|animal)[- ]ear(?:s)?\s+(?:headband|accessory|accessories)\b/],
  ["horns", /\b(?:horned headband|(?:decorative|costume|headband) horns)\b/],
  ["headband", /\b(?:headband|alice band)\b/], ["crown", /\bcrown\b(?!\s+(?:hair|volume|area|of))/],
  ["tiara", /\btiara\b/], ["goggles", /\bgoggles\b(?=.{0,35}\b(?:forehead|head|hair)\b)/],
  ["clip", /\b(?:hair[- ]?clips?|barrettes?|hairpins?|bobby pins?)\b/],
  ["bow", /\b(?:hair bows?|bows? in (?:the )?hair|head bows?)\b/],
  ["ribbon", /\b(?:hair ribbons?|ribbons? in (?:the )?hair|head ribbons?)\b/],
  ["flower", /\b(?:hair flowers?|flower (?:hair )?clips?|flowers? in (?:the )?hair|floral headpiece)\b/],
];
const negated = /\b(?:no|not|without|absent|unknown|uncertain|possibly|maybe|might|could|hidden|obscured|unseen)\b/;

export function ornamentFootprint(kind: HeadOrnamentKind, side: HeadOrnament["side"], color: [number, number, number], scale: "small" | "medium" | "large" = "medium"): HeadOrnamentCell[] {
  const cells = new Map<string, HeadOrnamentCell>();
  const put = (face: keyof BoxUV, x: number, y: number, factor = 1) => {
    if (x < 0 || x > 7 || y < 0 || y > 7) return;
    cells.set(`${face}:${x}:${y}`, { face, x, y, color: color.map(v => Math.min(255, Math.round(v * factor))) as [number, number, number] });
  };
  const sides = side === "both" ? ["left", "right"] as const : [side];
  if (["clip", "bow", "ribbon", "flower"].includes(kind)) {
    for (const s of sides) {
      if (kind === "clip") {
        const x = s === "right" ? 6 : s === "center" ? 3 : 1;
        put("front", x, 1, 1.12); put("front", x, 2); if (scale === "large") put("front", x, 3, .82);
      } else if (kind === "flower") {
        for (const p of hairFlowerFootprint(s as "left" | "right" | "center", scale)) put(p.face, p.x, p.y, p.y % 2 ? .88 : 1.08);
      } else for (const p of hairRibbonFootprint(s as "left" | "right" | "center", scale)) put(p.face, p.x, p.y, p.pigment === "knot" ? .72 : p.pigment === "light" ? 1.12 : p.pigment === "shade" ? .85 : 1);
    }
  } else if (["headband", "headphones", "earmuffs", "animal_ears", "horns"].includes(kind)) {
    // A physical transverse band: top x0 -> right x(7-y), top x7 -> left x(y).
    for (let x = 0; x < 8; x++) put("top", x, 4, 1.08);
    for (const face of ["right", "left"] as const) {
      const x = face === "right" ? 3 : 4;
      for (let y = 0; y <= (kind === "headband" ? 2 : 4); y++) put(face, x, y, y === 0 ? 1.08 : 1);
      if (kind === "headphones" || kind === "earmuffs") for (let y = 3; y <= 5; y++) for (const dx of [-1, 0, 1]) put(face, x + dx, y, dx === 0 && y === 4 ? 1.18 : .82);
    }
    if (kind === "animal_ears" || kind === "horns") for (const x of [1, 6]) {
      for (const y of [3, 4, 5]) put("top", x, y, y === 4 ? 1.2 : .8);
      // Texture suggestion within the legal outer cuboid; not arbitrary mesh ears.
      put("front", x, 0, 1.12); put("top", x, 7, 1.12);
      if (kind === "animal_ears") put("front", x, 1, .75);
    }
  } else if (kind === "crown" || kind === "tiara") {
    for (let x = 1; x < 7; x++) put("front", x, 1);
    for (const x of kind === "crown" ? [1, 3, 6] : [3, 4]) { put("front", x, 0, 1.2); put("top", x, 7, 1.2); }
  } else if (kind === "goggles") {
    // Only forehead-mounted goggles; worn eyewear keeps the existing eye grammar.
    for (const start of [1, 5]) for (const x of [start, start + 1]) { put("front", x, 1, .72); put("front", x, 2, 1.15); }
    for (const x of [3, 4]) put("front", x, 1);
  }
  return [...cells.values()];
}

export function buildObservedHeadOrnaments(a: PhotoAnalysis): HeadOrnament[] {
  // Only direct observed fields: inferred completion and generic identity prose
  // cannot invent a wearable. Split before color/side extraction to prevent bleed.
  const clauses = [a.observed.accessories, a.observed.hair]
    .flatMap((t, source) => t.toLowerCase().split(/[.;!?]|\bbut\b/).map(text => ({ text, source })))
    .filter(({text}) => !negated.test(text)) // Negation scopes over coordinated lists.
    .flatMap(({text, source}) => text.split(/,|\band\b/).map(clause => ({clause, source})));
  const result: HeadOrnament[] = [];
  for (const {clause, source} of clauses) {
    if (negated.test(clause) || /\b(?:print|printed|motif|logo|depicts|pattern)\b/.test(clause)) continue;
    let kinds = rules.filter(([, re]) => re.test(`${clause} `)).map(([kind]) => kind);
    if (kinds.includes("animal_ears") || kinds.includes("horns")) kinds = kinds.filter(k => k !== "headband");
    if (kinds.includes("flower")) kinds = kinds.filter(k => k !== "clip");
    if (source === 1 && !/\b(?:wearing|gold|silver|metal|jeweled|decorative|costume|royal)\b/.test(clause)) kinds = kinds.filter(k => k !== "crown");
    if (kinds.length > 1) continue; // Ambiguous shared color/location: do not guess.
    for (const kind of kinds) {
      // Existing single bow/flower rendering remains byte-compatible. Extend
      // only paired ornaments and categories that lacked an exact footprint.
      const paired = /\b(?:both|each side)\b/.test(clause);
      if (["bow", "ribbon", "flower"].includes(kind) && !paired) continue;
      const left = /\bviewer(?:'s)?[- ]left\b/.test(clause), right = /\bviewer(?:'s)?[- ]right\b/.test(clause);
      const lateral = ["clip", "bow", "ribbon", "flower"].includes(kind);
      const hint = a.renderHints.hairAccessory === kind ? a.renderHints.hairAccessorySide : undefined;
      const side = paired ? "both" : left && !right ? "left" : right && !left ? "right" : /\bcent(?:er|re)\b/.test(clause) ? "center" : lateral ? hint : "center";
      if (!side) continue; // Unknown laterality is not permission to choose a side.
      if (result.some(p => p.kind === kind && p.side === side) || result.length >= 3) continue;
      const noun = rules.find(([k]) => k === kind)![1].exec(clause)!.index;
      const candidates = [...clause.matchAll(/\b(black|white|silver|gray|gold|brown|red|orange|yellow|green|blue|purple|pink)\b/g)]
        .filter(m => Math.abs(m.index - noun) <= 28).sort((a, b) => Math.abs(a.index - noun) - Math.abs(b.index - noun));
      const named = candidates[0]?.[1];
      const color = colors[named ?? (hint ? a.renderHints.hairAccessoryColor : "gray")] ?? colors.gray;
      const scale = /\b(?:small|tiny|subtle)\b/.test(clause) ? "small" : /\b(?:large|oversized)\b/.test(clause) ? "large" : "medium";
      result.push({ kind, side, cells: ornamentFootprint(kind, side, color, scale) });
    }
  }
  return result;
}

export function paintHeadOrnaments(atlas: RawImage, ornaments: readonly HeadOrnament[] = []): void {
  for (const ornament of ornaments) for (const p of ornament.cells) {
    const r = CLASSIC_LAYOUT.head.overlay[p.face];
    atlas.rgba.set([...p.color, 255], ((r.y + p.y) * 64 + r.x + p.x) * 4);
  }
}
