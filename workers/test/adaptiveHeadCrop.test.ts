import { describe, expect, it } from "vitest";
import {
  conservativeFaceHeadFallback,
  planAdaptiveHeadCrop,
  type AdaptiveHeadCropContext,
} from "../src/adaptiveHeadCrop";
import type { PortraitRegion } from "../src/analysis";

const SOURCE = { width: 1200, height: 800 };

function region(overrides: Partial<PortraitRegion> = {}): PortraitRegion {
  return {
    subjectBox: { left: 0.18, top: 0.05, right: 0.82, bottom: 0.98 },
    headBox: { left: 0.34, top: 0.12, right: 0.66, bottom: 0.58 },
    faceBox: { left: 0.4, top: 0.24, right: 0.6, bottom: 0.52 },
    confidence: 0.94,
    ...overrides,
  };
}

function plan(overrides: Partial<PortraitRegion> = {}, context: AdaptiveHeadCropContext = {}) {
  return planAdaptiveHeadCrop(SOURCE, region(overrides), context);
}

describe("adaptive head crop", () => {
  it("uses a valid headBox as the primary anchor and preserves face resolution", () => {
    const result = plan();
    expect(result.originalHeadBox).toEqual(region().headBox);
    expect(result.anchor).toEqual({ x: 0.5, y: 0.35 });
    expect(result.cropBox.left).toBeLessThan(result.originalHeadBox.left);
    expect(result.cropBox.top).toBeLessThan(result.originalHeadBox.top);
    expect(result.quality.faceResolutionAdequate).toBe(true);
    expect(result.diagnostics.coverage).toEqual({ crown: 1, leftHair: 1, rightHair: 1, temples: 1, ears: 1, chin: 1 });
  });

  it("uses directional margins instead of uniform padding", () => {
    const result = plan();
    const ratios = {
      top: result.requestedMargins.top / 0.46,
      left: result.requestedMargins.left / 0.32,
      right: result.requestedMargins.right / 0.32,
      bottom: result.requestedMargins.bottom / 0.46,
    };
    expect(ratios.top).not.toBeCloseTo(ratios.left);
    expect(ratios.bottom).toBeGreaterThan(ratios.right);
  });

  it("adds top and side allowance for tall, wide curly hair", () => {
    const ordinary = plan();
    const curly = plan({}, { hairVolume: "full", hairTexture: "curly", overallHairLength: "jaw" });
    expect(curly.requestedMargins.top).toBeGreaterThan(ordinary.requestedMargins.top);
    expect(curly.requestedMargins.left).toBeGreaterThan(ordinary.requestedMargins.left);
    expect(curly.requestedMargins.right).toBeGreaterThan(ordinary.requestedMargins.right);
    expect(curly.requestedMargins.bottom).toBeGreaterThan(ordinary.requestedMargins.bottom);
  });

  it("permits bounded asymmetric expansion without mirroring noisy volume", () => {
    const left = plan({}, { hairVolume: "full", sideHairAsymmetry: "left" });
    const right = plan({}, { hairVolume: "full", sideHairAsymmetry: "right" });
    expect(left.requestedMargins.left).toBeGreaterThan(left.requestedMargins.right);
    expect(right.requestedMargins.right).toBeGreaterThan(right.requestedMargins.left);
  });

  it("keeps expansion inside the selected subject rather than a neighboring person", () => {
    const selected = region({ subjectBox: { left: 0.28, top: 0.04, right: 0.7, bottom: 0.94 } });
    const result = planAdaptiveHeadCrop(SOURCE, selected, { hairVolume: "full", hairTexture: "coily" });
    const subjectPadding = (0.7 - 0.28) * 0.025;
    expect(result.cropBox.left).toBeGreaterThanOrEqual(0.28 - subjectPadding - 1e-6);
    expect(result.cropBox.right).toBeLessThanOrEqual(0.7 + subjectPadding + 1e-6);
  });

  it.each([
    ["left", { left: 0.01, top: 0.08, right: 0.38, bottom: 0.98 }, { left: 0.035, top: 0.12, right: 0.31, bottom: 0.56 }, { left: 0.08, top: 0.22, right: 0.27, bottom: 0.5 }],
    ["right", { left: 0.62, top: 0.08, right: 0.99, bottom: 0.98 }, { left: 0.69, top: 0.12, right: 0.965, bottom: 0.56 }, { left: 0.73, top: 0.22, right: 0.92, bottom: 0.5 }],
  ] as const)("recenters a %s-edge subject before shrinking", (_side, subjectBox, headBox, faceBox) => {
    const input = region({ subjectBox, headBox, faceBox });
    const result = planAdaptiveHeadCrop(SOURCE, input, { hairVolume: "full" });
    expect(result.diagnostics.sourceBoundaryAdjustments.translatedX).not.toBe(0);
    expect(result.cropBox.right - result.cropBox.left).toBeGreaterThanOrEqual(headBox.right - headBox.left);
    expect(result.cropBox.left).toBeGreaterThanOrEqual(0);
    expect(result.cropBox.right).toBeLessThanOrEqual(1);
  });

  it("preserves desired size at the source edge and shrinks only when the subject limit is smaller", () => {
    const roomy = region({
      subjectBox: { left: 0, top: 0.02, right: 0.72, bottom: 0.98 },
      headBox: { left: 0.015, top: 0.12, right: 0.36, bottom: 0.56 },
      faceBox: { left: 0.07, top: 0.22, right: 0.29, bottom: 0.49 },
    });
    const result = planAdaptiveHeadCrop(SOURCE, roomy);
    expect(result.diagnostics.sourceBoundaryAdjustments.translatedX).toBeGreaterThan(0);
    expect(result.diagnostics.sourceBoundaryAdjustments.shrunkWidth).toBeCloseTo(0);
  });

  it("corrects an extreme aspect ratio by expansion only", () => {
    const tall = region({
      subjectBox: { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 },
      headBox: { left: 0.45, top: 0.08, right: 0.55, bottom: 0.7 },
      faceBox: { left: 0.46, top: 0.28, right: 0.54, bottom: 0.58 },
    });
    const result = planAdaptiveHeadCrop(SOURCE, tall);
    expect(result.diagnostics.aspectRatioAdjusted).toBe(true);
    expect(result.cropBox.left).toBeLessThanOrEqual(result.desiredBox.left + 1e-6);
    expect(result.cropBox.right - result.cropBox.left).toBeGreaterThan(tall.headBox.right - tall.headBox.left);
  });

  it("reports head occupancy so excessive background expansion is visible", () => {
    const ordinary = plan();
    const wide = plan({}, { hairVolume: "full", hairTexture: "coily", overallHairLength: "shoulder" });
    expect(ordinary.diagnostics.headOccupancyRatio).toBeGreaterThan(wide.diagnostics.headOccupancyRatio);
    expect(wide.diagnostics.headOccupancyRatio).toBeGreaterThan(0.2);
  });

  it("separates source-clipped crown from crop-induced crown risk", () => {
    const sourceClipped = plan({
      subjectBox: { left: 0.12, top: 0, right: 0.88, bottom: 0.96 },
      headBox: { left: 0.32, top: 0.001, right: 0.68, bottom: 0.5 },
      faceBox: { left: 0.4, top: 0.15, right: 0.6, bottom: 0.43 },
    });
    expect(sourceClipped.quality.sourceClipping.top).toBe(true);
    expect(sourceClipped.quality.cropClipping.top).toBe(false);

    const cropLimited = plan({
      subjectBox: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.9 },
      headBox: { left: 0.34, top: 0.12, right: 0.66, bottom: 0.58 },
    }, { hairVolume: "full", hairTexture: "curly" });
    expect(cropLimited.quality.sourceClipping.top).toBe(false);
    expect(cropLimited.risk.topRisk).toBeGreaterThan(0.65);
    expect(cropLimited.quality.cropClipping.top).toBe(true);
    expect(cropLimited.diagnostics.coverage.crown).toBeLessThan(1);
  });

  it("keeps visible-side hair usable when one side is boundary limited", () => {
    const result = plan({
      subjectBox: { left: 0, top: 0.04, right: 0.76, bottom: 0.98 },
      headBox: { left: 0.002, top: 0.1, right: 0.58, bottom: 0.62 },
      faceBox: { left: 0.18, top: 0.25, right: 0.43, bottom: 0.53 },
    }, { hairVolume: "full", hairTexture: "curly" });
    expect(result.quality.sourceClipping.left).toBe(true);
    expect(result.quality.usableForHairGeometry).toBe(true);
    expect(result.quality.warnings).toContain("source_left_clipped");
  });

  it("adds covering contour room without relabeling it as hair", () => {
    const hair = plan({}, { hairVolume: "normal" });
    const covering = plan({}, { hairVolume: "normal", headCovering: true });
    expect(covering.requestedMargins.top).toBeGreaterThan(hair.requestedMargins.top);
    expect(covering.requestedMargins.left).toBeGreaterThan(hair.requestedMargins.left);
  });

  it("adds only head-adjacent bottom room for long hair", () => {
    const short = plan({}, { overallHairLength: "ear" });
    const long = plan({}, { overallHairLength: "waist" });
    expect(long.requestedMargins.bottom).toBeGreaterThan(short.requestedMargins.bottom);
    expect(long.cropBox.bottom).toBeLessThanOrEqual(region().subjectBox.bottom + 0.03);
  });

  it("builds a conservative faceBox fallback only from a valid selected subject", () => {
    const fallback = conservativeFaceHeadFallback({
      subjectBox: { left: 0.2, top: 0.04, right: 0.72, bottom: 0.96 },
      headBox: { left: 0.9, top: 0.1, right: 0.4, bottom: 0.3 },
      faceBox: { left: 0.36, top: 0.24, right: 0.56, bottom: 0.52 },
      confidence: 0.9,
    });
    expect(fallback).not.toBeNull();
    expect(fallback!.headBox.left).toBeLessThan(fallback!.faceBox.left);
    expect(fallback!.headBox.top).toBeLessThan(fallback!.faceBox.top);
    expect(conservativeFaceHeadFallback({ ...region(), confidence: 0.4 })).toBeNull();
  });

  it("marks low face resolution independently from wide-head coverage", () => {
    const smallSource = { width: 160, height: 160 };
    const tinyFace = region({ faceBox: { left: 0.48, top: 0.3, right: 0.52, bottom: 0.46 } });
    const result = planAdaptiveHeadCrop(smallSource, tinyFace);
    expect(result.quality.faceResolutionAdequate).toBe(false);
    expect(result.quality.usableForFaceGeometry).toBe(false);
    expect(result.quality.warnings).toContain("face_resolution_low");
  });
});
