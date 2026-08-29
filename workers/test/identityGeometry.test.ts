import { describe, expect, it } from "vitest";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFacePixelPlanVariants, buildIdentityPixelPlans, compareFacePlans, measureFacePlanConvergence } from "../src/identityPlans";
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

  it("preserves asymmetric eye width, openness, brows and geometry mouth opening", () => {
    const source = makeIdentityGeometry();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        eyes: { ...source.eyes, leftWidth: 0.07, rightWidth: 0.2, openness: 0.82, verticalAsymmetry: 0.24 },
        brows: { ...source.brows, thickness: 0.82, tilt: -0.65 },
        mouth: { ...source.mouth, opening: "closed", leftCornerY: 0.77, rightCornerY: 0.7 },
      }),
      renderHints: { ...makeAnalysis().renderHints, eyeShape: "narrow", eyeSize: "small", eyebrowThickness: "thin", mouthOpening: "teeth_visible" },
    });
    const plan = buildFacePixelPlanVariants(analysis, 1)[0];
    expect(plan.layout.leftEyeWidth).toBeLessThan(plan.layout.rightEyeWidth);
    expect(plan.layout.eyeOpenness).toBe("open");
    expect(plan.layout.browThickness).toBe("strong");
    expect(plan.layout.browTiltOffset).toBe(-1);
    expect(plan.layout.mouthOpening).toBe("closed");
    expect(plan.pixels.filter((pixel) => pixel.cluster === "mouth").every((pixel) => pixel.role === "lip")).toBe(true);
    expect(plan.layout.geometryUsage).toMatchObject({ eyes: true, brows: true, mouth: true });
  });

  it("falls back per geometry group when its confidence is weak", () => {
    const source = makeIdentityGeometry();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        eyes: { ...source.eyes, leftWidth: 0.2, rightWidth: 0.2, openness: 0.95 },
        confidence: { ...source.confidence, eyes: 0.3 },
      }),
      renderHints: { ...makeAnalysis().renderHints, eyeSize: "small", eyeShape: "narrow" },
    });
    const layout = buildFacePixelPlanVariants(analysis, 1)[0].layout;
    expect(layout.geometryUsage.eyes).toBe(false);
    expect(layout.leftEyeWidth).toBe(1);
    expect(layout.eyeOpenness).toBe("compact");
  });

  it("produces different deterministic head masks inside the same coarse hair template", () => {
    const base = makeAnalysis();
    const first = buildIdentityPixelPlans({ ...base, identityGeometry: makeIdentityGeometry() }).hairPlan;
    const source = makeIdentityGeometry();
    const second = buildIdentityPixelPlans({
      ...base,
      identityGeometry: makeIdentityGeometry({
        headSilhouette: {
          ...source.headSilhouette,
          leftContourByRow: [0.04, 0.05, 0.07, 0.08, 0.1, 0.14, 0.2, 0.3],
          rightContourByRow: [0.96, 0.95, 0.93, 0.92, 0.9, 0.86, 0.8, 0.7],
          sideVolumeLeft: 0.95, sideVolumeRight: 0.2,
          hairEndpointLeftY: 0.98, hairEndpointRightY: 0.55,
        },
      }),
    }).hairPlan;
    expect(first.template).toBe(second.template);
    expect(first.headMask.source).toBe("identity_geometry");
    expect(first.headMask.faces.left).not.toEqual(second.headMask.faces.left);
    expect(first.headMask.endpointRows).not.toEqual(second.headMask.endpointRows);
  });
});
