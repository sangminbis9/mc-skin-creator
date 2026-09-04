import { describe, expect, it, vi } from "vitest";
import { applyCropVisibility, cropNormalizedToSource, IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX, IDENTITY_GEOMETRY_COMPACT_SCHEMA, IDENTITY_GEOMETRY_PROMPT, IDENTITY_GEOMETRY_SCHEMA, IDENTITY_GEOMETRY_WIRE_SCHEMA, normalizeIdentityGeometryCompactResponse, normalizeIdentityGeometryWireResponse, parseIdentityGeometry, runIdentityGeometryAnalysis, sourceNormalizedToCrop } from "../src/identityGeometry";
import type { Env } from "../src/types";
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
    expect(IDENTITY_GEOMETRY_WIRE_SCHEMA.required).not.toContain("coordinateSpaces");
    expect(IDENTITY_GEOMETRY_WIRE_SCHEMA.required).not.toContain("faceWindow");
    expect(IDENTITY_GEOMETRY_WIRE_SCHEMA.required).toContain("occlusion");
    expect(IDENTITY_GEOMETRY_COMPACT_SCHEMA.required).toContain("temples");
    expect(IDENTITY_GEOMETRY_COMPACT_SCHEMA.required).not.toContain("confidence");
    expect(IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX).toMatch(/viewer-left, viewer-right/);
  });

  it("normalizes the compact wire response into rich internal geometry", () => {
    const geometry = makeIdentityGeometry();
    const { interEyeDistance: _interEyeDistance, verticalAsymmetry: _verticalAsymmetry, ...eyes } = geometry.eyes;
    const { tilt: _tilt, ...brows } = geometry.brows;
    const { leftRightBias: _leftRightBias, ...nose } = geometry.nose;
    const { asymmetry: _hairlineAsymmetry, ...hairline } = geometry.hairline;
    const { leftTempleTransitionY: _leftTransition, rightTempleTransitionY: _rightTransition, ...fringe } = geometry.fringe;
    const { asymmetry: _templeAsymmetry, confidence: _templeConfidence, ...temple } = geometry.temple;
    const { asymmetry: _crownAsymmetry, evidence: _crownEvidence, confidence: _crownConfidence, ...crown } = geometry.crown;
    void [_interEyeDistance, _verticalAsymmetry, _tilt, _leftRightBias, _hairlineAsymmetry,
      _leftTransition, _rightTransition, _templeAsymmetry, _templeConfidence,
      _crownAsymmetry, _crownEvidence, _crownConfidence];
    const wire = {
      face: geometry.face, eyes, brows, nose, mouth: geometry.mouth, hairline, fringe, temple, crown,
      majorVolumePeaks: geometry.majorVolumePeaks,
      occlusion: { crown: false, leftHair: false, rightHair: false, chin: false, leftEar: false, rightEar: false },
      headSilhouette: geometry.headSilhouette, glasses: geometry.glasses, confidence: geometry.confidence,
    };
    const normalized = normalizeIdentityGeometryWireResponse(wire, {
      cropClippingKnown: true, sourceClippingKnown: false,
      crownClipped: false, leftHairClipped: false, rightHairClipped: false,
      chinClipped: false, leftEarClipped: false, rightEarClipped: false,
    });
    const parsed = normalized ? parseIdentityGeometry(normalized) : null;
    expect(parsed).not.toBeNull();
    expect(parsed!.coordinateSpaces).toEqual({ faceMeasurements: "tight_face_crop", headMeasurements: "wide_head_crop" });
    expect(parsed!.eyes.interEyeDistance).toBeCloseTo(geometry.eyes.rightCenterX - geometry.eyes.leftCenterX);
    expect(parsed!.fringe.leftTempleTransitionY).toBe(geometry.temple.leftStartY);
    expect(parsed!.faceWindow.leftEvidence).toBe("inferred");
    expect(parsed!.diagnostics.provenance["crown.left"]).toBe("observed_geometry");
    expect(parsed!.diagnostics.provenance["faceWindow.left"]).toBe("derived_geometry");
    expect(parsed!.visibility.sourceClippingKnown).toBe(false);
  });

  it("normalizes the compact provider grammar before deterministic derivation", () => {
    const geometry = makeIdentityGeometry();
    const compact = {
      face: { ...geometry.face, confidence: geometry.confidence.faceBounds },
      eyes: {
        sides: [
          { x: geometry.eyes.leftCenterX, y: geometry.eyes.leftCenterY, width: geometry.eyes.leftWidth },
          { x: geometry.eyes.rightCenterX, y: geometry.eyes.rightCenterY, width: geometry.eyes.rightWidth },
        ],
        openness: geometry.eyes.openness,
        confidence: geometry.confidence.eyes,
      },
      brows: { yBySide: [geometry.brows.leftY, geometry.brows.rightY], thickness: geometry.brows.thickness, confidence: geometry.confidence.brows },
      nose: { x: geometry.nose.centerX, y: geometry.nose.contrastY, strength: geometry.nose.visibleStrength, confidence: geometry.confidence.nose },
      mouth: { x: geometry.mouth.centerX, y: geometry.mouth.centerY, width: geometry.mouth.width, cornerYBySide: [geometry.mouth.leftCornerY, geometry.mouth.rightCornerY], opening: geometry.mouth.opening, confidence: geometry.confidence.mouth },
      hairline: { depthByColumn: geometry.hairline.depthByColumn, openingBySide: [geometry.hairline.foreheadOpeningLeft, geometry.hairline.foreheadOpeningRight], evidence: "observed", confidence: geometry.confidence.hairline },
      fringe: { visible: geometry.fringe.visible, peaks: geometry.fringe.peaks.map((peak) => ({ x: peak.x, y: peak.depthY, prominence: peak.prominence })), direction: geometry.fringe.direction, openingVisible: true, openingX: geometry.fringe.openingCenterX, openingWidth: geometry.fringe.openingWidth, evidence: geometry.fringe.evidence, confidence: geometry.fringe.confidence },
      temples: [
        { value: geometry.temple.leftRecession, y: geometry.temple.leftStartY, evidence: geometry.temple.leftEvidence, confidence: geometry.temple.leftConfidence },
        { value: geometry.temple.rightRecession, y: geometry.temple.rightStartY, evidence: geometry.temple.rightEvidence, confidence: geometry.temple.rightConfidence },
      ],
      crown: {
        sides: [
          { value: geometry.crown.leftY, y: geometry.crown.leftWidth, evidence: geometry.crown.leftEvidence, confidence: geometry.crown.leftConfidence },
          { value: geometry.crown.centerY, y: 0, evidence: geometry.crown.centerEvidence, confidence: geometry.crown.centerConfidence },
          { value: geometry.crown.rightY, y: geometry.crown.rightWidth, evidence: geometry.crown.rightEvidence, confidence: geometry.crown.rightConfidence },
        ],
        apexX: geometry.crown.apexX,
      },
      majorVolumePeaks: geometry.majorVolumePeaks.map((peak) => ({ ...peak, y: peak.verticalCenter, extent: peak.verticalExtent, verticalCenter: undefined, verticalExtent: undefined })),
      occlusion: { crown: false, leftHair: false, rightHair: false, chin: false, leftEar: false, rightEar: false },
      headSilhouette: {
        crownTopY: geometry.headSilhouette.crownTopY,
        leftContourByRow: geometry.headSilhouette.leftContourByRow,
        rightContourByRow: geometry.headSilhouette.rightContourByRow,
        sideVolumeBySide: [geometry.headSilhouette.sideVolumeLeft, geometry.headSilhouette.sideVolumeRight],
        partVisible: true,
        partX: geometry.headSilhouette.partCenterX,
        endpointYBySide: [geometry.headSilhouette.hairEndpointLeftY, geometry.headSilhouette.hairEndpointRightY],
        foreheadExposure: geometry.headSilhouette.foreheadExposure,
        earExposureBySide: [geometry.headSilhouette.earExposureLeft, geometry.headSilhouette.earExposureRight],
        coveringVisible: false,
        coveringLeftContourByRow: Array(8).fill(0),
        coveringRightContourByRow: Array(8).fill(1),
        evidence: "observed",
        confidence: geometry.headSilhouette.confidence,
      },
      glasses: {
        visible: true,
        leftBox: [geometry.glasses!.leftBox.left, geometry.glasses!.leftBox.top, geometry.glasses!.leftBox.right, geometry.glasses!.leftBox.bottom],
        rightBox: [geometry.glasses!.rightBox.left, geometry.glasses!.rightBox.top, geometry.glasses!.rightBox.right, geometry.glasses!.rightBox.bottom],
        bridgeX: geometry.glasses!.bridgeCenterX,
        bridgeY: geometry.glasses!.bridgeY,
        thickness: geometry.glasses!.thickness,
        confidence: geometry.confidence.glasses,
      },
    };
    const normalized = normalizeIdentityGeometryCompactResponse(compact, {
      cropClippingKnown: true, sourceClippingKnown: true,
      crownClipped: false, leftHairClipped: false, rightHairClipped: false,
      chinClipped: false, leftEarClipped: false, rightEarClipped: false,
      sourceCrownClipped: false, sourceLeftHairClipped: false,
      sourceRightHairClipped: false, sourceChinClipped: false,
    });
    const parsed = normalized ? parseIdentityGeometry(normalized) : null;
    expect(parsed).not.toBeNull();
    expect(parsed!.temple).toMatchObject({ leftRecession: geometry.temple.leftRecession, rightRecession: geometry.temple.rightRecession });
    expect(parsed!.crown).toMatchObject({ leftY: geometry.crown.leftY, centerY: geometry.crown.centerY, rightY: geometry.crown.rightY });
    expect(parsed!.majorVolumePeaks).toEqual(geometry.majorVolumePeaks);
    expect(parsed!.glasses).toEqual(geometry.glasses);
    expect(parsed!.faceWindow.leftEvidence).toBe("inferred");
    expect(parsed!.diagnostics.derivedMeasurements).toEqual(expect.arrayContaining(["faceWindow", "faceShape"]));
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

  it("does not treat clipping flags as facts when that coordinate space is unknown", () => {
    const adjusted = applyCropVisibility(makeIdentityGeometry(), {
      cropClippingKnown: false,
      sourceClippingKnown: false,
      crownClipped: true,
      leftHairClipped: true,
      rightHairClipped: true,
      chinClipped: true,
      leftEarClipped: true,
      rightEarClipped: true,
      sourceCrownClipped: true,
      sourceLeftHairClipped: true,
      sourceRightHairClipped: true,
      sourceChinClipped: true,
    });

    expect(adjusted.crown.leftEvidence).toBe("observed");
    expect(adjusted.temple.leftEvidence).toBe("observed");
    expect(adjusted.faceShape.evidence).toBe("observed");
  });
});

describe("identity geometry measurement protocol and adversarial validation", () => {
  it("round-trips off-center face and head crop coordinates through source space", () => {
    const sourcePoint = { x: 0.43, y: 0.31 };
    const faceCrop = { left: 0.22, top: 0.11, right: 0.69, bottom: 0.73 };
    const headCrop = { left: 0.04, top: 0.02, right: 0.91, bottom: 0.82 };
    const facePoint = sourceNormalizedToCrop(sourcePoint, faceCrop);
    const recoveredSource = cropNormalizedToSource(facePoint, faceCrop);
    const headPoint = sourceNormalizedToCrop(recoveredSource, headCrop);
    expect(recoveredSource.x).toBeCloseTo(sourcePoint.x, 12);
    expect(recoveredSource.y).toBeCloseTo(sourcePoint.y, 12);
    expect(cropNormalizedToSource(headPoint, headCrop)).toEqual(expect.objectContaining({ x: expect.closeTo(sourcePoint.x, 12), y: expect.closeTo(sourcePoint.y, 12) }));
  });

  it("rejects an explicit tight-face / wide-head coordinate-space swap", () => {
    const raw = makeIdentityGeometry();
    expect(parseIdentityGeometry({
      ...raw,
      coordinateSpaces: { faceMeasurements: "wide_head_crop", headMeasurements: "tight_face_crop" },
    })).toBeNull();
  });

  it("degrades unknown high-confidence evidence and source-clipped crown claims", () => {
    const raw = makeIdentityGeometry();
    const parsed = parseIdentityGeometry({
      ...raw,
      crown: {
        ...raw.crown,
        evidence: "unknown", leftEvidence: "unknown", centerEvidence: "observed", rightEvidence: "observed",
        leftConfidence: 0.95, centerConfidence: 0.95, rightConfidence: 0.9, confidence: 0.95,
      },
      visibility: { ...raw.visibility, sourceCrownClipped: true },
    })!;
    expect(parsed.crown.leftConfidence).toBe(0.34);
    expect(parsed.crown.centerEvidence).toBe("inferred");
    expect(parsed.crown.centerConfidence).toBe(0.45);
    expect(parsed.diagnostics.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["evidence_confidence_conflict", "clipping_evidence_conflict"]));
  });

  it("removes fringe and volume peaks outside their measured regions", () => {
    const raw = makeIdentityGeometry();
    const parsed = parseIdentityGeometry({
      ...raw,
      fringe: { ...raw.fringe, peaks: [{ x: 0.52, depthY: 0.95, prominence: 0.9 }] },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.9, verticalCenter: 0.82, verticalExtent: 0.2, evidence: "observed", confidence: 0.9 },
        { region: "side_right", protrusion: 0.7, verticalCenter: 0.45, verticalExtent: 0.3, evidence: "observed", confidence: 0.9 },
      ],
    })!;
    expect(parsed.fringe.peaks).toEqual([]);
    expect(parsed.majorVolumePeaks.map((peak) => peak.region)).toEqual(["side_right"]);
    expect(parsed.diagnostics.issues.filter((issue) => issue.action === "removed")).toHaveLength(2);
  });

  it("degrades impossible face windows and temple/face-window contradictions locally", () => {
    const raw = makeIdentityGeometry();
    const impossible = parseIdentityGeometry({
      ...raw,
      faceWindow: { ...raw.faceWindow, visibleFaceWidthAtEyes: 0.08, leftTempleWidth: 0.98 },
      temple: { ...raw.temple, leftRecession: 0.05 },
    })!;
    expect(impossible.faceWindow.leftEvidence).toBe("unknown");
    expect(impossible.faceWindow.confidence).toBe(0.34);
    expect(impossible.diagnostics.issues.some((issue) => issue.field === "faceWindow.width")).toBe(true);

    const contradiction = parseIdentityGeometry({
      ...raw,
      faceWindow: { ...raw.faceWindow, leftTempleWidth: 0.98 },
      temple: { ...raw.temple, leftRecession: 0.05 },
    })!;
    expect(contradiction.temple.leftEvidence).toBe("inferred");
    expect(contradiction.temple.leftConfidence).toBe(0.49);
  });

  it("degrades face-window and volume measurements that contradict derived landmarks", () => {
    const raw = makeIdentityGeometry();
    const parsed = parseIdentityGeometry({
      ...raw,
      faceWindow: {
        ...raw.faceWindow,
        leftEyeToHairDistance: 0.95,
        rightEyeToHairDistance: 0.95,
        confidence: 0.8,
        leftConfidence: 0.8,
        rightConfidence: 0.8,
      },
      majorVolumePeaks: [
        { region: "side_left", protrusion: 0.01, verticalCenter: 0.46, verticalExtent: 0.3, evidence: "observed", confidence: 0.9 },
      ],
    })!;

    expect(parsed.faceWindow.leftEvidence).toBe("inferred");
    expect(parsed.faceWindow.rightEvidence).toBe("inferred");
    expect(parsed.majorVolumePeaks[0]).toMatchObject({ evidence: "inferred", confidence: 0.49 });
    expect(parsed.diagnostics.issues.filter((issue) => issue.code === "cross_field_conflict").length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the visible side observed while degrading a one-side occlusion", () => {
    const raw = makeIdentityGeometry();
    const parsed = parseIdentityGeometry({
      ...raw,
      visibility: { ...raw.visibility, leftHairOccluded: true, leftEarOccluded: true },
    })!;
    expect(parsed.temple.leftEvidence).toBe("inferred");
    expect(parsed.temple.leftConfidence).toBe(0.45);
    expect(parsed.temple.rightEvidence).toBe("observed");
    expect(parsed.diagnostics.completeness.leftTempleObserved).toBe(false);
    expect(parsed.diagnostics.completeness.rightTempleObserved).toBe(true);
  });

  it("keeps head-covering contour separate from hair crown and curl volume", () => {
    const raw = makeIdentityGeometry();
    const parsed = parseIdentityGeometry({
      ...raw,
      headSilhouette: {
        ...raw.headSilhouette,
        covering: { leftContourByRow: raw.headSilhouette.leftContourByRow, rightContourByRow: raw.headSilhouette.rightContourByRow },
      },
      majorVolumePeaks: [
        ...raw.majorVolumePeaks,
        { region: "crown_right", protrusion: 0.7, verticalCenter: 0.15, verticalExtent: 0.2, evidence: "observed", confidence: 0.9 },
      ],
    })!;
    expect(parsed.crown.leftEvidence).toBe("unknown");
    expect(parsed.majorVolumePeaks.some((peak) => peak.region.startsWith("crown"))).toBe(false);
    expect(parsed.headSilhouette.covering).not.toBeNull();
  });

  it("records completeness and pixel-plan provenance without semantic overwrite", () => {
    const raw = makeIdentityGeometry();
    const geometry = parseIdentityGeometry({
      ...raw,
      temple: { ...raw.temple, rightEvidence: "unknown", rightConfidence: 0.9 },
    })!;
    const plans = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: geometry }));
    expect(geometry.diagnostics.completeness).toMatchObject({ leftTempleObserved: true, rightTempleObserved: false });
    expect(plans.facePixelPlan.layout.geometryProvenance["temple.left"]).toBe("observed_geometry");
    expect(plans.facePixelPlan.layout.geometryProvenance["temple.right"]).toBe("semantic_fallback");
    expect(plans.hairPlan.structure.geometryProvenance["temple.left"]).toBe("observed_geometry");
    expect(plans.headIdentityPlan.geometryProvenance["temple.right"]).toBe("semantic_fallback");
  });

  it("performs exactly one provider call and never falls through to Workers AI", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const workersRun = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await runIdentityGeometryAnalysis({
        GEMINI_API_KEY: "fixture-key",
        VISION_MODEL: "fixture-primary",
        VISION_FALLBACK_MODEL: "fixture-must-not-run",
        AI: { run: workersRun } as unknown as Env["AI"],
      } as Env, "data:image/png;base64,AA==", "data:image/png;base64,AA==", makeAnalysis());
      expect(result.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(workersRun).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("creates deterministic hair candidates for salient low-confidence fringe and crown boundaries", () => {
    const base = makeIdentityGeometry();
    const geometry = parseIdentityGeometry({
      ...base,
      fringe: {
        ...base.fringe,
        peaks: [{ x: 2.5 / 7, depthY: 0.68, prominence: 0.8 }],
        confidence: 0.7,
      },
      crown: {
        ...base.crown,
        apexX: 3.5 / 7,
        centerConfidence: 0.7,
        confidence: 0.7,
      },
    })!;
    const analysis = makeAnalysis({ identityGeometry: geometry });
    const variants = buildFacePixelPlanVariants(analysis, 3);
    expect(variants).toHaveLength(3);
    expect(variants.some((plan) => plan.layout.fringePeaks[0]?.column !== variants[0].layout.fringePeaks[0]?.column)).toBe(true);
    expect(variants[0].layout.quantizationAmbiguities.some((ambiguity) => ambiguity.axis === "crown_apex")).toBe(true);
    expect(variants).toEqual(buildFacePixelPlanVariants(analysis, 3));
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
