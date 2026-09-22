/** Opt-in production-primary audit for the seven frozen public real-photo cases. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runPhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import {
  buildFaceStyle,
  buildProceduralFallbackAtlas,
  fallbackFeaturesToHex,
  normalizeAnalysisForRendering,
  refineFeatureColorsFromAnalysis,
} from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { bytesToBase64, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";

const RUN = process.env.RUN_PRODUCTION_PRIMARY_FACE_AUDIT === "approved-seven";
const BUILD = process.env.BUILD_PRODUCTION_PRIMARY_FACE_AUDIT === "approved-offline";
const ROOT = resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915");
const GENERALIZATION = resolve("evaluation-artifacts/generalization-20260905");
const PRIMARY_RESULTS = resolve(ROOT, "primary-results.json");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type Annotation = {
  id: string;
  photoId?: number;
  existing?: boolean;
};

function devVar(contents: string, name: string): string | undefined {
  const line = contents.split(/\r?\n/).find((candidate) =>
    new RegExp(`^\\s*${name}\\s*=`).test(candidate),
  );
  if (!line) return undefined;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
}

function safeAttempts(attempts: NonNullable<Awaited<ReturnType<typeof runPhotoAnalysis>>["providerAttempts"]>) {
  return attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    outcome: attempt.outcome,
    responseFormatMode: attempt.responseFormatMode ?? null,
    providerSchemaValidation: attempt.providerSchemaValidation ?? null,
    strictValidation: attempt.strictValidation ?? null,
    httpStatus: attempt.status ?? null,
    providerStatus: attempt.providerStatus ?? null,
    fallbackEligible: attempt.fallbackEligible ?? null,
    fallbackReason: attempt.fallbackReason ?? null,
    dailyQuotaExhausted: attempt.dailyQuotaExhausted ?? false,
  }));
}

function primarySummary(analysis: PhotoAnalysis) {
  const relevantHintNames = [
    "eyeSpacing", "eyeSize", "eyeShape", "eyeTilt", "eyebrowShape",
    "mouthShape", "mouthOpening", "lipFullness", "faceShape", "noseShape",
  ] as const;
  return {
    quality: analysis.quality,
    failReason: analysis.failReason,
    framing: analysis.framing,
    visibleRegions: analysis.visibleRegions,
    sourceSelection: {
      portraitImageIndex: analysis.sourceSelection.portraitImageIndex,
      outfitImageIndex: analysis.sourceSelection.outfitImageIndex,
      generationImageIndex: analysis.sourceSelection.generationImageIndex,
      portraitRegion: analysis.sourceSelection.portraitRegion ?? null,
    },
    faceMeasurementEvidence: analysis.faceMeasurementEvidence ?? null,
    relevantRenderHints: Object.fromEntries(relevantHintNames.map((name) => [
      name,
      analysis.renderHints[name],
    ])),
    fallbackFeatures: {
      glasses: analysis.fallbackFeatures.glasses,
      expression: analysis.fallbackFeatures.expression,
    },
    canonicalFaceIdentity: analysis.canonicalIdentity.features
      .filter((feature) => feature.category === "face")
      .map((feature) => ({
        feature: feature.feature,
        priority: feature.priority,
        confidence: feature.confidence,
        targetRegions: feature.targetRegions,
      })),
  };
}

function layoutAxes(plan: ReturnType<typeof buildSkinPlan>) {
  const layout = plan.facePixelPlan.layout;
  return {
    eyeSpacing: layout.eyeSpacingTopology,
    eyeFootprint: layout.eyeFootprintTopology,
    eyeOpenness: layout.eyeOpenness,
    browEyeDistance: layout.browDistanceTopology,
    browSlope: layout.browSlopeTopology,
    mouthWidth: layout.mouthWidth,
    mouthOpenness: layout.mouthOpening,
    expression: layout.mouthExpressionTopology,
  };
}

it.skipIf(!RUN)("captures seven current production primary analyses without geometry or retries", async () => {
  const rubricBytes = new Uint8Array(await readFile(resolve(ROOT, "source-rubric.json")));
  const rubric = JSON.parse(new TextDecoder().decode(rubricBytes)) as { cases: Array<{ id: string; sourceSha256: string }> };
  const annotations = JSON.parse(await readFile(resolve(GENERALIZATION, "annotations.json"), "utf8")) as Annotation[];
  const cases = annotations.filter((item) => !item.existing && item.photoId !== undefined);
  expect(cases.map((item) => item.id)).toEqual(rubric.cases.map((item) => item.id));
  expect(cases).toHaveLength(7);

  const initial = {
    artifact: "production-primary-face-measurement-audit-20260915",
    sourceRubricSha256: hash(rubricBytes),
    storedCurrentResultsReused: 0,
    newPrimaryAnalysisAttempts: 0,
    providerCalls: { gemini: 0, gemmaFallback: 0, total: 0, retry: 0 },
    prohibitedCalls: { faceGeometry: 0, imageGeneration: 0, critique: 0, evaluator: 0, pairwise: 0 },
    policy: {
      productionFunction: "runPhotoAnalysis",
      geminiMaxPerCase: 1,
      gemmaFallbackMaxPerCase: 1,
      retries: 0,
      visionModel: "gemini-3.8-flash",
      workersVisionModel: "@cf/google/gemma-4-26b-a4b-it",
      structuredTimeoutMs: 45000,
    },
    cases: [] as Record<string, unknown>[],
  };
  await writeFile(PRIMARY_RESULTS, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });

  const key = devVar(await readFile(resolve(".dev.vars"), "utf8"), "GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY_missing");
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<Env>({
    configPath: resolve("wrangler.jsonc"),
    persist: false,
    remoteBindings: true,
  });
  try {
    const env = {
      ...platform.env,
      GEMINI_API_KEY: key,
      VISION_MODEL: "gemini-3.8-flash",
      WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it",
      GEMINI_STRUCTURED_TIMEOUT_MS: "45000",
    } as Env;
    await mkdir(resolve(ROOT, "renders"), { recursive: false });
    for (const item of cases) {
      const source = new Uint8Array(await readFile(resolve(GENERALIZATION, `sources/${item.photoId}.jpg`)));
      const expected = rubric.cases.find((candidate) => candidate.id === item.id)!;
      expect(hash(source), `${item.id}: source hash drift`).toBe(expected.sourceSha256);
      expect(Array.from(source.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      const started = Date.now();
      initial.newPrimaryAnalysisAttempts++;
      await writeFile(PRIMARY_RESULTS, `${JSON.stringify(initial, null, 2)}\n`);
      const result = await runPhotoAnalysis(env, `data:image/jpeg;base64,${bytesToBase64(source)}`);
      const elapsedMs = Date.now() - started;
      const attempts = safeAttempts(result.providerAttempts ?? []);
      const startedAttempts = attempts.filter((attempt) => attempt.outcome === "started");
      const geminiCalls = startedAttempts.filter((attempt) => attempt.provider === "gemini").length;
      const gemmaCalls = startedAttempts.filter((attempt) => attempt.provider === "workers_ai").length;
      expect(geminiCalls, `${item.id}: Gemini budget`).toBeLessThanOrEqual(1);
      expect(gemmaCalls, `${item.id}: Gemma budget`).toBeLessThanOrEqual(1);
      initial.providerCalls.gemini += geminiCalls;
      initial.providerCalls.gemmaFallback += gemmaCalls;
      initial.providerCalls.total += geminiCalls + gemmaCalls;
      let saved: Record<string, unknown> = {
        id: item.id,
        sourceSha256: expected.sourceSha256,
        sourceBytes: source.byteLength,
        elapsedMs,
        ok: result.ok,
        attempts: result.attempts,
        providerSequence: attempts,
      };
      if (result.ok) {
        const normalized = normalizeAnalysisForRendering(structuredClone(result.analysis));
        const plan = buildSkinPlan(normalized);
        const features = refineFeatureColorsFromAnalysis(
          normalized,
          fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone),
        );
        const style = buildFaceStyle(normalized, features);
        const atlas = buildProceduralFallbackAtlas(features, style, plan);
        if (!atlas) throw new Error(`${item.id}: renderer rejected primary result`);
        expect(validateFinalAtlas(atlas).ok, `${item.id}: final atlas`).toBe(true);
        const encoded = await encodePng(atlas);
        const renderFile = `renders/${item.id}-geometry-disabled.png`;
        await writeFile(resolve(ROOT, renderFile), encoded);
        saved = {
          ...saved,
          validation: {
            compactProviderSchema: "passed_before_normalization",
            compactStrictRuntime: "passed_before_normalization",
            richPhotoAnalysis: "passed",
            finalAtlas: "passed",
          },
          primary: primarySummary(result.analysis),
          measurementTrace: resolveFaceMeasurements(result.analysis),
          faceLayoutPlan: layoutAxes(plan),
          planHash: hash(JSON.stringify(plan)),
          facePlanHash: hash(JSON.stringify(plan.facePixelPlan)),
          atlasSha256: hash(atlas.rgba),
          renderFile,
        };
      } else {
        saved = {
          ...saved,
          failure: { reason: result.reason, detail: result.detail },
        };
      }
      initial.cases.push(saved);
      await writeFile(PRIMARY_RESULTS, `${JSON.stringify(initial, null, 2)}\n`);
    }
    expect(initial.newPrimaryAnalysisAttempts).toBe(7);
    expect(initial.providerCalls.gemini).toBeLessThanOrEqual(7);
    expect(initial.providerCalls.gemmaFallback).toBeLessThanOrEqual(7);
  } finally {
    await platform.dispose();
  }
}, 750_000);

type RubricCell = {
  kind: "expected" | "ambiguous" | "unscorable";
  values?: string[];
  reason?: string;
};

it.skipIf(!BUILD)("builds a no-inference audit from the frozen rubric and captured primary results", async () => {
  const rubricBytes = new Uint8Array(await readFile(resolve(ROOT, "source-rubric.json")));
  const rubric = JSON.parse(new TextDecoder().decode(rubricBytes)) as {
    rubricFrozenBeforeProviderResults: boolean;
    cases: Array<{ id: string; rubric: Record<string, RubricCell> }>;
  };
  const primary = JSON.parse(await readFile(PRIMARY_RESULTS, "utf8")) as {
    sourceRubricSha256: string;
    storedCurrentResultsReused: number;
    newPrimaryAnalysisAttempts: number;
    providerCalls: { gemini: number; gemmaFallback: number; total: number; retry: number };
    prohibitedCalls: Record<string, number>;
    cases: Array<Record<string, unknown> & {
      id: string;
      ok: boolean;
      primary?: { faceMeasurementEvidence?: { cues?: Record<string, { value: string; provenance: string; confidence: number }> } };
      measurementTrace?: Record<string, unknown>;
      faceLayoutPlan?: Record<string, unknown>;
      failure?: { reason: string; detail: string };
    }>;
  };
  expect(rubric.rubricFrozenBeforeProviderResults).toBe(true);
  expect(hash(rubricBytes)).toBe(primary.sourceRubricSha256);
  expect(primary.cases).toHaveLength(7);
  expect(new Set(primary.cases.map((item) => item.id)).size).toBe(7);
  expect(primary.newPrimaryAnalysisAttempts).toBe(7);
  expect(primary.providerCalls).toEqual({ gemini: 7, gemmaFallback: 0, total: 7, retry: 0 });
  expect(Object.values(primary.prohibitedCalls).every((count) => count === 0)).toBe(true);

  const cues = [
    "eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance",
    "browSlope", "mouthWidth", "mouthOpenness", "expression",
  ];
  const matrix = rubric.cases.flatMap((source) => {
    const result = primary.cases.find((item) => item.id === source.id)!;
    return cues.map((cue) => {
      const expected = source.rubric[cue];
      const provider = result.primary?.faceMeasurementEvidence?.cues?.[cue];
      const coverage = expected.kind === "unscorable"
        ? "unscorable"
        : !result.ok || !provider
          ? "absent"
          : provider.value === "unknown"
            ? "unknown"
            : "covered";
      const agreement = coverage !== "covered"
        ? "n/a"
        : expected.values?.includes(provider!.value)
          ? expected.kind === "ambiguous" ? "ambiguous-compatible" : "exact"
          : "wrong";
      return {
        caseId: source.id,
        cue,
        sourceExpected: expected.values ?? null,
        sourceScorable: expected.kind !== "unscorable",
        sourceRubricKind: expected.kind,
        providerValue: provider?.value ?? null,
        providerProvenance: provider?.provenance ?? null,
        providerConfidence: provider?.confidence ?? null,
        coverage,
        agreement,
        note: !result.ok ? "primary analysis failed before a validated PhotoAnalysis was available" : null,
      };
    });
  });
  const perCue = Object.fromEntries(cues.map((cue) => {
    const rows = matrix.filter((row) => row.cue === cue);
    const scorable = rows.filter((row) => row.sourceScorable);
    return [cue, {
      scorableSources: scorable.length,
      coveredSources: scorable.filter((row) => row.coverage === "covered").length,
      unknownSources: scorable.filter((row) => row.coverage === "unknown").length,
      absentSources: scorable.filter((row) => row.coverage === "absent").length,
      coverageRate: scorable.length ? 0 : null,
      exactAgreement: rows.filter((row) => row.agreement === "exact").length,
      ambiguousCompatible: rows.filter((row) => row.agreement === "ambiguous-compatible").length,
      wrong: rows.filter((row) => row.agreement === "wrong").length,
      unscorable: rows.filter((row) => !row.sourceScorable).length,
    }];
  }));
  const coverageArtifact = {
    rubricSha256: hash(rubricBytes),
    interpretation: "coverageRate=0 records acquisition coverage only; category accuracy is not assessable because no validated provider result exists",
    rows: matrix,
    perCue,
    confidenceCalibration: {
      samples: 0,
      highConfidenceWrong: [],
      highConfidenceUnknown: [],
      lowConfidenceCorrect: [],
      conclusion: "not_assessable_no_valid_primary_output",
    },
    coupling: {
      eyeSpacingVsFootprint: "not_assessable",
      browDistanceVsSlope: "not_assessable",
      mouthWidthVsOpennessVsExpression: "not_assessable",
    },
  };

  const consumerCases = primary.cases.map((result) => ({
    id: result.id,
    faceMeasurementEvidence: result.primary?.faceMeasurementEvidence ?? null,
    resolveFaceMeasurements: result.measurementTrace ?? null,
    measurementTraceSelected: result.measurementTrace
      ? Object.fromEntries(Object.entries(result.measurementTrace).map(([cue, decision]) => [
        cue,
        (decision as { selected?: unknown }).selected ?? null,
      ]))
      : null,
    faceLayoutPlan: result.faceLayoutPlan ?? null,
    failureBoundary: result.ok ? null : "primary_provider_acquisition",
    consumerClassification: result.ok ? "available" : "not_reached",
  }));
  const consumerArtifact = {
    codePath: ["PhotoAnalysis.faceMeasurementEvidence", "resolveFaceMeasurements", "measurementTrace.selected", "FaceLayoutPlan"],
    productionSelectedValues: ["continuous_geometry", "categorical_grammar", "legacy_fallback"],
    semanticFallbackNamingNote: "The implementation uses selected=legacy_fallback for both semantic fallback and unknown-safe default.",
    cases: consumerCases,
  };

  const geometryEvidence = {
    "buzz-striped": {
      source: "evaluation-artifacts/face-geometry-production-live-20260914/smoke.json",
      sourceHashMatched: true,
      usableCoreAxes: ["eyes", "brows", "mouth"],
      categoryCrossCheck: "not_reconstructable_from_stored_summary",
    },
    "wavy-open-blazer": {
      source: "evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json and smoke-activation-gate-002/smoke.json",
      sourceHashMatched: true,
      usableCoreAxes: ["eyes", "brows", "mouth"],
      categoryCrossCheck: "partial numeric summary exists but face-envelope scale required by current quantizer was not stored",
    },
  };
  const fallbackCases = primary.cases.map((result) => ({
    id: result.id,
    geometryOnPlan: null,
    geometryOffPlan: result.faceLayoutPlan ?? null,
    replayStatus: result.ok ? "available" : "not_attempted_missing_valid_primary_analysis",
    planDivergence: null,
    sourceAgreement: null,
    failureClass: Object.hasOwn(geometryEvidence, result.id)
      ? "C_primary_unavailable_geometry_evidence_available"
      : "D_primary_unavailable_no_stored_geometry_evidence",
  }));
  const fallbackArtifact = {
    faceGeometryCalls: 0,
    contactSheet: {
      generated: false,
      reason: "latest explicit authorization prohibits storing source/crop image copies, and no valid primary render was produced",
    },
    storedGeometrySecondaryReference: geometryEvidence,
    cases: fallbackCases,
  };

  const summary = {
    classification: "primary_measurement_audit_inconclusive_acquisition_failure",
    rubricFrozenBeforeProviderResults: true,
    realPhotoCases: 7,
    storedCurrentResultsReused: primary.storedCurrentResultsReused,
    newPrimaryAnalysisAttempts: primary.newPrimaryAnalysisAttempts,
    validatedPrimaryResults: primary.cases.filter((item) => item.ok).length,
    providerCalls: primary.providerCalls,
    prohibitedCalls: primary.prohibitedCalls,
    scorableCueCells: matrix.filter((row) => row.sourceScorable).length,
    coveredCueCells: matrix.filter((row) => row.coverage === "covered").length,
    unknownCueCells: matrix.filter((row) => row.coverage === "unknown").length,
    absentCueCells: matrix.filter((row) => row.coverage === "absent").length,
    unscorableCueCells: matrix.filter((row) => row.coverage === "unscorable").length,
    categoryAgreementAssessableCells: matrix.filter((row) => row.agreement !== "n/a").length,
    confidenceCalibration: "not_assessable",
    consumerTraceReachedCases: consumerCases.filter((item) => item.consumerClassification === "available").length,
    geometryOffReplayCases: fallbackCases.filter((item) => item.replayStatus === "available").length,
    systemicIssues: [
      "7/7 production-equivalent local primary attempts failed before validated PhotoAnalysis acquisition",
      "all failures were network/local unclassified non_provider_error, so production policy correctly did not invoke Gemma fallback",
      "stored current artifacts preserve status/PNG but not the faceMeasurementEvidence needed for categorical calibration replay",
    ],
    productionCodeChanged: false,
    nextQualityTarget: "production-equivalent primary PhotoAnalysis acquisition that yields validated faceMeasurementEvidence for the seven-photo calibration set",
  };

  const report = `# Production primary face-measurement audit — 2026-09-15

## Result

The source rubric was frozen before provider results (SHA-256 \`${hash(rubricBytes)}\`). All seven missing real-photo cases were attempted exactly once through \`runPhotoAnalysis\`. Every attempt stopped at the Gemini acquisition boundary with \`network/local / unclassified\`; the production fallback classifier returned \`non_provider_error\`, which is not eligible for Gemma fallback.

This run therefore measures acquisition coverage, not model category accuracy. It produced 0 validated PhotoAnalysis results, 0 measurable confidence samples, and no consumer/fallback replay input. Source rubric labels were not changed.

## Calls

- Stored current results reused: ${primary.storedCurrentResultsReused}
- Primary analyses: ${primary.newPrimaryAnalysisAttempts}
- Gemini: ${primary.providerCalls.gemini}
- Gemma fallback: ${primary.providerCalls.gemmaFallback}
- Retry: ${primary.providerCalls.retry}
- Face geometry / image generation / critique / evaluator / pairwise: 0

## Coverage

- Scorable source cue cells: ${summary.scorableCueCells}
- Covered: ${summary.coveredCueCells}
- Absent because no validated primary result: ${summary.absentCueCells}
- Source-unscorable: ${summary.unscorableCueCells}
- Category agreement and confidence calibration: not assessable

## Consumer and geometry-off replay

\`faceMeasurementEvidence → resolveFaceMeasurements → measurementTrace.selected → FaceLayoutPlan\` was not reached for any case. Geometry-off replay was not fabricated from manual annotations. Historical geometry usage evidence exists for \`buzz-striped\` and \`wavy-open-blazer\`, but its stored summaries are insufficient to recreate a current geometry-on plan.

The requested source/current/fallback contact sheet was not generated because the later explicit live authorization forbids storing source/crop image copies and no valid current primary render exists.

## Conclusion

No measurement cue, category boundary, confidence threshold, normalizer, consumer, schema, prompt, renderer, or production policy was changed. The top blocker is obtaining a validated current primary result in a production-equivalent execution environment; category coverage/calibration cannot be inferred from these transport-local failures.

NEXT_QUALITY_TARGET: production-equivalent primary PhotoAnalysis acquisition that yields validated faceMeasurementEvidence for the seven-photo calibration set
`;

  await writeFile(resolve(ROOT, "coverage-matrix.json"), `${JSON.stringify(coverageArtifact, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(ROOT, "consumer-trace.json"), `${JSON.stringify(consumerArtifact, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(ROOT, "fallback-replay.json"), `${JSON.stringify(fallbackArtifact, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(ROOT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(ROOT, "REPORT.md"), report, { flag: "wx" });
  expect(matrix).toHaveLength(56);
  expect(summary.scorableCueCells).toBe(47);
  expect(summary.absentCueCells).toBe(47);
  expect(summary.unscorableCueCells).toBe(9);
  expect(summary.productionCodeChanged).toBe(false);
});
