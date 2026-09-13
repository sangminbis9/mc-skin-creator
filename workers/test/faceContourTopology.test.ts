import { describe, expect, it } from "vitest";
import { buildIdentityPixelPlans, type FacePixelPlan } from "../src/identityPlans";
import { type RawImage } from "../src/png";
import { createFacePlanAtlasCandidate, DEFAULT_FACE_STYLE } from "../src/skinPack";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function planFor(cheekWidth: number, jawWidth: number, faceShape: "round" | "oval" | "long" | "angular" | "square" = "oval", jawShape: "rounded" | "pointed" | "square" | "soft" = "soft"): FacePixelPlan {
  const source = makeIdentityGeometry();
  const base = makeAnalysis();
  return buildIdentityPixelPlans(makeAnalysis({
    identityGeometry: makeIdentityGeometry({
      faceShape: { ...source.faceShape, cheekWidth, jawWidth, evidence: "observed", confidence: 0.9 },
    }),
    renderHints: { ...base.renderHints, faceShape, jawShape },
  })).facePixelPlan;
}

function contour(plan: FacePixelPlan): string[] {
  return plan.pixels
    .filter((pixel) => pixel.cluster === "complexion")
    .map((pixel) => `${pixel.x},${pixel.y}:${pixel.role}`)
    .sort();
}

function skinAtlas(skin: [number, number, number]): RawImage {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let index = 0; index < 64 * 64; index++) rgba.set([...skin, 255], index * 4);
  return { width: 64, height: 64, rgba };
}

function rgbaAt(atlas: RawImage, x: number, y: number): number[] {
  const face = CLASSIC_LAYOUT.head.base.front;
  const at = ((face.y + y) * 64 + face.x + x) * 4;
  return [...atlas.rgba.subarray(at, at + 4)];
}

describe("calibrated cheek/jaw contour topology", () => {
  it("keeps cheek footprint and jaw taper as independent geometry axes", () => {
    const broadSquare = planFor(0.75, 0.75);
    const broadTapered = planFor(0.75, 0.52);
    const narrowTapered = planFor(0.61, 0.49);

    expect(contour(broadSquare)).toEqual([]);
    expect(contour(broadTapered)).toEqual([
      "2,7:jaw_contour",
      "5,7:jaw_contour",
    ]);
    expect(contour(narrowTapered)).toEqual([
      "1,5:cheek_contour",
      "2,7:jaw_contour",
      "5,7:jaw_contour",
      "6,5:cheek_contour",
    ]);
    expect(narrowTapered.salience.pixelBudget.faceBoundary).toBe(4);
  });

  it("gives calibrated geometry precedence over conflicting categorical labels", () => {
    const geometryBroadSemanticPointed = planFor(0.75, 0.75, "long", "pointed");
    const geometryTaperedSemanticSquare = planFor(0.75, 0.52, "square", "square");

    expect(contour(geometryBroadSemanticPointed)).toEqual([]);
    expect(contour(geometryTaperedSemanticSquare)).toEqual([
      "2,7:jaw_contour",
      "5,7:jaw_contour",
    ]);
  });

  it("keeps source-supported asymmetry inside the front face seam", () => {
    const source = makeIdentityGeometry();
    const base = makeAnalysis();
    const plan = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        faceShape: { ...source.faceShape, cheekWidth: 0.61, jawWidth: 0.49, leftRightAsymmetry: 0.3, evidence: "observed", confidence: 0.9 },
      }),
      renderHints: { ...base.renderHints },
    })).facePixelPlan;

    expect(plan.pixels.filter((pixel) => pixel.cluster === "complexion").every((pixel) => pixel.x > 0 && pixel.x < 7)).toBe(true);
  });

  it("does not fabricate new contour cells when accepted geometry is absent", () => {
    const base = makeAnalysis();
    const plan = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: null,
      renderHints: { ...base.renderHints, faceShape: "angular", jawShape: "pointed" },
    })).facePixelPlan;

    expect(plan.layout.geometryUsage.faceShape).toBe(false);
    expect(contour(plan)).toEqual([]);
  });

  it("keeps a colliding jaw contour bilateral by moving the pair below facial landmarks", () => {
    const source = makeIdentityGeometry();
    const base = makeAnalysis();
    const plan = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        faceShape: { ...source.faceShape, cheekWidth: 0.7, jawWidth: 0.62, evidence: "observed", confidence: 0.9 },
        mouth: { ...source.mouth, centerX: 0.75, centerY: 0.88, width: 0.35, leftCornerY: 0.88, rightCornerY: 0.88, opening: "closed" },
      }),
      renderHints: { ...base.renderHints, mouthShape: "small", mouthOpening: "closed" },
    })).facePixelPlan;

    expect(contour(plan)).toEqual([
      "2,7:jaw_contour",
      "5,7:jaw_contour",
    ]);
  });

  it("does not place skin contour shading under observed facial hair", () => {
    const base = makeAnalysis();
    const plan = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry(),
      fallbackFeatures: { ...base.fallbackFeatures, facialHair: "beard" },
    })).facePixelPlan;

    expect(contour(plan)).toEqual([]);
  });

  it("renders a bounded complexion-relative contour without transparency or black outline", () => {
    const plan = planFor(0.61, 0.49);
    const lightSkin: [number, number, number] = [224, 178, 146];
    const darkSkin: [number, number, number] = [92, 61, 47];
    const style = { ...DEFAULT_FACE_STYLE, skinTone: "#e0b292", hairColor: "#322820", glasses: "none", bangs: "none" };
    const light = createFacePlanAtlasCandidate(skinAtlas(lightSkin), plan, style);
    const dark = createFacePlanAtlasCandidate(skinAtlas(darkSkin), plan, { ...style, skinTone: "#5c3d2f" });

    for (const pixel of plan.pixels.filter((item) => item.cluster === "complexion")) {
      const lightPixel = rgbaAt(light, pixel.x, pixel.y);
      const darkPixel = rgbaAt(dark, pixel.x, pixel.y);
      expect(lightPixel[3]).toBe(255);
      expect(darkPixel[3]).toBe(255);
      expect(lightPixel.slice(0, 3)).not.toEqual([0, 0, 0]);
      expect(darkPixel.slice(0, 3)).not.toEqual([0, 0, 0]);
      expect(lightPixel[0] / lightSkin[0]).toBeCloseTo(darkPixel[0] / darkSkin[0], 1);
    }
    expect(plan.pixels.filter((item) => item.cluster === "complexion")).toHaveLength(4);
  });
});
