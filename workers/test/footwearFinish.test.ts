import { describe, expect, it } from "vitest";
import { paintFootwearBase, paintFootwearRelief } from "../../shared/footwearFinish";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../../shared/skinLayout";

const color = [120, 110, 100] as const;
const offset = (x: number, y: number) => (y * 64 + x) * 4;
const pixel = (data: Uint8Array, p: { x: number; y: number }) =>
  [...data.slice(offset(p.x, p.y), offset(p.x, p.y) + 4)];

describe("connected footwear finish", () => {
  it.each([CLASSIC_LAYOUT.rightLeg, CLASSIC_LAYOUT.leftLeg])("shades the toe and sole without repainting trousers", (leg) => {
    const data = new Uint8Array(64 * 64 * 4).fill(123), before = data.slice();
    paintFootwearBase(data, leg.base, color, 9, "sneakers");
    const changed = new Set<number>();
    for (const [face, r] of Object.entries(leg.base)) {
      if (face === "top") continue;
      for (let y = face === "bottom" ? 0 : 9; y < r.h; y++)
        for (let x = 0; x < r.w; x++) changed.add(offset(r.x + x, r.y + y));
    }
    for (let i = 0; i < data.length; i += 4)
      if (!changed.has(i)) expect(data.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
    const seams = getBoxUvSeams(leg.base);
    for (const seam of seams.vertical) for (let y = 9; y < 12; y++)
      expect(pixel(data, seam.primary[y])).toEqual(pixel(data, seam.adjacent[y]));
    for (const seam of seams.horizontal.slice(4)) for (let i = 0; i < seam.primary.length; i++)
      expect(pixel(data, seam.primary[i])).toEqual(pixel(data, seam.adjacent[i]));
    const front = leg.base.front;
    expect(pixel(data, { x: front.x + 1, y: front.y + 10 })[0])
      .toBeGreaterThan(pixel(data, { x: front.x + 1, y: front.y + 11 })[0]);
  });

  it("replaces the inflated outer sole with two connected toe cells", () => {
    const data = new Uint8Array(64 * 64 * 4).fill(123);
    const box = CLASSIC_LAYOUT.rightLeg.overlay;
    const before = data.slice();
    paintFootwearRelief(data, box, color, 10, true);
    let visible = 0;
    for (const [face, r] of Object.entries(box)) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = offset(r.x + x, r.y + y);
        if (face !== "top" && (face === "bottom" || y >= 10)) {
          if (data[i + 3]) visible++;
        } else expect(data.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
      }
    }
    expect(visible).toBe(2);
    for (const x of [1, 2]) expect(data[offset(box.front.x + x, box.front.y + 10) + 3]).toBe(255);
  });

  it("does not invent shoes or relief when no shoe interval is available", () => {
    const data = new Uint8Array(64 * 64 * 4).fill(123), before = data.slice();
    paintFootwearBase(data, CLASSIC_LAYOUT.rightLeg.base, color, 12);
    paintFootwearRelief(data, CLASSIC_LAYOUT.rightLeg.overlay, color, 11, true);
    expect(data).toEqual(before);
  });
});
