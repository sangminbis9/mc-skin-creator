import {
  CLASSIC_LAYOUT as L,
  type BodyPart,
  type Rect,
} from "../../shared/skinLayout";

export type VariationRegion = "head" | "upper" | "lower";
export interface SkinVariation {
  id: string;
  label: string;
  pixels: Uint8ClampedArray;
}
export const VARIATION_PARTS: Record<VariationRegion, BodyPart[]> = {
  head: ["head"],
  upper: ["body", "rightArm", "leftArm"],
  lower: ["rightLeg", "leftLeg"],
};
const LENGTH = 64 * 64 * 4;
type Color = [number, number, number];
const hex = (value: string): Color =>
  [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Color;
function check(data: Uint8ClampedArray) {
  if (data.length !== LENGTH) throw new Error("64×64 RGBA 스킨이 필요합니다.");
}
function each(rect: Rect, fn: (x: number, y: number, index: number) => void) {
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++)
      fn(x, y, ((rect.y + y) * 64 + rect.x + x) * 4);
}

/** Replace, never alpha-blend: transparent overlay pixels must erase the previous outfit. */
export function replaceSkinRegion(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  region: VariationRegion,
): Uint8ClampedArray {
  check(target);
  check(source);
  const result = new Uint8ClampedArray(target);
  for (const part of VARIATION_PARTS[region])
    for (const layer of [L[part].base, L[part].overlay]) {
      for (const rect of Object.values(layer))
        each(rect, (_x, _y, i) => result.set(source.subarray(i, i + 4), i));
    }
  return result;
}

function colorAt(
  data: Uint8ClampedArray,
  rect: Rect,
  points: [number, number][],
  fallback: Color,
): Color {
  const samples = points
    .map(([x, y]) => ((rect.y + y) * 64 + rect.x + x) * 4)
    .filter((i) => data[i + 3] > 128);
  if (!samples.length) return fallback;
  return [0, 1, 2].map(
    (c) =>
      samples.map((i) => data[i + c]).sort((a, b) => a - b)[
        Math.floor(samples.length / 2)
      ],
  ) as Color;
}
function pixel(
  data: Uint8ClampedArray,
  rect: Rect,
  x: number,
  y: number,
  color: Color,
  shade = 1,
) {
  const i = ((rect.y + y) * 64 + rect.x + x) * 4;
  data.set([...color.map((c) => Math.round(c * shade)), 255], i);
}
function fill(data: Uint8ClampedArray, rect: Rect, color: Color) {
  each(rect, (x, y) => pixel(data, rect, x, y, color));
}
function clearOverlay(data: Uint8ClampedArray, region: VariationRegion) {
  for (const part of VARIATION_PARTS[region])
    for (const rect of Object.values(L[part].overlay))
      each(rect, (_x, _y, i) => data.fill(0, i, i + 4));
}

function hair(
  source: Uint8ClampedArray,
  style: "crop" | "part" | "soft" | "beanie",
  skin: Color,
  color: Color,
) {
  const data = new Uint8ClampedArray(source);
  const { base, overlay } = L.head;
  // Preserve the original front face and accessories from row 2 down (eyes, nose, mouth).
  for (const [face, rect] of Object.entries(overlay))
    each(rect, (_x, y, i) => {
      if (face !== "front" || y < 2) data.fill(0, i, i + 4);
    });
  const cap = style === "beanie";
  const pigment = cap ? hex("#647851") : color;
  fill(data, base.top, color);
  fill(data, overlay.top, pigment);
  const frontDepth = cap
    ? [2, 2, 2, 2, 2, 2, 2, 2]
    : style === "part"
      ? [2, 2, 2, 1, 0, 1, 2, 2]
      : style === "crop"
        ? [1, 1, 1, 1, 1, 1, 1, 1]
        : [2, 2, 1, 2, 2, 1, 2, 2];
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 2; y++) {
      pixel(data, base.front, x, y, y < frontDepth[x] ? color : skin);
      if (y < frontDepth[x])
        pixel(data, overlay.front, x, y, pigment, y === 0 ? 1 : 0.94);
    }
  const rear = cap ? 3 : style === "crop" ? 3 : 5;
  for (const face of ["right", "left", "back"] as const) {
    each(base[face], (x, y) => {
      const depth =
        face === "back"
          ? rear
          : Math.round(
              frontDepth[face === "right" ? 0 : 7] +
                ((rear - frontDepth[face === "right" ? 0 : 7]) *
                  (face === "right" ? 7 - x : x)) /
                  7,
            );
      pixel(
        data,
        base[face],
        x,
        y,
        y < depth ? color : skin,
        y < depth ? 1 - y * 0.025 : 0.96,
      );
      // Connected upper cap, tapered lower volume instead of floating corner pixels.
      const frontEdge = face === "right" ? x === 7 : face === "left" && x === 0;
      if (
        y <
        (frontEdge
          ? frontDepth[face === "right" ? 0 : 7]
          : Math.max(1, depth - 1))
      )
        pixel(data, overlay[face], x, y, pigment, y === 0 ? 1 : 0.94);
    });
  }
  return data;
}

function outfit(
  source: Uint8ClampedArray,
  region: "upper" | "lower",
  style: string,
  color: Color,
  skin: Color,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(source);
  clearOverlay(data, region);
  const light = hex("#e4dfcf");
  const shoes =
    style === "denim" || style === "shorts" ? light : hex("#252b29");
  for (const part of VARIATION_PARTS[region]) {
    const arm = part === "leftArm" || part === "rightArm";
    const cutoff =
      region === "lower"
        ? style === "shorts"
          ? 6
          : 10
        : arm
          ? style === "tee"
            ? 5
            : 10
          : 12;
    for (const [face, rect] of Object.entries(L[part].base))
      each(rect, (x, y) => {
        const level = face === "top" ? 0 : face === "bottom" ? 11 : y;
        let pigment = level < cutoff ? color : skin;
        if (region === "lower" && level >= 10) pigment = shoes;
        const edge = x === 0 || x === rect.w - 1;
        const shade =
          face === "bottom"
            ? 0.78
            : 1 - level * 0.008 + (!edge && (x + y) % 5 === 0 ? 0.035 : 0);
        pixel(data, rect, x, y, pigment, shade);
      });
    for (const face of ["front", "back", "left", "right"] as const) {
      const rect = L[part].overlay[face];
      // Cuffs and hems wrap the complete part; transparent areas reveal its base.
      const hem = region === "upper" ? (arm ? cutoff - 1 : 11) : cutoff - 1;
      for (let x = 0; x < rect.w; x++) pixel(data, rect, x, hem, color, 0.85);
      if (region === "lower")
        for (let x = 0; x < rect.w; x++) pixel(data, rect, x, 11, shoes, 0.8);
    }
  }
  if (region === "upper") {
    const b = L.body.base.front;
    const o = L.body.overlay.front;
    pixel(data, b, 3, 0, skin);
    pixel(data, b, 4, 0, skin);
    if (style === "jacket") {
      for (let y = 1; y < 12; y++)
        for (const x of [3, 4]) pixel(data, b, x, y, light, 0.9);
      for (const x of [2, 5])
        for (let y = 0; y < 4; y++) pixel(data, o, x, y, color, 1.13);
    } else if (style === "hoodie") {
      for (const x of [2, 5])
        for (let y = 1; y < 4; y++) pixel(data, o, x, y, light);
      for (let x = 1; x < 7; x++)
        for (let y = 8; y < 10; y++) pixel(data, o, x, y, color, 0.85);
      for (let x = 1; x < 7; x++)
        for (let y = 0; y < 3; y++)
          pixel(data, L.body.overlay.back, x, y, color, 0.88);
    } else if (style === "knit") {
      for (const face of ["front", "back"] as const)
        for (let x = 1; x < 7; x += 2)
          for (let y = 2; y < 11; y++)
            pixel(data, L.body.base[face], x, y, color, 0.92);
    } else {
      for (const x of [2, 3, 4, 5]) pixel(data, o, x, 4, light);
    }
  } else {
    for (const part of VARIATION_PARTS.lower) {
      const back = L[part].overlay.back;
      for (const x of [1, 2])
        for (const y of [2, 3]) pixel(data, back, x, y, color, 0.86);
    }
  }
  return data;
}

/** Local curated alternatives, not additional AI generations. Immutable per-session candidates. */
export function createSkinVariations(
  original: Uint8ClampedArray,
  current: Uint8ClampedArray,
): Record<VariationRegion, SkinVariation[]> {
  check(original);
  check(current);
  const skin = colorAt(
    original,
    L.head.base.front,
    [
      [1, 4],
      [6, 4],
      [1, 5],
      [6, 5],
    ],
    hex("#dfb798"),
  );
  const hairColor = colorAt(
    original,
    L.head.base.top,
    [
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ],
    hex("#302b28"),
  );
  const initial = (): SkinVariation[] => [
    {
      id: "current",
      label: "현재 모습",
      pixels: new Uint8ClampedArray(current),
    },
    {
      id: "original",
      label: "생성 원본",
      pixels: new Uint8ClampedArray(original),
    },
  ];
  return {
    head: [
      ...initial(),
      ...(
        [
          ["crop", "숏 크롭"],
          ["part", "가르마"],
          ["soft", "소프트 프린지"],
          ["beanie", "세이지 비니"],
        ] as const
      ).map(([id, label]) => ({
        id,
        label,
        pixels: hair(current, id, skin, hairColor),
      })),
    ],
    upper: [
      ...initial(),
      ...(
        [
          ["knit", "크림 니트", "#ccbea1"],
          ["hoodie", "세이지 후디", "#667e60"],
          ["jacket", "차콜 재킷", "#3c4544"],
          ["tee", "화이트 티", "#dcded3"],
        ] as const
      ).map(([id, label, color]) => ({
        id,
        label,
        pixels: outfit(original, "upper", id, hex(color), skin),
      })),
    ],
    lower: [
      ...initial(),
      ...(
        [
          ["denim", "인디고 데님", "#3f5872"],
          ["dark", "차콜 팬츠", "#414745"],
          ["sand", "샌드 팬츠", "#a79878"],
          ["shorts", "탐험가 쇼츠", "#667553"],
        ] as const
      ).map(([id, label, color]) => ({
        id,
        label,
        pixels: outfit(original, "lower", id, hex(color), skin),
      })),
    ],
  };
}
