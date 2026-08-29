import { describe, expect, it } from "vitest";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFacePixelPlanVariants, compareFacePlans, measureFacePlanConvergence } from "../src/identityPlans";
import { quantizeIdentityGeometry } from "../src/identityQuantization";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

describe("IdentityGeometryAnalysis parsing", () => {
  it("accepts normalized face/head geometry and rejects invalid bounds", () => {
    const geometry = makeIdentityGeometry();
    expect(parseIdentityGeometry(geometry)).toMatchObject({ source: "normalized_face_head_crops", face: geometry.face });
    expect(parseIdentityGeometry({ ...geometry, face: { ...geometry.face, visibleLeft: 0.9, visibleRight: 0.2 } })).toBeNull();
    expect(parseIdentityGeometry({ ...geometry, hairline: { ...geometry.hairline, depthByColumn: [0.2, 0.3] } })).toBeNull();
  });
});

describe("normalized identity geometry quantization", () => {
  it("uses source geometry rather than matching semantic enums", () => {
    const base = makeAnalysis();
    const wideHigh = makeIdentityGeometry({
      eyes: { ...makeIdentityGeometry().eyes, leftCenterX: 0.28, rightCenterX: 0.73, leftCenterY: 0.39, rightCenterY: 0.4 },
      mouth: { ...makeIdentityGeometry().mouth, centerY: 0.68, width: 0.42 },
    });
    const closeLow = makeIdentityGeometry({
      eyes: { ...makeIdentityGeometry().eyes, leftCenterX: 0.42, rightCenterX: 0.58, leftCenterY: 0.56, rightCenterY: 0.55 },
      mouth: { ...makeIdentityGeometry().mouth, centerY: 0.82, width: 0.2 },
    });
    const first = buildFacePixelPlanVariants({ ...base, identityGeometry: wideHigh }, 1)[0];
    const second = buildFacePixelPlanVariants({ ...base, identityGeometry: closeLow }, 1)[0];
    expect(first.source).toBe("identity_geometry");
    expect(first.layout.leftEyeXs).not.toEqual(second.layout.leftEyeXs);
    expect(first.layout.rightEyeXs).not.toEqual(second.layout.rightEyeXs);
    expect(first.layout.mouthWidth).not.toBe(second.layout.mouthWidth);
  });

  it("creates a bounded alternative only near a quantization boundary", () => {
    const baseGeometry = makeIdentityGeometry();
    const boundaryGeometry = makeIdentityGeometry({
      eyes: {
        ...baseGeometry.eyes,
        leftCenterX: 0.18 + 0.64 * 1.5 / 7,
        rightCenterX: 0.18 + 0.64 * 5.5 / 7,
        leftCenterY: 0.4125,
        rightCenterY: 0.4125,
      },
    });
    const analysis = makeAnalysis({ identityGeometry: boundaryGeometry });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    expect(variants.length).toBeGreaterThan(1);
    expect(variants.length).toBeLessThanOrEqual(3);
    expect(variants.some((plan) => plan.variantId.startsWith("geometry_alt_"))).toBe(true);
  });

  it("smooths the eight-column hairline and maps glasses as protected geometry", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry({
      hairline: { ...makeIdentityGeometry().hairline, depthByColumn: [0.1, 0.95, 0.05, 0.9, 0.1, 0.85, 0.1, 0.9] },
    }) });
    const layout = quantizeIdentityGeometry(analysis, analysis.identityGeometry!);
    expect(layout.hairlineDepthByColumn).toHaveLength(8);
    for (let index = 1; index < 8; index++) expect(Math.abs(layout.hairlineDepthByColumn[index] - layout.hairlineDepthByColumn[index - 1])).toBeLessThanOrEqual(1);
    expect(layout.glassesMask.length).toBeGreaterThanOrEqual(4);
    expect(layout.protectedGeometry).toContain("glasses");
    expect(layout.protectedGeometry).toContain("hairline");
  });

  it("does not vary an eye axis protected by a P5 cue", () => {
    const base = makeAnalysis();
    const protectedAnalysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({ eyes: { ...makeIdentityGeometry().eyes, leftCenterY: 0.4125, rightCenterY: 0.4125 } }),
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 0
          ? { ...feature, feature: "extremely wide eye spacing", evidence: "eyes are unusually far apart", category: "face" as const, priority: 5 as const }
          : feature),
      },
    });
    const variants = buildFacePixelPlanVariants(protectedAnalysis, 3);
    expect(variants.every((plan) => plan.layout.leftEyeXs.join(",") === variants[0].layout.leftEyeXs.join(","))).toBe(true);
    expect(variants.every((plan) => plan.layout.rightEyeXs.join(",") === variants[0].layout.rightEyeXs.join(","))).toBe(true);
  });

  it("reports geometry-backed plan distance without random diversity", () => {
    const base = makeAnalysis();
    const plans = [
      makeIdentityGeometry(),
      makeIdentityGeometry({ eyes: { ...makeIdentityGeometry().eyes, leftCenterX: 0.27, rightCenterX: 0.75 }, mouth: { ...makeIdentityGeometry().mouth, width: 0.44 } }),
      makeIdentityGeometry({ hairline: { ...makeIdentityGeometry().hairline, depthByColumn: [0.05, 0.1, 0.15, 0.8, 0.75, 0.2, 0.1, 0.05] }, face: { ...makeIdentityGeometry().face, widthWithinHead: 0.48 } }),
    ].map((identityGeometry) => buildFacePixelPlanVariants({ ...base, identityGeometry }, 1)[0]);
    expect(compareFacePlans(plans[0], plans[1]).eyeLayoutDistance).toBeGreaterThan(0);
    expect(compareFacePlans(plans[0], plans[2]).hairlineProfileDistance).toBeGreaterThan(0);
    const convergence = measureFacePlanConvergence(plans);
    expect(convergence.pairCount).toBe(3);
    expect(convergence.nearIdenticalPairs).toBe(0);
  });
});
