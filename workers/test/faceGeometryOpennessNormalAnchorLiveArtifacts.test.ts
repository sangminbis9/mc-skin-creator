import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { FACE_MEASUREMENT_VALUES, resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA, type FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { buildSkinPlan } from "../src/skinPlan";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_NORMAL_ANCHOR_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001");
const SUMMARY = path.join(ROOT, "summary.json");
const FROZEN = path.resolve("evaluation-artifacts/generalization-20260905/after/wavy-open-blazer/analysis-and-plan.json");
const HISTORICAL = path.resolve("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
const PRIOR_ANCHORS = path.resolve("evaluation-artifacts/face-geometry-openness-threshold-evidence-review-20260922-001/post-contract-anchor-table.json");

const EXPECTED = {
  head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
  sourceSha256: "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702",
  sourceBytes: 70987,
  rubricSha256: "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27",
  promptSha256: "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd",
  schemaSha256: "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469",
  summarySha256: "a72b396ae0d73b23228d478968fdf17bd6ab59287acecdd869455898f17f8240",
  cropSha256: "7b20f61a5e64d140cbf660cc08ba3e332de47597be898078fd800d1ab809fe85",
} as const;

type Box = { left: number; top: number; right: number; bottom: number };
type GeometryResult = {
  caseId: string;
  sourceSha256: string;
  sourceBytes: number;
  sourceImageIndex: number;
  frozenSourceEyeOpenness: string;
  freshPortraitRegion: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  primaryFaceMeasurementEvidence: PhotoAnalysis["faceMeasurementEvidence"];
  primaryFallbackFeaturesGlasses: PhotoAnalysis["fallbackFeatures"]["glasses"];
  crop: {
    cropMode: string;
    subjectBox: Box;
    headBox: Box;
    faceBox: Box;
    sourceDimensions: { width: number; height: number };
    faceCropDimensions: { width: number; height: number };
    faceCoverageRatio: number;
    faceCropLateralGuard: { applied: boolean; reason: string; originalExpandedWidthRatio: number; guardedWidthRatio: number };
    finalFaceBox: Box;
    quality: { usableForFaceGeometry: boolean; warnings: string[] };
    sourceClipping: Record<string, boolean>;
    cropClipping: Record<string, boolean>;
  };
  faceCropSha256: string;
  faceCropEncodedBytes: number;
  httpStatus: number;
  ok: boolean;
  elapsedMs: number;
  providerShapeValid: boolean;
  semanticValidationPassed: boolean;
  errors: string[];
  measurements: Record<string, unknown>;
  geometry: FaceIdentityGeometryAnalysis;
  providerStatus: string;
  providerCalls: Record<string, number>;
  cropValidity: { usableForFaceGeometry: boolean; lateralCropClean: boolean };
  anchorTier: string;
};
type Summary = {
  mode: string;
  branch: string;
  head: string;
  sourceRubricSha256: string;
  faceGeometryPromptSha256: string;
  faceGeometrySchemaSha256: string;
  faceGeometryContract: { lateralGuard: number; compactMax: number; openMin: number };
  selectedCases: Array<{ id: string; photoId: number; expectedSha256: string; expectedBytes: number }>;
  startupAttempts: number;
  healthAttempts: number;
  health: { status: string; httpStatus: number; body: { providerCalls: number } };
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  primaryProviderCalls: Record<string, number>;
  geometryProviderCalls: Record<string, number>;
  primary: Record<string, unknown> & {
    sourceSelection: PhotoAnalysis["sourceSelection"];
    faceMeasurementEvidence: PhotoAnalysis["faceMeasurementEvidence"];
    relevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
    fallbackFeaturesGlasses: PhotoAnalysis["fallbackFeatures"]["glasses"];
  };
  geometryResults: GeometryResult[];
  normalAnchor: { anchorTier: string; postContractOpenness: number; eyesConfidence: number; historicalPreContractOpenness: number };
  prohibited: Record<string, number>;
  packageManagerCalls: number;
  productionAdditionalDiff: number;
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  cleanupFailed: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
  classification: string;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer | object) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");
const fileSha = (file: string) => sha(fs.readFileSync(file));

function orderedPixels(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"], eyesOnly = false) {
  return plan.pixels
    .filter(pixel => !eyesOnly || pixel.cluster === "left_eye" || pixel.cluster === "right_eye")
    .map(({ x, y, role, cluster }) => ({ x, y, role, cluster }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
}

function planEvidence(plan: ReturnType<typeof buildSkinPlan>["facePixelPlan"]) {
  const eyes = orderedPixels(plan, true);
  return {
    layout: {
      geometryUsageEyes: plan.layout.geometryUsage.eyes,
      eyeOpenness: plan.layout.eyeOpenness,
      eyeTopology: plan.layout.eyeTopology,
      eyeSpacingTopology: plan.layout.eyeSpacingTopology,
      eyeFootprintTopology: plan.layout.eyeFootprintTopology,
      leftEyeRow: plan.layout.leftEyeRow,
      rightEyeRow: plan.layout.rightEyeRow,
      leftEyeXs: plan.layout.leftEyeXs,
      rightEyeXs: plan.layout.rightEyeXs,
    },
    eyeCoordinates: eyes,
    irisCoordinates: eyes.filter(pixel => pixel.role === "iris").map(({ x, y }) => ({ x, y })),
    eyePixelCount: eyes.length,
    eyePixelHash: sha(eyes),
    fullFacePixelPlanHash: sha({
      layout: plan.layout,
      pixels: orderedPixels(plan),
      glassesPlan: plan.glassesPlan,
      renderContract: plan.renderContract,
    }),
  };
}

function buildAudit() {
  expect(fileSha(SUMMARY)).toBe(EXPECTED.summarySha256);
  expect(sha(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(EXPECTED.promptSha256);
  expect(sha(FACE_IDENTITY_GEOMETRY_SCHEMA)).toBe(EXPECTED.schemaSha256);
  expect(FACE_MEASUREMENT_VALUES.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);

  const summary = read<Summary>(SUMMARY);
  expect(summary).toMatchObject({
    mode: "face_geometry_openness_normal_anchor_live",
    branch: "main",
    head: EXPECTED.head,
    sourceRubricSha256: EXPECTED.rubricSha256,
    faceGeometryPromptSha256: EXPECTED.promptSha256,
    faceGeometrySchemaSha256: EXPECTED.schemaSha256,
    faceGeometryContract: { lateralGuard: 0.65, compactMax: 0.34, openMin: 0.68 },
    startupAttempts: 1,
    healthAttempts: 1,
    health: { status: "passed", httpStatus: 200, body: { providerCalls: 0 } },
    qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true,
    ownedProcessInventoryClean: true,
    cleanupFailed: false,
    temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true,
    productionConfigChanged: false,
    packageManagerCalls: 0,
    productionAdditionalDiff: 0,
    classification: "READY_TO_REVIEW_FACE_GEOMETRY_NORMAL_ANCHOR",
  });
  expect(summary.selectedCases).toEqual([{ id: "wavy-open-blazer", photoId: 19908659,
    expectedSha256: EXPECTED.sourceSha256, expectedBytes: EXPECTED.sourceBytes }]);
  expect(summary.calls).toMatchObject({ jpegReads: 1, hashChecks: 2, base64Preparations: 1,
    jpegTransmissions: 2, primaryPosts: 1, faceCropPreparations: 1, geometryPosts: 1 });
  expect(summary.primaryProviderCalls).toMatchObject({ geminiStarted: 1, geminiCompleted: 1,
    geminiFailed: 0, gemmaStarted: 1, gemmaCompleted: 1, gemmaFailed: 0, retry: 0 });
  expect(summary.geometryProviderCalls).toMatchObject({ geminiStarted: 0, gemmaStarted: 1,
    gemmaCompleted: 1, gemmaFailed: 0, retry: 0 });
  expect(Object.values(summary.prohibited).every(value => value === 0)).toBe(true);

  const result = summary.geometryResults[0];
  expect(result).toMatchObject({ caseId: "wavy-open-blazer", sourceSha256: EXPECTED.sourceSha256,
    sourceBytes: EXPECTED.sourceBytes, sourceImageIndex: 0, frozenSourceEyeOpenness: "normal",
    faceCropSha256: EXPECTED.cropSha256, httpStatus: 200, ok: true, providerShapeValid: true,
    semanticValidationPassed: true, errors: [], anchorTier: "TIER_A_NORMAL_ANCHOR",
    cropValidity: { usableForFaceGeometry: true, lateralCropClean: true } });
  expect(result.crop.faceCropLateralGuard).toMatchObject({ applied: true });
  expect(result.crop.faceCropLateralGuard.guardedWidthRatio).toBeCloseTo(0.65, 12);
  expect(result.geometry.confidence.eyes).toBeGreaterThanOrEqual(0.55);
  expect(result.geometry.eyes.openness).toBe(0.6);
  expect(summary.normalAnchor).toMatchObject({ anchorTier: "TIER_A_NORMAL_ANCHOR", postContractOpenness: 0.6,
    eyesConfidence: 0.95, historicalPreContractOpenness: 0.85 });

  const historical = read<{ results: Array<{ id: string; measurements: { eyes: { openness: number } } }> }>(HISTORICAL);
  const oldWavy = historical.results.find(item => item.id === "wavy-open-blazer");
  expect(oldWavy?.measurements.eyes.openness).toBe(0.85);
  const anchors = read<{ tierA: Array<Record<string, unknown>> }>(PRIOR_ANCHORS);
  const striped = anchors.tierA.find(item => item.caseId === "striped-open-shirt");
  expect(striped).toMatchObject({ sourceOpennessRubric: "narrow", rawOpenness: 0.5,
    eyesConfidence: 0.9, anchorTier: "TIER_A_CALIBRATION_ANCHOR", promptHash: EXPECTED.promptSha256 });

  const frozen = read<{ normalized: PhotoAnalysis }>(FROZEN).normalized;
  const base = structuredClone(frozen);
  base.sourceSelection = {
    ...base.sourceSelection,
    portraitImageIndex: summary.primary.sourceSelection.portraitImageIndex,
    outfitImageIndex: summary.primary.sourceSelection.outfitImageIndex,
    generationImageIndex: summary.primary.sourceSelection.generationImageIndex,
    portraitRegion: structuredClone(summary.primary.sourceSelection.portraitRegion),
  };
  base.faceMeasurementEvidence = structuredClone(summary.primary.faceMeasurementEvidence);
  Object.assign(base.renderHints, summary.primary.relevantRenderHints);
  base.fallbackFeatures = { ...base.fallbackFeatures, glasses: summary.primary.fallbackFeaturesGlasses };
  delete base.identityGeometry;
  delete base.faceIdentityGeometry;
  const baseValidation = validatePhotoAnalysis(base);
  expect(baseValidation.ok, JSON.stringify(baseValidation.errors)).toBe(true);
  const replay = { ...structuredClone(base), faceIdentityGeometry: structuredClone(result.geometry) };
  const replayValidation = validatePhotoAnalysis(replay);
  expect(replayValidation.ok, JSON.stringify(replayValidation.errors)).toBe(true);

  const baselinePlan = buildSkinPlan(base);
  const replayPlan = buildSkinPlan(replay);
  const before = planEvidence(baselinePlan.facePixelPlan);
  const after = planEvidence(replayPlan.facePixelPlan);
  const trace = resolveFaceMeasurements(replay);
  expect(after.layout.geometryUsageEyes).toBe(true);
  expect(after.layout.eyeOpenness).toBe("readable");
  const lowBoundary = {
    narrow: { caseId: "striped-open-shirt", tier: "TIER_A_CALIBRATION_ANCHOR", score: 0.5, confidence: 0.9 },
    normal: { caseId: "wavy-open-blazer", tier: "TIER_A_NORMAL_ANCHOR", score: 0.6, confidence: 0.95 },
    classification: "LOW_BOUNDARY_SEPARABLE",
    feasibleInterval: { lowerExclusive: 0.5, upperExclusive: 0.6, notation: "(0.50, 0.60)" },
    thresholdSelected: false,
    currentCompactMax: { value: 0.34, compatible: false },
    highBoundary: { openMin: 0.68, status: "FROZEN_UNEVALUATED_NO_POST_CONTRACT_OPEN_ANCHOR" },
  } as const;
  expect(lowBoundary.normal.score).toBeGreaterThan(lowBoundary.narrow.score);

  return {
    summary,
    result,
    preflight: {
      head: summary.head,
      branch: summary.branch,
      sourceRubricSha256: summary.sourceRubricSha256,
      promptSha256: summary.faceGeometryPromptSha256,
      schemaSha256: summary.faceGeometrySchemaSha256,
      contract: summary.faceGeometryContract,
      source: summary.selectedCases[0],
    },
    lowBoundary,
    historicalScaleShift: { caseId: "wavy-open-blazer", preContract: 0.85, postContract: 0.6,
      direction: "decreased", thresholdFittingUse: false },
    replay: {
      source: "frozen analysis + fresh primary localization/evidence + POST_CONTRACT face-only geometry",
      rawOpenness: result.geometry.eyes.openness,
      measurementTrace: {
        eyeSpacing: trace.eyeSpacing.selected,
        eyeOpenness: trace.eyeOpenness.selected,
        eyeFootprint: trace.eyeFootprint.selected,
      },
      baseline: before,
      postContractGeometry: after,
      eyePixelsChanged: before.eyePixelHash !== after.eyePixelHash,
      fullFacePlanChanged: before.fullFacePixelPlanHash !== after.fullFacePixelPlanHash,
    },
  };
}

it("validates the live normal anchor and replays it through current face quantization", () => {
  const audit = buildAudit();
  expect(audit.lowBoundary.classification).toBe("LOW_BOUNDARY_SEPARABLE");
  expect(audit.lowBoundary.feasibleInterval.notation).toBe("(0.50, 0.60)");
  expect(audit.replay.postContractGeometry.layout).toMatchObject({ geometryUsageEyes: true, eyeOpenness: "readable" });
});

it.skipIf(!BUILD)("writes secret-safe normal-anchor review artifacts", () => {
  const audit = buildAudit();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("preflight.json", audit.preflight);
  write("primary-localization.json", {
    caseId: audit.result.caseId,
    sourceSha256: audit.result.sourceSha256,
    sourceBytes: audit.result.sourceBytes,
    sourceImageIndex: audit.result.sourceImageIndex,
    portraitRegion: audit.result.freshPortraitRegion,
    faceMeasurementEvidence: audit.result.primaryFaceMeasurementEvidence,
    fallbackFeaturesGlasses: audit.result.primaryFallbackFeaturesGlasses,
    primaryValidation: { providerSchema: "passed", strictRuntime: "passed", richPhotoAnalysis: "passed" },
    providerCalls: audit.summary.primaryProviderCalls,
  });
  write("crop-verification.json", {
    caseId: audit.result.caseId,
    crop: audit.result.crop,
    cropSha256: audit.result.faceCropSha256,
    encodedBytes: audit.result.faceCropEncodedBytes,
    validity: audit.result.cropValidity,
  });
  write("geometry-result.json", {
    caseId: audit.result.caseId,
    promptGeneration: "POST_CONTRACT",
    provider: "@cf/google/gemma-4-26b-a4b-it",
    httpStatus: audit.result.httpStatus,
    providerStatus: audit.result.providerStatus,
    elapsedMs: audit.result.elapsedMs,
    providerShapeValid: audit.result.providerShapeValid,
    semanticValidationPassed: audit.result.semanticValidationPassed,
    errors: audit.result.errors,
    measurements: audit.result.measurements,
    geometry: audit.result.geometry,
    providerCalls: audit.result.providerCalls,
    anchorTier: audit.result.anchorTier,
  });
  write("low-boundary-evidence.json", {
    ...audit.lowBoundary,
    historicalScaleShift: audit.historicalScaleShift,
    conclusion: "LOW_BOUNDARY_ANCHOR_ACQUIRED",
  });
  write("plan-replay.json", audit.replay);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# POST_CONTRACT normal openness anchor\n\n` +
    `- Wavy source rubric: normal; current production primary returned a valid portrait region and exact categorical normal diagnostic.\n` +
    `- Current 0.65 lateral guard applied; final crop ${audit.result.crop.faceCropDimensions.width}x${audit.result.crop.faceCropDimensions.height}, hash ${audit.result.faceCropSha256}.\n` +
    `- Gemma face-only geometry passed provider and semantic validation: openness 0.60, eyes confidence 0.95.\n` +
    `- Anchor tier: TIER_A_NORMAL_ANCHOR. No glasses/occlusion confounder and no lateral clipping.\n` +
    `- Existing POST_CONTRACT striped Tier A narrow anchor is 0.50; the feasible low-boundary interval is (0.50, 0.60). No threshold was selected or changed.\n` +
    `- Current compactMax 0.34 remains incompatible with the narrow 0.50 anchor. openMin 0.68 remains frozen and unevaluated.\n` +
    `- Historical PRE_CONTRACT wavy 0.85 -> POST_CONTRACT 0.60: decreased; the historical value was not used for fitting.\n` +
    `- Replay: geometryUsage.eyes=${audit.replay.postContractGeometry.layout.geometryUsageEyes}, current bin=${audit.replay.postContractGeometry.layout.eyeOpenness}, topology=${audit.replay.postContractGeometry.layout.eyeTopology}.\n` +
    `- Remote startup 1, health 1, primary POST 1, geometry POST 1, retry 0; literal q exactly once and cleanup passed.\n` +
    `- No striped/warm re-call, full geometry, detail, generation, critique, pairwise, evaluator, commit, push, or deploy.\n\n` +
    `LOW_BOUNDARY_ANCHOR_ACQUIRED\n`, { flag: "wx" });
});
