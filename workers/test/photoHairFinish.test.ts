import { expect, it } from "vitest";
import { buildPhotoDrape, classifyPhotoHair, photoHairTone, type PhotoHairType } from "../src/photoHairFinish";
import { DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";

const base = { ...DEFAULT_FACE_STYLE, hairstyle: "short", hairTexture: "straight", hairStructure: "loose", hairPart: "none" } as const;

it("classifies eight distinct texture/structure families without demographics", () => {
  const fixtures: Record<PhotoHairType, Partial<FaceStyle>> = {
    compact: { hairstyle: "buzz" }, straight: {}, wavy: { hairTexture: "wavy" },
    curly: { hairTexture: "curly" }, coily: { hairTexture: "coily" },
    braided: { hairStructure: "braids" }, locs: { hairStructure: "locs" }, tied: { hairstyle: "ponytail" },
  };
  const textures = new Set<string>();
  for (const [expected, patch] of Object.entries(fixtures)) {
    const style = { ...base, ...patch }, p = classifyPhotoHair(style, "");
    expect(p.type).toBe(expected);
    textures.add(Array.from({ length: 384 }, (_, i) => photoHairTone([i % 8, Math.floor(i / 8) % 8, Math.floor(i / 64)], style, p, true)).join(""));
  }
  expect(textures.size).toBe(8);
});

it("distinguishes the source's part from the direction the strands fall", () => {
  const style = { ...base, bangs: "side", hairPart: "left" } as const;
  const right = classifyPhotoHair(style, "Visible part on the viewer-right, with hair sweeping toward the viewer-left.");
  expect(right).toMatchObject({ part: "right", sweep: "left" });
  const left = classifyPhotoHair(style, "Hair is parted on the viewer-left and sweeps toward the viewer-right.");
  expect(left).toMatchObject({ part: "left", sweep: "right" });
  const center = classifyPhotoHair(style, "A visible middle part.");
  const unparted = classifyPhotoHair({ ...style, hairPart: "none" }, "Visible gap between the bangs, but no visible scalp part.");
  expect(center.part).toBe("center");
  expect(unparted.part).toBe("none");
  const textured = classifyPhotoHair({ ...style, hairPart: "none", bangs: "straight", fringeEdge: "staggered" }, "Short, textured black hair.");
  expect(textured.fringe).toBe("textured");
  for (const [profile, dark, light] of [[left, 2, 5], [right, 5, 2], [center, 4, 2]] as const) {
    expect(photoHairTone([dark, 2, 0], style, profile, true)).toBe(0);
    expect(photoHairTone([light, 2, 0], style, profile, true)).toBeGreaterThan(0);
  }
});

it("requires visible placement and keeps front locks on the supported side and endpoint", () => {
  const a = makeAnalysis(); a.visibleRegions.hair = true;
  const plan = buildSkinPlan(a);
  const style = { ...base, hairstyle: "long", hairTexture: "wavy", overallHairLength: "waist", hairBackShape: "rounded" } as const;
  a.observed.hair = "The lock on the viewer-right hangs over the cardigan to the chest while the viewer-left side tucks behind the ear.";
  const right = buildPhotoDrape(plan, a, style);
  expect(right.length).toBeGreaterThan(8);
  expect(right.every(p => p.face === "front" && p.x >= 6 && p.y < 8)).toBe(true);
  expect(right.some(p => p.layer === "overlay")).toBe(true);
  expect(buildPhotoDrape(plan, a, { ...style, overallHairLength: "jaw" })).toEqual([]);
  a.observed.hair = "Hair is waist length behind the shoulders. No hair hangs over the chest.";
  expect(buildPhotoDrape(plan, a, style)).toEqual([]);
  a.observed.hair = "Hair lies over the front of the top on both sides to the shoulders.";
  const both = buildPhotoDrape(plan, a, style);
  expect(both.filter(p => p.y === 0).map(p => p.x)).toEqual([0, 7]);
  expect(Math.max(...both.map(p => p.y))).toBe(3);
  expect(buildPhotoDrape(plan, a, { ...style, hairstyle: "bun" })).toEqual([]);
});
