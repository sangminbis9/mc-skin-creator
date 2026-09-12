/** Gemini 3.8 migration diagnostic only; never imported by the production caller. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { validatePhotoAnalysis } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_HINT_GROUPS } from "../src/compactPhotoAnalysis";
import {
  COMPACT_PHOTO_ANALYSIS_V3_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  normalizeCompactPhotoAnalysisV3,
  validateCompactPhotoAnalysisV3,
  validateCompactPhotoAnalysisV3Provider,
} from "../src/compactPhotoAnalysisV3";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import {
  buildGeminiStructuredRequestEnvelope,
  type GeminiStructuredRequest,
} from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { safeProviderMessage } from "./primaryTransportSupport";

type CallResult = {
  id: "A" | "B";
  attemptedCalls: number;
  httpStatus: number | null;
  providerCode: number | null;
  providerStatus: string | null;
  providerMessage: string | null;
  jsonReturned: boolean;
  providerAjvValidation: boolean;
  providerShapeValidation: boolean;
  strictRuntimeValidation: boolean | null;
  richNormalization: boolean | null;
  richValidation: boolean | null;
  completed: boolean;
  [key: string]: unknown;
};

type FailedFaceMeasurementDiagnostic = {
  index: number;
  cue: (typeof COMPACT_FACE_ORDER)[number];
  value: string;
  provenance: string;
  confidence: number;
  allowedValuesForCue: readonly string[];
};

type ProviderPayload = {
  error?: { code?: number; status?: string; message?: string };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
};

const OFFLINE_ROOT = resolve("evaluation-artifacts/compact-v3-offline-20260910");
const COVERAGE = resolve("evaluation-artifacts/compact-manual-fixture-coverage-20260910/coverage.json");
const PRIOR_LIVE_ROOT = resolve("evaluation-artifacts/compact-primary-v3-gemini38-live-20260911");
const PRIOR_PREFLIGHT = join(PRIOR_LIVE_ROOT, "preflight.json");
const LIVE_ROOT = resolve("evaluation-artifacts/compact-primary-v3-gemini38-120s-live-20260911");
const LIVE_RESULT = join(LIVE_ROOT, "result.json");
const JPEG_PATH = resolve("evaluation-artifacts/generalization-20260905/sources/29002888.jpg");
const JPEG_SHA256 = "0c5a890f0e54275e2851a66f5f6ba92578c0d4feabf83c826aafa57cbf7a1d5a";
const SCHEMA_SHA256 = "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986";
const PROMPT_SHA256 = "056218d82b23d619a91d845fdc24bdd70bc8afab7b75b00ba97a241db7f4767c";
const CLIENT_TIMEOUT_MS = "120000";
const BASELINE_MODEL = "gemini-3.6-flash";
const MODEL = "gemini-3.8-flash";
const BASELINE_ENDPOINT = `/v1beta/models/${BASELINE_MODEL}:generateContent`;
const ENDPOINT = `/v1beta/models/${MODEL}:generateContent`;
const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const prompt = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}${referenceSuffix}`;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function request(model: string, images: string[]): GeminiStructuredRequest {
  return {
    model,
    imageDataUrls: images,
    prompt,
    responseSchema: COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
    maxOutputTokens: 8192,
    allowWorkersAiFallback: false,
  };
}

function withoutTemperature(body: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(body) as { generationConfig?: Record<string, unknown> };
  if (copy.generationConfig) delete copy.generationConfig.temperature;
  return copy;
}

function buildGemini38MigrationEnvelope(options: GeminiStructuredRequest) {
  const baseline = buildGeminiStructuredRequestEnvelope(options);
  const body = withoutTemperature(baseline.body);
  return {
    body,
    shape: {
      ...baseline.shape,
      temperature: null,
      serializedBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
    },
  };
}

function failedFaceMeasurementDiagnostic(
  raw: unknown,
  errorPaths: readonly string[],
): FailedFaceMeasurementDiagnostic | undefined {
  const match = errorPaths
    .map((path) => /^(?:compact\.)?faceMeasurements\[(\d+)](?:\.|:)/.exec(path))
    .find((candidate) => candidate !== null);
  if (!match) return undefined;
  const index = Number(match[1]);
  const cue = COMPACT_FACE_ORDER[index];
  if (!Number.isInteger(index) || !cue || typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const measurements = (raw as Record<string, unknown>).faceMeasurements;
  if (!Array.isArray(measurements)) return undefined;
  const failed = measurements[index];
  if (typeof failed !== "object" || failed === null || Array.isArray(failed)) return undefined;
  const value = (failed as Record<string, unknown>).value;
  const provenance = (failed as Record<string, unknown>).provenance;
  const confidence = (failed as Record<string, unknown>).confidence;
  if (typeof value !== "string" || typeof provenance !== "string"
    || typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  return { index, cue, value, provenance, confidence,
    allowedValuesForCue: [...FACE_MEASUREMENT_VALUES[cue]] };
}

function sourceContract(raw: unknown): Record<string, unknown> {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const selection = typeof value.sourceSelection === "object" && value.sourceSelection !== null
    ? value.sourceSelection as Record<string, unknown> : {};
  const sourceIndices = [selection.portraitImageIndex, selection.outfitImageIndex, selection.generationImageIndex];
  const measurements = Array.isArray(value.faceMeasurements) ? value.faceMeasurements : [];
  const hints = typeof value.renderHints === "object" && value.renderHints !== null
    ? value.renderHints as Record<string, unknown> : {};
  const hintGroups = Object.entries(COMPACT_HINT_GROUPS);
  const evidenceContractValid = measurements.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const cue = item as Record<string, unknown>;
    return (cue.value === "unknown" && cue.provenance === "unknown" && cue.confidence === 0)
      || (cue.value !== "unknown" && cue.provenance !== "unknown"
        && typeof cue.confidence === "number" && cue.confidence >= 0.75 && cue.confidence <= 1);
  });
  const identityFeatureCount = Array.isArray(value.identityFeatures) ? value.identityFeatures.length : null;
  return {
    sourceIndices,
    sourceIndicesAllZero: sourceIndices.every((index) => index === 0),
    portraitIndexMatchesContext: selection.portraitImageIndex === 0,
    faceMeasurementCount: measurements.length,
    expectedFaceMeasurementCount: COMPACT_FACE_ORDER.length,
    faceMeasurementsComplete: measurements.length === COMPACT_FACE_ORDER.length,
    faceMeasurementEvidenceContractValid: evidenceContractValid,
    observedMeasurementCount: measurements.filter((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).value !== "unknown").length,
    unknownMeasurementCount: measurements.filter((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).value === "unknown").length,
    renderHintGroupCount: Object.keys(hints).length,
    expectedRenderHintGroupCount: hintGroups.length,
    renderHintGroupsAndLengthsMatch: hintGroups.every(([group, slots]) =>
      Array.isArray(hints[group]) && hints[group].length === slots.length),
    renderHintSlotCount: Object.values(hints).reduce((sum, group) => sum + (Array.isArray(group) ? group.length : 0), 0),
    expectedRenderHintSlotCount: hintGroups.reduce((sum, [, slots]) => sum + slots.length, 0),
    identityFeatureCount,
    identityFeatureMinimumSatisfied: typeof identityFeatureCount === "number" && identityFeatureCount >= 4,
  };
}

async function preflight() {
  const [complexity, semantic, frozen, preservation, coverage, priorPreflight, jpegBytes] = await Promise.all([
    readFile(join(OFFLINE_ROOT, "complexity.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "semantic-equivalence.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "frozen-regression.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "source-preservation.json"), "utf8").then(JSON.parse),
    readFile(COVERAGE, "utf8").then(JSON.parse),
    readFile(PRIOR_PREFLIGHT, "utf8").then(JSON.parse),
    readFile(JPEG_PATH),
  ]);
  const metrics = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
  expect(metrics).toMatchObject({
    valid: true,
    serializedBytes: 4688,
    propertyCount: 98,
    requiredCount: 13,
    depth: 5,
    enumValueCount: 39,
    unsupportedConstructs: [],
  });
  expect(complexity).toMatchObject({
    selected: "C",
    generations: { v3: {
      ...metrics,
      enumDeclarations: 7,
      largestEnum: 16,
      promptBytes: Buffer.byteLength(COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
      promptHash: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
    } },
    liveCalls: 0,
  });
  expect(semantic).toMatchObject({ fixtures: 8, sourceSemanticLoss: 0, planDiffs: 0, atlasDiffs: 0 });
  expect(frozen).toMatchObject({ cases: 12, craftApproved: 12, calibrated: 5, planDiffs: 0, atlasDiffs: 0 });
  expect(coverage).toMatchObject({ afterStrictAccepted: 12, fabricationCount: 0,
    v2V3RichDiffs: 0, allStrictNormalizedCorePlanDiffs: 0,
    allStrictNormalizedAtlasDiffs: 0, craftApproved: 12,
    calibratedCases: 5, calibratedAtlasDiffs: 0, providerCalls: 0,
    compactV3Active: false });
  expect(preservation).toMatchObject({ activeSelectionChanged: false, providerCalls: 0 });
  expect(sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)).toBe(SCHEMA_SHA256);
  expect(sha(prompt)).toBe(PROMPT_SHA256);
  expect([...jpegBytes.subarray(0, 3)]).toEqual([255, 216, 255]);
  expect(jpegBytes.byteLength).toBe(204067);
  expect(fileSha(jpegBytes)).toBe(JPEG_SHA256);

  const jpegDataUrl = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`;
  const baselineText = buildGeminiStructuredRequestEnvelope(request(BASELINE_MODEL, []));
  const targetText = buildGemini38MigrationEnvelope(request(MODEL, []));
  const baselineJpeg = buildGeminiStructuredRequestEnvelope(request(BASELINE_MODEL, [jpegDataUrl]));
  const targetJpeg = buildGemini38MigrationEnvelope(request(MODEL, [jpegDataUrl]));
  for (const [baseline, target, imageParts] of [
    [baselineText, targetText, 0],
    [baselineJpeg, targetJpeg, 1],
  ] as const) {
    expect(baseline.shape).toMatchObject({ model: BASELINE_MODEL, apiFamily: "generateContent",
      apiVersion: "v1beta", temperature: 0, imageParts, maxOutputTokens: 8192,
      responseMimeType: "application/json" });
    expect(target.shape).toMatchObject({ model: MODEL, apiFamily: "generateContent",
      apiVersion: "v1beta", temperature: null, imageParts, maxOutputTokens: 8192,
      responseMimeType: "application/json" });
    expect((baseline.body as { generationConfig: Record<string, unknown> }).generationConfig.temperature).toBe(0);
    expect((target.body as { generationConfig: Record<string, unknown> }).generationConfig)
      .not.toHaveProperty("temperature");
    expect((target.body as { generationConfig: Record<string, unknown> }).generationConfig.thinkingConfig)
      .toEqual({ thinkingLevel: "LOW" });
    expect(target.body).toEqual(withoutTemperature(baseline.body));
  }
  expect(targetJpeg.shape).toMatchObject({ imageMimeTypes: ["image/jpeg"], imageRawBytes: [204067],
    imageMagicMatchesMime: [true] });
  expect(BASELINE_ENDPOINT).toBe("/v1beta/models/gemini-3.6-flash:generateContent");
  expect(ENDPOINT).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
  expect(priorPreflight).toMatchObject({
    schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
    promptHash: sha(prompt),
    targetTextWireHash: sha(targetText.body),
    targetJpegWireHash: sha(targetJpeg.body),
  });
  return { complexity, semantic, frozen, preservation, coverage, jpegBytes, metrics,
    priorPreflight, baselineText, targetText, baselineJpeg, targetJpeg };
}

describe("Gemini 3.8 Compact v3 migration preflight", () => {
  it("allows only model, endpoint and temperature omission deltas", async () => {
    const ready = await preflight();
    await mkdir(LIVE_ROOT, { recursive: true });
    await writeFile(join(LIVE_ROOT, "preflight.json"), JSON.stringify({
      baselineModel: BASELINE_MODEL,
      model: MODEL,
      baselineEndpoint: BASELINE_ENDPOINT,
      endpoint: ENDPOINT,
      requestDelta: ["model", "endpoint.modelSegment", "generationConfig.temperature:removed"],
      schemaHash: SCHEMA_SHA256,
      promptHash: PROMPT_SHA256,
      schemaMetrics: ready.metrics,
      baselineTextWireHash: sha(ready.baselineText.body),
      targetTextWireHash: sha(ready.targetText.body),
      baselineJpegWireHash: sha(ready.baselineJpeg.body),
      targetJpegWireHash: sha(ready.targetJpeg.body),
      priorTextWireHash: ready.priorPreflight.targetTextWireHash,
      priorJpegWireHash: ready.priorPreflight.targetJpegWireHash,
      textWireHashEqualTo45s: ready.priorPreflight.targetTextWireHash === sha(ready.targetText.body),
      jpegWireHashEqualTo45s: ready.priorPreflight.targetJpegWireHash === sha(ready.targetJpeg.body),
      priorClientTimeoutMs: 45000,
      clientTimeoutMs: Number(CLIENT_TIMEOUT_MS),
      temperatureFieldPresent: false,
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      imageMetadata: { provider: "Pexels", fileName: "29002888.jpg", mimeType: "image/jpeg",
        rawBytes: ready.jpegBytes.byteLength, sha256: fileSha(ready.jpegBytes),
        magicMatchesMime: true, representation: "raw_base64_in_inlineData" },
      offlineEvidence: { strictBoundaryAccepted: ready.coverage.afterStrictAccepted,
        manualFixtureCoverageGap: 12 - ready.coverage.afterStrictAccepted,
        fabricationCount: ready.coverage.fabricationCount,
        craftApproved: ready.frozen.craftApproved, calibratedCases: ready.frozen.calibrated,
        calibratedAtlasDiffs: ready.coverage.calibratedAtlasDiffs,
        semanticPlanAtlasDiffs: ready.semantic.planDiffs + ready.semantic.atlasDiffs },
      providerCalls: 0,
      productionActivated: false,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_PRIMARY_V3_GEMINI38_CANARY !== "1")(
  "authorized Gemini 3.8 Compact v3 text-first live canary",
  () => {
    it("runs JPEG only after complete text-only provider acceptance", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const ready = await preflight();
      const artifact: {
        maxProviderCalls: number;
        totalProviderCalls: number;
        model: string;
        apiFamily: string;
        apiVersion: string;
        endpoint: string;
        requestDelta: string[];
        temperatureFieldPresent: boolean;
        thinkingConfig: { thinkingLevel: string };
        maxOutputTokens: number;
        responseMimeType: string;
        schemaHash: string;
        promptHash: string;
        schemaMetrics: unknown;
        offlineEvidence: Record<string, unknown>;
        canaryA: CallResult;
        canaryB: CallResult;
        classification: string | null;
        productionActivated: boolean;
      } = {
        maxProviderCalls: 2,
        totalProviderCalls: 0,
        model: MODEL,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: ENDPOINT,
        requestDelta: ["model", "endpoint.modelSegment", "generationConfig.temperature:removed"],
        temperatureFieldPresent: false,
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        schemaHash: SCHEMA_SHA256,
        promptHash: PROMPT_SHA256,
        schemaMetrics: ready.metrics,
        offlineEvidence: {
          semanticFixtures: ready.semantic.fixtures,
          sourceSemanticLoss: ready.semantic.sourceSemanticLoss,
          planDiffs: ready.semantic.planDiffs,
          atlasDiffs: ready.semantic.atlasDiffs,
          frozenCases: ready.frozen.cases,
          craftApproved: ready.frozen.craftApproved,
          calibratedCases: ready.frozen.calibrated,
          strictBoundaryAccepted: ready.coverage.afterStrictAccepted,
          manualFixtureCoverageGap: 12 - ready.coverage.afterStrictAccepted,
          fabricationCount: ready.coverage.fabricationCount,
        },
        canaryA: { id: "A", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 0, wireHash: sha(ready.targetText.body),
          priorWireHash: ready.priorPreflight.targetTextWireHash,
          wireHashEqualTo45s: ready.priorPreflight.targetTextWireHash === sha(ready.targetText.body),
          clientTimeoutMs: Number(CLIENT_TIMEOUT_MS) },
        canaryB: { id: "B", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 1, wireHash: sha(ready.targetJpeg.body),
          priorWireHash: ready.priorPreflight.targetJpegWireHash,
          wireHashEqualTo45s: ready.priorPreflight.targetJpegWireHash === sha(ready.targetJpeg.body),
          clientTimeoutMs: Number(CLIENT_TIMEOUT_MS),
          imageMetadata: { provider: "Pexels", fileName: "29002888.jpg", mimeType: "image/jpeg",
            rawBytes: ready.jpegBytes.byteLength, sha256: fileSha(ready.jpegBytes),
            magicMatchesMime: true, representation: "raw_base64_in_inlineData" } },
        classification: null,
        productionActivated: false,
      };
      await mkdir(LIVE_ROOT, { recursive: true });
      await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2), { flag: "wx" });

      const run = async (
        result: CallResult,
        envelope: ReturnType<typeof buildGemini38MigrationEnvelope>,
        context: { imageCount: number } | null,
      ) => {
        expect((envelope.body as { generationConfig: Record<string, unknown> }).generationConfig)
          .not.toHaveProperty("temperature");
        expect(sha(envelope.body)).toBe(result.wireHash);
        if (++artifact.totalProviderCalls > artifact.maxProviderCalls) throw new Error("GEMINI38_CANARY_BUDGET_EXCEEDED");
        result.attemptedCalls = 1;
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(CLIENT_TIMEOUT_MS));
        const startedAt = performance.now();
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com${ENDPOINT}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey!,
            },
            body: JSON.stringify(envelope.body),
            signal: controller.signal,
          });
          result.httpStatus = response.status;
          const payload = await response.json().catch(() => null) as ProviderPayload | null;
          result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
          result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
          result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
          result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
          const output = payload?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? "").join("").trim();
          let parsed: unknown;
          try {
            parsed = response.ok && output ? JSON.parse(output) : undefined;
            result.jsonReturned = parsed !== undefined;
          } catch {
            result.jsonReturned = false;
          }
          if (result.jsonReturned) {
            const ajv = new Ajv({ allErrors: true }).compile(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
            result.providerAjvValidation = ajv(parsed) === true;
            result.providerAjvErrorCount = ajv.errors?.length ?? 0;
            result.providerAjvErrorPaths = (ajv.errors ?? []).map((error) => `${error.instancePath}:${error.keyword}`);
            const providerErrors = validateCompactPhotoAnalysisV3Provider(parsed);
            result.providerShapeValidation = result.providerAjvValidation && providerErrors.length === 0;
            result.providerShapeErrorCount = providerErrors.length;
            result.providerShapeErrorPaths = providerErrors.map((error) => safeProviderMessage(error));
            if (context && result.providerShapeValidation) {
              const strictErrors = validateCompactPhotoAnalysisV3(parsed, context);
              result.strictRuntimeValidation = strictErrors.length === 0;
              result.strictRuntimeErrorCount = strictErrors.length;
              result.strictRuntimeErrorPaths = strictErrors.map((error) => safeProviderMessage(error));
              const failedFaceMeasurement = failedFaceMeasurementDiagnostic(parsed, strictErrors);
              if (failedFaceMeasurement) result.failedFaceMeasurement = failedFaceMeasurement;
              const normalized = normalizeCompactPhotoAnalysisV3(parsed, context);
              result.richNormalization = normalized.ok;
              result.normalizationErrorCount = normalized.ok ? 0 : normalized.errors.length;
              result.normalizationErrorPaths = normalized.ok ? [] : normalized.errors.map((error) => safeProviderMessage(error));
              if (normalized.ok) {
                const rich = validatePhotoAnalysis(normalized.analysis);
                result.richValidation = rich.ok;
                result.richValidationErrorCount = rich.ok ? 0 : rich.errors.length;
              } else result.richValidation = false;
              result.sourceContract = sourceContract(parsed);
            }
          }
        } catch (error) {
          const timedOut = controller.signal.aborted;
          result.clientErrorName = error instanceof Error ? error.name : "unknown";
          result.clientDiagnosticHttpStatus = timedOut ? 504 : null;
          result.clientDiagnosticProviderStatus = timedOut ? "DEADLINE_EXCEEDED" : null;
          result.clientDiagnosticMessage = safeProviderMessage(
            timedOut ? `Gemini structured request (${MODEL}) timed out after ${CLIENT_TIMEOUT_MS}ms`
              : error instanceof Error ? error.message : String(error),
            [apiKey!],
          );
        } finally {
          clearTimeout(timeout);
          result.latencyMs = Math.round(performance.now() - startedAt);
          result.completed = true;
          await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        }
      };

      await run(artifact.canaryA, ready.targetText, null);
      try {
        const aPassed = artifact.canaryA.httpStatus === 200
          && artifact.canaryA.jsonReturned
          && artifact.canaryA.providerAjvValidation
          && artifact.canaryA.providerShapeValidation;
        if (!aPassed) {
          artifact.classification = artifact.canaryA.httpStatus === 400
            && artifact.canaryA.providerStatus === "INVALID_ARGUMENT"
            ? "gemini38_v3_schema_or_config_rejected"
            : artifact.canaryA.httpStatus === 404 || artifact.canaryA.providerStatus === "NOT_FOUND"
              ? "gemini38_model_unavailable_or_invalid"
              : artifact.canaryA.clientErrorName === "AbortError"
                ? "gemini38_client_timeout_inconclusive"
              : artifact.canaryA.httpStatus === 200
                ? "gemini38_provider_output_invalid"
                : "gemini38_provider_health_inconclusive";
        } else {
          await run(artifact.canaryB, ready.targetJpeg, { imageCount: 1 });
          const bPassed = artifact.canaryB.httpStatus === 200
            && artifact.canaryB.jsonReturned
            && artifact.canaryB.providerAjvValidation
            && artifact.canaryB.providerShapeValidation
            && artifact.canaryB.strictRuntimeValidation
            && artifact.canaryB.richNormalization
            && artifact.canaryB.richValidation;
          artifact.classification = bPassed
            ? "gemini38_v3_live_compatibility_accepted"
            : artifact.canaryB.httpStatus === 400
              ? "gemini38_image_provider_rejected"
              : artifact.canaryB.httpStatus === 200
                ? "gemini38_v3_image_output_semantic_invalid"
                : artifact.canaryB.clientErrorName === "AbortError"
                  ? "gemini38_target_client_timeout_inconclusive"
                : "gemini38_target_provider_failure_inconclusive";
        }
      } finally {
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
      }

      expect(artifact.totalProviderCalls).toBeGreaterThanOrEqual(1);
      expect(artifact.totalProviderCalls).toBeLessThanOrEqual(2);
      if (artifact.canaryA.httpStatus !== 200 || !artifact.canaryA.jsonReturned
        || !artifact.canaryA.providerAjvValidation || !artifact.canaryA.providerShapeValidation) {
        expect(artifact.canaryB.attemptedCalls).toBe(0);
      }
      expect(artifact.productionActivated).toBe(false);
    }, 260_000);
  },
);
