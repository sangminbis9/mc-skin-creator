import { expect, it } from "vitest";
import { NAMEMC_EYES } from "../src/namemcHeadTemplate";
import { classifyPhotoHair } from "../src/photoHairFinish";
import { buildPhotoHeadGeometry } from "../src/photoHeadGeometry";
import { headMaterialPoint } from "../src/referenceMaterialDetail";
import { DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { hairTreatment, sculptStylizedHair, stylizedHairRamp, stylizedHairTone } from "../src/stylizedHairArt";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "../src/uvLayout";

const cases: [Partial<FaceStyle>, string][] = [
  [{ hairPart: "left", bangs: "curtain", overallHairLength: "ear" }, "Part on the viewer-left."],
  [{ hairPart: "right", bangs: "side", overallHairLength: "ear" }, "Part on the viewer-right."],
  [{ hairPart: "center", hairTexture: "wavy", hairstyle: "long", overallHairLength: "chest" }, "Long waves with a center part."],
  [{ bangs: "wispy", hairstyle: "medium", overallHairLength: "jaw" }, "Bob cut with wisps."],
  [{ hairstyle: "buzz" }, "Buzz cut."],
  [{ hairstyle: "short", hairTexture: "coily" }, "Coily hair."],
  [{ hairstyle: "long", hairStructure: "braids" }, "Twin braids."],
  [{ hairstyle: "bun" }, "Tied bun."],
];
const box = CLASSIC_LAYOUT.head.overlay;
const faces = Object.keys(box) as (keyof BoxUV)[];
const { vertical, horizontal } = getBoxUvSeams(box);
const local = (p: {x: number; y: number}) => {
  const face = faces.find(f => p.x >= box[f].x && p.x < box[f].x + 8 && p.y >= box[f].y && p.y < box[f].y + 8)!;
  return [face, p.x - box[face].x, p.y - box[face].y] as const;
};
const value = (g: ReturnType<typeof buildPhotoHeadGeometry>["base"], p: {x: number; y: number}) => {
  const [f, x, y] = local(p);
  return g[f][y][x];
};

it("styles the raised hair groups while preserving the exact photo cut and supported seams", () => {
  const signatures = new Set<string>();
  for (const [i, [patch, words]] of cases.entries()) {
    const style = { ...DEFAULT_FACE_STYLE, ...patch };
    const profile = classifyPhotoHair(style, words, true);
    const base = buildPhotoHeadGeometry(style, profile, words);
    const ribbon = sculptStylizedHair(base, profile, "feminine");
    const sweep = sculptStylizedHair(base, profile, "masculine");
    if (i < 4) {
      expect(ribbon.overlay.front, words).not.toEqual(sweep.overlay.front);
      expect(ribbon.overlay.top, words).not.toEqual(sweep.overlay.top);
    } else {
      expect(ribbon.overlay, words).toEqual(base.overlay);
      expect(sweep.overlay, words).toEqual(base.overlay);
    }
    signatures.add(JSON.stringify(base.base));
    for (const g of [ribbon, sweep, sculptStylizedHair(base, profile, "source")]) {
      expect(g.cut).toBe(base.cut);
      expect(g.base).toEqual(base.base);
      for (const {x, y} of NAMEMC_EYES) expect(g.overlay.front[y][x]).toBe(".");
      for (const face of faces) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (g.overlay[face][y][x] === "#") expect(g.base[face][y][x]).toBe("#");
      }
      for (const seam of [...vertical, ...horizontal]) for (const [k, a] of seam.primary.entries()) {
        const b = seam.adjacent[k];
        if (value(g.base, a) === "#" && value(g.base, b) === "#") {
          expect(value(g.overlay, a), `${words}: ${a.x},${a.y}`).toBe(value(g.overlay, b));
          expect(headMaterialPoint(...local(a)), `${words}: shared shading coordinates`).toEqual(headMaterialPoint(...local(b)));
        }
      }
    }
  }
  expect(signatures.size).toBe(cases.length);
});

it("keeps the dye as the midtone, opens the part with shadow and shades mirror sweeps consistently", () => {
  const pigment = [39, 30, 32] as const;
  for (const treatment of ["ribbon", "sweep"] as const) {
    const ramp = stylizedHairRamp(pigment, treatment);
    expect(ramp[2]).toEqual(pigment);
    expect(ramp[4][0]).toBeGreaterThan(pigment[0]);
    expect(ramp[0][0]).toBeLessThan(pigment[0]);
    const left = classifyPhotoHair({ ...DEFAULT_FACE_STYLE, hairPart: "left" }, "");
    const right = classifyPhotoHair({ ...DEFAULT_FACE_STYLE, hairPart: "right" }, "");
    expect(stylizedHairTone([2, 1, 0], "side_part", left, treatment, true, 3)).toBe(0);
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++)
      expect(stylizedHairTone([x, y, z], "side_part", left, treatment, true, 2))
        .toBe(stylizedHairTone([7 - x, y, z], "side_part", right, treatment, true, 2));
  }
  const noPreference = classifyPhotoHair(DEFAULT_FACE_STYLE, "");
  expect(hairTreatment("crop", noPreference, "source")).toBe("sweep");
  expect(hairTreatment("wave", noPreference, "source")).toBe("ribbon");
});
