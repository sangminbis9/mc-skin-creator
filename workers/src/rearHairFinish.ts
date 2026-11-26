import type { PhotoDrapeCell, PhotoHairProfile } from "./photoHairFinish";
import type { RearHairPattern } from "./appearanceDetail";

type LooseTexture = "straight" | "wavy" | "curly" | "coily";
export function isLooseRearHair(type: PhotoHairProfile["type"]): type is LooseTexture {
  return type === "straight" || type === "wavy" || type === "curly" || type === "coily";
}

const defaults = { straight: "straight", wavy: "loose_wave", curly: "ringlets", coily: "tight_coils" } as const;

/** Use visible strand evidence; back inference can authorize length but cannot
 * invent a curl class. A straight-length classification stays straight unless
 * the observed text specifically documents a visible bend in those lengths. */
export function chooseRearHairPattern(texture: LooseTexture, observed: string, hint?: RearHairPattern | "unknown"): RearHairPattern {
  const usable = observed.toLowerCase().split(/[.;\n]/g)
    .filter(c => !/\b(?:no|not|without|unknown|possibly|maybe|uncertain|hidden|occluded|inferred)\b/.test(c));
  const cues: Array<[RearHairPattern, RegExp]> = [
    ["ends_in", /\b(?:ends|tips)\b[^,]{0,38}\b(?:curl\w*|turn\w*|tuck\w*|bend\w*) (?:inwards?|under)\b|\b(?:inward[- ](?:curled|turned)|turned[- ]under) (?:ends|tips)\b/],
    ["ends_out", /\b(?:ends|tips)\b[^,]{0,38}\b(?:curl\w*|turn\w*|flip\w*|bend\w*) outwards?\b|\b(?:outward[- ](?:curled|flipped)|flipped[- ]out) (?:ends|tips)\b/],
    ["low_wave", /\b(?:waves?|bends?|curls?)\b[^,]{0,38}\b(?:start\w*|begin\w*|concentrat\w*)\b[^,]{0,38}\b(?:near (?:the )?(?:ends|tips)|below (?:the )?shoulders?|lower (?:half|lengths?))\b|\b(?:waves?|bends?) (?:only )?(?:at (?:the )?(?:ends|tips)|in the lower half)\b/],
    ["layered_wave", /\b(?:staggered|uneven|layered) (?:long )?(?:waves|wavy (?:layers|locks|hair))\b|\b(?:wavy layers|waves of different lengths)\b/],
    ["loose_wave", /\bs[- ]waves?\b|\b(?:s[- ]shaped|loose flowing|broad|loose) waves?\b/],
    ["ringlets", /\b(?:ringlets?|spiral curls?|barrel curls?)\b/],
    ["tight_coils", /\b(?:tight|small|compact) coils?\b|\b(?:tightly coiled|corkscrew coils?)\b/],
  ];
  const described = cues.find(([, re]) => usable.some(c => re.test(c)))?.[0];
  const pinStraight = usable.some(c => /\b(?:pin[- ]straight|poker[- ]straight|straight from (?:the )?roots? to (?:the )?(?:tips?|ends?)|completely straight (?:hair|locks?))\b/.test(c));
  if (pinStraight) return "straight";
  const visiblyWavy = usable.some(c => /\bwavy (?:hair|locks?|lengths?)\b|\b(?:hair|locks?|lengths?) (?:is|are) wavy\b/.test(c));
  const visiblyStraight = usable.some(c => /\bstraight (?:hair|locks?|lengths?)\b|\b(?:hair|locks?|lengths?) (?:is|are) straight\b/.test(c));
  if (visiblyStraight && !visiblyWavy && !described) return "straight";
  if (texture === "straight") {
    return described ?? (visiblyWavy ? "loose_wave" : "straight");
  }
  if (described) return described;
  if (hint && hint !== "unknown") return hint;
  return defaults[texture];
}

// Eight normalized stages: the upper back stays connected to the nape, but
// the two ends taper at different widths. The second layer picks out separate
// locks instead of extruding the entire silhouette as another slab.
const shapes = {
  straight: [".######.", ".######.", ".######.", ".######.", ".######.", ".######.", ".######.", ".######."],
  ends_in: [".######.", ".######.", ".######.", ".######.", ".######.", ".######.", "..####..", "...##..."],
  ends_out: [".######.", ".######.", ".######.", ".######.", "..####..", "..####..", ".###.##.", ".##..##."],
  low_wave: [".######.", ".######.", ".######.", ".######.", ".#####..", "..#####.", "..##.##.", "...#..#."],
  loose_wave: [".######.", ".######.", "..#####.", "..#####.", ".######.", ".#####..", ".##.###.", "..#..##."],
  layered_wave: [".######.", ".######.", ".######.", ".#####..", ".####.#.", ".##.###.", ".#...##.", ".....#.."],
  ringlets: [".######.", ".######.", ".#####..", "..#####.", ".######.", ".######.", ".##..##.", ".#....#."],
  tight_coils: [".######.", ".######.", ".######.", ".##.###.", ".######.", "..####..", "..##.##.", "..#..#.."],
} as const satisfies Record<RearHairPattern, readonly string[]>;
const ridges = {
  straight: [[2, 5], [2, 5], [2, 5], [2, 5], [2, 5], [2, 5], [2, 5], [2, 5]],
  ends_in: [[2, 5], [2, 5], [2, 5], [2, 5], [2, 5], [2, 5], [3, 4], [3, 4]],
  ends_out: [[2, 5], [2, 5], [2, 5], [2, 5], [3, 4], [3, 4], [2, 5], [1, 6]],
  low_wave: [[2, 5], [2, 5], [2, 5], [2, 5], [2, 4], [3, 5], [3, 5], [3, 6]],
  loose_wave: [[2, 5], [2, 5], [3, 6], [3, 6], [2, 5], [2, 4], [2, 5], [2, 5]],
  layered_wave: [[2, 5], [2, 5], [2, 5], [2, 4], [2, 6], [2, 5], [1, 5], [5]],
  ringlets: [[2, 5], [2, 5], [2, 4], [3, 6], [2, 5], [2, 5], [2, 6], [1, 6]],
  tight_coils: [[2, 5], [2, 5], [3, 5], [2, 6], [2, 5], [3, 5], [2, 5], [2, 5]],
} as const satisfies Record<RearHairPattern, readonly (readonly number[])[]>;

// Straight locks are vertical columns, not curves translated side to side.
// Keep the longest strands at the observed endpoint and stagger only the hem.
const straightTipTrim = [2, 1, 0, 0, 0, 1] as const;

export function buildLooseRearHair(rows: number, texture: LooseTexture, mirror: boolean, pattern: RearHairPattern = defaults[texture]): PhotoDrapeCell[] {
  const cells: PhotoDrapeCell[] = [];
  for (let y = 0; y < rows; y++) {
    const stage = rows <= 1 ? 0 : Math.round(y * 7 / (rows - 1));
    const shape = shapes[pattern][stage], [first, second] = ridges[pattern][stage];
    const xAt = (x: number) => mirror ? 7 - x : x;
    for (let x = 0; x < shape.length; x++) {
      if (shape[x] !== "#") continue;
      const trim = pattern === "straight" ? Math.min(straightTipTrim[x - 1], Math.floor((rows - 1) / 2)) : 0;
      const tip = rows - 1 - trim;
      if (y > tip) continue;
      const edge = shape[x - 1] !== "#" || shape[x + 1] !== "#";
      const ridge = x === first || x === second;
      const fold = x === first + 1 && shape[x + 1] === "#";
      const tone = y === 0 ? 2 : y === tip ? ridge ? 2 : 1 : ridge ? 3 : fold || edge ? 1 : 2;
      cells.push({ face: "back", layer: "base", x: xAt(x), y, tone });
      const relief = y === 0 ? ridge : pattern === "straight"
        ? ridge && y <= tip - (x === first ? 1 : 2)
        : y < rows - 1 && (x === first && y <= rows - 3 || x === second && y >= 2 && y % 3 !== 0);
      if (relief) cells.push({ face: "back", layer: "overlay", x: xAt(x), y, tone: 3 });
    }
  }
  return cells;
}
