import { expect, it } from "vitest";
import { readAppearanceDetail } from "../src/appearanceDetail";
import { applyObservedBeanie, nameMcHairMask, NAMEMC_EYES } from "../src/namemcHeadTemplate";
import { PUBLIC_LEGWEAR_POLICY } from "../src/outfitIdentity";
import { buildPhotoDrape } from "../src/photoHairFinish";
import { DEFAULT_FACE_STYLE } from "../src/skinPack";
import { buildSkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

function sample(detail: unknown) {
  const base = makeAnalysis();
  const clothing = "A multicolor top. Pink plaid mini skirt. White tall socks. White shoes.";
  return { ...base, observed: { ...base.observed, clothing, hair: "Long wavy hair.", accessories: "None." },
    outfitPrompt: clothing, visibleRegions: { ...base.visibleRegions, upperBody: true, lowerBody: true, feet: true },
    appearanceDetail: readAppearanceDetail(detail) };
}

it("keeps left/right front locks independent, connected, and away from the opposite side", () => {
  const a = sample({ frontHairLeft: "chest", frontHairRight: "not_in_front", frontHairTexture: "wavy" });
  const style = { ...DEFAULT_FACE_STYLE, hairstyle: "long", overallHairLength: "chest" } as const;
  const p = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY);
  const f = buildPhotoDrape(p, a, style, true).filter(c => c.face === "front");
  expect(f.some(c => c.y === 7)).toBe(true);
  expect(f.some(c => c.layer === "overlay" && c.x === 2)).toBe(true);
  expect(f.every(c => c.x <= 2)).toBe(true);
  expect(buildPhotoDrape(p, { ...a, visibleRegions: { ...a.visibleRegions, upperBody: false } }, style, true).some(c => c.face === "front")).toBe(false);
});

it("does not grow jaw-length hair over the torso from a contradictory front lock label", () => {
  const a = sample({ frontHairLeft: "shoulder", frontHairRight: "chest", templeLeft: "at_ear", templeRight: "jaw" });
  a.observed.hair = "Tousled hair around the ears, with a fuller nape behind the neck.";
  const p = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY);
  const short = { ...DEFAULT_FACE_STYLE, hairstyle: "medium", overallHairLength: "jaw" } as const;
  expect(buildPhotoDrape(p, a, short, true)).toEqual([]);
  expect(buildPhotoDrape(p, a, { ...short, overallHairLength: "shoulder" }, true)).toEqual([]);
  a.appearanceDetail = readAppearanceDetail({ frontHairLeft: "shoulder", templeLeft: "at_ear" });
  a.observed.hair = "Short tousled hair. Hair on the viewer-left lies over the top at the shoulder.";
  expect(buildPhotoDrape(p, a, short, true)).toEqual([]);
  a.appearanceDetail = readAppearanceDetail({ frontHairLeft: "chest", templeLeft: "at_ear" });
  a.observed.hair = "An ear-length cut with one separate braid. A braid from behind the ear on the viewer-left lies over the shirt to the chest.";
  expect(buildPhotoDrape(p, a, short, true).some(c => c.face === "front" && c.y === 7)).toBe(true);
});

it("preserves an ear-tucked lock to the chest without adding one on the rear-only side", () => {
  const a = sample({ frontHairLeft: "chest", frontHairRight: "not_in_front", templeLeft: "at_ear", templeRight: "at_ear", frontHairTexture: "wavy" });
  a.observed.hair = "Long wavy hair. The viewer-left temple is tucked behind the ear.";
  a.inferred.hairBack = { ...a.inferred.hairBack, value: "Long wavy hair at the back" };
  const p = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY);
  const style = { ...DEFAULT_FACE_STYLE, hairstyle: "long", overallHairLength: "chest", hairBackShape: "long" } as const;
  const cells = buildPhotoDrape(p, a, style, true);
  expect(cells.some(c => c.face === "back")).toBe(true);
  const f = cells.filter(c => c.face === "front");
  expect(f.every(c => c.x <= 2)).toBe(true);
  expect(f.some(c => c.y === 7)).toBe(true);
  expect(f.some(c => c.layer === "overlay" && c.x === 2)).toBe(true);
  const shoulder = buildPhotoDrape(p, a, { ...style, overallHairLength: "shoulder" }, true).filter(c => c.face === "front");
  expect(shoulder).toEqual(f); // Overall length is not the visible lock endpoint.
});

it("uses an observed braid crossing the garment in a crop without guessing the other side", () => {
  const a = sample({ frontHairLeft: "unknown", frontHairRight: "unknown", templeRight: "at_ear" });
  a.visibleRegions.upperBody = false;
  a.observed.hair = "A braid from behind the ear on the viewer-right lies over the jacket to the chest. On the viewer-left it stays behind the shoulder.";
  const style = { ...DEFAULT_FACE_STYLE, hairstyle: "ponytail", overallHairLength: "jaw" } as const;
  const p = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY);
  const f = buildPhotoDrape(p, a, style, true).filter(c => c.face === "front");
  expect(f.some(c => c.y === 7)).toBe(true);
  expect(f.every(c => c.x >= 6)).toBe(true);
  a.observed.hair = "Long braids lie behind the shoulders, not over the chest.";
  expect(buildPhotoDrape(p, a, style, true)).toEqual([]);
});

it("uses only the visible garment swatches and separates tall sock heights without losing skin", () => {
  const a = sample({ upperPattern: "torso_blocks", upperPalette: ["#D4A8DA", "#A7BDE9", "#fee2b3"],
    leftSleeveColor: "#a7bde9", skirtBase: "#cba9b0", skirtCheck: "#e5cfd1", sockTop: "above_knee" });
  const taller = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY).outfitPlan;
  expect(taller.upper.pattern).toMatchObject({ construction: "pixel_blocks", surfaceParts: ["body"], blockColors: ["#d4a8da", "#a7bde9", "#fee2b3"] });
  expect(taller.upper.rightSleeve.color).toBe("#a7bde9");
  expect(taller.lower).toMatchObject({ baseColor: "#cba9b0", pattern: { color: "#e5cfd1" }, legwear: { startRow: 5 }, skinExposureRows: 2 });
  const atKnee = buildSkinPlan({ ...a, appearanceDetail: { ...a.appearanceDetail!, sockTop: "at_knee" } }, PUBLIC_LEGWEAR_POLICY).outfitPlan;
  expect(atKnee.lower).toMatchObject({ legwear: { startRow: 6 }, skinExposureRows: 3 });
  expect(readAppearanceDetail({ beanieBase: "red", upperPalette: ["#00aaff", "bad"], frontHairLeft: "uncertain" }))
    .toMatchObject({ beanieBase: "", upperPalette: ["#00aaff"], frontHairLeft: "unknown" });
});

it("paints a visible hat and cuff colors without altering eye pixels or reserving hat areas as editable hair", () => {
  const a = sample({ beanie: "ear_beanie", beanieBase: "#76cddd", beanieTrim: ["#eeb5ce", "#a7add8"] });
  const img = { width: 64, height: 64, rgba: new Uint8Array(16384).fill(111) };
  applyObservedBeanie(img, DEFAULT_FACE_STYLE, a.appearanceDetail);
  const top = CLASSIC_LAYOUT.head.overlay.top, front = CLASSIC_LAYOUT.head.base.front;
  expect(img.rgba[((top.y + 6) * 64 + top.x + 1) * 4 + 3]).toBe(255);
  expect([...img.rgba.subarray(((front.y + 2) * 64 + front.x + 1) * 4, ((front.y + 2) * 64 + front.x + 1) * 4 + 3)]).toEqual([238, 181, 206]);
  for (const p of NAMEMC_EYES) expect(img.rgba[((front.y + p.y) * 64 + front.x + p.x) * 4]).toBe(111);
  expect(nameMcHairMask(DEFAULT_FACE_STYLE, [], undefined, undefined, a.appearanceDetail)).not.toBe(nameMcHairMask(DEFAULT_FACE_STYLE));
});
