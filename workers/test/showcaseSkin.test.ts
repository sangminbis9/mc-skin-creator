import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createShowcaseSkin } from "../../shared/showcaseSkin";
import { ALL_PARTS, SLIM_LAYOUT, buildZoneMap } from "../../shared/skinLayout";
import { convertClassicRgbaToSlim } from "../../src/lib/slimSkin";
import { decodePng } from "../src/png";

it("authors the female lace example only inside standard 64x64 Minecraft UVs", () => {
  const pixels = createShowcaseSkin(),
    zones = buildZoneMap();
  expect(pixels.length).toBe(64 * 64 * 4);
  let outerPixels = 0,
    clearOuterPixels = 0;
  zones.forEach((zone, i) => {
    const alpha = pixels[i * 4 + 3];
    if (zone === "base") expect(alpha).toBe(255);
    if (zone === "outside")
      expect([...pixels.slice(i * 4, i * 4 + 4)]).toEqual([0, 0, 0, 0]);
    if (zone === "overlay") {
      expect([0, 255]).toContain(alpha);
      if (alpha) outerPixels++;
      else clearOuterPixels++;
    }
  });
  expect(outerPixels).toBeGreaterThan(100);
  expect(clearOuterPixels).toBeGreaterThan(100);
});

it("ships a real 64x64 PNG identical to the authored skin, not a generated illustration", async () => {
  const atlas = await decodePng(
    new Uint8Array(
      readFileSync("../public/images/woman-lace-skin-v2-slim-64.png"),
    ),
  );
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  expect(atlas.rgba).toEqual(
    new Uint8Array(convertClassicRgbaToSlim(createShowcaseSkin())),
  );
});

it("exports legal three-pixel slim arms with opaque bases and no out-of-net texels", () => {
  const pixels = convertClassicRgbaToSlim(createShowcaseSkin());
  const zones = new Uint8Array(4096);
  for (const part of ALL_PARTS)
    for (const layer of ["base", "overlay"] as const)
      for (const r of Object.values(SLIM_LAYOUT[part][layer]))
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++)
            zones[(r.y + y) * 64 + r.x + x] = layer === "base" ? 1 : 2;
  for (let i = 0; i < zones.length; i++) {
    if (zones[i] === 1) expect(pixels[i * 4 + 3]).toBe(255);
    if (zones[i] === 0)
      expect([...pixels.slice(i * 4, i * 4 + 4)]).toEqual([0, 0, 0, 0]);
    expect([0, 255]).toContain(pixels[i * 4 + 3]);
  }
  expect(SLIM_LAYOUT.leftArm.base.front.w).toBe(3);
});
