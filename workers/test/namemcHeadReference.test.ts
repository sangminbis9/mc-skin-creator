import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { renderSkinInspectionView } from "../src/skinRender";
import { applyNameMcHead, nameMcHairMask, DRAPE_NAMEMC_HEAD_FINISH, NAMEMC_EYES, NAMEMC_HEAD_HAIR, usesNameMcHead } from "../src/namemcHeadTemplate";
import { CLASSIC_LAYOUT, type BoxUV, type Rect } from "../src/uvLayout";
import type { PhotoDrapeCell } from "../src/photoHairFinish";
import { composeGlassesOverlay, DEFAULT_FACE_STYLE } from "../src/skinPack";
import { buildSkinPlan } from "../src/skinPlan";
import { applyCoveredHeadFinish } from "../src/coveredHeadFinish";
import { headwearVisibleLandmarks } from "../src/headwearFootprint";
import { buildHeadwearPaint } from "../../shared/headwear";
import { makeAnalysis } from "./helpers";
import { createSkinVariations as appVariations } from "../../src/lib/skinVariations";
import { createSkinVariations as webVariations } from "../../web/src/lib/skinVariations";

const at = (r: Rect, x: number, y: number) => ((r.y + y) * 64 + r.x + x) * 4;
const head = CLASSIC_LAYOUT.head, torso = CLASSIC_LAYOUT.body;
const fixture = () => {
  const input = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  for (const part of Object.values(CLASSIC_LAYOUT)) for (const r of Object.values(part.base)) {
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) input.rgba.set([125, 33, 77, 255], at(r, x, y));
  }
  const analysis = makeAnalysis();
  analysis.fallbackFeatures.glasses = "none";
  analysis.fallbackFeatures.earrings = false;
  analysis.observed.accessories = "none";
  const plan = buildSkinPlan(analysis);
  const style = { ...DEFAULT_FACE_STYLE, hat: "none", glasses: "none", facialHair: "none" } as const;
  return { input, plan, style };
};

it("keeps exact base and relief hair positions, and two visible 2x2 eyes, across different source cues", () => {
  const { input, plan, style } = fixture();
  const a = { ...style, hairColor: "#332620", eyeColor: "#553824", hairPart: "left", hairTexture: "wavy" } as const;
  const b = { ...style, hairColor: "#8b6456", eyeColor: "#37675b", hairPart: "right", hairTexture: "straight" } as const;
  expect(nameMcHairMask(a, [], DRAPE_NAMEMC_HEAD_FINISH)).toBe(nameMcHairMask(b, [], DRAPE_NAMEMC_HEAD_FINISH));
  for (const s of [a, b]) {
    const rendered = applyNameMcHead(input, input, plan, s, "source", DRAPE_NAMEMC_HEAD_FINISH).rgba;
    const mask = Uint8Array.from(atob(nameMcHairMask(s, [], DRAPE_NAMEMC_HEAD_FINISH)), c => c.charCodeAt(0));
    for (const face of Object.keys(head.base) as (keyof BoxUV)[]) for (const layer of ["base", "overlay"] as const) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = at(head[layer][face], x, y), isHair = NAMEMC_HEAD_HAIR[layer][face][y][x] === "#";
        expect(Boolean(mask[(i / 4) >> 3] & (1 << (i / 4 % 8)))).toBe(isHair);
        expect(rendered[i + 3]).toBe(layer === "base" || isHair ? 255 : 0);
      }
    }
    for (const e of NAMEMC_EYES) {
      expect(rendered[at(head.overlay.front, e.x, e.y) + 3]).toBe(0);
      expect(rendered[at(head.base.front, e.x, e.y)] > 180).toBe(e.role.startsWith("sclera"));
    }
    expect(rendered[at(head.base.front, 3, 7)]).toBe(rendered[at(head.base.front, 4, 7)]);
    expect(rendered[at(torso.base.front, 3, 7)]).toBe(125); // new hair never repaints the garment center
  }
  expect(usesNameMcHead(plan, { ...style, hat: "headscarf" })).toBe(false);
  expect(usesNameMcHead(plan, { ...style, hat: "full_helmet" })).toBe(false);
});

it.each([appVariations, webVariations])("keeps app and standalone web wardrobe geometry fixed", build => {
  const { input, plan, style } = fixture();
  const drape: PhotoDrapeCell[] = Array.from({length: 8}, (_, y) => ({ face: "front", layer: "base", x: 1, y, tone: 2 }));
  drape.push({ face: "front", layer: "overlay", x: 1, y: 7, tone: 3 });
  const mask = nameMcHairMask(style, drape, DRAPE_NAMEMC_HEAD_FINISH);
  const baseline = new Uint8ClampedArray(applyNameMcHead(input, input, plan, style, "source", DRAPE_NAMEMC_HEAD_FINISH, drape).rgba);
  const variants = build(baseline, baseline, { fixedHairMask: mask });
  expect(variants.head.filter(v => v.id.startsWith("fixed-")).length).toBe(4);
  const fringe = at(head.overlay.front, 3, 2), eye = at(head.base.front, 2, 6);
  for (const v of variants.head.filter(v => v.id.startsWith("fixed-"))) {
    expect(v.pixels[fringe]).not.toBe(baseline[fringe]);
    expect(v.pixels.slice(eye, eye + 4)).toEqual(baseline.slice(eye, eye + 4));
    for (let i = 3; i < baseline.length; i += 4) expect(v.pixels[i]).toBe(baseline[i]);
  }
  const lock = at(torso.base.front, 1, 7), relief = at(torso.overlay.front, 1, 7);
  for (const v of variants.upper) for (const i of [lock, relief]) {
    expect(v.pixels.slice(i, i + 4)).toEqual(baseline.slice(i, i + 4));
  }
});

it.each(["regular", "round", "sunglasses"] as const)("omits %s from the fixed head without changing eyes or hair", glasses => {
  const { input, plan, style } = fixture();
  const wearing = { ...style, glasses, glassesColor: "#ff00ff" };
  const legacy = { ...input, rgba: input.rgba.slice() };
  composeGlassesOverlay(legacy, wearing);
  expect(legacy.rgba).not.toEqual(input.rgba);
  const withoutGlasses = applyNameMcHead(input, input, plan, style);
  const fromGlassesPhoto = applyNameMcHead(legacy, input, plan, wearing);
  expect(fromGlassesPhoto.rgba).toEqual(withoutGlasses.rgba);
});

it("removes legacy rims and lenses on the covered path without touching the helmet's visor or base eyes", () => {
  const { input, plan, style } = fixture();
  const wearing = { ...style, hat: "full_helmet", hatVisor: "opaque", glasses: "sunglasses", glassesColor: "#ff00ff" } as const;
  const legacy = { ...input, rgba: input.rgba.slice() };
  composeGlassesOverlay(legacy, wearing);
  const visor = buildHeadwearPaint(wearing.hat, wearing.hatColor, wearing.hatVisor, headwearVisibleLandmarks(plan.facePixelPlan));
  for (const p of visor) legacy.rgba.set([...p.color, 255], at(head[p.layer][p.face], p.x, p.y));
  const out = applyCoveredHeadFinish(legacy, plan, wearing, "source");
  for (const p of visor) {
    const i = at(head[p.layer][p.face], p.x, p.y);
    expect(out.rgba.slice(i, i + 4)).toEqual(legacy.rgba.slice(i, i + 4));
  }
  const bridge = at(head.overlay.front, 3, 3), iris = at(head.base.front, 2, 5);
  expect(legacy.rgba[bridge + 3]).toBe(255);
  expect(out.rgba[bridge + 3]).toBe(0);
  expect(out.rgba.slice(iris, iris + 4)).toEqual(legacy.rgba.slice(iris, iris + 4));
});

const dir = process.env.NAMEMC_HEAD_REVIEW_DIR;
it.skipIf(!dir)("inspects the privately downloaded geometry reference from the front and both sides", async () => {
  const raw = await decodePng(await readFile(join(dir!, "namemc-6c13a4b6c3d74499-analysis.png")));
  for (const face of Object.keys(head.overlay) as (keyof BoxUV)[]) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = at(head.overlay[face], x, y);
      const ornament = face === "top" || ((face === "left" || face === "right") && y === 1)
        || (y === 3 && ((face === "left" && (x === 1 || x === 3)) || (face === "right" && (x === 4 || x === 6))));
      expect(NAMEMC_HEAD_HAIR.overlay[face][y][x] === "#").toBe(raw.rgba[i + 3] === 255 && !ornament);
      if (face === "bottom") expect(NAMEMC_HEAD_HAIR.base.bottom[y][x] === "#").toBe(raw.rgba[at(head.base.bottom, x, y)] < 50);
    }
  }
  for (const e of NAMEMC_EYES) {
    expect(raw.rgba[at(head.overlay.front, e.x, e.y) + 3]).toBe(0);
    expect(raw.rgba[at(head.base.front, e.x, e.y) + 1] > 175).toBe(e.role.startsWith("sclera"));
  }
  for (const yaw of [0, 40, -40, 165]) {
    await writeFile(join(dir!, `namemc-reference-inspect-${yaw}.png`), await encodePng(renderSkinInspectionView(raw, yaw, 8)));
  }
});
