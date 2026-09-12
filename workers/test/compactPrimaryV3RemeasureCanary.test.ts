/** Health-gated exact remeasurement of the prior Compact v3 JPEG request. */
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
  COMPACT_PHOTO_ANALYSIS_V3_SCHEMA as CURRENT_COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
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
import type { Env } from "../src/types";
import { semanticFixture, wireFixture } from "./compactV3Support";
import { safeProviderMessage } from "./primaryTransportSupport";

type FailedFaceMeasurementDiagnostic = {
  index: number;
  cue: (typeof COMPACT_FACE_ORDER)[number];
  value: string;
  provenance: string;
  confidence: number;
  allowedValuesForCue: readonly string[];
};

type CallResult = {
  id: "control" | "target";
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

const BASELINE = resolve("evaluation-artifacts/compact-primary-v3-live-20260910/result.json");
const ROOT = resolve("evaluation-artifacts/compact-primary-v3-remeasure-20260910");
const RESULT = join(ROOT, "result.json");
const JPEG_PATH = resolve("evaluation-artifacts/generalization-20260905/sources/29002888.jpg");
const MODEL = "gemini-3.6-flash";
const ENDPOINT = `/v1beta/models/${MODEL}:generateContent`;
const CLIENT_TIMEOUT_MS = "45000";
const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const prompt = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}${referenceSuffix}`;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// This harness preserves the already-measured pre-enum wire. New candidate live
// validation belongs to compactPrimaryV3Canary after separate authorization.
const COMPACT_PHOTO_ANALYSIS_V3_SCHEMA = structuredClone(CURRENT_COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
delete COMPACT_PHOTO_ANALYSIS_V3_SCHEMA.properties!.faceMeasurements.items!.properties!.value.enum;

/** Extract one categorical failure without retaining the response or sibling cues. */
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
  return {
    index,
    cue,
    value,
    provenance,
    confidence,
    allowedValuesForCue: [...FACE_MEASUREMENT_VALUES[cue]],
  };
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

function sourceContract(raw: unknown): Record<string, unknown> {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const selection = typeof value.sourceSelection === "object" && value.sourceSelection !== null
    ? value.sourceSelection as Record<string, unknown> : {};
  const sourceIndices = [selection.portraitImageIndex, selection.outfitImageIndex, selection.generationImageIndex];
  const measurements = Array.isArray(value.faceMeasurements) ? value.faceMeasurements : [];
  const hints = typeof value.renderHints === "object" && value.renderHints !== null
    ? value.renderHints as Record<string, unknown> : {};
  const hintGroups = Object.entries(COMPACT_HINT_GROUPS);
  const measurementContract = measurements.every((item) => {
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
    portraitImageIndex: selection.portraitImageIndex ?? null,
    portraitIndexMatchesImageCount: selection.portraitImageIndex === 0,
    faceMeasurementCount: measurements.length,
    faceMeasurementsComplete: measurements.length === COMPACT_FACE_ORDER.length,
    faceMeasurementEvidenceContractValid: measurementContract,
    observedMeasurementCount: measurements.filter((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).value !== "unknown").length,
    unknownMeasurementCount: measurements.filter((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).value === "unknown").length,
    renderHintGroupCount: Object.keys(hints).length,
    renderHintGroupCountExpected: hintGroups.length,
    renderHintGroupsAndLengthsMatch: hintGroups.every(([group, slots]) =>
      Array.isArray(hints[group]) && hints[group].length === slots.length),
    renderHintSlotCount: Object.values(hints).reduce((sum, group) => sum + (Array.isArray(group) ? group.length : 0), 0),
    renderHintSlotCountExpected: hintGroups.reduce((sum, [, slots]) => sum + slots.length, 0),
    identityFeatureCount,
    identityFeatureMinimumSatisfied: typeof identityFeatureCount === "number" && identityFeatureCount >= 4,
  };
}

async function preflight() {
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Record<string, unknown>;
  const bytes = await readFile(JPEG_PATH);
  expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
  const controlRequest = request([]);
  const targetRequest = request([`data:image/jpeg;base64,${bytes.toString("base64")}`]);
  const controlEnvelope = buildGeminiStructuredRequestEnvelope(controlRequest);
  const targetEnvelope = buildGeminiStructuredRequestEnvelope(targetRequest);
  const previousA = baseline.canaryA as Record<string, unknown>;
  const previousB = baseline.canaryB as Record<string, unknown>;
  const previousImage = previousB.imageMetadata as Record<string, unknown>;

  expect(baseline).toMatchObject({
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
    productionActivated: false,
  });
  expect(previousA).toMatchObject({
    httpStatus: 200,
    jsonReturned: true,
    providerAjvValidation: true,
    providerShapeValidation: true,
    imageCount: 0,
    schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
    promptHash: sha(prompt),
    wireHash: sha(controlEnvelope.body),
    clientTimeoutMs: 45000,
  });
  expect(previousB).toMatchObject({
    imageCount: 1,
    schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
    promptHash: sha(prompt),
    wireHash: sha(targetEnvelope.body),
    clientTimeoutMs: 45000,
  });
  expect(previousImage).toMatchObject({
    provider: "Pexels",
    fileName: "29002888.jpg",
    mimeType: "image/jpeg",
    rawBytes: bytes.byteLength,
    magicMatchesMime: true,
  });
  expect(bytes.byteLength).toBe(204067);
  expect(targetEnvelope.shape).toMatchObject({
    model: MODEL,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    imageParts: 1,
    imageMimeTypes: ["image/jpeg"],
    imageRawBytes: [bytes.byteLength],
    imageMagicMatchesMime: [true],
    temperature: 0,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  });
  expect(controlEnvelope.shape).toMatchObject({
    model: MODEL,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    imageParts: 0,
    temperature: 0,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  });
  expect((controlEnvelope.body as { generationConfig: unknown }).generationConfig)
    .toEqual((targetEnvelope.body as { generationConfig: unknown }).generationConfig);
  return { baseline, bytes, controlRequest, targetRequest, controlEnvelope, targetEnvelope };
}

describe("Compact v3 JPEG remeasurement preflight", () => {
  it("reconstructs the prior A and exact prior JPEG B wires", async () => {
    const ready = await preflight();
    const previousA = ready.baseline.canaryA as Record<string, unknown>;
    const previousB = ready.baseline.canaryB as Record<string, unknown>;
    expect(sha(ready.controlEnvelope.body)).toBe(previousA.wireHash);
    expect(sha(ready.targetEnvelope.body)).toBe(previousB.wireHash);
  });

  it("records only the first failed face-measurement cue without changing rejection", () => {
    const raw = wireFixture(semanticFixture("plain"));
    raw.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({
      value: "unknown", provenance: "unknown", confidence: 0,
    }));
    const measurements = raw.faceMeasurements as Array<{ value: string; provenance: string; confidence: number }>;
    measurements[0] = {
      value: "average", provenance: "observed_categorical", confidence: 0.91,
    };
    measurements[1] = {
      value: "must-not-be-recorded", provenance: "inferred", confidence: 0.88,
    };

    const errors = validateCompactPhotoAnalysisV3(raw, { imageCount: 1 });
    expect(errors).toContain("compact.faceMeasurements[0].value:enum");
    expect(failedFaceMeasurementDiagnostic(raw, errors)).toEqual({
      index: 0,
      cue: "eyeSpacing",
      value: "average",
      provenance: "observed_categorical",
      confidence: 0.91,
      allowedValuesForCue: ["narrow", "medium", "wide", "unknown"],
    });
    expect(JSON.stringify(failedFaceMeasurementDiagnostic(raw, errors))).not.toContain("must-not-be-recorded");
  });

  it.each(["narrow", "medium", "wide", "unknown"] as const)(
    "leaves valid eyeSpacing token %s unchanged",
    (value) => {
      const raw = wireFixture(semanticFixture("plain"));
      raw.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({
        value: "unknown", provenance: "unknown", confidence: 0,
      }));
      raw.faceMeasurements[0] = value === "unknown"
        ? { value, provenance: "unknown", confidence: 0 }
        : { value, provenance: "observed_categorical", confidence: 0.9 };
      const errors = validateCompactPhotoAnalysisV3(raw, { imageCount: 1 });
      expect(errors).toEqual([]);
      expect(failedFaceMeasurementDiagnostic(raw, errors)).toBeUndefined();
    },
  );

  it("omits failedFaceMeasurement for unrelated or malformed diagnostics", () => {
    const raw = wireFixture(semanticFixture("plain"));
    expect(failedFaceMeasurementDiagnostic(raw, ["compact.renderHints.eyes[0]:enum"])).toBeUndefined();
    expect(failedFaceMeasurementDiagnostic(raw, ["compact.faceMeasurements[x].value:enum"])).toBeUndefined();
    expect(failedFaceMeasurementDiagnostic(
      { faceMeasurements: [{ value: { nested: "not-safe" }, provenance: "observed_categorical", confidence: 0.9 }] },
      ["compact.faceMeasurements[0].value:type"],
    )).toBeUndefined();
  });
});

describe.skipIf(process.env.COMPACT_PRIMARY_V3_REMEASURE_CANARY !== "1")(
  "authorized health control and exact JPEG B remeasurement",
  () => {
    it("dispatches target once only after the exact control fully passes", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const ready = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifact: {
        exactControlEquality: boolean;
        exactTargetEquality: boolean;
        maxProviderCalls: number;
        totalProviderCalls: number;
        control: CallResult;
        target: CallResult;
        classification: string | null;
        productionActivated: boolean;
        manualFixtureCoverageGap: Record<string, unknown>;
      } = {
        exactControlEquality: true,
        exactTargetEquality: true,
        maxProviderCalls: 2,
        totalProviderCalls: 0,
        control: {
          id: "control", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 0,
          schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA), promptHash: sha(prompt),
          wireHash: sha(ready.controlEnvelope.body), clientTimeoutMs: 45000,
        },
        target: {
          id: "target", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          providerAjvValidation: false, providerShapeValidation: false,
          strictRuntimeValidation: null, richNormalization: null, richValidation: null,
          completed: false, imageCount: 1,
          schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA), promptHash: sha(prompt),
          wireHash: sha(ready.targetEnvelope.body), clientTimeoutMs: 45000,
          imageMetadata: {
            provider: "Pexels", fileName: "29002888.jpg", mimeType: "image/jpeg",
            rawBytes: ready.bytes.byteLength, sha256: fileSha(ready.bytes), magicMatchesMime: true,
            representation: "raw_base64_in_inlineData",
          },
        },
        classification: null,
        productionActivated: false,
        manualFixtureCoverageGap: {
          cases: 5,
          reason: "identityFeatures_below_minimum_four",
          padded: false,
          validatorRelaxed: false,
        },
      };
      await writeFile(RESULT, JSON.stringify(artifact, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let active: { result: CallResult; wireHash: string } | null = null;
      let stageCalls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!active) throw new Error("COMPACT_V3_REMEASURE_WITHOUT_ACTIVE_STAGE");
        if (++stageCalls !== 1) throw new Error("COMPACT_V3_REMEASURE_RETRY_FORBIDDEN");
        if (++artifact.totalProviderCalls > artifact.maxProviderCalls) throw new Error("COMPACT_V3_REMEASURE_BUDGET_EXCEEDED");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(ENDPOINT);
        expect(sha(JSON.parse(String(init?.body)))).toBe(active.wireHash);
        active.result.attemptedCalls = 1;
        await writeFile(RESULT, JSON.stringify(artifact, null, 2));
        const response = await originalFetch(input, init);
        active.result.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        active.result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
        active.result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
        active.result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
        await writeFile(RESULT, JSON.stringify(artifact, null, 2));
        return response;
      });

      const run = async (result: CallResult, options: GeminiStructuredRequest, imageCount: 0 | 1) => {
        const envelope = buildGeminiStructuredRequestEnvelope(options);
        active = { result, wireHash: sha(envelope.body) };
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
            result.providerAjvErrorPaths = (ajv.errors ?? []).map((error) => `${error.instancePath}:${error.keyword}`);
            const providerErrors = validateCompactPhotoAnalysisV3Provider(parsed);
            result.providerShapeValidation = result.providerAjvValidation && providerErrors.length === 0;
            result.providerShapeErrorPaths = providerErrors.map((error) => safeProviderMessage(error));
            if (imageCount === 1) {
              const strictErrors = validateCompactPhotoAnalysisV3(parsed, { imageCount: 1 });
              result.strictRuntimeValidation = strictErrors.length === 0;
              result.strictRuntimeErrorPaths = strictErrors.map((error) => safeProviderMessage(error));
              const failedFaceMeasurement = failedFaceMeasurementDiagnostic(parsed, strictErrors);
              if (failedFaceMeasurement) result.failedFaceMeasurement = failedFaceMeasurement;
              const normalized = normalizeCompactPhotoAnalysisV3(parsed, { imageCount: 1 });
              result.richNormalization = normalized.ok;
              result.normalizationErrorPaths = normalized.ok ? [] : normalized.errors.map((error) => safeProviderMessage(error));
              if (normalized.ok) {
                const rich = validatePhotoAnalysis(normalized.analysis);
                result.richValidation = rich.ok;
                result.richValidationErrorPaths = rich.ok ? [] : rich.errors.map((error) => safeProviderMessage(error));
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
          await writeFile(RESULT, JSON.stringify(artifact, null, 2));
        }
      };

      try {
        await run(artifact.control, ready.controlRequest, 0);
        const controlPassed = artifact.control.httpStatus === 200
          && artifact.control.jsonReturned
          && artifact.control.providerShapeValidation;
        if (!controlPassed) {
          artifact.classification = "provider_health_inconclusive";
        } else {
          await run(artifact.target, ready.targetRequest, 1);
          const targetPassed = artifact.target.httpStatus === 200
            && artifact.target.jsonReturned
            && artifact.target.providerAjvValidation
            && artifact.target.providerShapeValidation
            && artifact.target.strictRuntimeValidation
            && artifact.target.richNormalization
            && artifact.target.richValidation;
          artifact.classification = targetPassed
            ? "v3_live_compatibility_accepted"
            : artifact.target.httpStatus === 400 && artifact.target.providerStatus === "INVALID_ARGUMENT"
              ? "v3_image_provider_rejected"
              : artifact.target.httpStatus === 200
                ? "v3_image_output_semantic_invalid"
                : "target_inconclusive_provider_failure";
        }
      } finally {
        active = null;
        spy.mockRestore();
        await writeFile(RESULT, JSON.stringify(artifact, null, 2));
      }

      expect(artifact.totalProviderCalls).toBeGreaterThanOrEqual(1);
      expect(artifact.totalProviderCalls).toBeLessThanOrEqual(2);
      if (artifact.control.httpStatus !== 200
        || !artifact.control.jsonReturned
        || !artifact.control.providerShapeValidation) {
        expect(artifact.target.attemptedCalls).toBe(0);
      }
      expect(artifact.productionActivated).toBe(false);
    }, 110_000);
  },
);
