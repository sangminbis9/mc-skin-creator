import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import {
  FACE_IDENTITY_GEOMETRY_PROMPT,
  FACE_IDENTITY_GEOMETRY_SCHEMA,
  type FaceIdentityGeometryAnalysis,
} from "../src/faceIdentityGeometry";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { buildSkinPlan } from "../src/skinPlan";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_CONTRACT_LIVE_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-contract-live-20260922-001");
const LIVE_SUMMARY = path.join(ROOT, "summary.json");
const BEFORE_SUMMARY = path.resolve("evaluation-artifacts/face-crop-lateral-guard-geometry-live-20260922-001/summary.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const TARGETS = ["warm-white-tee", "striped-open-shirt"] as const;
const EXPECTED_CROPS = {
  "warm-white-tee": "85f62ffaf83e785c62e45b4fb04306e8d5d8c69484e3a6fa084ad6f3aa188b85",
  "striped-open-shirt": "e954ede4ebe00deafa25f090d3ed374d56897832cb0a85d403a5a5f9ef59270f",
} as const;
const PROMPT_HASH = "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd";
const SCHEMA_HASH = "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469";

type Target = typeof TARGETS[number];
type GeometryResult = {
  caseId: Target;
  sourceSha256: string;
  sourceBytes: number;
  sourceImageIndex: number;
  storedPortraitRegion: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  primaryFaceMeasurementEvidence: PhotoAnalysis["faceMeasurementEvidence"];
  primaryRelevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
  primaryFallbackFeaturesGlasses: PhotoAnalysis["fallbackFeatures"]["glasses"];
  crop: {
    sourceDimensions: { width: number; height: number };
    faceCropDimensions: { width: number; height: number };
    finalFaceBox: { left: number; top: number; right: number; bottom: number };
    faceCropLateralGuard?: { applied: boolean; guardedWidthRatio: number };
  };
  faceCropSha256: string;
  httpStatus: number;
  ok: boolean;
  elapsedMs: number;
  providerShapeValid: boolean;
  semanticValidationPassed: boolean;
  errors: string[];
  geometry: FaceIdentityGeometryAnalysis | null;
  providerStatus: string | null;
  providerCalls: Record<string, number>;
};
type Summary = {
  branch: string;
  head: string;
  faceGeometryPromptSha256?: string;
  faceGeometrySchemaSha256?: string;
  classification: string;
  geometryResults: GeometryResult[];
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  prohibited: Record<string, number>;
  packageManagerCalls: number;
  productionAdditionalDiff: number;
  startupAttempts: number;
  devServerReadyReceived: boolean;
  healthAttempts: number;
  healthElapsedMs: number;
  health: { status: string; httpStatus: number };
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
  cleanupFailed: boolean;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");

function replayAnalysis(result: GeometryResult): PhotoAnalysis {
  const stored = read<{ normalized: PhotoAnalysis }>(path.join(GENERALIZATION, "after", result.caseId, "analysis-and-plan.json"));
  const analysis = structuredClone(stored.normalized);
  analysis.sourceSelection = { ...analysis.sourceSelection, portraitImageIndex: result.sourceImageIndex,
    portraitRegion: structuredClone(result.storedPortraitRegion) };
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
    eyes: { ...geometry.eyes, meanWidth,
      normalizedSpacingCells: geometry.eyes.interEyeDistance / envelopeWidth * 7,
      normalizedFootprintCells: meanWidth / envelopeWidth * 8,
      confidence: geometry.confidence.eyes },
    brows: geometry.brows,
    nose: geometry.nose,
    mouth: geometry.mouth,
  };
}

function layout(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) {
  const value = plan.layout;
  return {
    geometryUsage: value.geometryUsage,
    eyeSpacingTopology: value.eyeSpacingTopology,
    eyeFootprintTopology: value.eyeFootprintTopology,
    eyeOpenness: value.eyeOpenness,
    eyeTopology: value.eyeTopology,
    leftEyeXs: value.leftEyeXs,
    rightEyeXs: value.rightEyeXs,
    leftEyeRow: value.leftEyeRow,
    rightEyeRow: value.rightEyeRow,
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
  const nonEyes = orderedPixels(plan).filter(pixel => pixel.cluster !== "left_eye" && pixel.cluster !== "right_eye");
  const iris = eyes.filter(pixel => pixel.role === "iris");
  return {
    eyeCoordinates: eyes,
    irisCoordinates: iris.map(({ x, y }) => ({ x, y })),
    irisRows: [...new Set(iris.map(pixel => pixel.y))].sort((a, b) => a - b),
    eyePixelCount: eyes.length,
    eyePixelHash: hash(eyes),
    nonEyeFacePixelHash: hash(nonEyes),
    fullFacePixelPlanHash: hash({ layout: plan.layout, pixels: orderedPixels(plan),
      glassesPlan: plan.glassesPlan, renderContract: plan.renderContract }),
  };
}

function buildAudit() {
  const live = read<Summary>(LIVE_SUMMARY);
  const before = read<Summary>(BEFORE_SUMMARY);
  expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(PROMPT_HASH);
  expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(SCHEMA_HASH);
  expect(live).toMatchObject({
    branch: "main",
    head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
    faceGeometryPromptSha256: PROMPT_HASH,
    faceGeometrySchemaSha256: SCHEMA_HASH,
    classification: "READY_TO_REVIEW_FACE_GEOMETRY_LOW_EYE_TARGET_AUDIT",
    startupAttempts: 1,
    devServerReadyReceived: true,
    healthAttempts: 1,
    qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true,
    ownedProcessInventoryClean: true,
    temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true,
    productionConfigChanged: false,
    cleanupFailed: false,
  });
  expect(live.health).toMatchObject({ status: "passed", httpStatus: 200 });
  expect(live.geometryResults.map(result => result.caseId)).toEqual(TARGETS);
  expect(live.calls).toMatchObject({ jpegReads: 2, hashChecks: 2, faceCropPreparations: 2,
    jpegTransmissions: 2, geometryPosts: 2, primaryPosts: 0 });
  expect(live.providerCalls).toMatchObject({ geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
    gemmaStarted: 2, gemmaCompleted: 2, gemmaFailed: 0, retry: 0 });
  expect(Object.values(live.prohibited).every(value => value === 0)).toBe(true);

  const cases = live.geometryResults.map(afterResult => {
    const beforeResult = before.geometryResults.find(result => result.caseId === afterResult.caseId);
    expect(beforeResult?.geometry).toBeTruthy();
    expect(afterResult.geometry).toBeTruthy();
    if (!beforeResult?.geometry || !afterResult.geometry) throw new Error(`${afterResult.caseId}: geometry missing`);
    expect(afterResult).toMatchObject({ httpStatus: 200, ok: true, providerShapeValid: true,
      semanticValidationPassed: true, errors: [] });
    expect(afterResult.sourceSha256).toBe(beforeResult.sourceSha256);
    expect(afterResult.faceCropSha256).toBe(EXPECTED_CROPS[afterResult.caseId]);
    expect(afterResult.faceCropSha256).toBe(beforeResult.faceCropSha256);
    expect(afterResult.crop.faceCropLateralGuard).toMatchObject({ applied: true });
    expect(afterResult.crop.faceCropLateralGuard.guardedWidthRatio).toBeCloseTo(0.65, 12);

    const base = replayAnalysis(afterResult);
    const beforePlan = buildSkinPlan({ ...structuredClone(base), faceIdentityGeometry: structuredClone(beforeResult.geometry) });
    const afterPlan = buildSkinPlan({ ...structuredClone(base), faceIdentityGeometry: structuredClone(afterResult.geometry) });
    const beforeRaw = continuous(beforeResult.geometry);
    const afterRaw = continuous(afterResult.geometry);
    const beforeLayout = layout(beforePlan.facePixelPlan);
    const afterLayout = layout(afterPlan.facePixelPlan);
    const beforePixels = pixelEvidence(beforePlan.facePixelPlan);
    const afterPixels = pixelEvidence(afterPlan.facePixelPlan);
    const delta = afterRaw.eyes.openness - beforeRaw.eyes.openness;
    const direction = delta < -0.01 ? "STRONG_LOW_DIRECTION" : delta > 0.01 ? "HIGHER" : "UNCHANGED";
    const opennessClassification = afterResult.caseId === "striped-open-shirt"
      ? afterLayout.eyeFootprintTopology !== "compact" ? "OPENNESS_PATCH_SIDE_EFFECT"
        : afterLayout.eyeOpenness === "compact" ? "FULL_OPENNESS_RECOVERY"
          : delta < -0.01 && afterLayout.eyeOpenness === "readable" ? "DIRECTIONAL_OPENNESS_RECOVERY"
            : delta < -0.01 ? "RAW_DIRECTION_ONLY" : delta > 0.01 ? "OPENNESS_REGRESSION" : "NO_OPENNESS_EFFECT"
      : direction;
    const trace = resolveFaceMeasurements({ ...structuredClone(base), faceIdentityGeometry: structuredClone(afterResult.geometry) });
    const nonEye = {
      hairPlanEqual: hash(beforePlan.hairPlan) === hash(afterPlan.hairPlan),
      headCoveringEqual: hash(beforePlan.hairPlan.headMask.coveringTopology ?? null) === hash(afterPlan.hairPlan.headMask.coveringTopology ?? null),
      glassesPlanEqual: hash(beforePlan.facePixelPlan.glassesPlan) === hash(afterPlan.facePixelPlan.glassesPlan),
      outfitPlanEqual: hash(beforePlan.outfitPlan) === hash(afterPlan.outfitPlan),
      nonEyeFacePixelsEqual: beforePixels.nonEyeFacePixelHash === afterPixels.nonEyeFacePixelHash,
    };
    expect(nonEye).toMatchObject({ hairPlanEqual: true, headCoveringEqual: true, glassesPlanEqual: true, outfitPlanEqual: true });
    expect(afterLayout.geometryUsage.eyes).toBe(true);
    return {
      caseId: afterResult.caseId,
      provider: { httpStatus: afterResult.httpStatus, providerStatus: afterResult.providerStatus,
        elapsedMs: afterResult.elapsedMs, providerShapeValid: afterResult.providerShapeValid,
        semanticValidationPassed: afterResult.semanticValidationPassed, errors: afterResult.errors,
        calls: afterResult.providerCalls },
      source: { sha256: afterResult.sourceSha256, bytes: afterResult.sourceBytes,
        cropSha256: afterResult.faceCropSha256, cropHashVerified: true },
      raw: { before: beforeRaw, after: afterRaw, opennessDelta: delta, direction },
      quantization: { before: beforeLayout, after: afterLayout, opennessClassification },
      pixels: { before: beforePixels, after: afterPixels,
        eyePixelsChanged: beforePixels.eyePixelHash !== afterPixels.eyePixelHash,
        fullFacePlanChanged: beforePixels.fullFacePixelPlanHash !== afterPixels.fullFacePixelPlanHash },
      topologyEffect: {
        from: beforeLayout.eyeTopology,
        to: afterLayout.eyeTopology,
        lowerIrisRowRemoved: beforePixels.irisRows.length > afterPixels.irisRows.length,
        sourceDirection: afterResult.caseId === "striped-open-shirt" ? "closer_to_frozen_narrow" : "secondary_confounded_same_direction",
      },
      nonEye,
      trace: {
        geometryUsageEyes: afterLayout.geometryUsage.eyes,
        measurementTraceEyeOpenness: trace.eyeOpenness.selected,
        classification: afterLayout.geometryUsage.eyes && trace.eyeOpenness.selected !== "continuous_geometry"
          ? "TRACE_PROVENANCE_INCONSISTENCY" : "TRACE_CONSISTENT",
      },
    };
  });
  const warm = cases.find(item => item.caseId === "warm-white-tee")!;
  const striped = cases.find(item => item.caseId === "striped-open-shirt")!;
  expect(striped.quantization).toMatchObject({ opennessClassification: "DIRECTIONAL_OPENNESS_RECOVERY",
    after: { eyeFootprintTopology: "compact", eyeOpenness: "readable", eyeTopology: "readable_iris" } });
  expect(striped.raw).toMatchObject({ direction: "STRONG_LOW_DIRECTION" });
  expect(striped.raw.opennessDelta).toBeCloseTo(-0.2, 12);
  expect(striped.topologyEffect.lowerIrisRowRemoved).toBe(true);
  expect(warm.raw).toMatchObject({ direction: "STRONG_LOW_DIRECTION" });
  expect(warm.raw.opennessDelta).toBeCloseTo(-0.2, 12);
  const warmInterpretation = warm.raw.direction === striped.raw.direction
    ? "SUPPORTS_STRIPED_DIRECTION" : warm.raw.direction === "UNCHANGED" ? "UNCHANGED_CONFOUNDED" : "CONTRADICTS_STRIPED_DIRECTION";
  const sentinel = {
    availability: "unavailable",
    calls: 0,
    reason: "the only stored normal-openness candidate has no current production-equivalent portraitRegion; no region was fabricated",
  };
  const overall = "CONTRACT_CLARIFICATION_EFFECTIVE" as const;
  return { live, before, cases, warmInterpretation, sentinel, overall };
}

it("replays the clarified-prompt live geometry through frozen layout and pixels", () => {
  const audit = buildAudit();
  expect(audit.overall).toBe("CONTRACT_CLARIFICATION_EFFECTIVE");
  expect(audit.cases.every(item => item.provider.providerShapeValid && item.provider.semanticValidationPassed)).toBe(true);
  expect(audit.cases.every(item => item.trace.classification === "TRACE_PROVENANCE_INCONSISTENCY")).toBe(true);
  expect(audit.sentinel.calls).toBe(0);
});

it.skipIf(!BUILD)("writes the clarified-prompt targeted live comparison artifacts", () => {
  const audit = buildAudit();
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("preflight.json", {
    branch: audit.live.branch, head: audit.live.head,
    promptSha256: audit.live.faceGeometryPromptSha256, schemaSha256: audit.live.faceGeometrySchemaSha256,
    quantizer: { compactMax: 0.34, openMin: 0.68 }, lateralGuard: 0.65,
    sentinel: audit.sentinel,
    lifecycle: { startupAttempts: audit.live.startupAttempts, ready: audit.live.devServerReadyReceived,
      healthAttempts: audit.live.healthAttempts, health: audit.live.health },
  });
  write("geometry-before-after.json", { cases: audit.cases.map(item => ({ caseId: item.caseId,
    provider: item.provider, source: item.source, raw: item.raw })) });
  write("quantization-before-after.json", { cases: audit.cases.map(item => ({ caseId: item.caseId,
    ...item.quantization, topologyEffect: item.topologyEffect })) });
  write("plan-comparison.json", { cases: audit.cases.map(item => ({ caseId: item.caseId,
    pixels: item.pixels, nonEye: item.nonEye, trace: item.trace })) });
  write("sentinel.json", audit.sentinel);
  write("result-summary.json", {
    classification: audit.overall,
    warmInterpretation: audit.warmInterpretation,
    cases: audit.cases.map(item => ({ caseId: item.caseId, openness: item.quantization.opennessClassification,
      delta: item.raw.opennessDelta, footprint: item.quantization.after.eyeFootprintTopology,
      spacing: item.quantization.after.eyeSpacingTopology, topology: item.quantization.after.eyeTopology,
      eyePixelsChanged: item.pixels.eyePixelsChanged, nonEye: item.nonEye, trace: item.trace.classification })),
    callAccounting: { calls: audit.live.calls, providers: audit.live.providerCalls,
      prohibited: audit.live.prohibited, packageManagerCalls: audit.live.packageManagerCalls },
    teardown: { qSentCount: audit.live.qSentCount, graceful: audit.live.wranglerGracefulTeardownPathCompleted,
      inventoryClean: audit.live.ownedProcessInventoryClean, temporaryConfigRemoved: audit.live.temporaryConfigRemoved,
      temporaryTokenFileRemoved: audit.live.temporaryTokenFileRemoved, productionConfigChanged: audit.live.productionConfigChanged },
  });
  const striped = audit.cases.find(item => item.caseId === "striped-open-shirt")!;
  const warm = audit.cases.find(item => item.caseId === "warm-white-tee")!;
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Clarified face-geometry openness targeted live retest\n\n` +
    `- Prompt/schema/crop hashes matched; protected health passed before 2 JPEG reads and 2 geometry POSTs.\n` +
    `- Striped openness ${striped.raw.before.eyes.openness.toFixed(2)} -> ${striped.raw.after.eyes.openness.toFixed(2)}; open_iris_sclera -> readable_iris; the lower iris row was removed.\n` +
    `- Striped footprint remained ${striped.quantization.after.eyeFootprintTopology} at ${striped.raw.after.eyes.normalizedFootprintCells.toFixed(3)} cells. Spacing remained ${striped.quantization.after.eyeSpacingTopology} at ${striped.raw.after.eyes.normalizedSpacingCells.toFixed(3)} cells.\n` +
    `- Warm openness ${warm.raw.before.eyes.openness.toFixed(2)} -> ${warm.raw.after.eyes.openness.toFixed(2)} (${audit.warmInterpretation}); envelopeRight remains ${warm.raw.after.face.envelopeRight.toFixed(2)}, so it stays secondary/confounded.\n` +
    `- Both outputs were provider-shape and semantic valid. Two identical 0.50 scores are observation only, not a distribution claim.\n` +
    `- No normal sentinel call: no stored normal case had a current production-equivalent portraitRegion.\n` +
    `- HairPlan, covering, GlassesPlan and OutfitPlan were unchanged. TRACE_PROVENANCE_INCONSISTENCY remains observed and frozen.\n` +
    `- Gemma geometry 2/2 completed, retry 0; primary/full geometry/detail/generation/evaluator calls 0.\n` +
    `- Literal q once; graceful teardown, process inventory, temporary cleanup and production-config hash passed.\n\n` +
    `${audit.overall}\n`, { flag: "wx" });
});
