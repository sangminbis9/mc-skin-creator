import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const BUILD = process.env.BUILD_PRIMARY_SIX_CASE_AUDIT === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001");
const LIVE = path.join(ROOT, "summary.json");
const WAVY = path.resolve("evaluation-artifacts/bound-profile-cli-primary-canary-live-20260921-001/summary.json");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const cues = ["eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance", "browSlope", "mouthWidth", "mouthOpenness", "expression"] as const;
const sixIds = ["buzz-striped", "bun-check", "warm-white-tee", "full-body-layered", "striped-open-shirt", "sleeveless-bag-skirt"];

type Cue = typeof cues[number];
type RubricCell = { kind: "expected" | "ambiguous" | "unscorable"; values?: string[]; reason?: string };
type RubricCase = { id: string; faceVisibility: string; glassesOrCovering: string; rubric: Record<Cue, RubricCell> };
type Row = {
  caseId: string; cue: Cue; sourceExpected: string[] | null; sourceScorable: boolean;
  providerValue: string | null; providerProvenance: string | null; providerConfidence: number | null;
  coverage: "covered" | "unknown" | "absent" | "unscorable";
  agreement: "exact" | "ambiguous-compatible" | "wrong" | "n/a";
};
type PrimaryResult = {
  caseId: string; ok: boolean; elapsedMs: number | null; providerSequence: Array<Record<string, unknown>>;
  validation: Record<string, string> | null; failure: { reason?: string | null; detail?: string | null } | null;
  sourceGlassesOrCovering: string; fallbackFeaturesGlasses: string | null; observedAccessories: string | null;
  canonicalAccessoryCues: Array<{ feature: string; evidence: string; confidence: string; priority: number; targetRegions: string[] }> | null;
  faceMeasurementEvidence: { cues: Record<Cue, { value: string; provenance: string; confidence: number }> } | null;
  measurementTraceSelected: Record<Cue, string> | null; categoricalOnlyFaceLayoutPlan: Record<string, unknown> | null;
  rubricComparison: Row[];
};
type BatchSummary = {
  sourceRubricSha256: string; classification: string; primaryResults: PrimaryResult[];
  startupAttempts: number; healthAttempts: number; health: { status: string };
  calls: Record<string, number>; providerCalls: Record<string, number>; prohibited: Record<string, number>;
  qSentCount: number; wranglerGracefulTeardownPathCompleted: boolean; ownedProcessInventoryClean: boolean;
  temporaryConfigRemoved: boolean; temporaryTokenFileRemoved: boolean; productionConfigChanged: boolean;
};
type WavySummary = {
  selectedCanary: { id: string; expectedSha256: string; expectedBytes: number };
  primary: {
    faceMeasurementEvidence: { cues: Record<Cue, { value: string; provenance: string; confidence: number }> };
    measurementTraceSelected: Record<Cue, string>; categoricalOnlyFaceLayoutPlan: Record<string, unknown>;
  };
  rubricComparison: Array<Omit<Row, "caseId">>;
};

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function sourcePresence(value: string): "present" | "absent" | "unknown" {
  const text = value.toLowerCase();
  if (/\b(?:no glasses|none)\b/.test(text)) return "absent";
  if (/\b(?:sunglasses|glasses|spectacles|eyeglasses|eyewear)\b/.test(text)) return "present";
  return "unknown";
}

function positiveAccessoryText(value: string): boolean {
  const withoutNegation = value.toLowerCase().replace(/\b(?:no|without)\s+(?:visible\s+|any\s+)?(?:glasses|spectacles|eyeglasses|eyewear|frames?)\b/g, " ");
  return /\b(?:sunglasses|glasses|spectacles|eyeglasses|eyewear)\b|\bframes?\s+(?:around|over)\s+(?:both\s+)?eyes?\b/.test(withoutNegation);
}

function glassesTaxonomy(result: PrimaryResult | null, source: "present" | "absent" | "unknown") {
  if (!result?.ok || !result.fallbackFeaturesGlasses) return "INSUFFICIENT_STORED_EVIDENCE";
  const tokenPresent = result.fallbackFeaturesGlasses !== "none";
  const texts = [result.observedAccessories ?? "", ...(result.canonicalAccessoryCues ?? []).flatMap(item => [item.feature, item.evidence])];
  const internalPositive = texts.some(positiveAccessoryText);
  const internalNegative = texts.some(value => /\b(?:no|without)\s+(?:visible\s+|any\s+)?(?:glasses|spectacles|eyeglasses|eyewear|frames?)\b|^none(?: visible)?$/i.test(value));
  if ((tokenPresent && internalNegative) || (!tokenPresent && internalPositive)) return "CROSS_FIELD_CONFLICT";
  if ((source === "present" && !tokenPresent) || (source === "absent" && tokenPresent)) return "SOURCE_CONFLICT";
  if (source === "present" && tokenPresent) return "CONSISTENT_PRESENT";
  if (source === "absent" && !tokenPresent) return "CONSISTENT_ABSENT";
  return "INSUFFICIENT_STORED_EVIDENCE";
}

function tupleSummary(cases: Array<{ id: string; cues: Record<Cue, { value: string }> | null }>, selected: Cue[]) {
  const tuples = cases.flatMap(item => {
    if (!item.cues) return [];
    const values = selected.map(cue => item.cues![cue]?.value ?? "unknown");
    return values.some(value => value === "unknown") ? [] : [{ caseId: item.id, tuple: values.join("|") }];
  });
  const counts = Object.fromEntries([...new Set(tuples.map(item => item.tuple))].map(tuple => [tuple, tuples.filter(item => item.tuple === tuple).length]));
  return { axes: selected, tuples, repeatedTuples: Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1)),
    interpretation: "descriptive repetition in a seven-case calibration set; no statistical independence claim" };
}

function buildArtifacts() {
  const batch = read<BatchSummary>(LIVE);
  const wavy = read<WavySummary>(WAVY);
  const rubricText = fs.readFileSync(RUBRIC, "utf8");
  const rubric = JSON.parse(rubricText) as { cases: RubricCase[] };
  expect(sha(rubricText)).toBe(RUBRIC_HASH);
  expect(batch.sourceRubricSha256).toBe(RUBRIC_HASH);
  expect(batch.primaryResults.map(item => item.caseId)).toEqual(sixIds);

  const wavyRows = wavy.rubricComparison.map(row => ({ caseId: "wavy-open-blazer", ...row })) as Row[];
  const rows = [...wavyRows, ...batch.primaryResults.flatMap(result => result.rubricComparison)];
  expect(rows).toHaveLength(56);
  const scorable = rows.filter(row => row.sourceScorable);
  const unscorable = rows.filter(row => !row.sourceScorable);
  expect(scorable).toHaveLength(47);
  expect(unscorable).toHaveLength(9);
  expect(scorable.filter(row => ["covered", "unknown", "absent"].includes(row.coverage))).toHaveLength(47);

  const perCue = Object.fromEntries(cues.map(cue => {
    const all = rows.filter(row => row.cue === cue);
    const source = all.filter(row => row.sourceScorable);
    return [cue, {
      scorableSources: source.length,
      coveredSources: source.filter(row => row.coverage === "covered").length,
      unknownSources: source.filter(row => row.coverage === "unknown").length,
      absentSources: source.filter(row => row.coverage === "absent").length,
      exactAgreement: all.filter(row => row.agreement === "exact").length,
      ambiguousCompatible: all.filter(row => row.agreement === "ambiguous-compatible").length,
      wrong: all.filter(row => row.agreement === "wrong").length,
    }];
  }));
  const confidence = {
    diagnosticThresholdsOnly: { high: 0.85, low: 0.8 },
    highConfidenceWrong: rows.filter(row => row.agreement === "wrong" && (row.providerConfidence ?? 0) >= 0.85),
    highConfidenceUnknown: rows.filter(row => row.coverage === "unknown" && (row.providerConfidence ?? 0) >= 0.85),
    lowConfidenceExact: rows.filter(row => row.agreement === "exact" && (row.providerConfidence ?? 1) < 0.8),
    highVisibilityLowConfidence: rows.filter(row => {
      const source = rubric.cases.find(item => item.id === row.caseId);
      return source?.faceVisibility === "high" && row.coverage === "covered" && (row.providerConfidence ?? 1) < 0.8;
    }),
  };

  const evidenceCases = [
    { id: "wavy-open-blazer", cues: wavy.primary.faceMeasurementEvidence.cues },
    ...batch.primaryResults.map(result => ({ id: result.caseId, cues: result.faceMeasurementEvidence?.cues ?? null })),
  ];
  const coupling = {
    eyeSpacingVsEyeFootprint: tupleSummary(evidenceCases, ["eyeSpacing", "eyeFootprint"]),
    browEyeDistanceVsBrowSlope: tupleSummary(evidenceCases, ["browEyeDistance", "browSlope"]),
    mouthWidthVsMouthOpennessVsExpression: tupleSummary(evidenceCases, ["mouthWidth", "mouthOpenness", "expression"]),
  };

  const glassesCases = [
    {
      caseId: "wavy-open-blazer", sourceState: "absent", fallbackFeaturesGlasses: "unavailable",
      observedAccessories: "unavailable", canonicalAccessoryCues: "unavailable",
      taxonomy: "SOURCE_CONFLICT", note: "historical trace proves only normalized non-none; exact token and provider cross-fields were not retained",
    },
    ...batch.primaryResults.map(result => {
      const sourceState = sourcePresence(result.sourceGlassesOrCovering);
      return {
        caseId: result.caseId,
        sourceState,
        sourceGlassesOrCovering: result.sourceGlassesOrCovering,
        fallbackFeaturesGlasses: result.fallbackFeaturesGlasses,
        observedAccessories: result.observedAccessories,
        canonicalAccessoryCues: result.canonicalAccessoryCues,
        taxonomy: glassesTaxonomy(result, sourceState),
      };
    }),
  ];

  const consumerCases = [
    { caseId: "wavy-open-blazer", measurementTraceSelected: wavy.primary.measurementTraceSelected,
      faceLayoutPlan: wavy.primary.categoricalOnlyFaceLayoutPlan, glassesToken: "unavailable" },
    ...batch.primaryResults.map(result => ({ caseId: result.caseId, measurementTraceSelected: result.measurementTraceSelected,
      faceLayoutPlan: result.categoricalOnlyFaceLayoutPlan, glassesToken: result.fallbackFeaturesGlasses,
      classification: result.ok ? "available" : "not_reached_primary_invalid" })),
  ];

  const coverage = {
    rubricSha256: RUBRIC_HASH,
    calibrationSetOnly: true,
    denominator: { totalCueCells: 56, scorableCueCells: 47, unscorableCueCells: 9 },
    totals: {
      covered: scorable.filter(row => row.coverage === "covered").length,
      unknown: scorable.filter(row => row.coverage === "unknown").length,
      absent: scorable.filter(row => row.coverage === "absent").length,
      exact: rows.filter(row => row.agreement === "exact").length,
      ambiguousCompatible: rows.filter(row => row.agreement === "ambiguous-compatible").length,
      wrong: rows.filter(row => row.agreement === "wrong").length,
    },
    perCue,
    rows,
  };

  const repeatedWrong = cues.map(cue => ({ cue, count: rows.filter(row => row.cue === cue && row.agreement === "wrong").length }))
    .filter(item => item.count > 1).sort((a, b) => b.count - a.count);
  const systemicIssues = [
    ...repeatedWrong.map(item => `${item.cue}: repeated wrong in ${item.count} cases`),
    `bun-check: strict runtime invalid_response left ${rows.filter(row => row.caseId === "bun-check" && row.sourceScorable).length} scorable cells absent`,
    `full-body-layered: ${rows.filter(row => row.caseId === "full-body-layered" && row.coverage === "unknown").length} source-scorable mouth cells unknown behind an otherwise correct sunglasses classification`,
  ].slice(0, 3);
  const combined = {
    classification: "seven_case_primary_face_measurement_calibration_complete_with_one_invalid_case",
    existingWavyReused: 1,
    newCasesAttemptedExactlyOnce: batch.primaryResults.length,
    validatedCases: 1 + batch.primaryResults.filter(result => result.ok).length,
    failedCases: batch.primaryResults.filter(result => !result.ok).map(result => ({ id: result.caseId, failure: result.failure })),
    coverage: coverage.totals,
    providerCalls: batch.providerCalls,
    calls: batch.calls,
    prohibited: batch.prohibited,
    confidence,
    coupling,
    systemicIssues,
    nextQualityTarget: repeatedWrong.length
      ? "calibrate repeated eye openness/footprint category errors without changing thresholds from this small set"
      : "resolve the largest repeated source-visible cue loss",
  };
  return { batch, coverage, confidence, coupling, glassesCases, consumerCases, combined };
}

it.skipIf(!fs.existsSync(LIVE) || !fs.existsSync(WAVY))("validates the secret-safe six-case live result and fixed 56-cell denominator", () => {
  const value = buildArtifacts();
  expect(value.batch.classification).toBe("READY_TO_REVIEW_SIX_CASE_PRIMARY_FACE_MEASUREMENT_AUDIT");
  expect(value.batch.startupAttempts).toBe(1);
  expect(value.batch.healthAttempts).toBe(1);
  expect(value.batch.calls).toMatchObject({ jpegReads: 6, hashChecks: 6, base64Preparations: 6, jpegTransmissions: 6, primaryPosts: 6 });
  expect(value.batch.providerCalls).toMatchObject({ geminiStarted: 6, gemmaStarted: 6, retry: 0 });
  expect(Object.values(value.batch.prohibited).every(count => count === 0)).toBe(true);
  expect(value.batch.qSentCount).toBe(1);
  expect(value.batch.wranglerGracefulTeardownPathCompleted && value.batch.ownedProcessInventoryClean).toBe(true);
  expect(value.batch.temporaryConfigRemoved && value.batch.temporaryTokenFileRemoved && !value.batch.productionConfigChanged).toBe(true);
  expect(value.coverage.totals.covered + value.coverage.totals.unknown + value.coverage.totals.absent).toBe(47);
});

it.skipIf(!BUILD || !fs.existsSync(LIVE) || !fs.existsSync(WAVY))("writes the combined seven-case calibration artifacts without provider calls", () => {
  const value = buildArtifacts();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name),
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("primary-results.json", { cases: value.batch.primaryResults });
  write("coverage-matrix.json", value.coverage);
  write("confidence-audit.json", { ...value.confidence, coupling: value.coupling });
  write("consumer-trace.json", { cases: value.consumerCases });
  write("glasses-consistency.json", {
    cases: value.glassesCases,
    normalizationFixLiveEvidence: "four validated no-glasses cases returned none, including unrelated bag/no-accessory cases; bun-check was invalid and cannot be counted",
    generalizationCaveat: "this bounded calibration set does not prove parser correctness for the population",
  });
  write("combined-seven-summary.json", value.combined);
  write("REPORT.md", `# Production primary face-measurement six-case live audit\n\n` +
    `- Existing wavy result reused without a new call: 8/8 covered, 8/8 exact.\n` +
    `- Remaining six cases were attempted exactly once in one health-gated Wrangler remote session.\n` +
    `- Five new cases produced validated PhotoAnalysis; bun-check ended at strict runtime invalid_response and the batch continued with known accounting.\n` +
    `- Scorable cells: ${value.coverage.totals.covered} covered, ${value.coverage.totals.unknown} unknown, ${value.coverage.totals.absent} absent; exact ${value.coverage.totals.exact}, ambiguous-compatible ${value.coverage.totals.ambiguousCompatible}, wrong ${value.coverage.totals.wrong}.\n` +
    `- Glasses: four validated no-glasses sources returned none; full-body-layered returned sunglasses with observed black sunglasses; bun-check is insufficient; historical wavy remains SOURCE_CONFLICT with exact token unavailable.\n` +
    `- Systemic candidates: ${value.combined.systemicIssues.join("; ")}.\n` +
    `- Calls: startup 1, health 1, JPEG/posts 6, Gemini ${value.batch.providerCalls.geminiStarted}, Gemma ${value.batch.providerCalls.gemmaStarted}, retry 0; geometry/generation/evaluator 0.\n` +
    `- Graceful q teardown, owned-process cleanup, temporary-file cleanup and production config hash equality all passed.\n\n` +
    `NEXT_QUALITY_TARGET: ${value.combined.nextQualityTarget}\n`);
});
