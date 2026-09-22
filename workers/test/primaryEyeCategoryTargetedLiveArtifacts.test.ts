import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ANALYSIS_PROMPT } from "../src/analysis";

const BUILD = process.env.BUILD_PRIMARY_EYE_TARGETED_LIVE_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001");
const CURRENT = path.join(ROOT, "summary.json");
const BASELINE = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001/summary.json");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const IDS = ["warm-white-tee", "striped-open-shirt", "sleeveless-bag-skirt"] as const;
const EYE_HINTS = ["eyeSpacing", "eyeSize", "eyeShape", "eyeTilt"] as const;
const CUES = ["eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance", "browSlope", "mouthWidth", "mouthOpenness", "expression"] as const;

type Measurement = { value: string; provenance: string; confidence: number };
type Primary = {
  caseId: string;
  sourceSha256: string;
  sourceBytes: number;
  httpStatus: number;
  ok: boolean;
  elapsedMs: number;
  providerSequence: Array<Record<string, unknown>>;
  validation: Record<string, string>;
  faceMeasurementEvidence: { cues: Record<string, Measurement> };
  relevantRenderHints: Record<string, string>;
  measurementTraceSelected: Record<string, string>;
  categoricalOnlyFaceLayoutPlan: Record<string, unknown>;
};
type Summary = {
  branch: string;
  head: string;
  sourceRubricSha256: string;
  selectedCases: Array<{ id: string; expectedSha256: string; expectedBytes: number }>;
  primaryResults: Primary[];
  startupAttempts: number;
  healthAttempts: number;
  health: { status: string; httpStatus: number };
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  prohibited: Record<string, number>;
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: path.resolve(".."), encoding: "utf8" }).trim();

function targetStatus(result: Primary): string {
  const cues = result.faceMeasurementEvidence.cues;
  const openness = cues.eyeOpenness.value;
  const footprint = cues.eyeFootprint.value;
  if (openness === "narrow" && footprint === "compact") return "RECOVERED_BOTH";
  if (openness === "narrow" && footprint === "medium") return "RECOVERED_OPENNESS_ONLY";
  if (openness === "normal" && footprint === "compact") return "RECOVERED_FOOTPRINT_ONLY";
  if (openness === "normal" && footprint === "medium") return "UNCHANGED_MIDDLE";
  return "OTHER_REGRESSION";
}

function buildArtifacts() {
  const current = read<Summary>(CURRENT);
  const baseline = read<Summary>(BASELINE);
  expect(current.sourceRubricSha256).toBe(RUBRIC_HASH);
  expect(hash(fs.readFileSync(RUBRIC))).toBe(RUBRIC_HASH);
  expect(current.selectedCases.map((item) => item.id)).toEqual(IDS);
  expect(current.primaryResults.map((item) => item.caseId)).toEqual(IDS);
  const oldById = new Map(baseline.primaryResults.map((item) => [item.caseId, item]));
  const newById = new Map(current.primaryResults.map((item) => [item.caseId, item]));
  const comparisons = IDS.map((caseId) => {
    const before = oldById.get(caseId)!;
    const after = newById.get(caseId)!;
    const selected = current.selectedCases.find((item) => item.id === caseId)!;
    expect(after.sourceSha256).toBe(selected.expectedSha256);
    expect(after.sourceBytes).toBe(selected.expectedBytes);
    expect(after.httpStatus).toBe(200);
    expect(after.ok).toBe(true);
    expect(after.validation).toEqual({ compactProviderSchema: "passed", compactStrictRuntime: "passed", richPhotoAnalysis: "passed" });
    const measurements = Object.fromEntries(CUES.map((cue) => [cue, {
      before: before.faceMeasurementEvidence.cues[cue],
      after: after.faceMeasurementEvidence.cues[cue],
      categoryChanged: before.faceMeasurementEvidence.cues[cue].value !== after.faceMeasurementEvidence.cues[cue].value,
      confidenceDelta: Number((after.faceMeasurementEvidence.cues[cue].confidence - before.faceMeasurementEvidence.cues[cue].confidence).toFixed(4)),
    }]));
    const legacyEyeHints = Object.fromEntries(EYE_HINTS.map((hint) => [hint, {
      before: before.relevantRenderHints[hint], after: after.relevantRenderHints[hint],
      changed: before.relevantRenderHints[hint] !== after.relevantRenderHints[hint],
    }]));
    const status = caseId === "sleeveless-bag-skirt"
      ? after.faceMeasurementEvidence.cues.eyeOpenness.value === "normal"
        && after.faceMeasurementEvidence.cues.eyeFootprint.value === "medium" ? "STABLE" : "REGRESSED"
      : targetStatus(after);
    return {
      caseId,
      sourceVerification: { sha256: after.sourceSha256, bytes: after.sourceBytes, passedBeforeTransmission: true },
      providerSequence: after.providerSequence,
      elapsedMs: after.elapsedMs,
      status,
      measurements,
      legacyEyeHints,
      measurementTrace: after.measurementTraceSelected,
      faceLayoutPlan: { before: before.categoricalOnlyFaceLayoutPlan, after: after.categoricalOnlyFaceLayoutPlan,
        changed: JSON.stringify(before.categoricalOnlyFaceLayoutPlan) !== JSON.stringify(after.categoricalOnlyFaceLayoutPlan) },
    };
  });
  const targetStatuses = comparisons.slice(0, 2).map((item) => item.status);
  const sentinel = comparisons[2].status;
  const classification = sentinel === "REGRESSED" ? "OVER_CORRECTION"
    : targetStatuses.every((status) => status === "RECOVERED_BOTH") ? "TARGETED_CALIBRATION_PASS"
      : targetStatuses.every((status) => status === "UNCHANGED_MIDDLE") ? "PROMPT_PATCH_NO_OBSERVED_EFFECT"
        : "PARTIAL_RECOVERY";
  const promptClauses = [
    "Judge eyeSpacing as the distance between the two eyes relative to face width.",
    "Judge eyeOpenness from vertical eyelid aperture only",
    "Judge eyeFootprint as one eye's overall visible horizontal span relative to the face",
    "do not derive it from inter-eye spacing or vertical openness",
  ];
  for (const clause of promptClauses) expect(ANALYSIS_PROMPT).toContain(clause);
  const results = {
    branch: current.branch,
    head: current.head,
    exactCases: IDS,
    prompt: {
      analysisPromptSha256: hash(ANALYSIS_PROMPT),
      clarificationClausesSha256: hash(promptClauses.join("\n")),
      analysisSourceDiffSha256: hash(git("diff", "--", "workers/src/analysis.ts")),
      schemaChanges: 0, thresholdChanges: 0, normalizerChanges: 0, rendererChanges: 0,
    },
    rubricSha256: current.sourceRubricSha256,
    remote: { startupAttempts: current.startupAttempts, healthAttempts: current.healthAttempts, health: current.health },
    calls: current.calls,
    providerCalls: current.providerCalls,
    prohibited: current.prohibited,
    comparisons,
    classification,
  };
  expect(current.calls).toMatchObject({ jpegReads: 3, hashChecks: 3, base64Preparations: 3, jpegTransmissions: 3, primaryPosts: 3 });
  expect(current.providerCalls.geminiStarted).toBeLessThanOrEqual(3);
  expect(current.providerCalls.gemmaStarted).toBeLessThanOrEqual(3);
  expect(current.providerCalls.retry).toBe(0);
  expect(Object.values(current.prohibited).every((value) => value === 0)).toBe(true);
  expect(current).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true, ownedProcessInventoryClean: true,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
  expect(classification).toBe("PROMPT_PATCH_NO_OBSERVED_EFFECT");
  return results;
}

it("classifies the exact three-case live recheck without changing its frozen rubric", () => {
  const results = buildArtifacts();
  expect(results.comparisons.map((item) => item.status)).toEqual(["UNCHANGED_MIDDLE", "UNCHANGED_MIDDLE", "STABLE"]);
});

it.skipIf(!BUILD)("writes secret-safe targeted live comparison artifacts", () => {
  const results = buildArtifacts();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("results.json", results);
  write("before-after.json", { cases: results.comparisons.map(({ caseId, status, measurements, legacyEyeHints }) => ({ caseId, status, measurements, legacyEyeHints })) });
  write("consumer-trace.json", { cases: results.comparisons.map(({ caseId, measurementTrace, faceLayoutPlan }) => ({ caseId, measurementTrace, faceLayoutPlan })) });
  write("plan-diff.json", {
    cases: results.comparisons.map(({ caseId, faceLayoutPlan }) => ({ caseId, categoricalFaceLayoutPlan: faceLayoutPlan,
      eyeCoordinates: "not_retained_by_existing_secret_safe_live_capture",
      eyeFootprintCells: "not_retained_by_existing_secret_safe_live_capture",
      eyePixelHash: "not_retained_by_existing_secret_safe_live_capture",
      entireFacePixelPlanHash: "not_retained_by_existing_secret_safe_live_capture" })),
    nonFabricationNote: "Exact FacePixelPlan fields were not reconstructed from partial live evidence.",
  });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Targeted eye-category live recheck\n\n` +
    `- Exact cases: warm-white-tee, striped-open-shirt, sleeveless-bag-skirt.\n` +
    `- Frozen rubric SHA-256: ${RUBRIC_HASH}.\n` +
    `- Remote startup/health: 1/1; health HTTP ${results.remote.health.httpStatus}.\n` +
    `- Sources read/hashed/transmitted: 3/3/3, only after health passed.\n` +
    `- Warm target: UNCHANGED_MIDDLE (normal/medium).\n` +
    `- Striped target: UNCHANGED_MIDDLE (normal/medium).\n` +
    `- Sleeveless sentinel: STABLE (normal/medium).\n` +
    `- All eight cues remained categorical_grammar consumers; categorical FaceLayoutPlan values were unchanged.\n` +
    `- Existing secret-safe capture did not retain exact FacePixelPlan pixels/hashes; none were fabricated.\n` +
    `- Gemini/Gemma started: ${results.providerCalls.geminiStarted}/${results.providerCalls.gemmaStarted}; retry 0.\n` +
    `- Geometry/generation/critique/pairwise/evaluator calls: 0.\n` +
    `- Teardown: literal q once, graceful path and process inventory clean, temporary files removed.\n` +
    `- Production config unchanged; no post-result production source change.\n\n` +
    `${results.classification}\n`, { flag: "wx" });
});
