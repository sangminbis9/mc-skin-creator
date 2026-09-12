/** Health-gated diagnostic: known-good control first, Compact v2 minus renderHints only after PASS. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_PHOTO_ANALYSIS_PROMPT,
  COMPACT_PHOTO_ANALYSIS_SCHEMA,
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
} from "../src/compactPhotoAnalysis";
import {
  buildGeminiStructuredRequestEnvelope,
  geminiProviderErrorDiagnostic,
  generateGeminiStructuredJson,
  type GeminiStructuredRequest,
} from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { safeProviderMessage } from "./primaryTransportSupport";

type Schema = {
  type?: string | readonly string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
  enum?: readonly unknown[];
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
};

type CallResult = {
  id: "control" | "target";
  attemptedCalls: number;
  httpStatus: number | null;
  providerCode: number | null;
  providerStatus: string | null;
  providerMessage: string | null;
  jsonReturned: boolean;
  schemaValidation: boolean;
  completed: boolean;
  [key: string]: unknown;
};

const ROOT = resolve("evaluation-artifacts/compact-v2-no-render-hints-20260910");
const CONTROL_BASELINE = resolve(
  "evaluation-artifacts/compact-render-hints-tiny-enum-remeasure-20260909/result.json",
);
const FULL_BASELINE = resolve("evaluation-artifacts/compact-primary-v2-20260909/canary-a.json");
const LIVE_RESULT = join(ROOT, "result.json");
const CLIENT_TIMEOUT_MS = "45000";
const REFERENCE_SUFFIX = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const compactV1Subtree = (COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema).properties!.renderHints;
const controlSchema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(compactV1Subtree) },
  required: ["renderHints"],
  additionalProperties: false,
};
delete controlSchema.properties!.renderHints.minItems;
delete controlSchema.properties!.renderHints.maxItems;
controlSchema.properties!.renderHints.items!.enum = compactV1Subtree.items!.enum!.slice(0, 3);

const fullSchema = COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema;
const targetSchema = structuredClone(fullSchema);
delete targetSchema.properties!.renderHints;
targetSchema.required = targetSchema.required!.filter((key) => key !== "renderHints");

const controlRequest: GeminiStructuredRequest = {
  model: "gemini-3.6-flash",
  imageDataUrls: [],
  prompt: `${COMPACT_PHOTO_ANALYSIS_PROMPT}${REFERENCE_SUFFIX}`,
  responseSchema: controlSchema,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
};
const fullRequest: GeminiStructuredRequest = {
  model: "gemini-3.6-flash",
  imageDataUrls: [],
  prompt: `${COMPACT_PHOTO_ANALYSIS_V2_PROMPT}${REFERENCE_SUFFIX}`,
  responseSchema: fullSchema,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
};
const targetRequest: GeminiStructuredRequest = {
  ...fullRequest,
  responseSchema: targetSchema,
};

function extraMetrics(schema: Schema) {
  let arrayCount = 0;
  let enumDeclarations = 0;
  let largestSingleEnum = 0;
  const visit = (node: Schema): void => {
    if (node.type === "array") arrayCount += 1;
    if (node.enum) {
      enumDeclarations += 1;
      largestSingleEnum = Math.max(largestSingleEnum, node.enum.length);
    }
    Object.values(node.properties ?? {}).forEach(visit);
    if (node.items) visit(node.items);
  };
  visit(schema);
  return { arrayCount, enumDeclarations, largestSingleEnum };
}

async function preflight() {
  const controlBaseline = JSON.parse(await readFile(CONTROL_BASELINE, "utf8")) as Record<string, unknown>;
  const fullBaseline = JSON.parse(await readFile(FULL_BASELINE, "utf8")) as Record<string, unknown>;
  const controlEnvelope = buildGeminiStructuredRequestEnvelope(controlRequest);
  const fullEnvelope = buildGeminiStructuredRequestEnvelope(fullRequest);
  const targetEnvelope = buildGeminiStructuredRequestEnvelope(targetRequest);

  expect(controlSchema.properties!.renderHints.items!.enum).toEqual(["warm", "cool", "neutral"]);
  expect(controlBaseline).toMatchObject({
    id: "C-RH-TE-R1",
    exactWireEquality: true,
    schemaHash: sha(controlSchema),
    promptHash: sha(controlRequest.prompt),
    wireHash: sha(controlEnvelope.body),
    tinyEnumValues: ["warm", "cool", "neutral"],
    model: controlRequest.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${controlRequest.model}:generateContent`,
    imageCount: 0,
    temperature: 0,
    thinkingConfig: { thinkingLevel: "LOW" },
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
    attemptedCalls: 1,
    httpStatus: 200,
    jsonReturned: true,
    providerSchemaValidation: true,
    completed: true,
  });

  expect(fullBaseline).toMatchObject({
    id: "A",
    schemaHash: sha(fullSchema),
    promptHash: sha(fullRequest.prompt),
    wireHash: sha(fullEnvelope.body),
    model: fullRequest.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${fullRequest.model}:generateContent`,
    imageCount: 0,
    attemptedCalls: 1,
    httpStatus: 400,
    providerStatus: "INVALID_ARGUMENT",
  });

  const fullPropertyNames = Object.keys(fullSchema.properties!);
  expect(Object.keys(targetSchema.properties!)).toEqual(
    fullPropertyNames.filter((key) => key !== "renderHints"),
  );
  expect(targetSchema.required).toEqual(fullSchema.required!.filter((key) => key !== "renderHints"));
  for (const name of fullPropertyNames.filter((key) => key !== "renderHints")) {
    expect(sha(targetSchema.properties![name])).toBe(sha(fullSchema.properties![name]));
  }
  const restoredSchema = structuredClone(targetSchema);
  restoredSchema.properties = Object.fromEntries(
    fullPropertyNames.map((name) => [
      name,
      name === "renderHints" ? fullSchema.properties!.renderHints : targetSchema.properties![name],
    ]),
  );
  restoredSchema.required = structuredClone(fullSchema.required);
  expect(JSON.stringify(restoredSchema)).toBe(JSON.stringify(fullSchema));

  const restoredBody = structuredClone(targetEnvelope.body) as {
    generationConfig: { responseJsonSchema: unknown };
  };
  restoredBody.generationConfig.responseJsonSchema = fullSchema;
  expect(JSON.stringify(restoredBody)).toBe(JSON.stringify(fullEnvelope.body));
  expect(sha(fullEnvelope.body)).toBe(fullBaseline.wireHash);
  expect(sha(targetRequest.prompt)).toBe(fullBaseline.promptHash);

  for (const envelope of [controlEnvelope, fullEnvelope, targetEnvelope]) {
    expect(envelope.shape).toMatchObject({
      apiFamily: "generateContent",
      apiVersion: "v1beta",
      imageParts: 0,
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    });
    expect((envelope.body as { generationConfig: Record<string, unknown> }).generationConfig.thinkingConfig)
      .toEqual({ thinkingLevel: "LOW" });
  }

  const metrics = {
    ...inspectGeminiResponseSchema(targetSchema),
    ...extraMetrics(targetSchema),
  };
  expect(metrics.valid).toBe(true);
  expect(metrics.unsupportedConstructs).toEqual([]);
  return { controlBaseline, fullBaseline, controlEnvelope, targetEnvelope, metrics };
}

describe("health-gated Compact v2 minus renderHints preflight", () => {
  it("proves the exact two-location schema delta and preserves every other wire field", async () => {
    const check = await preflight();
    expect(sha(check.controlEnvelope.body)).toBe(check.controlBaseline.wireHash);
    expect(sha(targetRequest.prompt)).toBe(check.fullBaseline.promptHash);
    expect(CLIENT_TIMEOUT_MS).toBe("45000");
  });
});

describe.skipIf(process.env.COMPACT_V2_NRH_CANARY !== "1")(
  "authorized health control then conditional Compact v2 minus renderHints target",
  () => {
    it("never dispatches target unless the known-good control fully passes", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifact: {
        controlExactEquality: boolean;
        targetExactSingleDelta: boolean;
        maxProviderCalls: number;
        totalProviderCalls: number;
        targetMetrics: Record<string, unknown>;
        control: CallResult;
        target: CallResult;
        classification: string | null;
      } = {
        controlExactEquality: true,
        targetExactSingleDelta: true,
        maxProviderCalls: 2,
        totalProviderCalls: 0,
        targetMetrics: check.metrics,
        control: {
          id: "control", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          schemaValidation: false, completed: false,
          schemaHash: sha(controlSchema), promptHash: sha(controlRequest.prompt),
          wireHash: sha(check.controlEnvelope.body), clientTimeoutMs: 45000,
        },
        target: {
          id: "target", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          schemaValidation: false, completed: false,
          schemaHash: sha(targetSchema), promptHash: sha(targetRequest.prompt),
          wireHash: sha(check.targetEnvelope.body), clientTimeoutMs: 45000,
        },
        classification: null,
      };
      await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let active: { record: CallResult; wireHash: string; schema: Schema } | null = null;
      let stageCalls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!active) throw new Error("C_V2_NRH_CANARY_WITHOUT_ACTIVE_STAGE");
        if (++stageCalls !== 1) throw new Error("C_V2_NRH_CANARY_RETRY_FORBIDDEN");
        if (++artifact.totalProviderCalls > artifact.maxProviderCalls) {
          throw new Error("C_V2_NRH_CANARY_BUDGET_EXCEEDED");
        }
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe("/v1beta/models/gemini-3.6-flash:generateContent");
        expect(sha(JSON.parse(String(init?.body)))).toBe(active.wireHash);
        active.record.attemptedCalls = 1;
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        const response = await originalFetch(input, init);
        active.record.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        active.record.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
        active.record.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
        active.record.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
        if (response.ok) {
          const text = (payload?.candidates?.[0]?.content?.parts ?? [])
            .filter((part: { thought?: boolean }) => !part.thought)
            .map((part: { text?: string }) => part.text ?? "")
            .join("");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
            active.record.jsonReturned = true;
          } catch {
            active.record.jsonReturned = false;
          }
          const validator = new Ajv({ allErrors: true }).compile(active.schema);
          active.record.schemaValidation = active.record.jsonReturned && validator(parsed) === true;
          active.record.schemaErrorCount = validator.errors?.length ?? 0;
          active.record.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        }
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        return response;
      });

      const run = async (
        record: CallResult,
        request: GeminiStructuredRequest,
        wireHash: string,
        schema: Schema,
      ) => {
        active = { record, wireHash, schema };
        stageCalls = 0;
        try {
          await generateGeminiStructuredJson({
            GEMINI_API_KEY: apiKey!,
            GEMINI_STRUCTURED_TIMEOUT_MS: CLIENT_TIMEOUT_MS,
          } as Env, request);
        } catch (error) {
          const diagnostic = geminiProviderErrorDiagnostic(error);
          record.clientErrorName = error instanceof Error ? error.name : "unknown";
          record.clientDiagnosticStatus = diagnostic.httpStatus;
          record.clientDiagnosticProviderStatus = diagnostic.providerStatus;
          record.clientDiagnosticMessage = safeProviderMessage(diagnostic.message, [apiKey!]);
        } finally {
          record.completed = true;
          await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        }
      };

      try {
        await run(artifact.control, controlRequest, sha(check.controlEnvelope.body), controlSchema);
        const controlPassed = artifact.control.httpStatus === 200
          && artifact.control.jsonReturned
          && artifact.control.schemaValidation;
        if (controlPassed) {
          await run(artifact.target, targetRequest, sha(check.targetEnvelope.body), targetSchema);
          artifact.classification = artifact.target.httpStatus === 200
            && artifact.target.jsonReturned
            && artifact.target.schemaValidation
            ? "cumulative_schema_interaction_strongly_supported"
            : artifact.target.httpStatus === 400
              && artifact.target.providerStatus === "INVALID_ARGUMENT"
              ? "non_renderHints_schema_issue_supported"
              : "target_inconclusive_provider_failure";
        } else {
          artifact.classification = "provider_health_inconclusive";
        }
      } finally {
        active = null;
        spy.mockRestore();
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
      }

      expect(artifact.totalProviderCalls).toBeGreaterThanOrEqual(1);
      expect(artifact.totalProviderCalls).toBeLessThanOrEqual(2);
      if (artifact.control.httpStatus !== 200
        || !artifact.control.jsonReturned
        || !artifact.control.schemaValidation) {
        expect(artifact.target.attemptedCalls).toBe(0);
      }
    }, 110_000);
  },
);
