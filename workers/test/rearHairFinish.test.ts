import { expect, it } from "vitest";
import { readAppearanceDetail, type RearHairPattern } from "../src/appearanceDetail";
import { buildPhotoDrape, classifyPhotoHair } from "../src/photoHairFinish";
import { buildPhotoHeadGeometry } from "../src/photoHeadGeometry";
import { photoHeadForRender, renderNameMcPresentation } from "../src/skinEngine";
import { DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { buildSkinPlan } from "../src/skinPlan";
import { applyUvMask, validateFinalAtlas } from "../src/skinPost";
import { sculptWrappedHair } from "../src/stylizedHairArt";
import { buildLooseRearHair, chooseRearHairPattern } from "../src/rearHairFinish";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

const style = { ...DEFAULT_FACE_STYLE, hairstyle: "long", hairColor: "#3b2a1e", hairTexture: "wavy", hairBackShape: "long", overallHairLength: "chest" } as const;

function fixture() {
  const a = makeAnalysis();
  a.visibleRegions.hair = true;
  a.visibleRegions.upperBody = true;
  a.observed.hair = "Long loose wavy hair with wispy bangs.";
  a.inferred.hairBack = { ...a.inferred.hairBack, value: "Long loose waves on the back" };
  a.appearanceDetail = readAppearanceDetail({ frontHairLeft: "chest", frontHairRight: "chest", frontHairTexture: "wavy" });
  return a;
}

it("sculpts connected rear strands with texture-specific stepped tips and partial relief", () => {
  const a = fixture(), plan = buildSkinPlan(a);
  const previous = buildPhotoDrape(plan, a, style, true, false);
  const next = buildPhotoDrape(plan, a, style, true);
  expect(next.filter(p => p.face === "front")).toEqual(previous.filter(p => p.face === "front"));
  const rows = next.filter(p => p.face === "back" && p.layer === "base");
  expect(rows).toEqual(buildLooseRearHair(8, "wavy", false).filter(p => p.layer === "base"));
  expect(rows.filter(c => c.y === 7).map(c => c.x)).toEqual([2, 5, 6]);
  const relief = next.filter(p => p.face === "back" && p.layer === "overlay");
  expect(relief.length).toBeGreaterThan(4);
  expect(relief.length).toBeLessThan(rows.length / 2);
  for (const p of relief) expect(rows.some(c => c.x === p.x && c.y === p.y)).toBe(true);
  expect(buildLooseRearHair(8, "straight", false)).not.toEqual(buildLooseRearHair(8, "wavy", false));
  expect(buildLooseRearHair(8, "wavy", true).map(c => c.x)).toEqual(buildLooseRearHair(8, "wavy", false).map(c => 7 - c.x));
});

it("joins the back, under-edge and torso without changing the front textures", () => {
  const a = fixture(), plan = buildSkinPlan(a), baseline = applyUvMask(makeSyntheticAtlas());
  const drape = buildPhotoDrape(plan, a, style, true);
  const geometry = photoHeadForRender(style, a, drape);
  expect(geometry.base.back[7]).toBe("########");
  expect(geometry.base.right[7].slice(0, 2)).toBe("##");
  expect(geometry.base.left[7].slice(-2)).toBe("##");
  expect(geometry.overlay.back[7]).toBe(geometry.overlay.bottom[7]);
  expect(geometry.rearJoin).toEqual([2, 5]);
  const historicalDrape = buildPhotoDrape(plan, a, style, true, false);
  const p = classifyPhotoHair(style, a.observed.hair, true);
  const historical = sculptWrappedHair(buildPhotoHeadGeometry(style, p, a.observed.hair, historicalDrape, a.appearanceDetail), p, "source");
  // Verify rendered pixels, not just a plan flag.
  const next = renderNameMcPresentation(baseline, plan, a, style, "source", undefined, undefined, drape, geometry);
  const before = renderNameMcPresentation(baseline, plan, a, style, "source", undefined, undefined, historicalDrape, historical);
  const pix = (atlas: typeof next, r: Rect, x: number, y: number) => atlas.rgba.slice(((r.y + y) * 64 + r.x + x) * 4, ((r.y + y) * 64 + r.x + x) * 4 + 4);
  const layouts = [CLASSIC_LAYOUT.head, CLASSIC_LAYOUT.body];
  for (const b of layouts) for (const layer of ["base", "overlay"] as const) {
    const r = b[layer].front;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) expect(pix(next, r, x, y)).toEqual(pix(before, r, x, y));
  }
  for (const layer of ["base", "overlay"] as const) {
    const h = CLASSIC_LAYOUT.head[layer].back, t = CLASSIC_LAYOUT.body[layer].back;
    expect(pix(next, h, 2, 7)).toEqual(pix(next, t, 2, 0));
  }
  expect(validateFinalAtlas(next).ok).toBe(true);
});

it("does not fill nape skin or add loose locks to short hair, a ponytail or an unsupported back", () => {
  const a = fixture(), plan = buildSkinPlan(a);
  const styles: FaceStyle[] = [
    { ...style, overallHairLength: "ear", hairstyle: "short", hairBackShape: "tapered" },
    { ...style, hairstyle: "ponytail", hairBackShape: "tied" },
  ];
  a.observed.hair = "Ponytail down the back.";
  for (const s of styles) {
    const old = buildPhotoDrape(plan, a, s, true, false), next = buildPhotoDrape(plan, a, s, true);
    expect(next).toEqual(old);
    const g = photoHeadForRender(s, a, next);
    expect(g.rearJoin).toBeUndefined();
    expect(g.base.back[7]).toContain(".");
  }
  a.inferred.hairBack.value = "Unknown, unseen";
  expect(buildPhotoDrape(plan, a, style, true).some(c => c.face === "back")).toBe(false);
});

it("keeps straight hair straight and separates bends at the tips from curls in the lengths", () => {
  expect(chooseRearHairPattern("straight", "Long straight hair with wispy bangs.", "ringlets")).toBe("straight");
  expect(chooseRearHairPattern("wavy", "Long pin-straight locks.", "layered_wave")).toBe("straight");
  expect(chooseRearHairPattern("straight", "The hair ends turn inward.")).toBe("ends_in");
  expect(chooseRearHairPattern("wavy", "Only the tips flip outward.")).toBe("ends_out");
  expect(chooseRearHairPattern("wavy", "Waves begin below the shoulders.")).toBe("low_wave");
  expect(chooseRearHairPattern("wavy", "Layered waves with shorter locks.")).toBe("layered_wave");
  expect(chooseRearHairPattern("wavy", "Loose S-shaped waves.")).toBe("loose_wave");
  expect(chooseRearHairPattern("curly", "Visible barrel curls.")).toBe("ringlets");
  expect(chooseRearHairPattern("coily", "Small compact coils.")).toBe("tight_coils");
  expect(chooseRearHairPattern("wavy", "There are no ringlets.")).toBe("loose_wave");
});

it("renders eight distinct, rooted silhouettes without changing their photographed length", () => {
  const types: RearHairPattern[] = ["straight", "ends_in", "ends_out", "low_wave", "loose_wave", "layered_wave", "ringlets", "tight_coils"];
  const a = fixture();
  a.observed.hair = "Long loose hair.";
  const plan = buildSkinPlan(a);
  for (const [overallHairLength, rows] of [["shoulder", 4], ["chest", 8], ["waist", 12]] as const) {
    const silhouettes = new Set<string>();
    for (const rearHairPattern of types) {
      a.appearanceDetail = readAppearanceDetail({ rearHairPattern });
      const authored = buildLooseRearHair(rows, "wavy", false, rearHairPattern);
      const rendered = buildPhotoDrape(plan, a, { ...style, overallHairLength }, true).filter(p => p.face === "back");
      expect(rendered, rearHairPattern).toEqual(authored);
      const base = rendered.filter(p => p.layer === "base");
      expect(Math.max(...base.map(p => p.y))).toBe(rows - 1);
      silhouettes.add(base.map(p => `${p.x},${p.y}`).join(";"));
      if (rearHairPattern === "straight") {
        for (let y = 0; y < rows - 2; y++) expect(base.filter(p => p.y === y).map(p => p.x)).toEqual([1, 2, 3, 4, 5, 6]);
        const tips = [1, 2, 3, 4, 5, 6].map(x => {
          const ys = base.filter(p => p.x === x).map(p => p.y);
          expect(ys).toEqual(Array.from({ length: ys.length }, (_, y) => y));
          return ys.at(-1);
        });
        expect(tips).toEqual([rows - (rows === 4 ? 2 : 3), rows - 2, rows - 1, rows - 1, rows - 1, rows - 2]);
      }
    }
    if (rows >= 8) expect(silhouettes.size).toBe(types.length);
  }
});

it("uses the straight front lock even when the coarse front label claims a wave", () => {
  const a = fixture();
  a.observed.hair = "Long pin-straight hair.";
  a.appearanceDetail = readAppearanceDetail({ frontHairLeft: "chest", frontHairTexture: "wavy", rearHairPattern: "ringlets" });
  const front = buildPhotoDrape(buildSkinPlan(a), a, { ...style, hairTexture: "straight" }, true).filter(p => p.face === "front");
  expect(front.filter(p => p.layer === "base" && p.y === 4).map(p => p.x)).toEqual([0, 1]);
  expect(front.some(p => p.x === 2)).toBe(false);
});
