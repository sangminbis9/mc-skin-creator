import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { FACE_GEOMETRY_MODEL, FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA } from "../src/faceIdentityGeometry";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_THRESHOLD_REVIEW === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-threshold-evidence-review-20260922-001");
const HISTORICAL = path.resolve("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
const OLD_TARGETS = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001/summary.json");
const GUARDED_TARGETS = path.resolve("evaluation-artifacts/face-crop-lateral-guard-geometry-live-20260922-001/summary.json");
const POST_TARGETS = path.resolve("evaluation-artifacts/face-geometry-openness-contract-live-20260922-001/summary.json");
const OLD_CORPUS = path.resolve("evaluation-artifacts/face-geometry-openness-calibration-audit-20260922-001/provider-origin-corpus.json");
const CROP_AUDIT = path.resolve("evaluation-artifacts/face-crop-lateral-guard-20260922-001/before-after-crops.json");
const PROMPT_AUDIT = path.resolve("evaluation-artifacts/face-geometry-openness-contract-clarification-20260922-001/prompt-contract-before-after.json");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const PRIMARY_SIX = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001/summary.json");
const TARGETED_PRIMARY = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001/summary.json");

const CURRENT_PROMPT = "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd";
const OLD_PROMPT = "c1b9f013368b15bc7b92fc6dbc600875e685ee14e9e3ef6a959f7816bf8af68f";
const CURRENT_SCHEMA = "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469";
const EXPECTED_HASHES = {
  historical: "e86822b1308e4dbe3725a3e0812adc8360d516e2de7efef35bc0b39d7b5b99ef",
  oldTargets: "b1e3964859c76b02f3d535634bbb5425e54a48d1839bbd2dbb00a0dba58f30f7",
  guardedTargets: "9676b8b68b7f38dba5382b3a2a16ac004ed9cea7bdc7ef58bd14500249b80ca2",
  postTargets: "16e461ea69b3345694c4b064febb8b1f734369afc1643f09538bfb45be600927",
  oldCorpus: "7575360aefdd491ac7a99ff1260d3009bda569bc2af3b800c2af9da270013016",
  cropAudit: "d37daf14f72ed63ae777bbf09879ff8c813bc4a0706833a9030e775611ade807",
  promptAudit: "251d31401de8a8b35717e75b738ca3c09d5d3330eba25b26f4b288c16040271d",
  rubric: "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27",
  primarySix: "53c8cbaff7c64f1cf2d43751b14370c8c2e09501fdecee7bf6e851dfb9379254",
  targetedPrimary: "0e20850cb0a217f52e0f053e9aafd02b2c3bbac62e8b3cadba77a2a6f72d579f",
} as const;

type GeometryResult = {
  caseId: string;
  sourceSha256: string;
  faceCropSha256: string;
  elapsedMs: number;
  ok: boolean;
  providerShapeValid: boolean;
  semanticValidationPassed: boolean;
  geometry: {
    face: { envelopeLeft: number; envelopeRight: number };
    eyes: { openness: number; leftWidth: number; rightWidth: number };
    confidence: { eyes: number };
  };
};
type TargetSummary = {
  mode: string;
  faceGeometryPromptSha256?: string;
  faceGeometrySchemaSha256?: string;
  geometryResults: GeometryResult[];
};
type Historical = {
  model: string;
  promptHash: string;
  selected: Array<{ id: string; sourceHash: string; faceHash: string; cropBox: number[] }>;
  results: Array<{ id: string; ok: boolean; providerShapeValid: boolean; semanticValid: boolean; elapsedMs: number;
    measurements: { eyes: { openness: number; confidence: number; leftWidth: number; rightWidth: number } } }>;
};
type Rubric = { cases: Array<{ id: string; sourceSha256: string; sourceBytes: number; faceVisibility: string;
  glassesOrCovering: string; rubric: { eyeOpenness: { kind: string; values?: string[] } } }> };
type PrimarySummary = { primaryResults: Array<{ caseId: string; sourceSha256: string; ok: boolean;
  sourceSelection: null | { portraitRegion: unknown | null } }> };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => sha(fs.readFileSync(file));
const bin = (score: number) => score <= 0.34 ? "compact" : score >= 0.68 ? "open" : "readable";

function topologyAt(openness: number) {
  const base = makeAnalysis();
  const geometry = makeIdentityGeometry();
  const analysis = { ...base, identityGeometry: { ...geometry, eyes: { ...geometry.eyes, openness } } };
  const plan = buildFacePixelPlanVariants(analysis, 1)[0];
  if (!plan) throw new Error("face plan unavailable");
  const eyePixels = plan.pixels.filter(pixel => pixel.cluster === "left_eye" || pixel.cluster === "right_eye");
  return { score: openness, bin: plan.layout.eyeOpenness, topology: plan.layout.eyeTopology,
    eyeRows: [...new Set(eyePixels.filter(pixel => pixel.role === "iris" || pixel.role === "sclera").map(pixel => pixel.y))].sort(),
    eyePixelCount: eyePixels.length };
}

function buildReview() {
  const integrityFiles = { historical: HISTORICAL, oldTargets: OLD_TARGETS, guardedTargets: GUARDED_TARGETS,
    postTargets: POST_TARGETS, oldCorpus: OLD_CORPUS, cropAudit: CROP_AUDIT, promptAudit: PROMPT_AUDIT,
    rubric: RUBRIC, primarySix: PRIMARY_SIX, targetedPrimary: TARGETED_PRIMARY };
  for (const [key, file] of Object.entries(integrityFiles)) {
    expect(fileHash(file)).toBe(EXPECTED_HASHES[key as keyof typeof EXPECTED_HASHES]);
  }
  expect(sha(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(CURRENT_PROMPT);
  expect(sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(CURRENT_SCHEMA);
  expect(FACE_MEASUREMENT_VALUES.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);

  const historical = read<Historical>(HISTORICAL);
  const oldTargets = read<TargetSummary>(OLD_TARGETS);
  const guardedTargets = read<TargetSummary>(GUARDED_TARGETS);
  const postTargets = read<TargetSummary>(POST_TARGETS);
  const oldCorpus = read<{ integrity: { prompt: string }; corpus: Array<{ observationId: string }> }>(OLD_CORPUS);
  const cropAudit = read<{ cases: Array<{ caseId: string; after: { sha256: string }; classificationAfter: string }> }>(CROP_AUDIT);
  const promptAudit = read<{ oldPromptSha256: string; newPromptSha256: string }>(PROMPT_AUDIT);
  const rubric = read<Rubric>(RUBRIC);
  const primarySix = read<PrimarySummary>(PRIMARY_SIX);
  const targetedPrimary = read<PrimarySummary>(TARGETED_PRIMARY);
  expect(historical.promptHash).toBe(OLD_PROMPT);
  expect(oldCorpus.integrity.prompt).toBe(OLD_PROMPT);
  expect(promptAudit).toEqual(expect.objectContaining({ oldPromptSha256: OLD_PROMPT, newPromptSha256: CURRENT_PROMPT }));
  expect(postTargets).toMatchObject({ faceGeometryPromptSha256: CURRENT_PROMPT, faceGeometrySchemaSha256: CURRENT_SCHEMA });
  expect(oldCorpus.corpus.map(row => row.observationId)).toEqual(expect.arrayContaining([
    "old-target:warm-white-tee", "old-target:striped-open-shirt",
    "corrected-target:warm-white-tee", "corrected-target:striped-open-shirt",
  ]));

  const rubricCase = (id: string) => rubric.cases.find(item => item.id === id);
  const label = (id: string) => rubricCase(id)?.rubric.eyeOpenness.values?.[0]
    ?? (id === "short-hair-red-shirt" ? "narrow" : null);
  const inventory: Array<Record<string, unknown>> = [];
  for (const result of historical.results) {
    const selected = historical.selected.find(item => item.id === result.id)!;
    expect(result).toMatchObject({ ok: true, providerShapeValid: true, semanticValid: true });
    inventory.push({ observationId: `historical-face-only:${result.id}`, caseId: result.id,
      artifact: path.relative(path.resolve("."), HISTORICAL), providerOrigin: true, provider: historical.model,
      model: historical.model, runClass: "face-only-geometry-20260914/live-001", promptHash: historical.promptHash,
      promptGeneration: "PRE_CONTRACT", promptGenerationEvidence: "prompt hash stored directly",
      cropHash: selected.faceHash, cropProvenance: "stored source/crop diagnostic selection",
      cropValidity: "historical face-only crop; no current production-equivalent portraitRegion assertion",
      sourceOpennessRubric: label(result.id), rawOpenness: result.measurements.eyes.openness,
      eyesConfidence: result.measurements.eyes.confidence, calibrationEligible: false,
      calibrationExclusion: "pre-contract numeric scale" });
  }
  const appendTargets = (summary: TargetSummary, artifact: string, runClass: string, cropProvenance: string) => {
    for (const result of summary.geometryResults) {
      expect(result).toMatchObject({ ok: true, providerShapeValid: true, semanticValidationPassed: true });
      const oldObservation = `${runClass === "initial_crop" ? "old" : "corrected"}-target:${result.caseId}`;
      expect(oldCorpus.corpus.some(row => row.observationId === oldObservation)).toBe(true);
      inventory.push({ observationId: `${runClass}:${result.caseId}`, caseId: result.caseId,
        artifact: path.relative(path.resolve("."), artifact), providerOrigin: true, provider: "workers_ai",
        model: FACE_GEOMETRY_MODEL, runClass, promptHash: null, promptGeneration: "PRE_CONTRACT",
        promptGenerationEvidence: `paired observation is recorded under old prompt ${OLD_PROMPT} in the immutable pre-contract corpus`,
        cropHash: result.faceCropSha256, cropProvenance, cropValidity: runClass === "guarded_crop"
          ? cropAudit.cases.find(item => item.caseId === result.caseId)?.classificationAfter : "pre-guard crop",
        sourceOpennessRubric: label(result.caseId), rawOpenness: result.geometry.eyes.openness,
        eyesConfidence: result.geometry.confidence.eyes, calibrationEligible: false,
        calibrationExclusion: "pre-contract numeric scale" });
    }
  };
  appendTargets(oldTargets, OLD_TARGETS, "initial_crop", "stored primary portraitRegion + pre-guard createIdentityCrops");
  appendTargets(guardedTargets, GUARDED_TARGETS, "guarded_crop", "stored primary portraitRegion + current createIdentityCrops + 0.65 lateral guard");

  for (const result of postTargets.geometryResults) {
    const crop = cropAudit.cases.find(item => item.caseId === result.caseId)!;
    expect(crop.after.sha256).toBe(result.faceCropSha256);
    const tier = result.caseId === "striped-open-shirt" ? "TIER_A_CALIBRATION_ANCHOR" : "TIER_B_DIRECTIONAL_ANCHOR";
    inventory.push({ observationId: `post-contract:${result.caseId}`, caseId: result.caseId,
      artifact: path.relative(path.resolve("."), POST_TARGETS), providerOrigin: true, provider: "workers_ai",
      model: FACE_GEOMETRY_MODEL, runClass: postTargets.mode, promptHash: postTargets.faceGeometryPromptSha256,
      promptGeneration: "POST_CONTRACT", promptGenerationEvidence: "current prompt hash stored directly",
      cropHash: result.faceCropSha256,
      cropProvenance: "stored production primary portraitRegion + current createIdentityCrops + 0.65 lateral guard",
      cropValidity: { cropAudit: crop.classificationAfter, envelope: [result.geometry.face.envelopeLeft, result.geometry.face.envelopeRight] },
      sourceOpennessRubric: label(result.caseId), rawOpenness: result.geometry.eyes.openness,
      eyesConfidence: result.geometry.confidence.eyes, providerSchemaValidation: "passed",
      semanticValidation: "passed", noSunglassesOrOcclusion: true, anchorTier: tier,
      tierReason: result.caseId === "striped-open-shirt"
        ? "frozen scorable narrow label; current prompt/crop; crop audit FULL_FACE_MARGIN_OK; confidence 0.90; footprint compact retained"
        : "same-direction narrow evidence, but crop audit is EDGE_TIGHT_BUT_COMPLETE and provider face envelope still contacts right edge 1.00" });
  }

  expect(inventory).toHaveLength(9);
  const generationCounts = { PRE_CONTRACT: inventory.filter(row => row.promptGeneration === "PRE_CONTRACT").length,
    POST_CONTRACT: inventory.filter(row => row.promptGeneration === "POST_CONTRACT").length,
    UNKNOWN_CONTRACT: inventory.filter(row => row.promptGeneration === "UNKNOWN_CONTRACT").length };
  expect(generationCounts).toEqual({ PRE_CONTRACT: 7, POST_CONTRACT: 2, UNKNOWN_CONTRACT: 0 });

  const post = inventory.filter(row => row.promptGeneration === "POST_CONTRACT");
  const tierA = post.filter(row => row.anchorTier === "TIER_A_CALIBRATION_ANCHOR");
  const tierB = post.filter(row => row.anchorTier === "TIER_B_DIRECTIONAL_ANCHOR");
  expect(tierA.map(row => row.caseId)).toEqual(["striped-open-shirt"]);
  expect(tierB.map(row => row.caseId)).toEqual(["warm-white-tee"]);
  const classAnchors = {
    NARROW: { eligibleCount: tierA.filter(row => row.sourceOpennessRubric === "narrow").length,
      directionalOnlyCount: tierB.filter(row => row.sourceOpennessRubric === "narrow").length,
      eligibleScores: tierA.filter(row => row.sourceOpennessRubric === "narrow").map(row => row.rawOpenness),
      directionalScores: tierB.filter(row => row.sourceOpennessRubric === "narrow").map(row => row.rawOpenness) },
    NORMAL: { eligibleCount: tierA.filter(row => row.sourceOpennessRubric === "normal").length,
      directionalOnlyCount: tierB.filter(row => row.sourceOpennessRubric === "normal").length,
      eligibleScores: tierA.filter(row => row.sourceOpennessRubric === "normal").map(row => row.rawOpenness), directionalScores: [] },
    OPEN: { eligibleCount: tierA.filter(row => row.sourceOpennessRubric === "open").length,
      directionalOnlyCount: tierB.filter(row => row.sourceOpennessRubric === "open").length,
      eligibleScores: tierA.filter(row => row.sourceOpennessRubric === "open").map(row => row.rawOpenness), directionalScores: [] },
  };
  expect(classAnchors).toMatchObject({ NARROW: { eligibleCount: 1, directionalOnlyCount: 1, eligibleScores: [0.5], directionalScores: [0.5] },
    NORMAL: { eligibleCount: 0 }, OPEN: { eligibleCount: 0 } });

  const paired = ["striped-open-shirt", "warm-white-tee"].map(caseId => {
    const before = guardedTargets.geometryResults.find(item => item.caseId === caseId)!;
    const after = postTargets.geometryResults.find(item => item.caseId === caseId)!;
    expect(before.faceCropSha256).toBe(after.faceCropSha256);
    return { caseId, cropHash: after.faceCropSha256, cropGuard: 0.65, preContractPrompt: OLD_PROMPT,
      postContractPrompt: CURRENT_PROMPT, before: before.geometry.eyes.openness, after: after.geometry.eyes.openness,
      delta: after.geometry.eyes.openness - before.geometry.eyes.openness,
      evidence: "CONTRACT_SCALE_SHIFT_EVIDENCE" };
  });
  expect(paired.map(row => [row.before, row.after])).toEqual([[0.7, 0.5], [0.7, 0.5]]);

  const normalRubric = rubric.cases.filter(item => item.rubric.eyeOpenness.values?.includes("normal")
    && item.glassesOrCovering === "none");
  const primaryRows = [...primarySix.primaryResults, ...targetedPrimary.primaryResults];
  const candidateRows = normalRubric.map(item => {
    const observations = primaryRows.filter(row => row.caseId === item.id && row.ok);
    const hasPortraitRegion = observations.some(row => row.sourceSelection?.portraitRegion);
    for (const row of observations) expect(row.sourceSha256).toBe(item.sourceSha256);
    expect(item.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.sourceBytes).toBeGreaterThan(0);
    expect(observations.length > 0 || historical.selected.some(row => row.id === item.id)).toBe(true);
    return { caseId: item.id, sourceLabel: "normal", sourceSha256: item.sourceSha256,
      sourceBytes: item.sourceBytes, sourceScorable: true, noSunglassesOrOcclusion: true,
      storedProductionEquivalentPortraitRegion: hasPortraitRegion,
      candidateStatus: hasPortraitRegion ? "NORMAL_ANCHOR_CANDIDATE" : "blocked_missing_production_portrait_region" };
  });
  expect(candidateRows.map(row => row.caseId).sort()).toEqual(["buzz-striped", "sleeveless-bag-skirt", "wavy-open-blazer"]);
  expect(candidateRows.every(row => !row.storedProductionEquivalentPortraitRegion)).toBe(true);
  const openRubric = rubric.cases.filter(item => item.rubric.eyeOpenness.values?.includes("open"));
  expect(openRubric).toHaveLength(0);

  const topology = [0.34, 0.35, 0.67, 0.68].map(topologyAt);
  expect(topology).toEqual(expect.arrayContaining([
    expect.objectContaining({ score: 0.34, bin: "compact", topology: "compact_dark" }),
    expect.objectContaining({ score: 0.35, bin: "readable", topology: "readable_iris" }),
    expect.objectContaining({ score: 0.68, bin: "open", topology: "open_iris_sclera" }),
  ]));
  const categoricalMapping = { narrow: "compact", normal: "readable", open: "open" };
  const threshold = {
    current: { compactMax: 0.34, openMin: 0.68 },
    mappingIntent: categoricalMapping,
    currentLowBoundaryCompatibility: bin(0.5) === "compact" ? "COMPATIBLE" : "CURRENT_LOW_BOUNDARY_INCOMPATIBLE_WITH_ANCHOR",
    currentHighBoundaryEvaluability: "NOT_EVALUABLE_WITHOUT_POST_CONTRACT_NORMAL_AND_OPEN_ANCHORS",
    lowBoundary: { status: "LOW_BOUNDARY_NOT_IDENTIFIABLE", feasibleInterval: null,
      reason: "eligible post-contract narrow exists, but eligible post-contract normal does not" },
    highBoundary: { status: "HIGH_BOUNDARY_NOT_IDENTIFIABLE", feasibleInterval: null,
      reason: "eligible post-contract normal and open anchors do not exist" },
    crossContractFittingProhibited: true,
    readiness: "CURRENT_THRESHOLD_INCOMPATIBLE_BUT_REPLACEMENT_UNIDENTIFIABLE",
  };
  expect(threshold.currentLowBoundaryCompatibility).toBe("CURRENT_LOW_BOUNDARY_INCOMPATIBLE_WITH_ANCHOR");

  const scoreGranularity = { postContractN: post.length,
    uniqueScores: [...new Set(post.map(row => row.rawOpenness))], repeatedValues: [{ score: 0.5, count: 2 }],
    confidenceValues: post.map(row => row.eyesConfidence), conclusion: "n=2; insufficient to classify provider score granularity" };
  const candidates = { normal: { eligible: [], reviewed: candidateRows },
    open: { eligible: [], reviewed: [], reason: "no frozen open-openness source label exists in the audited rubric/corpus" } };
  const acquisition = { priority: [
    { order: 1, class: "NORMAL", required: 1, immediateCallable: false,
      nextBoundary: "obtain or independently validate a production-equivalent portraitRegion for an existing frozen normal case; wavy-open-blazer is the cleanest frozen source candidate" },
    { order: 2, class: "OPEN", required: 1, immediateCallable: false,
      nextBoundary: "identify an already-frozen scorable open source before any geometry call; none exists in the current rubric" },
    { order: 3, class: "NARROW", required: 0, immediateCallable: true,
      nextBoundary: "not required for first identifiability pass; striped Tier A plus warm Tier B already provide target-direction evidence" },
  ], providerCallsThisIteration: 0, primaryLocalizationCallsThisIteration: 0 };

  return {
    integrity: { expectedFileHashes: EXPECTED_HASHES, currentPromptSha256: CURRENT_PROMPT,
      currentSchemaSha256: CURRENT_SCHEMA, sourceRubricSha256: EXPECTED_HASHES.rubric },
    inventory: { observationCount: inventory.length, generationCounts, observations: inventory,
      exclusions: ["synthetic/manual geometry and deterministic replays are not provider-origin observations",
        "direct-face-geometry-20260913 used a different 10,558-byte direct-contour contract and retained no eye-openness score"] },
    anchors: { postContractCount: post.length, tierA, tierB, classes: classAnchors, scoreGranularity },
    threshold: { ...threshold, sameCaseContractShift: paired }, topology: { categoricalMapping, continuousBoundaries: topology,
      lossFunction: { compact: "compact_dark; one-row narrow topology", readable: "readable_iris; ordinary readable topology",
        open: "open_iris_sclera; lower-row eye pixel may survive" }, objective: "source-visible identity preservation, not numeric score matching" },
    candidates, acquisition,
    traceBacklog: "frozen: geometryUsage.eyes=true while measurementTrace can remain categorical_grammar",
    overall: "NEEDS_POST_CONTRACT_ANCHORS",
  };
}

it("separates prompt generations and refuses cross-contract threshold fitting", () => {
  const review = buildReview();
  expect(review.inventory.generationCounts).toEqual({ PRE_CONTRACT: 7, POST_CONTRACT: 2, UNKNOWN_CONTRACT: 0 });
  expect(review.anchors.classes.NARROW).toMatchObject({ eligibleCount: 1, directionalOnlyCount: 1 });
  expect(review.anchors.classes.NORMAL.eligibleCount).toBe(0);
  expect(review.anchors.classes.OPEN.eligibleCount).toBe(0);
  expect(review.threshold.readiness).toBe("CURRENT_THRESHOLD_INCOMPATIBLE_BUT_REPLACEMENT_UNIDENTIFIABLE");
  expect(review.overall).toBe("NEEDS_POST_CONTRACT_ANCHORS");
});

it.skipIf(!BUILD)("writes the post-contract threshold evidence review artifacts", () => {
  const review = buildReview();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("contract-generation-inventory.json", review.inventory);
  write("post-contract-anchor-table.json", review.anchors);
  write("threshold-identifiability.json", review.threshold);
  write("topology-mapping.json", review.topology);
  write("anchor-candidates.json", review.candidates);
  write("acquisition-plan.json", review.acquisition);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face geometry openness threshold evidence review\n\n` +
    `- Offline only: remote/provider/geometry/JPEG/evaluator/package-manager calls 0.\n` +
    `- Provider-origin face-only openness observations: 9 total; PRE_CONTRACT 7, POST_CONTRACT 2, UNKNOWN 0.\n` +
    `- Numeric calibration uses POST_CONTRACT only. Historical scores remain qualitative prompt-shift/candidate evidence.\n` +
    `- Striped is Tier A: current prompt and production crop, FULL_FACE_MARGIN_OK, confidence 0.90, frozen narrow label, compact footprint retained.\n` +
    `- Warm is Tier B only: same-direction 0.50 replication, but EDGE_TIGHT_BUT_COMPLETE and provider envelopeRight=1.00.\n` +
    `- Eligible anchors: narrow 1 at 0.50; normal 0; open 0. Current compactMax=0.34 does not map the narrow anchor to compact.\n` +
    `- Neither boundary is identifiable: low lacks a same-contract normal anchor; high lacks normal and open anchors. No midpoint or cross-contract fitting was performed.\n` +
    `- Same-case prompt shift is 0.70 -> 0.50 for striped and warm with identical guarded crop hashes.\n` +
    `- Existing frozen normal sources lack a stored production-equivalent portraitRegion; no frozen open source exists in the audited rubric.\n` +
    `- Readiness: CURRENT_THRESHOLD_INCOMPATIBLE_BUT_REPLACEMENT_UNIDENTIFIABLE.\n\n` +
    `NEEDS_POST_CONTRACT_ANCHORS\n`, { flag: "wx" });
});
