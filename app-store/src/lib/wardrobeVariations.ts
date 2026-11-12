import {
  CLASSIC_LAYOUT as L,
  type BodyPart,
  type BoxUV,
  type Rect,
} from "../../shared/skinLayout";
import {
  paintFootwearBase,
  paintFootwearRelief,
} from "../../shared/footwearFinish";
type Color = [number, number, number];
export interface WardrobeStyle {
  id: string;
  label: string;
  color: string;
  description: string;
}
const styles = (rows: string[][]): WardrobeStyle[] =>
  rows.map(([id, label, color, description]) => ({
    id,
    label,
    color,
    description,
  }));
export const TOP_STYLES = styles([
  ["knit", "Cream knit", "#ccbea1", "Ribbed texture and a raised neckline"],
  ["hoodie", "Sage hoodie", "#667e60", "Hood, drawstrings and a raised pocket"],
  ["jacket", "Charcoal jacket", "#3c4544", "Layered collar and front pockets"],
  ["tee", "White tee", "#dcded3", "Short sleeves and a chest stripe"],
  ["denim-jacket", "Denim jacket", "#476680", "Chest pockets, buttons and stitching"],
  ["flannel", "Flannel shirt", "#995346", "Plaid across the front, back and sleeves"],
  ["varsity", "Varsity jacket", "#763e45", "Cream sleeves and a chest patch"],
  ["fisherman", "Cable knit", "#45566a", "Cable texture and ribbed hem"],
  ["cardigan", "Sand cardigan", "#a28a65", "V-neck and wooden buttons"],
  ["field", "Field jacket", "#666b45", "Layered flaps and utility pockets"],
]);
export const BOTTOM_STYLES = styles([
  ["denim", "Indigo denim", "#3f5872", "Washed denim and light sneakers"],
  ["dark", "Charcoal pants", "#414745", "Subtle shading and dark loafers"],
  ["sand", "Sand pants", "#a79878", "Rolled hems and rear pockets"],
  ["shorts", "Explorer shorts", "#667553", "Above-knee shorts and socks"],
  ["cargo", "Olive cargo", "#69704b", "Raised cargo pockets"],
  ["jogger", "Grey joggers", "#707577", "Cuffed ankles and sneakers"],
  ["chinos", "Caramel chinos", "#a37b4d", "Front pleats and brown shoes"],
  ["denim-shorts", "Denim shorts", "#65859a", "Washed denim and rolled hems"],
  ["pleated", "Pleated skirt", "#515263", "Outer-layer pleats and tall socks"],
  ["boots", "Workwear + boots", "#81715a", "Utility pockets and tall boots"],
]);
const SIDES = ["front", "back", "left", "right"] as const;
const hex = (v: string): Color =>
  [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as Color;
function each(r: Rect, fn: (x: number, y: number, i: number) => void) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) fn(x, y, ((r.y + y) * 64 + r.x + x) * 4);
}
function pixel(
  data: Uint8ClampedArray,
  r: Rect,
  x: number,
  y: number,
  c: Color,
  shade = 1,
) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h)
    throw new Error("Out of face bounds");
  data.set(
    [...c.map((v) => Math.round(v * shade)), 255],
    ((r.y + y) * 64 + r.x + x) * 4,
  );
}

export function makeWardrobe(
  source: Uint8ClampedArray,
  region: "upper" | "lower",
  preset: WardrobeStyle,
  skin: Color,
) {
  const data = new Uint8ClampedArray(source),
    style = preset.id,
    color = hex(preset.color);
  const parts: BodyPart[] =
    region === "upper"
      ? ["body", "rightArm", "leftArm"]
      : ["rightLeg", "leftLeg"];
  const light = hex("#e4dfcf");
  const shoes = ["denim", "shorts", "denim-shorts", "jogger"].includes(style)
    ? light
    : style === "chinos"
      ? hex("#594636")
      : hex("#252b29");
  const short = ["shorts", "denim-shorts", "pleated"].includes(style),
    boot = style === "boots";
  for (const part of parts) {
    for (const r of Object.values(L[part].overlay))
      each(r, (_x, _y, i) => data.fill(0, i, i + 4));
    const arm = part === "leftArm" || part === "rightArm";
    const cutoff =
      region === "lower"
        ? short
          ? 6
          : boot
            ? 8
            : 10
        : arm
          ? style === "tee"
            ? 5
            : 10
          : 12;
    const fabric = style === "varsity" && arm ? light : color;
    for (const face of Object.keys(L[part].base) as (keyof BoxUV)[]) {
      const r = L[part].base[face];
      each(r, (x, y) => {
        const level = face === "top" ? 0 : face === "bottom" ? 11 : y;
        let c = level < cutoff ? fabric : skin;
        if (region === "lower" && level >= (boot ? 8 : 10)) c = shoes;
        if (region === "lower" && short && level >= 8 && level < 10) c = light;
        const interior = x > 0 && x < r.w - 1;
        // Broad folds; adjacent vertical faces share the same edge shades.
        let shade =
          face === "bottom"
            ? 0.78
            : 1 -
              level * 0.008 +
              (interior && level > 1 && level < cutoff - 1
                ? Math.cos((x + y * 0.2) * 1.7) * 0.045
                : 0);
        if (style === "flannel" && level < cutoff)
          shade *=
            (y % 4 === 2 ? 0.76 : 1) * (interior && x % 3 === 1 ? 0.78 : 1);
        pixel(data, r, x, y, c, shade);
      });
    }
    for (const face of SIDES) {
      const r = L[part].overlay[face];
      const hem = region === "upper" ? (arm ? cutoff - 1 : 11) : cutoff - 1;
      for (let x = 0; x < r.w; x++) pixel(data, r, x, hem, color, 0.82);
      if (region === "lower")
        for (let x = 0; x < r.w; x++) pixel(data, r, x, 11, shoes, 0.72);
      if (style === "varsity" && arm)
        for (let x = 0; x < r.w; x++) pixel(data, r, x, 8, color);
    }
  }
  if (region === "upper") {
    const b = L.body.base.front,
      o = L.body.overlay.front;
    pixel(data, b, 3, 0, skin);
    pixel(data, b, 4, 0, skin);
    if (
      ["jacket", "denim-jacket", "cardigan", "field", "varsity"].includes(style)
    ) {
      for (let y = 1; y < 12; y++)
        for (const x of [3, 4]) pixel(data, b, x, y, light, 0.93);
      for (const x of [2, 5])
        for (let y = 0; y < 4; y++) pixel(data, o, x, y, color, 1.15);
      for (const x0 of [1, 5])
        for (let x = x0; x < x0 + 2; x++)
          for (let y = 7; y < 10; y++)
            pixel(data, o, x, y, color, y === 7 ? 1.12 : 0.82);
      if (style === "denim-jacket" || style === "field") {
        for (const x of [1, 6])
          for (let y = 2; y < 5; y++)
            pixel(data, o, x, y, color, y === 2 ? 1.2 : 0.8);
        for (const x of [2, 5]) pixel(data, o, x, 3, light, 0.75);
      }
      if (style === "cardigan") {
        for (const y of [4, 7, 10]) pixel(data, o, 4, y, hex("#695135"));
        for (const x of [2, 5]) pixel(data, o, x, 0, light);
      }
      if (style === "varsity")
        for (const [x, y] of [
          [1, 2],
          [1, 3],
          [1, 4],
          [2, 4],
        ])
          pixel(data, o, x, y, light);
    } else if (style === "hoodie") {
      for (const x of [2, 5])
        for (let y = 1; y < 4; y++) pixel(data, o, x, y, light);
      for (let x = 1; x < 7; x++)
        for (let y = 8; y < 10; y++) pixel(data, o, x, y, color, 0.82);
      for (let x = 1; x < 7; x++)
        for (let y = 0; y < 3; y++)
          pixel(data, L.body.overlay.back, x, y, color, y === 2 ? 0.75 : 0.91);
    } else if (style === "knit" || style === "fisherman") {
      for (const face of ["front", "back"] as const) {
        for (let x = 1; x < 7; x += 2)
          for (let y = 2; y < 11; y++)
            pixel(
              data,
              L.body.base[face],
              x,
              y,
              color,
              style === "fisherman" ? (y % 4 < 2 ? 1.2 : 0.8) : 0.9,
            );
        for (const x of [2, 3, 4, 5])
          pixel(data, L.body.overlay[face], x, 0, color, 0.78);
      }
    } else if (style === "flannel") {
      for (const y of [2, 5, 8, 11]) pixel(data, o, 4, y, light, 0.8);
      for (const x of [2, 5]) pixel(data, o, x, 0, color, 1.2);
    } else {
      for (const x of [2, 3, 4, 5]) pixel(data, o, x, 4, hex("#4e6555"));
    }
  } else {
    for (const part of parts) {
      const base = L[part].base,
        over = L[part].overlay;
      for (const x of [1, 2])
        for (const y of [2, 3])
          pixel(data, over.back, x, y, color, y === 2 ? 1.12 : 0.8);
      for (const face of SIDES) {
        for (let x = 0; x < 4; x++) pixel(data, base[face], x, 0, color, 0.72);
        if (style === "pleated")
          for (let y = 0; y < 6; y++)
            for (let x = 0; x < 4; x++)
              pixel(
                data,
                over[face],
                x,
                y,
                color,
                x === 1 || x === 2 ? 0.78 : 1.05,
              );
        if (style === "jogger")
          for (let x = 0; x < 4; x++)
            for (const y of [8, 9]) pixel(data, over[face], x, y, color, 0.7);
      }
      if (["cargo", "boots"].includes(style)) {
        const outer = part === "rightLeg" ? "right" : "left";
        for (let x = 1; x < 3; x++)
          for (let y = 4; y < 7; y++)
            pixel(data, over[outer], x, y, color, y === 4 ? 1.18 : 0.8);
      }
      for (let y = 2; y < (short ? 5 : boot ? 8 : 10); y++) {
        pixel(data, base.front, part === "rightLeg" ? 2 : 1, y, color, 0.82);
        if (["denim", "denim-shorts"].includes(style))
          pixel(data, base.front, part === "rightLeg" ? 1 : 2, y, color, 1.16);
        if (style === "chinos") pixel(data, base.front, 2, y, color, 1.12);
      }
      const shoeStart = boot ? 8 : 10;
      paintFootwearBase(
        data,
        base,
        shoes,
        shoeStart,
        boot
          ? "boots"
          : ["denim", "shorts", "denim-shorts", "jogger"].includes(style)
            ? "sneakers"
            : "loafers",
      );
      paintFootwearRelief(data, over, shoes, shoeStart, true);
    }
  }
  return data;
}
