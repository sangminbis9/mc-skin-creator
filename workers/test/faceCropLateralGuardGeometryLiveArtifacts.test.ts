import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import type { FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { buildSkinPlan } from "../src/skinPlan";

const BUILD = process.env.BUILD_FACE_CROP_LATERAL_GUARD_GEOMETRY_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-crop-lateral-guard-geometry-live-20260922-001");
const SUMMARY = path.join(ROOT, "summary.json");
const OLD_SUMMARY = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001/summary.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const TARGETS = ["warm-white-tee", "striped-open-shirt"] as const;
const EXPECTED_CROPS = {
  "warm-white-tee": "85f62ffaf83e785c62e45b4fb04306e8d5d8c69484e3a6fa084ad6f3aa188b85",
  "striped-open-shirt": "e954ede4ebe00deafa25f090d3ed374d56897832cb0a85d403a5a5f9ef59270f",
} as const;

type Target = typeof TARGETS[number];
type Box = { left: number; top: number; right: number; bottom: number };
type Crop = {
  sourceDimensions: { width: number; height: number };
  faceCropDimensions: { width: number; height: number };
  finalFaceBox: Box;
  faceCropLateralGuard?: {
    applied: boolean;
    reason: string;
    originalExpandedWidthRatio: number;
    guardedWidthRatio: number;
  };
};
type GeometryResult = {
  caseId: Target;
  sourceSha256: string;
  sourceBytes: number;
  sourceImageIndex: number;
  storedPortraitRegion: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  primaryFaceMeasurementEvidence: PhotoAnalysis["faceMeasurementEvidence"];
  primaryRelevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
  primaryFallbackFeaturesGlasses: PhotoAnalysis["fallbackFeatures"]["glasses"];
  cropContext: Record<string, unknown>;
  crop: Crop;
  faceCropSha256: string;
  faceCropEncodedBytes: number;
  httpStatus: number;
  ok: boolean;
  elapsedMs: number;
  providerShapeValid: boolean;
  semanticValidationPassed: boolean;
  errors: string[];
  measurements: Record<string, unknown> | null;
  geometry: FaceIdentityGeometryAnalysis | null;
  providerStatus: string | null;
  providerAccounting: string;
  providerCalls: Record<string, number>;
};
type Summary = {
  branch: string;
  head: string;
  selectedCases: Array<{ id: Target; photoId: number; expectedSha256: string; expectedBytes: number }>;
  classification: string;
  geometryResults: GeometryResult[];
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  prohibited: Record<string, number>;
  startupAttempts: number;
  healthAttempts: number;
  healthElapsedMs: number;
  health: { status: string; httpStatus: number };
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");

function replayAnalysis(result: GeometryResult): PhotoAnalysis {
  const stored = read<{ normalized: PhotoAnalysis }>(path.join(GENERALIZATION, "after", result.caseId, "analysis-and-plan.json"));
  const analysis = structuredClone(stored.normalized);
  analysis.sourceSelection = {
    ...analysis.sourceSelection,
    portraitImageIndex: result.sourceImageIndex,
    portraitRegion: structuredClone(result.storedPortraitRegion),
  };
  analysis.faceMeasurementEvidence = structuredClone(result.primaryFaceMeasurementEvidence);
  Object.assign(analysis.renderHints, result.primaryRelevantRenderHints);
  analysis.fallbackFeatures = { ...analysis.fallbackFeatures, glasses: result.primaryFallbackFeaturesGlasses };
  delete analysis.faceIdentityGeometry;
  delete analysis.identityGeometry;
  expect(validatePhotoAnalysis(analysis).ok, `${result.caseId}: replay analysis`).toBe(true);
  return analysis;
}

function continuous(geometry: FaceIdentityGeometryAnalysis) {
  const envelopeWidth = geometry.face.envelopeRight - geometry.face.envelopeLeft;
  const meanWidth = (geometry.eyes.leftWidth + geometry.eyes.rightWidth) / 2;
  return {
    face: { ...geometry.face, envelopeWidth },
    eyes: {
      ...geometry.eyes,
      meanWidth,
      normalizedSpacingCells: (geometry.eyes.interEyeDistance / envelopeWidth) * 7,
      normalizedFootprintCells: (meanWidth / envelopeWidth) * 8,
      confidence: geometry.confidence.eyes,
    },
    brows: geometry.brows,
    nose: geometry.nose,
    mouth: geometry.mouth,
    directLowerFaceContour: geometry.directLowerFaceContour,
  };
}

function layout(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) {
  const value = plan.layout;
  return {
    eyeSpacingTopology: value.eyeSpacingTopology,
    eyeFootprintTopology: value.eyeFootprintTopology,
    eyeOpenness: value.eyeOpenness,
    leftEyeXs: value.leftEyeXs,
    rightEyeXs: value.rightEyeXs,
    leftEyeRow: value.leftEyeRow,
    rightEyeRow: value.rightEyeRow,
    eyeTopology: value.eyeTopology,
    geometryUsage: value.geometryUsage,
  };
}

function orderedPixels(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"], eyesOnly = false) {
  return plan.pixels
    .filter(pixel => !eyesOnly || pixel.cluster === "left_eye" || pixel.cluster === "right_eye")
    .map(({ x, y, role, cluster }) => ({ x, y, role, cluster }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
}

function pixelEvidence(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) {
  const eyes = orderedPixels(plan, true);
  return {
    eyeCoordinates: eyes,
    irisCoordinates: eyes.filter(pixel => pixel.role === "iris").map(({ x, y }) => ({ x, y })),
    eyePixelCount: eyes.length,
    eyePixelHash: hash(eyes),
    fullFacePixelPlanHash: hash({ layout: plan.layout, pixels: orderedPixels(plan), glassesPlan: plan.glassesPlan, renderContract: plan.renderContract }),
  };
}

function cropSignal(before: FaceIdentityGeometryAnalysis, after: FaceIdentityGeometryAnalysis) {
  const edge = (geometry: FaceIdentityGeometryAnalysis) => ({
    left: geometry.face.envelopeLeft <= 0.01,
    right: geometry.face.envelopeRight >= 0.99,
  });
  const oldEdge = edge(before);
  const newEdge = edge(after);
  const movement = {
    envelopeLeft: after.face.envelopeLeft - before.face.envelopeLeft,
    envelopeRight: after.face.envelopeRight - before.face.envelopeRight,
    noseTowardCenter: Math.abs(before.nose.centerX - 0.5) - Math.abs(after.nose.centerX - 0.5),
    mouthTowardCenter: Math.abs(before.mouth.centerX - 0.5) - Math.abs(after.mouth.centerX - 0.5),
  };
  const oldTouched = oldEdge.left || oldEdge.right;
  const newTouched = newEdge.left || newEdge.right;
  const changed = Math.abs(movement.envelopeLeft) >= 0.02 || Math.abs(movement.envelopeRight) >= 0.02;
  return {
    oldEdge,
    newEdge,
    movement,
    classification: oldTouched && !newTouched ? "CROP_SIGNAL_RECOVERED"
      : changed && newTouched ? "CROP_SIGNAL_PARTIAL"
        : !changed ? "CROP_SIGNAL_UNCHANGED" : "CROP_SIGNAL_PARTIAL",
  };
}

function opennessClassification(before: ReturnType<typeof continuous>, after: ReturnType<typeof continuous>, afterBin: string) {
  if (afterBin === "compact") return "OPENNESS_RECOVERED";
  if (after.eyes.openness < before.eyes.openness - 0.01) return "OPENNESS_DIRECTIONAL_IMPROVEMENT";
  if (after.eyes.openness > before.eyes.openness + 0.01) return "OPENNESS_WORSE";
  return "OPENNESS_UNCHANGED";
}

function footprintClassification(before: ReturnType<typeof continuous>, after: ReturnType<typeof continuous>, afterBin: string) {
  if (afterBin === "compact") return "FOOTPRINT_RECOVERED";
  if (after.eyes.normalizedFootprintCells < before.eyes.normalizedFootprintCells - 0.05) return "FOOTPRINT_DIRECTIONAL_IMPROVEMENT";
  if (after.eyes.normalizedFootprintCells > before.eyes.normalizedFootprintCells + 0.05) return "FOOTPRINT_WORSE";
  return "FOOTPRINT_UNCHANGED";
}

function verticalPixels(crop: Crop) {
  return {
    top: Math.floor(crop.finalFaceBox.top * crop.sourceDimensions.height),
    bottom: Math.ceil(crop.finalFaceBox.bottom * crop.sourceDimensions.height),
  };
}

function buildAudit() {
  const current = read<Summary>(SUMMARY);
  const previous = read<Summary>(OLD_SUMMARY);
  expect(current.geometryResults.map(result => result.caseId)).toEqual(TARGETS);
  expect(previous.geometryResults.map(result => result.caseId)).toEqual(TARGETS);
  expect(current).toMatchObject({
    branch: "main",
    head: "0b9d6dec4346076736ad21d92b4125481808efc1",
    classification: "READY_TO_REVIEW_FACE_GEOMETRY_LOW_EYE_TARGET_AUDIT",
    startupAttempts: 1,
    healthAttempts: 1,
    qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true,
    ownedProcessInventoryClean: true,
    temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true,
    productionConfigChanged: false,
  });
  expect(current.health).toMatchObject({ status: "passed", httpStatus: 200 });
  expect(current.calls).toMatchObject({ jpegReads: 2, hashChecks: 2, base64Preparations: 2, jpegTransmissions: 2,
    primaryPosts: 0, faceCropPreparations: 2, geometryPosts: 2 });
  expect(current.providerCalls).toMatchObject({ geminiStarted: 0, gemmaStarted: 2, gemmaCompleted: 2, gemmaFailed: 0, retry: 0 });
  expect(Object.values(current.prohibited).every(value => value === 0)).toBe(true);

  const cases = current.geometryResults.map((afterResult, index) => {
    const beforeResult = previous.geometryResults[index];
    expect(beforeResult.caseId).toBe(afterResult.caseId);
    expect(afterResult.faceCropSha256).toBe(EXPECTED_CROPS[afterResult.caseId]);
    expect(afterResult.crop.faceCropLateralGuard).toMatchObject({ applied: true });
    expect(afterResult.crop.faceCropLateralGuard?.guardedWidthRatio).toBeCloseTo(0.65, 12);
    expect(afterResult).toMatchObject({ httpStatus: 200, ok: true, providerShapeValid: true, semanticValidationPassed: true, errors: [] });
    expect(afterResult.geometry).toBeTruthy();
    expect(beforeResult.geometry).toBeTruthy();
    if (!afterResult.geometry || !beforeResult.geometry) throw new Error(`${afterResult.caseId}: geometry missing`);
    expect(afterResult.sourceSha256).toBe(beforeResult.sourceSha256);
    expect(afterResult.sourceBytes).toBe(beforeResult.sourceBytes);
    expect(afterResult.sourceImageIndex).toBe(0);
    expect(afterResult.storedPortraitRegion).toEqual(beforeResult.storedPortraitRegion);
    expect(verticalPixels(afterResult.crop)).toEqual(verticalPixels(beforeResult.crop));

    const analysis = replayAnalysis(afterResult);
    const beforeAnalysis = { ...structuredClone(analysis), faceIdentityGeometry: structuredClone(beforeResult.geometry) };
    const afterAnalysis = { ...structuredClone(analysis), faceIdentityGeometry: structuredClone(afterResult.geometry) };
    const beforePlan = buildSkinPlan(beforeAnalysis);
    const afterPlan = buildSkinPlan(afterAnalysis);
    const beforeContinuous = continuous(beforeResult.geometry);
    const afterContinuous = continuous(afterResult.geometry);
    const beforeLayout = layout(beforePlan.facePixelPlan);
    const afterLayout = layout(afterPlan.facePixelPlan);
    const beforePixels = pixelEvidence(beforePlan.facePixelPlan);
    const afterPixels = pixelEvidence(afterPlan.facePixelPlan);
    const trace = resolveFaceMeasurements(afterAnalysis);
    const boundary = cropSignal(beforeResult.geometry, afterResult.geometry);
    const openness = opennessClassification(beforeContinuous, afterContinuous, afterLayout.eyeOpenness);
    const footprint = footprintClassification(beforeContinuous, afterContinuous, afterLayout.eyeFootprintTopology);
    const spacingTarget = afterResult.caseId === "warm-white-tee" ? { kind: "unscorable", values: [] }
      : { kind: "expected", values: ["medium"] };
    const spacingEffect = spacingTarget.kind === "unscorable" ? "UNSCORABLE_CHANGED"
      : afterLayout.eyeSpacingTopology === spacingTarget.values[0] ? "SPACING_RECOVERED"
        : beforeLayout.eyeSpacingTopology === afterLayout.eyeSpacingTopology ? "SPACING_UNCHANGED_MISMATCH" : "SPACING_CHANGED_MISMATCH";
    const nonEye = {
      hairPlanEqual: hash(beforePlan.hairPlan) === hash(afterPlan.hairPlan),
      headCoveringEqual: hash(beforePlan.hairPlan.headMask.coveringTopology ?? null) === hash(afterPlan.hairPlan.headMask.coveringTopology ?? null),
      glassesPlanEqual: hash(beforePlan.facePixelPlan.glassesPlan) === hash(afterPlan.facePixelPlan.glassesPlan),
      outfitPlanEqual: hash(beforePlan.outfitPlan) === hash(afterPlan.outfitPlan),
    };
    expect(Object.values(nonEye).every(Boolean), `${afterResult.caseId}: non-eye isolation`).toBe(true);
    expect(afterLayout.geometryUsage.eyes).toBe(true);
    const taxonomy = afterResult.caseId === "striped-open-shirt" && footprint === "FOOTPRINT_RECOVERED"
      ? "PARTIAL_GEOMETRY_RECOVERY"
      : boundary.classification === "CROP_SIGNAL_RECOVERED"
        ? "CROP_FIXED_MEASUREMENT_STILL_WRONG" : "CROP_STILL_INVALID";
    return {
      caseId: afterResult.caseId,
      source: { sha256: afterResult.sourceSha256, bytes: afterResult.sourceBytes, portraitImageIndex: afterResult.sourceImageIndex,
        storedPortraitRegion: afterResult.storedPortraitRegion },
      crop: { before: { hash: beforeResult.faceCropSha256, dimensions: beforeResult.crop.faceCropDimensions,
        finalBox: beforeResult.crop.finalFaceBox, verticalPixels: verticalPixels(beforeResult.crop) },
      after: { hash: afterResult.faceCropSha256, dimensions: afterResult.crop.faceCropDimensions,
        finalBox: afterResult.crop.finalFaceBox, verticalPixels: verticalPixels(afterResult.crop), guard: afterResult.crop.faceCropLateralGuard },
      verticalUnchanged: JSON.stringify(verticalPixels(afterResult.crop)) === JSON.stringify(verticalPixels(beforeResult.crop)) },
      provider: { httpStatus: afterResult.httpStatus, elapsedMs: afterResult.elapsedMs, providerStatus: afterResult.providerStatus,
        providerShapeValid: afterResult.providerShapeValid, semanticValidationPassed: afterResult.semanticValidationPassed,
        errors: afterResult.errors, accounting: afterResult.providerCalls },
      raw: { before: beforeContinuous, after: afterContinuous, boundary },
      quantization: { before: beforeLayout, after: afterLayout, openness, footprint, spacingTarget, spacingEffect },
      pixels: { before: beforePixels, after: afterPixels,
        eyePixelsChanged: beforePixels.eyePixelHash !== afterPixels.eyePixelHash,
        fullFacePlanChanged: beforePixels.fullFacePixelPlanHash !== afterPixels.fullFacePixelPlanHash },
      nonEye,
      measurementTrace: {
        eyeSpacing: trace.eyeSpacing.selected,
        eyeOpenness: trace.eyeOpenness.selected,
        eyeFootprint: trace.eyeFootprint.selected,
        geometryUsageEyes: afterLayout.geometryUsage.eyes,
        classification: afterLayout.geometryUsage.eyes && trace.eyeSpacing.selected !== "continuous_geometry"
          ? "TRACE_PROVENANCE_INCONSISTENCY" : "TRACE_CONSISTENT",
      },
      taxonomy,
    };
  });
  expect(cases.map(item => item.taxonomy)).toEqual(["CROP_STILL_INVALID", "PARTIAL_GEOMETRY_RECOVERY"]);
  expect(cases.map(item => item.quantization.footprint)).toEqual(["FOOTPRINT_UNCHANGED", "FOOTPRINT_RECOVERED"]);
  expect(cases.map(item => item.quantization.openness)).toEqual(["OPENNESS_UNCHANGED", "OPENNESS_UNCHANGED"]);
  return { current, previous, cases, overall: "LATERAL_GUARD_PARTIAL_RECOVERY" as const };
}

it("replays corrected live geometry through frozen quantization and FacePixelPlan", () => {
  const audit = buildAudit();
  expect(audit.cases.every(item => item.provider.providerShapeValid && item.provider.semanticValidationPassed)).toBe(true);
  expect(audit.cases.every(item => item.crop.verticalUnchanged)).toBe(true);
  expect(audit.cases.every(item => item.pixels.eyePixelsChanged && item.pixels.fullFacePlanChanged)).toBe(true);
  expect(audit.cases.every(item => item.measurementTrace.classification === "TRACE_PROVENANCE_INCONSISTENCY")).toBe(true);
});

it.skipIf(!BUILD)("writes the lateral-guard live geometry comparison artifacts", () => {
  const audit = buildAudit();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("source-verification.json", { cases: audit.cases.map(item => ({ caseId: item.caseId, ...item.source })) });
  write("crop-verification.json", { cases: audit.cases.map(item => ({ caseId: item.caseId, ...item.crop })) });
  write("geometry-before-after.json", { cases: audit.cases.map(item => ({ caseId: item.caseId, provider: item.provider, ...item.raw })) });
  write("quantization-before-after.json", { cases: audit.cases.map(item => ({ caseId: item.caseId, ...item.quantization, taxonomy: item.taxonomy })) });
  write("plan-comparison.json", { cases: audit.cases.map(item => ({ caseId: item.caseId, layout: { before: item.quantization.before, after: item.quantization.after },
    pixels: item.pixels, nonEye: item.nonEye, measurementTrace: item.measurementTrace })) });
  write("retention-summary.json", {
    overallClassification: audit.overall,
    cases: audit.cases.map(item => ({ caseId: item.caseId, cropSignal: item.raw.boundary.classification,
      openness: item.quantization.openness, footprint: item.quantization.footprint, spacing: item.quantization.spacingEffect,
      taxonomy: item.taxonomy, geometryUsageEyes: item.measurementTrace.geometryUsageEyes,
      trace: item.measurementTrace.classification, eyePixelsChanged: item.pixels.eyePixelsChanged,
      fullFacePlanChanged: item.pixels.fullFacePlanChanged, nonEye: item.nonEye })),
    lifecycle: { startupAttempts: audit.current.startupAttempts, healthAttempts: audit.current.healthAttempts,
      health: audit.current.health, qSentCount: audit.current.qSentCount,
      gracefulTeardown: audit.current.wranglerGracefulTeardownPathCompleted,
      inventoryClean: audit.current.ownedProcessInventoryClean,
      temporaryConfigRemoved: audit.current.temporaryConfigRemoved,
      temporaryTokenFileRemoved: audit.current.temporaryTokenFileRemoved,
      productionConfigChanged: audit.current.productionConfigChanged },
    callAccounting: { calls: audit.current.calls, providers: audit.current.providerCalls, prohibited: audit.current.prohibited },
  });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face-crop lateral guard targeted live geometry retest\n\n` +
    `- Remote startup 1, protected health 1/1 HTTP 200, geometry POST 2.\n` +
    `- Corrected crop hashes matched the offline guard artifacts exactly.\n` +
    `- Warm: envelope 0.12..1.00 -> 0.18..1.00; openness 0.70 -> 0.70; footprint cells 1.818 -> 1.805 (medium -> medium). Crop signal remains partial because the right envelope still touches 1.00.\n` +
    `- Striped: envelope 0.00..0.95 -> 0.03..0.99; openness 0.70 -> 0.70; footprint cells 2.109 -> 1.271 (wide -> compact). Nose/mouth centre bias moved toward the crop centre.\n` +
    `- Both accepted geometry results reached FaceLayoutPlan and changed eye/full FacePixelPlan hashes.\n` +
    `- HairPlan, head covering, GlassesPlan, and OutfitPlan remained unchanged.\n` +
    `- measurementTrace remains categorical_grammar while geometryUsage.eyes=true: TRACE_PROVENANCE_INCONSISTENCY (observed only, not fixed).\n` +
    `- Literal q exactly once; graceful teardown, process inventory, temporary cleanup, and production config hash all passed.\n` +
    `- No primary, full-geometry, detail, generation, critique, pairwise, or evaluator calls.\n\n${audit.overall}\n`, { flag: "wx" });
});
