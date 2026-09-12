/** Opt-in C-RH-TE remeasurement. The payload must match the stored 503 attempt exactly. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_PHOTO_ANALYSIS_PROMPT,
  COMPACT_PHOTO_ANALYSIS_SCHEMA,
} from "../src/compactPhotoAnalysis";
import {
  buildGeminiStructuredRequestEnvelope,
  generateGeminiStructuredJson,
} from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { safeProviderMessage } from "./primaryTransportSupport";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  description?: string;
};

const ROOT = resolve(
  "evaluation-artifacts/compact-render-hints-tiny-enum-remeasure-20260909",
);
const PREVIOUS_RESULT = resolve(
  "evaluation-artifacts/compact-render-hints-tiny-enum-canary-20260909/result.json",
);
const PREVIOUS_OFFLINE = resolve(
  "evaluation-artifacts/compact-render-hints-tiny-enum-canary-20260909/offline.json",
);
const compactSubtree = (COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema).properties!.renderHints;
const schema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(compactSubtree) },
  required: ["renderHints"],
  additionalProperties: false,
};
delete schema.properties!.renderHints.minItems;
delete schema.properties!.renderHints.maxItems;
const originalEnum = compactSubtree.items!.enum!;
schema.properties!.renderHints.items!.enum = originalEnum.slice(0, 3);

const prompt = `${COMPACT_PHOTO_ANALYSIS_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`;
const request = {
  model: "gemini-3.6-flash",
  imageDataUrls: [] as string[],
  prompt,
  responseSchema: schema,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
};
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function itemWithoutEnum(item: Schema) {
  const copy = structuredClone(item);
  delete copy.enum;
  return copy;
}

function extendedMetrics(value: Schema) {
  let arrayCount = 0;
  let enumCount = 0;
  const visit = (node: Schema): void => {
    if (node.type === "array") arrayCount += 1;
    if (Array.isArray(node.enum)) enumCount += 1;
    Object.values(node.properties ?? {}).forEach(visit);
    if (node.items) visit(node.items);
  };
  visit(value);
  return { ...inspectGeminiResponseSchema(value), arrayCount, enumCount };
}

async function preflight() {
  const previous = JSON.parse(await readFile(PREVIOUS_RESULT, "utf8")) as Record<string, unknown>;
  const previousOffline = JSON.parse(
    await readFile(PREVIOUS_OFFLINE, "utf8"),
  ) as Record<string, unknown>;
  expect(previous).toMatchObject({
    id: "C-RH-TE",
    model: request.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${request.model}:generateContent`,
    imageCount: 0,
    attemptedCalls: 1,
    httpStatus: 503,
    providerCode: 503,
    providerStatus: "UNAVAILABLE",
    jsonReturned: false,
    providerSchemaValidation: false,
    completed: true,
  });
  expect(previousOffline).toMatchObject({
    passed: true,
    tinyEnumSelectionRule: "originalEnum.slice(0, 3)",
    originalEnumCount: 121,
    tinyEnumCount: 3,
    tinyEnumValues: ["warm", "cool", "neutral"],
  });

  const enumValues = schema.properties!.renderHints.items!.enum!;
  expect(enumValues).toEqual(previousOffline.tinyEnumValues);
  expect(sha(enumValues)).toBe(previous.tinyEnumHash);
  expect(sha(originalEnum)).toBe(previous.originalEnumHash);
  expect(sha(schema.properties!.renderHints.items)).toBe(previous.tinyEnumItemSchemaHash);
  expect(sha(itemWithoutEnum(schema.properties!.renderHints.items!)))
    .toBe(previous.itemSchemaOutsideEnumHash);
  expect(sha(schema)).toBe(previous.tinyEnumWrapperSchemaHash);
  expect(sha(prompt)).toBe(previous.promptHash);

  const metrics = extendedMetrics(schema);
  expect(metrics).toEqual(previous.metrics);
  expect(metrics).toMatchObject({
    serializedBytes: 178,
    depth: 3,
    propertyCount: 1,
    requiredCount: 1,
    enumValueCount: 3,
    arrayCount: 1,
    enumCount: 1,
  });

  const envelope = buildGeminiStructuredRequestEnvelope(request);
  expect(sha(envelope.body)).toBe(previous.wireHash);
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
  return { previous, envelope, metrics };
}

describe("C-RH-TE remeasurement preflight", () => {
  it("reconstructs the stored 503 attempt byte-for-byte at the JSON wire level", async () => {
    const check = await preflight();
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline.json"), JSON.stringify({
      passed: true,
      previousAttemptId: check.previous.id,
      schemaHash: sha(schema),
      promptHash: sha(prompt),
      wireHash: sha(check.envelope.body),
      tinyEnumHash: sha(schema.properties!.renderHints.items!.enum),
      tinyEnumValues: schema.properties!.renderHints.items!.enum,
      itemSchemaOutsideEnumHash: sha(itemWithoutEnum(schema.properties!.renderHints.items!)),
      metrics: check.metrics,
      model: request.model,
      endpoint: `/v1beta/models/${request.model}:generateContent`,
      apiVersion: "v1beta",
      imageCount: 0,
      temperature: check.envelope.shape.temperature,
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: check.envelope.shape.maxOutputTokens,
      responseMimeType: check.envelope.shape.responseMimeType,
      exactWireEquality: true,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_RENDER_HINTS_TINY_ENUM_REMEASURE_CANARY !== "1")(
  "single authorized live C-RH-TE remeasurement",
  () => {
    it("dispatches the unchanged payload once and records secret-safe acceptance evidence", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifactPath = join(ROOT, "result.json");
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const result: Record<string, unknown> = {
        id: "C-RH-TE-R1",
        previousAttemptId: check.previous.id,
        exactWireEquality: true,
        schemaHash: sha(schema),
        promptHash: sha(prompt),
        wireHash: sha(check.envelope.body),
        tinyEnumHash: sha(schema.properties!.renderHints.items!.enum),
        tinyEnumValues: schema.properties!.renderHints.items!.enum,
        itemSchemaOutsideEnumHash: sha(itemWithoutEnum(schema.properties!.renderHints.items!)),
        metrics: check.metrics,
        model: request.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${request.model}:generateContent`,
        imageCount: 0,
        temperature: check.envelope.shape.temperature,
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: check.envelope.shape.maxOutputTokens,
        responseMimeType: check.envelope.shape.responseMimeType,
        attemptedCalls: 0,
        httpStatus: null,
        providerCode: null,
        providerStatus: null,
        providerMessage: null,
        jsonReturned: false,
        providerSchemaValidation: false,
        completed: false,
      };
      await writeFile(artifactPath, JSON.stringify(result, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let calls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (++calls !== 1) throw new Error("C_RH_TE_REMEASURE_RETRY_FORBIDDEN");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(result.endpoint);
        expect(sha(JSON.parse(String(init?.body)))).toBe(check.previous.wireHash);
        result.attemptedCalls = 1;
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
        const response = await originalFetch(input, init);
        result.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
        result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
        result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
        if (response.ok) {
          const text = (payload?.candidates?.[0]?.content?.parts ?? [])
            .filter((part: { thought?: boolean }) => !part.thought)
            .map((part: { text?: string }) => part.text ?? "")
            .join("");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
            result.jsonReturned = true;
          } catch {
            result.jsonReturned = false;
          }
          result.providerSchemaValidation = result.jsonReturned === true && validate(parsed) === true;
          result.providerSchemaErrorCount = validate.errors?.length ?? 0;
          result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        }
        result.completed = true;
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
        return response;
      });
      try {
        await generateGeminiStructuredJson({
          GEMINI_API_KEY: apiKey!,
          GEMINI_STRUCTURED_TIMEOUT_MS: "45000",
        } as Env, request);
      } catch (error) {
        result.clientErrorName = error instanceof Error ? error.name : "unknown";
      } finally {
        spy.mockRestore();
        result.completed = true;
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
      }
      expect(calls).toBe(1);
    }, 60000);
  },
);
