import { describe, expect, it } from "vitest";
import {
  mergeTargetedAtlas,
  resolveCorrectionTargets,
} from "../src/skinCorrection";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeSyntheticAtlas } from "./helpers";

function pixel(image: ReturnType<typeof makeSyntheticAtlas>, x: number, y: number) {
  const offset = (y * image.width + x) * 4;
  return [...image.rgba.subarray(offset, offset + 4)];
}

function center(rect: Rect): [number, number] {
  return [rect.x + Math.floor(rect.w / 2), rect.y + Math.floor(rect.h / 2)];
}

describe("targeted UV correction", () => {
  it("maps semantic body/face/layer regions to exact Java skin rectangles", () => {
    const plan = resolveCorrectionTargets([
      "head.front",
      "torso.overlay.back",
      "arm.left",
      "unknown.area",
    ]);
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ part: "head", layer: "base", face: "front" }),
        expect.objectContaining({ part: "head", layer: "overlay", face: "front" }),
        expect.objectContaining({ part: "body", layer: "overlay", face: "back" }),
        expect.objectContaining({ part: "leftArm", layer: "base", face: "front" }),
        expect.objectContaining({ part: "leftArm", layer: "overlay", face: "top" }),
      ]),
    );
    expect(plan.unresolvedRegions).toEqual(["unknown.area"]);
  });

  it("changes only selected faces plus their one-pixel physical seam context", () => {
    const base = makeSyntheticAtlas(3);
    const correction = makeSyntheticAtlas(99);
    const merged = mergeTargetedAtlas(base, correction, ["head.front"]);
    const headFront = CLASSIC_LAYOUT.head.base.front;
    const headBack = CLASSIC_LAYOUT.head.base.back;
    const bodyFront = CLASSIC_LAYOUT.body.base.front;
    expect(pixel(merged.atlas, ...center(headFront))).toEqual(
      pixel(correction, ...center(headFront)),
    );
    expect(pixel(merged.atlas, ...center(headBack))).toEqual(
      pixel(base, ...center(headBack)),
    );
    expect(pixel(merged.atlas, ...center(bodyFront))).toEqual(
      pixel(base, ...center(bodyFront)),
    );
  });
});
