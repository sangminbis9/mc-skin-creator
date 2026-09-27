import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_AUDIT_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-calibration-audit-20260922-001");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const HISTORICAL = path.resolve("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
const OLD_TARGETS = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001/summary.json");
const NEW_TARGETS = path.resolve("evaluation-artifacts/face-crop-lateral-guard-geometry-live-20260922-001/summary.json");
const ANNOTATIONS = path.resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const QUANTIZER = path.resolve("src/identityQuantization.ts");
const STORED_CONTRACT = path.join(ROOT, "openness-contract.json");

const EXPECTED = {
  rubric: "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27",
  historical: "e86822b1308e4dbe3725a3e0812adc8360d516e2de7efef35bc0b39d7b5b99ef",
  oldTargets: "b1e3964859c76b02f3d535634bbb5425e54a48d1839bbd2dbb00a0dba58f30f7",
  newTargets: "9676b8b68b7f38dba5382b3a2a16ac004ed9cea7bdc7ef58bd14500249b80ca2",
  prompt: "c1b9f013368b15bc7b92fc6dbc600875e685ee14e9e3ef6a959f7816bf8af68f",
  geometrySource: "93fb270567180bb09d0942717c3ff6a14982c01a8944585648b2b740b4b4b954",
  quantizerSource: "66f11a6a3499ed16e775ab6df08cda4891fc9fcc2b26cd31bcccf144cb8a7468",
} as const;

type Rubric = { cases: Array<{ id: string; rubric: { eyeOpenness: { kind: string; values?: string[]; reason?: string } } }> };
type Historical = {
  model: string;
  selected: Array<{ id: string; sourceHash: string; faceHash: string; cropBox: number[]; dimensions: { width: number; height: number } }>;
  results: Array<{ id: string; ok: boolean; providerShapeValid: boolean; semanticValid: boolean; elapsedMs: number;
    measurements: { eyes: { openness: number; confidence: number; leftWidth: number; rightWidth: number } } }>;
};
type TargetSummary = { geometryResults: Array<{ caseId: string; sourceSha256: string; faceCropSha256: string; elapsedMs: number;
  ok: boolean; providerShapeValid: boolean; semanticValidationPassed: boolean;
  primaryFaceMeasurementEvidence: { cues: { eyeOpenness: { value: string; confidence: number } } };
  geometry: { face: { envelopeLeft: number; envelopeRight: number }; eyes: { openness: number; confidence?: number; leftWidth: number; rightWidth: number };
    confidence: { eyes: number } } }> };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => sha(fs.readFileSync(file));
const bin = (score: number) => score <= 0.34 ? "compact" : score >= 0.68 ? "open" : "readable";
const distance = (score: number) => {
  const candidates = [{ threshold: 0.34, signed: score - 0.34 }, { threshold: 0.68, signed: score - 0.68 }];
  return candidates.sort((a, b) => Math.abs(a.signed) - Math.abs(b.signed))[0];
};

function topologyAt(openness: number) {
  const base = makeAnalysis();
  const geometry = makeIdentityGeometry();
  const analysis = {
    ...base,
    identityGeometry: { ...geometry, eyes: { ...geometry.eyes, openness } },
  };
  const face = buildFacePixelPlanVariants(analysis, 1)[0];
  if (!face) throw new Error("face plan unavailable");
  const eyePixels = face.pixels.filter(pixel => pixel.cluster === "left_eye" || pixel.cluster === "right_eye");
  return {
    score: openness,
    bin: face.layout.eyeOpenness,
    topology: face.layout.eyeTopology,
    eyePixelCount: eyePixels.length,
    eyePixels: eyePixels.map(({ x, y, role, cluster }) => ({ x, y, role, cluster }))
      .sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role)),
  };
}

function buildAudit() {
  expect(fileHash(RUBRIC)).toBe(EXPECTED.rubric);
  expect(fileHash(HISTORICAL)).toBe(EXPECTED.historical);
  expect(fileHash(OLD_TARGETS)).toBe(EXPECTED.oldTargets);
  expect(fileHash(NEW_TARGETS)).toBe(EXPECTED.newTargets);
  expect(fileHash(QUANTIZER)).toBe(EXPECTED.quantizerSource);
  const storedContract = read<{ hashes: { prompt: string; geometrySource: string } }>(STORED_CONTRACT);
  expect(storedContract.hashes).toMatchObject({ prompt: EXPECTED.prompt, geometrySource: EXPECTED.geometrySource });
  expect(FACE_MEASUREMENT_VALUES.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);

  const rubric = read<Rubric>(RUBRIC);
  const historical = read<Historical>(HISTORICAL);
  const oldTargets = read<TargetSummary>(OLD_TARGETS);
  const newTargets = read<TargetSummary>(NEW_TARGETS);
  const annotations = read<Array<{ id: string; face?: string }>>(ANNOTATIONS);
  const rubricLabel = (id: string) => rubric.cases.find(item => item.id === id)?.rubric.eyeOpenness.values?.[0] ?? null;
  const annotationLabel = (id: string) => annotations.find(item => item.id === id)?.face?.includes("narrow eyes") ? "narrow" : null;

  const corpus: Array<Record<string, unknown>> = [];
  for (const result of historical.results) {
    const selected = historical.selected.find(item => item.id === result.id)!;
    expect(result).toMatchObject({ ok: true, providerShapeValid: true, semanticValid: true });
    const label = rubricLabel(result.id) ?? annotationLabel(result.id);
    corpus.push({
      observationId: `historical-face-only:${result.id}`,
      caseId: result.id,
      corpusClass: result.id === "wavy-open-blazer" ? "provider_origin_frozen_rubric" : "provider_origin_historical_fixture",
      sourceLabel: label,
      sourceLabelAuthority: rubricLabel(result.id) ? "frozen_source_rubric" : annotationLabel(result.id) ? "historical_annotation" : "none",
      rawOpenness: result.measurements.eyes.openness,
      eyeConfidence: result.measurements.eyes.confidence,
      meanEyeWidth: (result.measurements.eyes.leftWidth + result.measurements.eyes.rightWidth) / 2,
      cropProvenance: { sourceHash: selected.sourceHash, faceHash: selected.faceHash, cropBox: selected.cropBox, dimensions: selected.dimensions },
      cropValidity: result.id === "wavy-open-blazer" ? "historical_reviewed_full_face_margin" : "historical_controlled_fixture_no_retained_face_envelope",
      calibrationUse: result.id === "wavy-open-blazer" ? "normal_anchor_secondary" : result.id === "short-hair-red-shirt" ? "narrow_anchor_secondary_manual_fixture" : "distribution_only",
      provider: historical.model,
      providerValidated: true,
      elapsedMs: result.elapsedMs,
      currentBin: bin(result.measurements.eyes.openness),
      nearestThreshold: distance(result.measurements.eyes.openness),
      artifact: path.relative(path.resolve("."), HISTORICAL),
    });
  }

  const addTargets = (summary: TargetSummary, cropVersion: "old" | "corrected") => {
    for (const result of summary.geometryResults) {
      expect(result).toMatchObject({ ok: true, providerShapeValid: true, semanticValidationPassed: true });
      const openness = result.geometry.eyes.openness;
      const edge = { left: result.geometry.face.envelopeLeft <= 0.01, right: result.geometry.face.envelopeRight >= 0.99 };
      const correctedStriped = cropVersion === "corrected" && result.caseId === "striped-open-shirt";
      corpus.push({
        observationId: `${cropVersion}-target:${result.caseId}`,
        caseId: result.caseId,
        corpusClass: "provider_origin_frozen_rubric",
        sourceLabel: rubricLabel(result.caseId),
        sourceLabelAuthority: "frozen_source_rubric",
        primaryCategoricalLabel: result.primaryFaceMeasurementEvidence.cues.eyeOpenness.value,
        rawOpenness: openness,
        eyeConfidence: result.geometry.confidence.eyes,
        meanEyeWidth: (result.geometry.eyes.leftWidth + result.geometry.eyes.rightWidth) / 2,
        cropProvenance: { sourceHash: result.sourceSha256, faceHash: result.faceCropSha256, version: cropVersion },
        cropValidity: result.caseId === "warm-white-tee"
          ? cropVersion === "corrected" ? "partial_right_edge_envelope_1.00" : "right_clipped"
          : cropVersion === "corrected" ? "partial_lateral_recovery_envelope_0.03..0.99" : "left_clipped",
        cropEdgeContact: edge,
        calibrationUse: correctedStriped ? "narrow_directional_anchor_partial_crop" : "excluded_crop_confounded",
        provider: "@cf/google/gemma-4-26b-a4b-it",
        providerValidated: true,
        elapsedMs: result.elapsedMs,
        currentBin: bin(openness),
        nearestThreshold: distance(openness),
        artifact: path.relative(path.resolve("."), cropVersion === "old" ? OLD_TARGETS : NEW_TARGETS),
      });
    }
  };
  addTargets(oldTargets, "old");
  addTargets(newTargets, "corrected");

  expect(corpus).toHaveLength(7);
  const frequencies = [...new Set(corpus.map(row => Number(row.rawOpenness)))].sort((a, b) => a - b)
    .map(score => ({ score, count: corpus.filter(row => row.rawOpenness === score).length,
      labels: [...new Set(corpus.filter(row => row.rawOpenness === score).map(row => row.sourceLabel).filter(Boolean))] }));
  expect(frequencies).toEqual([
    { score: 0.7, count: 4, labels: ["narrow"] },
    { score: 0.8, count: 1, labels: ["narrow"] },
    { score: 0.85, count: 1, labels: ["normal"] },
    { score: 0.9, count: 1, labels: [] },
  ]);

  const topology = [0.67, 0.68, 0.7, 0.85].map(topologyAt);
  expect(topology.find(row => row.score === 0.67)).toMatchObject({ bin: "readable", topology: "readable_iris" });
  expect(topology.find(row => row.score === 0.68)).toMatchObject({ bin: "open", topology: "open_iris_sclera" });
  expect(topology.find(row => row.score === 0.68)!.eyePixelCount)
    .toBeGreaterThan(topology.find(row => row.score === 0.67)!.eyePixelCount);

  const opennessContract = {
    hashes: { prompt: EXPECTED.prompt, geometrySource: EXPECTED.geometrySource, quantizerSource: EXPECTED.quantizerSource, sourceRubric: EXPECTED.rubric },
    layers: [
      { layer: "frozen source rubric", low: "narrow", middle: "normal", high: "open", intendedMeaning: "stable source-visible vertical eye aperture identity" },
      { layer: "primary faceMeasurementEvidence", low: "narrow", middle: "normal", high: "open", intendedMeaning: "vertical eyelid aperture only; stable observed categorical relation" },
      { layer: "face-only continuous geometry", low: "0 = narrow/closed", middle: "unspecified continuum", high: "1 = fully open", intendedMeaning: "ambiguous mixture of stable aperture morphology and instantaneous closed/open eyelid state" },
      { layer: "FaceLayoutPlan", low: "compact / compact_dark", middle: "readable / readable_iris", high: "open / open_iris_sclera", intendedMeaning: "Minecraft eye pixel topology; high adds a second iris row" },
    ],
    schema: { openness: { type: "number", minimum: 0, maximum: 1 }, required: true },
    validator: "finite number in [0,1]; no semantic or ratio validation",
    type: "number inherited through IdentityGeometryAnalysis['eyes']",
    denominator: "none specified; unlike width/spacing it is not divided by face envelope or eye width",
    semanticCollision: { narrow: "stable visible aperture morphology", closed: "instantaneous eyelid state", combinedByPrompt: true },
    classification: "SEMANTIC_CONTRACT_MISMATCH",
  };

  const thresholdOrigin = {
    compactMax: 0.34,
    openMin: 0.68,
    introducedCommit: "8dd55f991941cbec789adc7ce2879c75484d0866",
    introducedAt: "2026-08-29T11:41:19+09:00",
    commitSubject: "Improve Minecraft skin creator workflow and UI",
    sourceComment: null,
    providerContractDerivation: null,
    calibrationArtifactAtIntroduction: null,
    boundaryTestAtIntroduction: null,
    currentTests: "exercise representative values and mirror constants; no provider-origin threshold calibration proof",
    thresholdEvidence: "ungrounded",
  };

  const alignment = {
    rows: corpus.filter(row => row.sourceLabel).map(row => ({ observationId: row.observationId, caseId: row.caseId,
      sourceLabel: row.sourceLabel, rawOpenness: row.rawOpenness, currentBin: row.currentBin,
      cropValidity: row.cropValidity, calibrationUse: row.calibrationUse })),
    anchors: {
      narrow: { frozenCurrent: ["striped-open-shirt corrected (partial crop)", "warm-white-tee corrected (crop-confounded)"], historicalSecondary: ["short-hair-red-shirt 0.80"], fullQualityCount: 0 },
      normal: { secondaryHistorical: ["wavy-open-blazer 0.85"], fullQualityCount: 1 },
      open: { cases: [], count: 0 },
    },
    monotonicEvidence: "compatible but insufficient: corrected striped narrow 0.70 < wavy normal 0.85; historical short narrow 0.80 < wavy normal 0.85; no open anchor",
    contradiction: "all labeled narrow and normal observations quantize to open under current >=0.68 boundary",
  };

  const rawDistribution = {
    observationCount: corpus.length,
    uniqueSourceCount: new Set(corpus.map(row => row.caseId)).size,
    uniqueScores: frequencies,
    min: Math.min(...corpus.map(row => Number(row.rawOpenness))),
    max: Math.max(...corpus.map(row => Number(row.rawOpenness))),
    allProviderValidated: corpus.every(row => row.providerValidated),
    presetLikeEvidence: "suggestive_not_strong: four of seven observations equal 0.70 and all scores lie on 0.05/0.10 steps, but the corpus is too small and crop variants are correlated",
    invariance: {
      warm: { old: 0.7, corrected: 0.7, confidenceOld: 0.9, confidenceCorrected: 0.9 },
      striped: { old: 0.7, corrected: 0.7, confidenceOld: 0.9, confidenceCorrected: 0.95,
        meanWidthOld: 0.2505, meanWidthCorrected: 0.1525, normalizedFootprintOld: 2.1094736842105264, normalizedFootprintCorrected: 1.2708333333333333 },
    },
  };

  const topologySemantics = {
    mapping: {
      compact: { topology: "compact_dark unless smiling/crescent P5 cue selects smiling_squint", ordinaryPixels: "one eye row" },
      readable: { topology: "readable_iris", ordinaryPixels: "one eye row" },
      open: { topology: "open_iris_sclera", ordinaryPixels: "attempts one lower iris cell per eye; later ownership/collisions may remove a candidate" },
    },
    boundaryProbe: topology,
    discontinuity: "0.67 is readable_iris; 0.68 is open_iris_sclera and the audited final plan gains one surviving lower iris pixel, creating a two-row eye topology",
    likenessRisk: "a narrow source mapped to open receives a two-row iris grammar that reads taller/rounder at 8x8",
    widthIndependence: "eye footprint controls horizontal eyeXs/width while openness independently controls vertical topology",
  };

  const strategies = {
    finalTaxonomy: "MIXED",
    primary: "SEMANTIC_CONTRACT_MISMATCH",
    secondary: ["RAW_RANK_USEFUL_BIN_CALIBRATION_UNGROUNDED", "INSUFFICIENT_CALIBRATION_EVIDENCE"],
    notEstablished: ["RAW_MEASUREMENT_WRONG", "COARSE_PROVIDER_SCORE", "QUANTIZER_THRESHOLD_MISMATCH"],
    rootCauseRanking: [
      { rank: 1, cause: "continuous prompt combines narrow morphology with closed eyelid state", strength: "direct contract evidence" },
      { rank: 2, cause: "0.34/0.68 bins lack provider-origin calibration evidence", strength: "git/source/test audit" },
      { rank: 3, cause: "provider emits coarse round values", strength: "suggestive only; seven correlated observations" },
      { rank: 4, cause: "raw ordering is wrong", strength: "not supported by scorable anchors; available narrow scores rank below normal" },
    ],
    options: [
      { id: "A", strategy: "geometry prompt contract clarification", assessment: "recommended next boundary; separate stable aperture morphology from closed-eyelid state without selecting new thresholds" },
      { id: "B", strategy: "quantizer calibration", assessment: "not justified: zero open anchors and no fully clean current narrow anchor" },
      { id: "C", strategy: "add categorical openness to geometry output", assessment: "future option only if clarified continuous output remains coarse" },
      { id: "D", strategy: "accept limitation and use safe fallback", assessment: "architecturally possible but primary categorical openness was also wrong for warm/striped" },
      { id: "E", strategy: "tiny targeted calibration set", assessment: "needed before numeric threshold fitting, but calls remain prohibited in this iteration" },
    ],
    hybridFeasibility: {
      current: "all-or-nothing at the eyesFromGeometry group: spacing, footprint, openness, row, width and tilt all select geometry together",
      structuralPossibility: "yes; independent layout fields permit geometry spacing/footprint with fallback openness",
      currentSafety: "not safe to activate: primary categorical openness returned normal for both warm and striped despite frozen narrow labels",
      traceBacklogFrozen: "geometryUsage.eyes=true while resolveFaceMeasurements can report categorical_grammar because it checks identityGeometry rather than faceIdentityGeometry",
    },
    recommendedSingleNextBoundary: "clarify FACE_IDENTITY_GEOMETRY_PROMPT openness as stable visible aperture morphology and separate closed-eyelid state",
  };

  return { corpus, opennessContract, thresholdOrigin, alignment, rawDistribution, topologySemantics, strategies };
}

it("audits the stored provider-origin openness corpus and threshold topology offline", () => {
  const audit = buildAudit();
  expect(audit.rawDistribution.observationCount).toBe(7);
  expect(audit.alignment.anchors.open.count).toBe(0);
  expect(audit.thresholdOrigin.thresholdEvidence).toBe("ungrounded");
  expect(audit.strategies.finalTaxonomy).toBe("MIXED");
  expect(audit.corpus.filter(row => row.caseId === "striped-open-shirt").map(row => row.rawOpenness)).toEqual([0.7, 0.7]);
});

it.skipIf(!BUILD)("writes the face geometry openness calibration audit artifacts", () => {
  const audit = buildAudit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("openness-contract.json", audit.opennessContract);
  write("provider-origin-corpus.json", { integrity: EXPECTED, corpus: audit.corpus });
  write("raw-score-distribution.json", audit.rawDistribution);
  write("source-score-alignment.json", audit.alignment);
  write("threshold-origin.json", audit.thresholdOrigin);
  write("topology-semantics.json", audit.topologySemantics);
  write("strategy-comparison.json", audit.strategies);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face geometry openness calibration audit\n\n` +
    `- Scope: offline only; external calls 0; production source changes 0.\n` +
    `- Exact continuous contract: \`openness 0=narrow/closed to 1=fully open\`; schema/validator enforce only a finite 0..1 number and specify no denominator.\n` +
    `- Primary categorical/rubric meaning is stable vertical eyelid aperture; the continuous prompt merges that morphology with instantaneous eyelid closure.\n` +
    `- Provider-origin validated corpus: 7 observations / 5 sources. Distribution: 0.70 x4, 0.80 x1, 0.85 x1, 0.90 x1.\n` +
    `- Corrected striped is the cleanest directional diagnostic: mean width 0.2505 -> 0.1525 and footprint 2.109 -> 1.271, while openness stayed 0.70 and confidence rose 0.90 -> 0.95.\n` +
    `- Warm remains crop-confounded because corrected envelopeRight is 1.00.\n` +
    `- Available labeled ordering is compatible with narrow < normal, but every score maps to open and there is no provider-origin open-class anchor.\n` +
    `- The 0.34/0.68 thresholds entered in commit 8dd55f99 without a source comment, calibration artifact, provider derivation, or boundary test; thresholdEvidence=ungrounded.\n` +
    `- The 0.67 -> 0.68 transition changes readable_iris to open_iris_sclera; the audited final plan gains one surviving lower iris pixel and becomes two rows tall.\n` +
    `- Final taxonomy: MIXED; primary SEMANTIC_CONTRACT_MISMATCH, secondary RAW_RANK_USEFUL_BIN_CALIBRATION_UNGROUNDED and INSUFFICIENT_CALIBRATION_EVIDENCE.\n` +
    `- Do not fit a new threshold from this corpus. Per-axis hybrid is structurally possible but not currently safe because primary categorical openness also mislabeled warm/striped as normal.\n` +
    `- TRACE_PROVENANCE_INCONSISTENCY and the 0.65 lateral guard remain frozen.\n\n` +
    `NEXT_QUALITY_TARGET: clarify face-only geometry openness as stable visible aperture morphology and separate closed-eyelid state\n`, { flag: "wx" });
});
