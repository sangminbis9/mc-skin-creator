import { describe, expect, it } from "vitest";
import { applyCropVisibility, IDENTITY_GEOMETRY_PROMPT, IDENTITY_GEOMETRY_SCHEMA, parseIdentityGeometry } from "../src/identityGeometry";
import { buildFacePixelPlanVariants, buildIdentityPixelPlans, compareFacePlans, measureFacePlanConvergence, measureFacePixelPlanCost } from "../src/identityPlans";
import { quantizeIdentityGeometry } from "../src/identityQuantization";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

describe("IdentityGeometryAnalysis parsing", () => {
  it("accepts normalized face/head geometry and rejects invalid bounds", () => {
    const geometry = makeIdentityGeometry();
    expect(parseIdentityGeometry(geometry)).toMatchObject({ source: "normalized_face_head_crops", face: geometry.face });
    expect(parseIdentityGeometry({ ...geometry, face: { ...geometry.face, visibleLeft: 0.9, visibleRight: 0.2 } })).toBeNull();
    expect(parseIdentityGeometry({ ...geometry, hairline: { ...geometry.hairline, depthByColumn: [0.2, 0.3] } })).toBeNull();
  });

  it("requires the expanded source-geometry groups and assigns each crop a distinct job", () => {
    expect(IDENTITY_GEOMETRY_SCHEMA.required).toEqual(expect.arrayContaining([
      "fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "visibility",
    ]));
    expect(IDENTITY_GEOMETRY_SCHEMA.properties.fringe.properties.peaks.maxItems).toBe(3);
    expect(IDENTITY_GEOMETRY_SCHEMA.properties.majorVolumePeaks.maxItems).toBe(6);
    expect(IDENTITY_GEOMETRY_PROMPT).toMatch(/FACE crop priorities/);
    expect(IDENTITY_GEOMETRY_PROMPT).toMatch(/HEAD crop priorities/);
    expect(IDENTITY_GEOMETRY_PROMPT).toMatch(/Do not use a semantic hairstyle label as geometry evidence/);
    expect(IDENTITY_GEOMETRY_PROMPT).toMatch(/Do not choose Minecraft pixels/);
  });

  it("keeps legacy stored geometry readable but labels derived extensions as inferred", () => {
    const geometry = makeIdentityGeometry();
    const legacy: Record<string, unknown> = { ...geometry };
    for (const key of ["fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "visibility"]) {
      delete legacy[key];
    }
    const parsed = parseIdentityGeometry(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.fringe.evidence).toBe("inferred");
    expect(parsed!.temple.leftEvidence).toBe("inferred");
    expect(parsed!.crown.evidence).toBe("inferred");
    expect(parsed!.majorVolumePeaks.every((peak) => peak.evidence === "inferred")).toBe(true);
    expect(parsed!.visibility.cropClippingKnown).toBe(false);
  });

  it("rejects unbounded peak inventories and invalid evidence", () => {
    const geometry = makeIdentityGeometry();
    expect(parseIdentityGeometry({
      ...geometry,
      fringe: { ...geometry.fringe, peaks: Array.from({ length: 4 }, () => ({ x: 0.5, depthY: 0.5, prominence: 0.5 })) },
    })).toBeNull();
    expect(parseIdentityGeometry({
      ...geometry,
      crown: { ...geometry.crown, evidence: "guessed" },
    })).toBeNull();
  });

  it("downgrades only crop-dependent geometry instead of pretending clipped evidence was observed", () => {
    const clipped = applyCropVisibility(makeIdentityGeometry(), {
      crownClipped: true,
      leftHairClipped: true,
      rightHairClipped: false,
      chinClipped: true,
      leftEarClipped: true,
      rightEarClipped: false,
    });
    expect(clipped.visibility).toMatchObject({ cropClippingKnown: true, crownClipped: true, leftHairClipped: true, chinClipped: true });
    expect(clipped.fringe).toMatchObject({ evidence: "observed", confidence: 0.88 });
    expect(clipped.crown).toMatchObject({ evidence: "inferred", confidence: 0.45 });
    expect(clipped.temple.leftEvidence).toBe("inferred");
    expect(clipped.faceShape).toMatchObject({ evidence: "inferred", confidence: 0.45 });
    expect(clipped.majorVolumePeaks.find((peak) => peak.region === "side_left")!.evidence).toBe("inferred");
    expect(clipped.majorVolumePeaks.find((peak) => peak.region === "side_right")!.evidence).toBe("observed");
    const layout = quantizeIdentityGeometry(makeAnalysis({ identityGeometry: clipped }), clipped);
    expect(layout.geometryUsage).toMatchObject({ fringePeaks: true, temple: true, crown: false, majorVolumePeaks: true, faceWindow: true, faceShape: false });
    expect(layout.majorVolumePeaks.map((peak) => peak.region)).toEqual(["side_right"]);
    expect(layout.templeGeometry.rightRecession).toBe(1);
  });
});

describe("normalized identity geometry quantization", () => {
  it("wires observed fringe, temple, crown, volume, face-window and face-shape geometry into real plans", () => {
    const source = makeIdentityGeometry();
    const geometry = makeIdentityGeometry({
      fringe: { ...source.fringe, peaks: [{ x: 0.52, depthY: 0.94, prominence: 0.9 }], direction: "left_swept", openingCenterX: null, openingWidth: null },
      temple: { ...source.temple, leftRecession: 0.95, rightRecession: 0.05, leftStartY: 0.28, rightStartY: 0.7 },
      crown: { ...source.crown, leftY: 0.28, centerY: 0.02, rightY: 0.18, leftWidth: 0.9, rightWidth: 0.2, apexX: 0.2 },
      majorVolumePeaks: [
        { region: "crown_right", protrusion: 0.8, verticalCenter: 0.2, verticalExtent: 0.3, evidence: "observed", confidence: 0.92 },
        { region: "lower_left", protrusion: 0.95, verticalCenter: 0.8, verticalExtent: 0.55, evidence: "observed", confidence: 0.92 },
      ],
      faceWindow: { ...source.faceWindow, leftTempleWidth: 0.95, rightTempleWidth: 0.05, visibleFaceWidthAtEyes: 0.54, leftEyeToHairDistance: 0.14, rightEyeToHairDistance: 0.5 },
      faceShape: { ...source.faceShape, upperWidth: 0.55, cheekWidth: 0.92, jawWidth: 0.48, leftRightAsymmetry: 0.24 },
    });
    const base = makeAnalysis();
    const plans = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: geometry,
      renderHints: { ...base.renderHints, bangs: "none", bangsLength: "none", fringeOpening: "center", hairPart: "right", hairTexture: "curly", overallHairLength: "jaw", sideHairLength: "jaw" },
    }));
    expect(plans.facePixelPlan.layout.geometryUsage).toMatchObject({ fringePeaks: true, temple: true, crown: true, majorVolumePeaks: true, faceWindow: true, faceShape: true });
    expect(plans.facePixelPlan.layout.fringeDirection).toBe("left_swept");
    expect(plans.facePixelPlan.layout.fringePeaks).toEqual([{ column: 4, row: 3, prominence: 0.9 }]);
    expect(Math.max(...plans.hairPlan.structure.fringe.tipPoints.map((point) => point.y))).toBe(3);
    expect(plans.hairPlan.headMask.widthByRow.left).not.toEqual(plans.hairPlan.headMask.widthByRow.right);
    expect(plans.hairPlan.headMask.faces.front.some((point) => point.y === plans.facePixelPlan.layout.crownGeometry.centerRow)).toBe(true);
    expect(plans.hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe").map((group) => group.id)).toEqual(expect.arrayContaining(["curl-lobe-crown-right", "curl-lobe-lower-left"]));
    expect(plans.facePixelPlan.layout.exposedFaceWidth).toBe(plans.facePixelPlan.layout.faceWindow.visibleWidthAtEyes);
    expect(plans.facePixelPlan.pixels.some((pixel) => pixel.role === "skin_shadow" && pixel.cluster === "complexion")).toBe(true);
  });

  it("falls back independently for a weak geometry group while retaining other observed groups", () => {
    const source = makeIdentityGeometry();
    const base = makeAnalysis();
    const layout = quantizeIdentityGeometry(makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        fringe: { ...source.fringe, peaks: [{ x: 0.95, depthY: 0.95, prominence: 0.95 }], direction: "irregular", confidence: 0.3 },
        crown: { ...source.crown, apexX: 0.86, confidence: 0.95 },
      }),
      renderHints: { ...base.renderHints, bangs: "none", bangsLength: "none", hairPart: "left" },
    }), makeIdentityGeometry({
      fringe: { ...source.fringe, peaks: [{ x: 0.95, depthY: 0.95, prominence: 0.95 }], direction: "irregular", confidence: 0.3 },
      crown: { ...source.crown, apexX: 0.86, confidence: 0.95 },
    }));
    expect(layout.geometryUsage.fringePeaks).toBe(false);
    expect(layout.fringePeaks).toEqual([]);
    expect(layout.geometryUsage.crown).toBe(true);
    expect(layout.crownGeometry.apexColumn).toBe(6);
  });

  it("keeps candidate generation deterministic and capped at three after geometry expansion", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const first = buildFacePixelPlanVariants(analysis, 20);
    const second = buildFacePixelPlanVariants(analysis, 20);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(first).toEqual(second);
  });
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

  it("keeps P5 eye semantics while allowing contract-safe quantization variation", () => {
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
    expect(variants.length).toBeGreaterThan(1);
    expect(variants.every((plan) => plan.renderContract.eyes?.protected)).toBe(true);
    expect(variants.every((plan) => plan.candidateCost.p5ContractViolations === 0)).toBe(true);
    expect(variants.every((plan) => Math.min(...plan.layout.rightEyeXs) - Math.max(...plan.layout.leftEyeXs) - 1 >= plan.renderContract.eyes!.minimumInterEyeGap)).toBe(true);
  });

  it("renders a wide toothy P5 smile as a bounded multi-row topology rather than a white bar", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        mouth: { ...makeIdentityGeometry().mouth, width: 0.43, centerY: 0.75, leftCornerY: 0.64, rightCornerY: 0.65, opening: "teeth" },
      }),
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 0
          ? { ...feature, feature: "wide open toothy smile", evidence: "broad exposed teeth with lifted corners", category: "face" as const, priority: 5 as const }
          : feature),
      },
    });
    const plan = buildFacePixelPlanVariants(analysis, 1)[0];
    const mouth = plan.pixels.filter((pixel) => pixel.cluster === "mouth");
    expect(plan.layout.mouthTopology).toBe("wide_teeth_smile");
    expect(plan.layout.mouthWidth).toBe(5);
    expect(mouth.some((pixel) => pixel.role === "teeth")).toBe(true);
    expect(mouth.some((pixel) => pixel.role === "mouth_shadow" || pixel.role === "lip")).toBe(true);
    expect(new Set(mouth.map((pixel) => pixel.y)).size).toBeGreaterThan(1);
    expect(Math.max(...mouth.map((pixel) => pixel.x)) - Math.min(...mouth.map((pixel) => pixel.x)) + 1).toBeGreaterThanOrEqual(5);
    expect(plan.candidateCost.violations).not.toContain("mouth collapsed to flat white bar");
  });

  it("never introduces a toothy topology for a closed mouth", () => {
    const source = makeIdentityGeometry();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({ mouth: { ...source.mouth, width: 0.43, opening: "closed" } }),
      renderHints: { ...makeAnalysis().renderHints, mouthShape: "wide", mouthOpening: "closed" },
    });
    const plan = buildFacePixelPlanVariants(analysis, 3)[0];
    expect(plan.layout.mouthTopology).toMatch(/^closed_/);
    expect(plan.pixels.filter((pixel) => pixel.cluster === "mouth").some((pixel) => pixel.role === "teeth")).toBe(false);
  });

  it("promotes a geometry-supported wide toothy expression even when salience did not label the mouth P5", () => {
    const source = makeIdentityGeometry();
    const plan = buildFacePixelPlanVariants(makeAnalysis({
      identityGeometry: makeIdentityGeometry({ mouth: { ...source.mouth, width: 0.27, opening: "teeth" } }),
    }), 1)[0];
    expect(plan.renderContract.mouth?.protected).toBe(false);
    expect(plan.layout.mouthWidth).toBe(4);
    expect(plan.layout.mouthTopology).toBe("wide_teeth_smile");
  });

  it("offers one bounded topology alternative for a confident wide toothy expression", () => {
    const source = makeIdentityGeometry();
    const variants = buildFacePixelPlanVariants(makeAnalysis({
      identityGeometry: makeIdentityGeometry({ mouth: { ...source.mouth, width: 0.27, opening: "teeth" } }),
    }), 3);
    expect(variants.length).toBeGreaterThan(1);
    expect(new Set(variants.map((plan) => plan.layout.mouthTopology))).toEqual(new Set(["wide_teeth_smile", "teeth_smile"]));
    expect(variants.every((plan) => plan.candidateCost.violations.length === 0)).toBe(true);
    const primary = variants.find((plan) => plan.layout.mouthTopology === "wide_teeth_smile")!;
    const alternative = variants.find((plan) => plan.layout.mouthTopology === "teeth_smile")!;
    expect(primary.pixels.filter((pixel) => pixel.cluster === "mouth")).not.toEqual(alternative.pixels.filter((pixel) => pixel.cluster === "mouth"));
    const primaryMouth = primary.pixels.filter((pixel) => pixel.cluster === "mouth");
    expect(Math.min(...primaryMouth.map((pixel) => pixel.y))).toBeLessThan(primary.layout.mouthRow);
    expect(primary.candidateCost.totalCost).toBeLessThan(alternative.candidateCost.totalCost);
  });

  it("keeps brow pixels above rather than overwriting both measured eye apertures", () => {
    const source = makeIdentityGeometry();
    const plan = buildFacePixelPlanVariants(makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        eyes: { ...source.eyes, leftCenterY: 0.38, rightCenterY: 0.38 },
        brows: { ...source.brows, leftY: 0.39, rightY: 0.39, thickness: 0.9 },
      }),
    }), 1)[0];
    for (const cluster of ["left_eye", "right_eye"] as const) {
      expect(plan.pixels.some((pixel) => pixel.cluster === cluster && (pixel.role === "iris" || pixel.role === "sclera"))).toBe(true);
      const eyeRows = plan.pixels.filter((pixel) => pixel.cluster === cluster && (pixel.role === "iris" || pixel.role === "sclera")).map((pixel) => pixel.y);
      const browRows = plan.pixels.filter((pixel) => pixel.cluster === cluster && pixel.role === "brow").map((pixel) => pixel.y);
      expect(Math.max(...browRows)).toBeLessThan(Math.min(...eyeRows));
    }
  });

  it("uses asymmetric smile topology only when measured asymmetry is confident", () => {
    const source = makeIdentityGeometry();
    const mouth = { ...source.mouth, centerY: 0.74, leftCornerY: 0.62, rightCornerY: 0.74, opening: "teeth" as const };
    const confident = buildFacePixelPlanVariants(makeAnalysis({ identityGeometry: makeIdentityGeometry({ mouth }) }), 1)[0];
    const uncertain = buildFacePixelPlanVariants(makeAnalysis({ identityGeometry: makeIdentityGeometry({ mouth, confidence: { ...source.confidence, mouth: 0.6 } }) }), 1)[0];
    expect(confident.layout.mouthTopology).toBe("asymmetric_smile");
    expect(confident.renderContract.mouth?.preserveAsymmetry).toBe(true);
    expect(uncertain.layout.mouthTopology).not.toBe("asymmetric_smile");
  });

  it("does not freeze P5 mouth candidates and all variants retain the semantic contract", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry({ mouth: { ...makeIdentityGeometry().mouth, width: 0.27, opening: "teeth" } }),
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 0
          ? { ...feature, feature: "wide toothy smile", evidence: "wide visible teeth and level lifted corners", category: "face" as const, priority: 5 as const }
          : feature),
      },
    });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    expect(variants.length).toBeGreaterThan(1);
    expect(new Set(variants.map((plan) => plan.layout.mouthTopology)).size).toBeGreaterThan(1);
    expect(variants.every((plan) => measureFacePixelPlanCost(plan).p5ContractViolations === 0)).toBe(true);
    expect(variants.every((plan) => plan.pixels.some((pixel) => pixel.cluster === "mouth" && pixel.role === "teeth"))).toBe(true);
  });

  it("keeps both P5 glasses lenses and bridge in every bounded variant", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    expect(variants.every((plan) => plan.renderContract.glasses?.protected)).toBe(true);
    expect(variants.every((plan) => plan.layout.glassesMask.some((point) => point.x <= 3))).toBe(true);
    expect(variants.every((plan) => plan.layout.glassesMask.some((point) => point.x >= 4))).toBe(true);
    expect(variants.every((plan) => plan.layout.glassesMask.some((point) => point.x === 3 || point.x === 4))).toBe(true);
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

  it("keeps measured non-covering head masks contour-shaped instead of solid overlay planes", () => {
    const hairPlan = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: makeIdentityGeometry({
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 1, sideVolumeRight: 1, hairEndpointLeftY: 1, hairEndpointRightY: 1 },
    }) })).hairPlan;
    expect(hairPlan.headMask.faces.top.length).toBeLessThan(64);
    expect(hairPlan.headMask.faces.left.length).toBeLessThan(64);
    expect(hairPlan.headMask.faces.right.length).toBeLessThan(64);
    expect(hairPlan.headMask.faces.back.length).toBeLessThan(64);
  });
});
