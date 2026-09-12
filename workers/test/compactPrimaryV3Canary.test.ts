/** Inactive Compact v3 live diagnostic. Never imported by the production caller. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { validatePhotoAnalysis } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_HINT_GROUPS } from "../src/compactPhotoAnalysis";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import {
  COMPACT_PHOTO_ANALYSIS_V3_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  normalizeCompactPhotoAnalysisV3,
  validateCompactPhotoAnalysisV3,
  validateCompactPhotoAnalysisV3Provider,
} from "../src/compactPhotoAnalysisV3";
import {
  buildGeminiStructuredRequestEnvelope,
  geminiProviderErrorDiagnostic,
  generateGeminiStructuredJson,
  type GeminiStructuredRequest,
} from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
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
  failedFaceMeasurement?: FailedFaceMeasurementDiagnostic;
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

const OFFLINE_ROOT = resolve("evaluation-artifacts/compact-v3-offline-20260910");
const COVERAGE = resolve("evaluation-artifacts/compact-manual-fixture-coverage-20260910/coverage.json");
const LIVE_ROOT = resolve("evaluation-artifacts/compact-primary-v3-measurement-enum-live-20260911");
const LIVE_RESULT = join(LIVE_ROOT, "result.json");
const JPEG_PATH = resolve("evaluation-artifacts/generalization-20260905/sources/29002888.jpg");
const JPEG_SHA256 = "0c5a890f0e54275e2851a66f5f6ba92578c0d4feabf83c826aafa57cbf7a1d5a";
const CLIENT_TIMEOUT_MS = "45000";
const MODEL = "gemini-3.6-flash";
const ENDPOINT = `/v1beta/models/${MODEL}:generateContent`;
const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const prompt = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}${referenceSuffix}`;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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

function request(images: string[]): GeminiStructuredRequest {
  return {
    model: MODEL,
    imageDataUrls: images,
    prompt,
    responseSchema: COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
    maxOutputTokens: 8192,
    allowWorkersAiFallback: false,
  };
}

async function preflight() {
  const [complexity, semantic, frozen, preservation, coverage] = await Promise.all([
    readFile(join(OFFLINE_ROOT, "complexity.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "semantic-equivalence.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "frozen-regression.json"), "utf8").then(JSON.parse),
    readFile(join(OFFLINE_ROOT, "source-preservation.json"), "utf8").then(JSON.parse),
    readFile(COVERAGE, "utf8").then(JSON.parse),
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

  const textEnvelope = buildGeminiStructuredRequestEnvelope(request([]));
  const jpegEnvelope = buildGeminiStructuredRequestEnvelope(request(["data:image/jpeg;base64,/9j/2Q=="]));
  for (const envelope of [textEnvelope, jpegEnvelope]) {
    expect(envelope.shape).toMatchObject({
      model: MODEL,
      apiFamily: "generateContent",
      apiVersion: "v1beta",
      endpointMethod: "models.generateContent",
      structuredConfigKey: "generationConfig.responseJsonSchema",
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    });
    expect((envelope.body as { generationConfig: { thinkingConfig: unknown } }).generationConfig.thinkingConfig)
      .toEqual({ thinkingLevel: "LOW" });
  }
  expect(textEnvelope.shape.imageParts).toBe(0);
  expect(jpegEnvelope.shape).toMatchObject({ imageParts: 1, imageMimeTypes: ["image/jpeg"], imageMagicMatchesMime: [true] });
  expect((textEnvelope.body as { generationConfig: unknown }).generationConfig)
    .toEqual((jpegEnvelope.body as { generationConfig: unknown }).generationConfig);
  expect(sha(request([]).prompt)).toBe(sha(request(["data:image/jpeg;base64,/9j/2Q=="]).prompt));
  return { complexity, semantic, frozen, preservation, coverage, metrics, textEnvelope };
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
  const unknownEvidenceValid = measurements.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const cue = item as Record<string, unknown>;
    return cue.value !== "unknown"
      || (cue.provenance === "unknown" && cue.confidence === 0);
  });
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
    unknownEvidenceContractValid: unknownEvidenceValid,
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

describe("inactive Compact v3 primary canary preflight", () => {
  it("locks the exact v3 contract and keeps text/JPEG wires identical outside image content", async () => {
    const ready = await preflight();
    expect(ready.complexity.generations.v3.schemaHash).toBeUndefined();
    expect(sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)).toHaveLength(64);
    expect(sha(prompt)).toHaveLength(64);
    await mkdir(LIVE_ROOT, { recursive: true });
    await writeFile(join(LIVE_ROOT, "preflight.json"), JSON.stringify({
      schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
      basePromptHash: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
      requestPromptHash: sha(prompt),
      textWireHash: sha(ready.textEnvelope.body),
      schemaMetrics: ready.metrics,
      model: MODEL,
      apiFamily: "generateContent",
      apiVersion: "v1beta",
      endpoint: ENDPOINT,
      imageCount: 0,
      temperature: 0,
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      strictSourceContextClaimed: false,
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
      providerCalls: 0,
      productionActivated: false,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_PRIMARY_V3_CANARY !== "1")(
  "authorized Compact v3 text-first live canary",
  () => {
    it("runs JPEG only after complete text-only provider acceptance", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const ready = await preflight();
      const textRequest = request([]);
      const textEnvelope = buildGeminiStructuredRequestEnvelope(textRequest);
      await mkdir(LIVE_ROOT, { recursive: true });
      const artifact: {
        maxProviderCalls: number;
        totalProviderCalls: number;
        model: string;
        apiFamily: string;
        apiVersion: string;
        endpoint: string;
        temperature: number;
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
        manualFixtureCoverageGap: Record<string, unknown>;
      } = {
        maxProviderCalls: 2,
        totalProviderCalls: 0,
        model: MODEL,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: ENDPOINT,
        temperature: 0,
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
        promptHash: sha(prompt),
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
        canaryA: {
          id: "A", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 0, schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
          promptHash: sha(prompt), wireHash: sha(textEnvelope.body),
          strictSourceContextClaimed: false, clientTimeoutMs: 45000,
        },
        canaryB: {
          id: "B", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 1, schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
          promptHash: sha(prompt), wireHash: null, clientTimeoutMs: 45000,
        },
        classification: null,
        productionActivated: false,
        manualFixtureCoverageGap: {
          cases: 0,
          reason: "authoritative_strict_boundary_complete",
          padded: false,
          activationBlocked: false,
        },
      };
      await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let active: { result: CallResult; wireHash: string } | null = null;
      let stageCalls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!active) throw new Error("COMPACT_V3_CANARY_WITHOUT_ACTIVE_STAGE");
        if (++stageCalls !== 1) throw new Error("COMPACT_V3_CANARY_RETRY_FORBIDDEN");
        if (++artifact.totalProviderCalls > artifact.maxProviderCalls) throw new Error("COMPACT_V3_CANARY_BUDGET_EXCEEDED");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(ENDPOINT);
        expect(sha(JSON.parse(String(init?.body)))).toBe(active.wireHash);
        active.result.attemptedCalls = 1;
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        const response = await originalFetch(input, init);
        active.result.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        active.result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
        active.result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
        active.result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        return response;
      });

      const run = async (result: CallResult, options: GeminiStructuredRequest, context: { imageCount: number } | null) => {
        const envelope = buildGeminiStructuredRequestEnvelope(options);
        active = { result, wireHash: sha(envelope.body) };
        result.wireHash = active.wireHash;
        stageCalls = 0;
        try {
          const generated = await generateGeminiStructuredJson({
            GEMINI_API_KEY: apiKey!,
            GEMINI_STRUCTURED_TIMEOUT_MS: CLIENT_TIMEOUT_MS,
          } as Env, options) as { response?: unknown; finishReason?: unknown };
          result.finishReason = safeProviderMessage(generated.finishReason);
          let parsed: unknown;
          try {
            parsed = typeof generated.response === "string" ? JSON.parse(generated.response) : undefined;
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
            if (context) {
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
          const diagnostic = geminiProviderErrorDiagnostic(error);
          result.clientErrorName = error instanceof Error ? error.name : "unknown";
          result.clientDiagnosticHttpStatus = diagnostic.httpStatus;
          result.clientDiagnosticProviderStatus = safeProviderMessage(diagnostic.providerStatus, [apiKey!]);
          result.clientDiagnosticMessage = safeProviderMessage(diagnostic.message, [apiKey!]);
        } finally {
          result.completed = true;
          await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        }
      };

      try {
        await run(artifact.canaryA, textRequest, null);
        const aPassed = artifact.canaryA.httpStatus === 200
          && artifact.canaryA.jsonReturned
          && artifact.canaryA.providerShapeValidation;
        if (!aPassed) {
          artifact.classification = artifact.canaryA.httpStatus === 400
            && artifact.canaryA.providerStatus === "INVALID_ARGUMENT"
            ? "v3_measurement_enum_schema_rejected"
            : artifact.canaryA.httpStatus === 200
              ? "v3_provider_output_invalid"
              : "provider_health_inconclusive";
        } else {
          const bytes = await readFile(JPEG_PATH);
          expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
          expect(bytes.byteLength).toBe(204067);
          expect(fileSha(bytes)).toBe(JPEG_SHA256);
          artifact.canaryB.imageMetadata = {
            provider: "Pexels",
            fileName: "29002888.jpg",
            mimeType: "image/jpeg",
            rawBytes: bytes.byteLength,
            sha256: fileSha(bytes),
            magicMatchesMime: true,
            representation: "raw_base64_in_inlineData",
          };
          const jpegRequest = request([`data:image/jpeg;base64,${bytes.toString("base64")}`]);
          const jpegEnvelope = buildGeminiStructuredRequestEnvelope(jpegRequest);
          expect(jpegEnvelope.shape).toMatchObject({
            model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta",
            imageParts: 1, imageMimeTypes: ["image/jpeg"], imageMagicMatchesMime: [true],
            temperature: 0, maxOutputTokens: 8192, responseMimeType: "application/json",
          });
          expect((jpegEnvelope.body as { generationConfig: unknown }).generationConfig)
            .toEqual((textEnvelope.body as { generationConfig: unknown }).generationConfig);
          expect(sha(jpegRequest.prompt)).toBe(sha(textRequest.prompt));
          await run(artifact.canaryB, jpegRequest, { imageCount: 1 });
          const bPassed = artifact.canaryB.httpStatus === 200
            && artifact.canaryB.jsonReturned
            && artifact.canaryB.providerShapeValidation
            && artifact.canaryB.strictRuntimeValidation
            && artifact.canaryB.richNormalization
            && artifact.canaryB.richValidation;
          artifact.classification = bPassed
            ? "v3_live_compatibility_accepted"
            : artifact.canaryB.httpStatus === 400
              && artifact.canaryB.providerStatus === "INVALID_ARGUMENT"
              ? "v3_image_provider_rejected"
              : artifact.canaryB.httpStatus === 200
                ? artifact.canaryB.providerShapeValidation
                  ? "v3_image_output_semantic_invalid"
                  : "v3_provider_output_invalid"
                : "target_inconclusive_provider_failure";
        }
      } finally {
        active = null;
        spy.mockRestore();
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
      }

      expect(artifact.totalProviderCalls).toBeGreaterThanOrEqual(1);
      expect(artifact.totalProviderCalls).toBeLessThanOrEqual(2);
      if (artifact.canaryA.httpStatus !== 200
        || !artifact.canaryA.jsonReturned
        || !artifact.canaryA.providerShapeValidation) {
        expect(artifact.canaryB.attemptedCalls).toBe(0);
      }
      expect(artifact.productionActivated).toBe(false);
    }, 110_000);
  },
);
