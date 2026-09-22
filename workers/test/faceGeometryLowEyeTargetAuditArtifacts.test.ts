import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import type { FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { createIdentityCrops } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { base64ToBytes, bytesToBase64, decodeImage, encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";

const BUILD = process.env.BUILD_FACE_GEOMETRY_LOW_EYE_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001");
const SUMMARY = path.join(ROOT, "summary.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const SENTINEL = path.resolve("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
const TARGETS = ["warm-white-tee", "striped-open-shirt"] as const;
const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");

type GeometryResult = {
  caseId: typeof TARGETS[number];
  sourceSha256: string;
  sourceBytes: number;
  sourceImageIndex: number;
  storedPortraitRegion: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  primaryFaceMeasurementEvidence: PhotoAnalysis["faceMeasurementEvidence"];
  primaryRelevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
  primaryFallbackFeaturesGlasses: PhotoAnalysis["fallbackFeatures"]["glasses"];
  cropContext: AdaptiveHeadCropContext;
  crop: { sourceDimensions: { width: number; height: number }; faceCropDimensions: { width: number; height: number }; finalFaceBox: unknown; quality: { usableForFaceGeometry: boolean } };
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
  providerCalls: Record<string, number>;
};
type Summary = {
  branch: string;
  head: string;
  classification: string;
  geometryResults: GeometryResult[];
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  prohibited: Record<string, number>;
  startupAttempts: number;
  healthAttempts: number;
  health: { status: string; httpStatus: number };
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const orderedPixels = (plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"], eyeOnly = false) => plan.pixels
  .filter(pixel => !eyeOnly || pixel.cluster === "left_eye" || pixel.cluster === "right_eye")
  .map(({ x, y, role, cluster }) => ({ x, y, role, cluster }))
  .sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
const coordinates = (pixels: ReturnType<typeof orderedPixels>) => pixels.map(({ x, y, role, cluster }) => ({ x, y, role, cluster }));
const planHash = (plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) => hash({
  layout: plan.layout,
  pixels: orderedPixels(plan),
  glassesPlan: plan.glassesPlan,
  renderContract: plan.renderContract,
});

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
  const validation = validatePhotoAnalysis(analysis);
  expect(validation.ok, `${result.caseId}: replay analysis validation`).toBe(true);
  return analysis;
}

function layoutOf(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) {
  const layout = plan.layout;
  return {
    eyeSpacingTopology: layout.eyeSpacingTopology,
    eyeFootprintTopology: layout.eyeFootprintTopology,
    eyeOpenness: layout.eyeOpenness,
    leftEyeXs: layout.leftEyeXs,
    rightEyeXs: layout.rightEyeXs,
    leftEyeRow: layout.leftEyeRow,
    rightEyeRow: layout.rightEyeRow,
    eyeTopology: layout.eyeTopology,
    brow: { leftRow: layout.leftBrowRow, rightRow: layout.rightBrowRow, distance: layout.browDistanceTopology, slope: layout.browSlopeTopology },
    nose: { x: layout.noseX, y: layout.noseY, strength: layout.noseStrength },
    mouth: { x: layout.mouthCenterX, row: layout.mouthRow, width: layout.mouthWidth, opening: layout.mouthOpening, topology: layout.mouthTopology },
    geometryUsage: layout.geometryUsage,
    source: plan.source,
  };
}

function continuousEyes(geometry: FaceIdentityGeometryAnalysis) {
  const faceWidth = geometry.face.envelopeRight - geometry.face.envelopeLeft;
  return {
    confidence: geometry.confidence.eyes,
    leftCenterX: geometry.eyes.leftCenterX,
    rightCenterX: geometry.eyes.rightCenterX,
    leftCenterY: geometry.eyes.leftCenterY,
    rightCenterY: geometry.eyes.rightCenterY,
    leftWidth: geometry.eyes.leftWidth,
    rightWidth: geometry.eyes.rightWidth,
    interEyeDistance: geometry.eyes.interEyeDistance,
    openness: geometry.eyes.openness,
    normalizedSpacingCells: ((geometry.eyes.rightCenterX - geometry.eyes.leftCenterX) / faceWidth) * 7,
    normalizedFootprintCells: (((geometry.eyes.leftWidth + geometry.eyes.rightWidth) / 2) / faceWidth) * 8,
  };
}

function recovery(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"], usable: boolean) {
  if (!usable) return "GEOMETRY_EYES_UNUSABLE";
  const openness = plan.layout.eyeOpenness === "compact";
  const footprint = plan.layout.eyeFootprintTopology === "compact";
  if (openness && footprint) return "GEOMETRY_RECOVERS_BOTH";
  if (openness) return "GEOMETRY_RECOVERS_OPENNESS_ONLY";
  if (footprint) return "GEOMETRY_RECOVERS_FOOTPRINT_ONLY";
  return "GEOMETRY_STILL_MIDDLE";
}

function compositeCell(target: RawImage, source: RawImage, column: number, row: number, cell = 192) {
  const fitted = scaleNearestNeighbor(source, cell, cell);
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const readOffset = (y * cell + x) * 4;
    const writeOffset = (((row * cell + y) * target.width) + column * cell + x) * 4;
    const alpha = fitted.rgba[readOffset + 3];
    if (alpha === 0) target.rgba.set([236, 239, 244, 255], writeOffset);
    else target.rgba.set(fitted.rgba.subarray(readOffset, readOffset + 4), writeOffset);
  }
}

function renderFacePixelPlan(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"], scale = 24): RawImage {
  const width = 8 * scale;
  const height = 8 * scale;
  const rgba = new Uint8Array(width * height * 4);
  const color = (role: string): [number, number, number, number] => {
    if (role === "iris") return [52, 75, 83, 255];
    if (role === "sclera") return [231, 225, 211, 255];
    if (role === "brow") return [35, 27, 23, 255];
    if (role.startsWith("nose")) return [156, 104, 83, 255];
    if (role === "lip") return [157, 78, 89, 255];
    if (role === "teeth") return [236, 229, 210, 255];
    if (role === "mouth_shadow") return [75, 37, 42, 255];
    if (role === "glasses") return [190, 196, 202, 255];
    if (role.startsWith("hair")) return [55, 42, 35, 255];
    return [181, 126, 91, 255];
  };
  for (const pixel of plan.pixels) for (let y = pixel.y * scale; y < (pixel.y + 1) * scale; y++) {
    for (let x = pixel.x * scale; x < (pixel.x + 1) * scale; x++) rgba.set(color(pixel.role), (y * width + x) * 4);
  }
  return { width, height, rgba };
}

async function buildAudit() {
  const summary = read<Summary>(SUMMARY);
  expect(summary.geometryResults.map(item => item.caseId)).toEqual(TARGETS);
  expect(summary).toMatchObject({
    classification: "READY_TO_REVIEW_FACE_GEOMETRY_LOW_EYE_TARGET_AUDIT",
    startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true, ownedProcessInventoryClean: true,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
  });
  expect(summary.health).toMatchObject({ status: "passed", httpStatus: 200 });
  expect(summary.calls).toMatchObject({ jpegReads: 2, hashChecks: 2, base64Preparations: 2,
    jpegTransmissions: 2, primaryPosts: 0, faceCropPreparations: 2, geometryPosts: 2 });
  expect(summary.providerCalls).toMatchObject({ geminiStarted: 0, gemmaStarted: 2, gemmaCompleted: 2, gemmaFailed: 0, retry: 0 });
  expect(Object.values(summary.prohibited).every(value => value === 0)).toBe(true);

  const sheet: RawImage = { width: 192 * 3, height: 192 * 2, rgba: new Uint8Array(192 * 3 * 192 * 2 * 4) };
  const cases = [];
  for (let row = 0; row < summary.geometryResults.length; row++) {
    const result = summary.geometryResults[row];
    expect(result.httpStatus).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.providerShapeValid).toBe(true);
    expect(result.semanticValidationPassed).toBe(true);
    expect(result.geometry).toBeTruthy();
    if (!result.geometry) throw new Error(`${result.caseId}: geometry missing`);
    const baselineAnalysis = replayAnalysis(result);
    const geometryAnalysis = { ...structuredClone(baselineAnalysis), faceIdentityGeometry: structuredClone(result.geometry) };
    const baseline = buildSkinPlan(baselineAnalysis);
    const geometryOn = buildSkinPlan(geometryAnalysis);
    const baselineTrace = resolveFaceMeasurements(baselineAnalysis);
    const geometryTrace = resolveFaceMeasurements(geometryAnalysis);
    const usable = result.geometry.confidence.eyes >= 0.55;
    const eyeBefore = orderedPixels(baseline.facePixelPlan, true);
    const eyeAfter = orderedPixels(geometryOn.facePixelPlan, true);
    const nonEye = {
      hairPlanEqual: hash(baseline.hairPlan) === hash(geometryOn.hairPlan),
      headCoveringEqual: hash(baseline.hairPlan.headMask.coveringTopology ?? null) === hash(geometryOn.hairPlan.headMask.coveringTopology ?? null),
      glassesPlanEqual: hash(baseline.facePixelPlan.glassesPlan) === hash(geometryOn.facePixelPlan.glassesPlan),
      outfitPlanEqual: hash(baseline.outfitPlan) === hash(geometryOn.outfitPlan),
    };
    expect(Object.values(nonEye).every(Boolean), `${result.caseId}: non-eye frozen plans`).toBe(true);
    expect(baselineAnalysis.fallbackFeatures.glasses).toBe("none");
    expect(geometryOn.facePixelPlan.layout.geometryUsage.eyes).toBe(usable);
    const resultRow = {
      caseId: result.caseId,
      rubric: { eyeOpenness: "narrow", eyeFootprint: "compact" },
      replayBasis: "frozen normalized rich analysis plus exact retained live sourceSelection, faceMeasurementEvidence, relevant face renderHints, and glasses token",
      geometry: { ok: result.ok, providerShapeValid: result.providerShapeValid,
        semanticValidationPassed: result.semanticValidationPassed, elapsedMs: result.elapsedMs,
        eyeUsable: usable, eyes: continuousEyes(result.geometry) },
      measurementTrace: {
        baseline: Object.fromEntries(Object.entries(baselineTrace).map(([key, value]) => [key, value.selected])),
        geometryOn: Object.fromEntries(Object.entries(geometryTrace).map(([key, value]) => [key, value.selected])),
        effectiveLayoutGeometryUsage: geometryOn.facePixelPlan.layout.geometryUsage.eyes,
        traceConsistentWithEffectiveLayout: geometryTrace.eyeSpacing.selected === "continuous_geometry"
          && geometryTrace.eyeOpenness.selected === "continuous_geometry"
          && geometryTrace.eyeFootprint.selected === "continuous_geometry",
      },
      layout: { baseline: layoutOf(baseline.facePixelPlan), geometryOn: layoutOf(geometryOn.facePixelPlan) },
      pixels: {
        baselineEyeCoordinates: coordinates(eyeBefore), geometryEyeCoordinates: coordinates(eyeAfter),
        baselineEyePixelCount: eyeBefore.length, geometryEyePixelCount: eyeAfter.length,
        baselineIrisCoordinates: eyeBefore.filter(pixel => pixel.role === "iris").map(({ x, y }) => ({ x, y })),
        geometryIrisCoordinates: eyeAfter.filter(pixel => pixel.role === "iris").map(({ x, y }) => ({ x, y })),
        baselineEyeHash: hash(eyeBefore), geometryEyeHash: hash(eyeAfter),
        baselineFacePlanHash: planHash(baseline.facePixelPlan), geometryFacePlanHash: planHash(geometryOn.facePixelPlan),
        eyePixelsChanged: hash(eyeBefore) !== hash(eyeAfter),
        fullFacePlanChanged: planHash(baseline.facePixelPlan) !== planHash(geometryOn.facePixelPlan),
      },
      nonEye,
      glassesConstrained: baselineAnalysis.fallbackFeatures.glasses !== "none",
      recovery: recovery(geometryOn.facePixelPlan, usable),
    };
    cases.push(resultRow);

    const source = fs.readFileSync(path.join(GENERALIZATION, "sources", `${result.caseId === "warm-white-tee" ? 26954028 : 2881786}.jpg`));
    expect(hash(source)).toBe(result.sourceSha256);
    const crops = await createIdentityCrops(`data:image/jpeg;base64,${bytesToBase64(source)}`,
      result.storedPortraitRegion, result.cropContext);
    expect(crops).toBeTruthy();
    if (!crops) throw new Error(`${result.caseId}: local contact crop missing`);
    const cropBytes = base64ToBytes(crops.faceDataUrl.slice(crops.faceDataUrl.indexOf(",") + 1));
    expect(hash(Buffer.from(cropBytes))).toBe(result.faceCropSha256);
    compositeCell(sheet, await decodeImage(cropBytes), 0, row);
    compositeCell(sheet, renderFacePixelPlan(baseline.facePixelPlan), 1, row);
    compositeCell(sheet, renderFacePixelPlan(geometryOn.facePixelPlan), 2, row);
  }

  const storedSentinel = read<{ results: Array<Record<string, unknown>> }>(SENTINEL).results
    .find(item => item.id === "wavy-open-blazer");
  expect(storedSentinel).toBeTruthy();
  const sentinelTopology = storedSentinel?.topology as { geometryUsage?: { eyes?: boolean }; hairPlanUnchanged?: boolean; outfitPlanUnchanged?: boolean };
  expect(storedSentinel).toMatchObject({ ok: true, providerShapeValid: true, semanticValid: true });
  expect(sentinelTopology).toMatchObject({ geometryUsage: { eyes: true }, hairPlanUnchanged: true, outfitPlanUnchanged: true });
  const maskingClassification = cases.every(item => item.recovery === "GEOMETRY_RECOVERS_BOTH")
    ? "MASKED_BOTH_TARGETS"
    : cases.some(item => item.recovery.includes("RECOVERS"))
      ? "MASKED_PARTIALLY"
      : cases.some(item => !item.geometry.ok || !item.geometry.eyeUsable)
        ? "NOT_MASKED_GEOMETRY_FAILURE"
        : cases.some(item => !item.measurementTrace.effectiveLayoutGeometryUsage)
          ? "NOT_MASKED_RETENTION"
          : "NOT_MASKED_QUANTIZATION";
  expect(maskingClassification).toBe("NOT_MASKED_QUANTIZATION");
  return {
    summary,
    cases,
    sentinel: storedSentinel,
    maskingClassification,
    contactSheet: sheet,
    recommendedNextStrategy: "audit Gemma face-only eye aperture/width measurement calibration against source crops before changing categorical analysis",
  };
}

it("replays both accepted geometry results through the current layout and pixel plans", async () => {
  const audit = await buildAudit();
  expect(audit.cases.map(item => item.recovery)).toEqual(["GEOMETRY_STILL_MIDDLE", "GEOMETRY_STILL_MIDDLE"]);
  expect(audit.cases.every(item => item.pixels.eyePixelsChanged && item.pixels.fullFacePlanChanged)).toBe(true);
  expect(audit.cases.every(item => item.measurementTrace.effectiveLayoutGeometryUsage)).toBe(true);
});

it.skipIf(!BUILD)("writes the secret-safe geometry retention artifact set", async () => {
  const audit = await buildAudit();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("source-inputs.json", { cases: audit.summary.geometryResults.map(result => ({
    caseId: result.caseId, sourceSha256: result.sourceSha256, sourceBytes: result.sourceBytes,
    sourceImageIndex: result.sourceImageIndex, storedPortraitRegion: result.storedPortraitRegion,
    cropContext: result.cropContext, crop: result.crop, faceCropSha256: result.faceCropSha256,
    faceCropEncodedBytes: result.faceCropEncodedBytes,
  })) });
  write("geometry-results.json", { cases: audit.summary.geometryResults.map(result => ({
    caseId: result.caseId, httpStatus: result.httpStatus, ok: result.ok, elapsedMs: result.elapsedMs,
    providerStatus: result.providerStatus, providerShapeValid: result.providerShapeValid,
    semanticValidationPassed: result.semanticValidationPassed, errors: result.errors,
    measurements: result.measurements, geometry: result.geometry, providerCalls: result.providerCalls,
  })) });
  write("measurement-trace.json", { cases: audit.cases.map(({ caseId, measurementTrace, geometry }) => ({ caseId, measurementTrace, continuousEyes: geometry.eyes })) });
  write("plan-comparison.json", { cases: audit.cases.map(({ caseId, rubric, layout, pixels, nonEye, glassesConstrained, recovery }) => ({
    caseId, rubric, layout, pixels, nonEye, glassesConstrained, recovery,
  })) });
  write("retention-summary.json", {
    maskingClassification: audit.maskingClassification,
    cases: audit.cases.map(({ caseId, recovery, geometry, measurementTrace, pixels, nonEye }) => ({
      caseId, recovery, geometrySuccess: geometry.ok, eyeGeometryUsable: geometry.eyeUsable,
      measurementTrace, eyePixelsChanged: pixels.eyePixelsChanged, fullFacePlanChanged: pixels.fullFacePlanChanged, nonEye,
    })),
    wavyStoredSentinel: audit.sentinel,
    callAccounting: { calls: audit.summary.calls, providers: audit.summary.providerCalls, prohibited: audit.summary.prohibited },
    teardown: { qSentCount: audit.summary.qSentCount, graceful: audit.summary.wranglerGracefulTeardownPathCompleted,
      inventoryClean: audit.summary.ownedProcessInventoryClean, temporaryConfigRemoved: audit.summary.temporaryConfigRemoved,
      temporaryTokenFileRemoved: audit.summary.temporaryTokenFileRemoved },
    recommendedNextStrategy: audit.recommendedNextStrategy,
  });
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(audit.contactSheet), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face geometry low-eye target audit\n\n` +
    `- Remote startup/health: 1/1; protected health HTTP 200.\n` +
    `- Geometry calls: 2, Gemma completed 2, retry 0; all prohibited calls 0.\n` +
    `- Both production crops and both geometry contracts were valid with eye confidence 0.9.\n` +
    `- Warm: geometry quantized to ${audit.cases[0].layout.geometryOn.eyeOpenness}/${audit.cases[0].layout.geometryOn.eyeFootprintTopology}; ${audit.cases[0].recovery}.\n` +
    `- Striped: geometry quantized to ${audit.cases[1].layout.geometryOn.eyeOpenness}/${audit.cases[1].layout.geometryOn.eyeFootprintTopology}; ${audit.cases[1].recovery}.\n` +
    `- Both FaceLayoutPlan and eye-role pixels changed, so accepted geometry reached FacePixelPlan.\n` +
    `- resolveFaceMeasurements still labels all face-only geometry cases categorical_grammar even while layout.geometryUsage.eyes=true; this is a trace/provenance inconsistency, not evidence that quantization ignored geometry.\n` +
    `- Hair, head covering, glasses plan, and outfit plan remained equal.\n` +
    `- Stored wavy sentinel remains valid with geometryUsage.eyes=true and hair/outfit unchanged.\n` +
    `- Teardown: literal q once, graceful exit, inventory clean, temporary files removed.\n` +
    `- Production config unchanged.\n\n${audit.maskingClassification}\n`, { flag: "wx" });
});
