import { describe, expect, it } from "vitest";
import {
  buildSkinViewMontage,
  buildPairwiseHeadEvidence,
  inspectRenderedSkin,
  renderSkinViews,
  scaleNearestNeighbor,
} from "../src/skinRender";
import { makeSyntheticAtlas } from "./helpers";
import { ALL_PARTS, CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { convertClassicRgbaToSlim } from "../../src/lib/slimSkin";

function fillRect(
  rgba: Uint8Array,
  rect: Rect,
  color: [number, number, number, number],
) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      rgba.set(color, (y * 64 + x) * 4);
    }
  }
}

describe("deterministic skin renderer", () => {
  it("renders six orthographic and three-quarter views from exact UV faces", () => {
    const views = renderSkinViews(makeSyntheticAtlas());
    expect(views.map((view) => view.name)).toEqual([
      "front",
      "back",
      "left",
      "right",
      "front_left_three_quarter",
      "front_right_three_quarter",
    ]);
    expect(views.every((view) => view.opaquePixels > 1_500)).toBe(true);
    expect(views.every((view) => view.distinctColors > 20)).toBe(true);
    expect(Array.from(views[0].image.rgba.slice(0, 4))).toEqual([
      224, 232, 240, 255,
    ]);

    const inspection = inspectRenderedSkin(views);
    expect(inspection.ok).toBe(true);
    const montage = buildSkinViewMontage(views);
    expect([montage.width, montage.height]).toEqual([288, 480]);
    const closeupOpaque = Array.from(
      { length: 96 * 96 },
      (_, index) =>
        montage.rgba[
          ((288 + Math.floor(index / 96)) * 288 + (index % 96)) * 4 + 3
        ],
    ).filter((alpha) => alpha > 0).length;
    expect(closeupOpaque).toBeGreaterThan(1_000);
  });

  it("rejects an empty atlas in every rendered direction", () => {
    const views = renderSkinViews({
      width: 64,
      height: 64,
      rgba: new Uint8Array(64 * 64 * 4),
    });
    const inspection = inspectRenderedSkin(views);
    expect(inspection.ok).toBe(false);
    expect(inspection.problems).toHaveLength(12);
  });

  it("builds front-dominant pairwise evidence with exact nearest-neighbour blocks", () => {
    const source = { width: 2, height: 2, rgba: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]) };
    const scaled = scaleNearestNeighbor(source, 4, 4);
    const pixel = (x: number, y: number) => [...scaled.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 0)).toEqual([0, 255, 0, 255]);
    expect(new Set(Array.from({ length: 16 }, (_, index) => scaled.rgba[index * 4])).size).toBeLessThanOrEqual(2);
    const evidence = buildPairwiseHeadEvidence(renderSkinViews(makeSyntheticAtlas()));
    expect([evidence.width, evidence.height]).toEqual([288, 384]);
  });

  it("samples the physically correct front/back/left/right UV faces", () => {
    const rgba = new Uint8Array(64 * 64 * 4);
    const faceColors = {
      front: [220, 20, 20, 255],
      back: [20, 20, 220, 255],
      left: [20, 220, 20, 255],
      right: [220, 220, 20, 255],
      top: [140, 40, 180, 255],
      bottom: [40, 180, 180, 255],
    } as const;
    for (const part of ALL_PARTS) {
      for (const face of Object.keys(faceColors) as Array<
        keyof typeof faceColors
      >) {
        fillRect(rgba, CLASSIC_LAYOUT[part].base[face], [...faceColors[face]]);
      }
    }
    const views = renderSkinViews({ width: 64, height: 64, rgba });
    const centerBodyPixel = (name: (typeof views)[number]["name"]) => {
      const view = views.find((candidate) => candidate.name === name)!;
      const offset = (54 * view.image.width + 48) * 4;
      return [...view.image.rgba.subarray(offset, offset + 4)];
    };
    expect(centerBodyPixel("front")).toEqual([220, 20, 20, 255]);
    expect(centerBodyPixel("back")).toEqual([16, 16, 172, 255]);
    expect(centerBodyPixel("left")).toEqual([18, 194, 18, 255]);
    expect(centerBodyPixel("right")).toEqual([194, 194, 18, 255]);
  });

  it("renders converted Java slim skins with true 3px arm geometry and UVs", () => {
    const classic = new Uint8Array(64 * 64 * 4);
    const rightFront: [number, number, number, number] = [220, 30, 40, 255];
    const leftFront: [number, number, number, number] = [30, 90, 220, 255];
    fillRect(classic, CLASSIC_LAYOUT.rightArm.base.front, rightFront);
    fillRect(classic, CLASSIC_LAYOUT.leftArm.base.front, leftFront);
    const slim = convertClassicRgbaToSlim(classic);

    const classicFront = renderSkinViews(
      { width: 64, height: 64, rgba: classic },
      "classic",
    )[0];
    const slimFront = renderSkinViews(
      { width: 64, height: 64, rgba: new Uint8Array(slim) },
      "slim",
    )[0];
    const sample = (x: number, y: number) => {
      const offset = (y * slimFront.image.width + x) * 4;
      return [...slimFront.image.rgba.subarray(offset, offset + 4)];
    };

    // Front-facing arm samples retain the converted right/left textures.
    expect(sample(30, 54)).toEqual(rightFront);
    expect(sample(66, 54)).toEqual(leftFront);
    // Two one-pixel-narrower model arms produce a smaller projected body.
    expect(slimFront.opaquePixels).toBeLessThan(classicFront.opaquePixels);
  });
});
