import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function semanticHair(
  hints: Partial<PhotoAnalysis["renderHints"]>,
  overrides: Partial<PhotoAnalysis> = {},
): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    observed: {
      ...base.observed,
      hair: "clearly visible continuous hair from crown through both sides and back",
    },
    visibleRegions: { ...base.visibleRegions, hair: true },
    renderHints: { ...base.renderHints, ...hints },
    ...overrides,
  });
}

function activeSteps(profile: number[]): number[] {
  return profile.filter((width) => width > 0);
}

describe("source-derived semantic hair silhouette planning", () => {
  it("separates short, long-straight, and full-wavy contours without fake geometry", () => {
    const short = buildSkinPlan(semanticHair({
      overallHairLength: "ear",
      sideHairLength: "short",
      sideHairShape: "tapered",
      hairBackShape: "tapered",
      hairTexture: "straight",
      hairVolume: "normal",
      hairPart: "right",
      earExposure: "visible",
    }));
    const straight = buildSkinPlan(semanticHair({
      overallHairLength: "chest",
      sideHairLength: "shoulder",
      sideHairShape: "tapered",
      hairBackShape: "long",
      hairTexture: "straight",
      hairVolume: "normal",
      hairPart: "left",
    }));
    const wavy = buildSkinPlan(semanticHair({
      overallHairLength: "chest",
      sideHairLength: "shoulder",
      sideHairShape: "tapered",
      hairBackShape: "long",
      hairTexture: "wavy",
      hairVolume: "full",
      hairPart: "left",
    }));

    expect(short.hairPlan.headMask.source).toBe("semantic_template");
    expect(short.hairPlan.headMask.semanticSilhouette).toMatchObject({
      provenance: "observed_categorical",
      sideWidthFamily: "narrow",
      endpointCue: "ear",
      sideEndpointCue: "short",
    });
    expect(short.hairPlan.headMask.endpointRows).toEqual({ left: 4, right: 4 });
    expect(short.hairPlan.headMask.earExposure).toEqual({ left: 0.85, right: 0.85 });
    expect(short.headIdentityPlan.ownership.execution).toBe("resolved");

    expect(straight.hairPlan.headMask.semanticSilhouette?.sideWidthFamily).toBe("narrow");
    expect(wavy.hairPlan.headMask.semanticSilhouette?.sideWidthFamily).toBe("broad");
    expect(straight.hairPlan.headMask.endpointRows).toEqual({ left: 7, right: 7 });
    expect(wavy.hairPlan.headMask.endpointRows).toEqual({ left: 7, right: 7 });
    expect(wavy.hairPlan.headMask.widthByRow.left.reduce((sum, width) => sum + width, 0))
      .toBeGreaterThan(straight.hairPlan.headMask.widthByRow.left.reduce((sum, width) => sum + width, 0));
    expect(wavy.hairPlan.headMask.widthByRow.back.reduce((sum, width) => sum + width, 0))
      .toBeGreaterThan(straight.hairPlan.headMask.widthByRow.back.reduce((sum, width) => sum + width, 0));
    expect(short.hairPlan.headMask.widthByRow.left).not.toEqual(straight.hairPlan.headMask.widthByRow.left);
    expect(wavy.hairPlan.headMask.widthByRow.left[0]).toBeLessThan(Math.max(...wavy.hairPlan.headMask.widthByRow.left));
    expect(wavy.hairPlan.headMask.widthByRow.back).not.toEqual(Array(8).fill(8));

    for (const plan of [short, straight, wavy]) {
      for (const side of ["left", "right"] as const) {
        const widths = activeSteps(plan.hairPlan.headMask.widthByRow[side]);
        expect(widths.every((width, index) => index === 0 || Math.abs(width - widths[index - 1]) <= 1)).toBe(true);
      }
      expect(plan.hairPlan.headMask.curlySilhouette).toBeUndefined();
    }
  });

  it("keeps hair part independent from side mass asymmetry", () => {
    const baseHints: Partial<PhotoAnalysis["renderHints"]> = {
      overallHairLength: "jaw",
      sideHairLength: "jaw",
      sideHairShape: "face_framing",
      hairTexture: "straight",
      hairVolume: "normal",
      sideHairAsymmetry: "none",
    };
    const leftPart = buildSkinPlan(semanticHair({ ...baseHints, hairPart: "left" }));
    const rightPart = buildSkinPlan(semanticHair({ ...baseHints, hairPart: "right" }));
    expect(leftPart.hairPlan.headMask.endpointRows).toEqual(rightPart.hairPlan.headMask.endpointRows);
    expect(leftPart.hairPlan.headMask.widthByRow).toEqual(rightPart.hairPlan.headMask.widthByRow);

    const asymmetric = buildSkinPlan(semanticHair({ ...baseHints, hairPart: "left", sideHairAsymmetry: "right" }));
    expect(asymmetric.hairPlan.headMask.endpointRows).toEqual({ left: 6, right: 7 });
    expect(Math.abs(asymmetric.hairPlan.headMask.endpointRows.left - asymmetric.hairPlan.headMask.endpointRows.right)).toBe(1);
  });

  it("uses the conservative template for clipped hair and head coverings", () => {
    const base = makeAnalysis();
    const clipped = buildSkinPlan(semanticHair(
      { hairTexture: "wavy", hairVolume: "full" },
      { observed: { ...base.observed, hair: "dark textured hair clipped by source" } },
    ));
    expect(clipped.hairPlan.headMask.semanticSilhouette).toBeUndefined();
    expect(clipped.hairPlan.headMask.widthByRow.left).toEqual([4, 4, 4, 3, 3, 0, 0, 0]);

    const covering = buildSkinPlan(semanticHair(
      { hairTexture: "wavy", hairVolume: "full" },
      {
        observed: { ...base.observed, hair: "hair covered by dark gray patterned headscarf", accessories: "dark gray patterned headscarf" },
        fallbackFeatures: { ...base.fallbackFeatures, hat: "headscarf" },
      },
    ));
    expect(covering.hairPlan.headMask.semanticSilhouette).toBeUndefined();
    expect(covering.hairPlan.headMask.widthByRow.left).toEqual([4, 4, 4, 3, 3, 0, 0, 0]);
    expect(covering.headIdentityPlan.ownership.covering).toBe(true);
  });

  it("leaves the identity-geometry mask path and facial landmark plan independent", () => {
    const geometric = buildSkinPlan(semanticHair(
      { overallHairLength: "jaw", sideHairLength: "jaw", hairVolume: "full" },
      { identityGeometry: makeIdentityGeometry() },
    ));
    expect(geometric.hairPlan.headMask.source).toBe("identity_geometry");
    expect(geometric.hairPlan.headMask.semanticSilhouette).toBeUndefined();

    const straight = buildSkinPlan(semanticHair({
      overallHairLength: "chest", sideHairLength: "shoulder", hairTexture: "straight", hairVolume: "normal",
    }));
    const wavy = buildSkinPlan(semanticHair({
      overallHairLength: "chest", sideHairLength: "shoulder", hairTexture: "wavy", hairVolume: "full",
    }));
    const signature = (plan: typeof straight) => {
      const layout = plan.facePixelPlan.layout;
      return JSON.stringify({
        pixels: plan.facePixelPlan.pixels.filter((pixel) => pixel.cluster !== "fringe"),
        eyes: [layout.leftEyeRow, layout.rightEyeRow, layout.leftEyeXs, layout.rightEyeXs, layout.eyeTopology],
        brows: [layout.leftBrowRow, layout.rightBrowRow, layout.browThickness, layout.browSlopeTopology],
        nose: [layout.noseX, layout.noseY, layout.noseStrength, layout.noseShapeTopology],
        mouth: [layout.mouthRow, layout.mouthWidth, layout.mouthCenterX, layout.mouthTopology],
        lowerFace: layout.faceShape,
        glasses: plan.facePixelPlan.glassesPlan,
        contract: plan.facePixelPlan.renderContract,
      });
    };
    expect(signature(straight)).toBe(signature(wavy));
  });
});
