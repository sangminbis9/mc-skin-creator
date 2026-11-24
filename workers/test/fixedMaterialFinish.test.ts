import { expect, it } from "vitest";
import { paintFootwearBase, paintFootwearRelief } from "../../shared/footwearFinish";
import { fixedHairMaterialPoint, fixedHairTone, photoMaterialRamp, type MaterialRgb } from "../src/fixedMaterialPalette";
import { refineFixedFootwear } from "../src/fixedFootwearFinish";
import { applyNameMcHead, nameMcHairMask, MATERIAL_NAMEMC_HEAD_FINISH, PREVIOUS_NAMEMC_HEAD_FINISH } from "../src/namemcHeadTemplate";
import { DEFAULT_FACE_STYLE } from "../src/skinPack";
import { buildSkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const at = (r: Rect, x: number, y: number) => ((r.y + y) * 64 + r.x + x) * 4;
const raster = () => ({ width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) });

it("uses five ordered steps anchored to the source dye, with headroom for black and light hair", () => {
  for (const pigment of [[27, 27, 27], [68, 39, 33], [215, 182, 141], [237, 236, 231]] as MaterialRgb[]) {
    const ramp = photoMaterialRamp(pigment, "hair");
    expect(ramp[2]).toEqual(pigment);
    const values = ramp.map(([r, g, b]) => .2126 * r + .7152 * g + .0722 * b);
    expect(values.every((v, i) => i === 0 || v > values[i - 1])).toBe(true);
    expect(values[4] - values[0]).toBeGreaterThan(22);
    expect(values[4] - values[0]).toBeLessThan(50);
    expect(ramp[0][0] - ramp[0][2]).toBeLessThan(pigment[0] - pigment[2]);
  }
});

it("shares the same hair lighting point across physical head and torso side seams", () => {
  const style = { ...DEFAULT_FACE_STYLE, hairPart: "left", hairTexture: "wavy" } as const;
  for (const part of ["head", "body"] as const) {
    const box = CLASSIC_LAYOUT[part].base;
    const locate = (p: {x: number; y: number}) => {
      const [f, r] = Object.entries(box).find(([, r]) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h)!;
      return fixedHairMaterialPoint(part, f as keyof BoxUV, p.x - r.x, p.y - r.y);
    };
    const seams = getBoxUvSeams(box);
    for (const seam of [...seams.vertical, ...seams.horizontal.slice(0, 4)]) for (const [i, p] of seam.primary.entries()) {
      const q = seam.adjacent[i];
      expect(locate(p)).toEqual(locate(q));
      expect(fixedHairTone(locate(p), style, true)).toBe(fixedHairTone(locate(q), style, true));
    }
  }
  for (let x = 0; x < 8; x++) expect(fixedHairMaterialPoint("head", "front", x, 7)).toEqual(fixedHairMaterialPoint("body", "front", x, 0));
});

it("only changes previously authored hair RGB and leaves fixed eyes, skin, alpha and other areas byte-identical", () => {
  const image = raster(), plan = buildSkinPlan(makeAnalysis());
  const style = { ...DEFAULT_FACE_STYLE, hairColor: "#1b1b1b", hairPart: "left", hairTexture: "wavy" } as const;
  const before = applyNameMcHead(image, image, plan, style, "source", PREVIOUS_NAMEMC_HEAD_FINISH);
  const after = applyNameMcHead(image, image, plan, style, "source", MATERIAL_NAMEMC_HEAD_FINISH);
  const mask = Uint8Array.from(atob(nameMcHairMask(style, [], MATERIAL_NAMEMC_HEAD_FINISH)), c => c.charCodeAt(0));
  let changed = 0;
  for (let pixel = 0; pixel < 4096; pixel++) {
    const i = pixel * 4;
    expect(after.rgba[i + 3]).toBe(before.rgba[i + 3]);
    const differs = after.rgba.subarray(i, i + 3).some((v, c) => v !== before.rgba[i + c]);
    if (!differs) continue;
    expect(Boolean(mask[pixel >> 3] & (1 << (pixel % 8)))).toBe(true);
    changed++;
  }
  expect(changed).toBeGreaterThan(150);
});

it.each([2, 3])("changes a %i-row shoe, but never the pants, an accessory, or transparency", shoeRows => {
  const plan = buildSkinPlan(makeAnalysis()).outfitPlan.lower;
  const pigment = [34, 32, 30] as const, start = 12 - shoeRows;
  const lower = { ...plan, shoeRows, garmentRows: start, shoeColor: "#22201e", shoeStyle: "sneakers" } as const;
  const atlas = raster(), r = CLASSIC_LAYOUT.rightLeg;
  paintFootwearBase(atlas.rgba, r.base, pigment, start, "sneakers");
  // The other shoe has no raised relief: RGB finishing cannot create it.
  paintFootwearRelief(atlas.rgba, r.overlay, pigment, start);
  paintFootwearBase(atlas.rgba, CLASSIC_LAYOUT.leftLeg.base, pigment, start, "sneakers");
  const protectedDecoration = at(r.base.front, 2, 10), pants = at(r.base.front, 1, start - 1);
  atlas.rgba.set([153, 31, 90, 255], protectedDecoration);
  atlas.rgba.set([8, 78, 101, 255], pants);
  const previous = atlas.rgba.slice();
  expect(refineFixedFootwear(atlas, lower)).toBeGreaterThan(16);
  expect(atlas.rgba[at(r.base.front, 1, 10)] - atlas.rgba[at(r.base.front, 1, 11)]).toBeGreaterThan(25);
  for (let i = 3; i < atlas.rgba.length; i += 4) expect(atlas.rgba[i]).toBe(previous[i]);
  for (const i of [protectedDecoration, pants]) expect(atlas.rgba.slice(i, i + 4)).toEqual(previous.slice(i, i + 4));
  expect(refineFixedFootwear(atlas, { ...lower, shoeStyle: "sandals" })).toBe(0);
});
