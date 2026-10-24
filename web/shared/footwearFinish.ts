import type { BoxUV } from "./skinLayout";
type Color = readonly [number, number, number];
type Pixels = Uint8Array | Uint8ClampedArray;
export type ShoeStyle =
  "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals";
const at = (x: number, y: number) => (y * 64 + x) * 4;
const tone = (c: Color, factor: number, lift = 0) =>
  c.map((v) => Math.max(0, Math.min(255, Math.round(v * factor + lift))));

/** Material-local toe/heel/sole planes. Never extends the observed shoe interval. */
export function paintFootwearBase(
  data: Pixels,
  box: BoxUV,
  color: Color,
  start: number,
  style?: ShoeStyle,
) {
  if (start >= 12) return;
  start = Math.max(0, Math.floor(start));
  const sole = tone(color, 0.72, 4);
  for (const face of ["front", "right", "left", "back"] as const) {
    const r = box[face];
    for (let y = start; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const edge = x === 0 || x === r.w - 1;
        let c = y === r.h - 1 ? sole : tone(color, 0.9);
        if (!edge && y < r.h - 1) {
          if (face === "front")
            c = tone(color, y === r.h - 2 ? 1 : 0.86, y === r.h - 2 ? 10 : 2);
          else c = tone(color, face === "back" ? 0.8 : 0.85, 3);
          // Laces exist only when a shoe has room for a separate upper and toe.
          if (
            style === "sneakers" &&
            face === "front" &&
            y === start &&
            start < r.h - 2
          )
            c = tone(color, 0.75, 38);
        }
        data.set([...c, 255], at(r.x + x, r.y + y));
      }
  }
  const r = box.bottom;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++)
      data.set([...sole, 255], at(r.x + x, r.y + y));
}

/** Two connected toe cells, not a full inflated shoe/sole box or random side dots. */
export function paintFootwearRelief(
  data: Pixels,
  box: BoxUV,
  color: Color,
  start: number,
  clearExisting = false,
) {
  if (start >= 11) return;
  if (clearExisting)
    for (const face of ["front", "right", "left", "back", "bottom"] as const) {
      const r = box[face];
      for (let y = face === "bottom" ? 0 : start; y < r.h; y++)
        for (let x = 0; x < r.w; x++)
          data.fill(0, at(r.x + x, r.y + y), at(r.x + x, r.y + y) + 4);
    }
  for (const x of [1, 2])
    data.set(
      [...tone(color, 1, 8), 255],
      at(box.front.x + x, box.front.y + 10),
    );
}
