/** Opt-in C-RH-TE diagnostic. Only the renderHints item enum vocabulary differs from C-RH-NB. */
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

const ROOT = resolve("evaluation-artifacts/compact-render-hints-tiny-enum-canary-20260909");
const C_RH_NB_RESULT = resolve(
  "evaluation-artifacts/compact-render-hints-no-bounds-canary-20260909/result.json",
);
const compactSubtree = (COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema).properties!.renderHints;
const cRhNbSchema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(compactSubtree) },
  required: ["renderHints"],
  additionalProperties: false,
};
delete cRhNbSchema.properties!.renderHints.minItems;
delete cRhNbSchema.properties!.renderHints.maxItems;

const originalEnum = cRhNbSchema.properties!.renderHints.items!.enum!;
const tinyEnumSelectionRule = "originalEnum.slice(0, 3)";
const tinyEnum = originalEnum.slice(0, 3);
const schema = structuredClone(cRhNbSchema);
schema.properties!.renderHints.items!.enum = tinyEnum;

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

function deltaPaths(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const beforeObject = before !== null && typeof before === "object" && !Array.isArray(before)
    ? before as Record<string, unknown> : null;
  const afterObject = after !== null && typeof after === "object" && !Array.isArray(after)
    ? after as Record<string, unknown> : null;
  if (!beforeObject || !afterObject) return [`${path}:changed`];
  const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort();
  return keys.flatMap((key) => {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in afterObject)) return [`${childPath}:removed`];
    if (!(key in beforeObject)) return [`${childPath}:added`];
    return deltaPaths(beforeObject[key], afterObject[key], childPath);
  });
}

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
  const previous = JSON.parse(await readFile(C_RH_NB_RESULT, "utf8")) as Record<string, unknown>;
  expect(previous).toMatchObject({
    id: "C-RH-NB",
    model: request.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${request.model}:generateContent`,
    imageCount: 0,
    attemptedCalls: 1,
    httpStatus: 400,
    providerStatus: "INVALID_ARGUMENT",
    completed: true,
  });
  expect(sha(cRhNbSchema)).toBe(previous.noBoundsWrapperSchemaHash);
  expect(sha(cRhNbSchema.properties!.renderHints.items)).toBe(previous.itemSchemaHash);
  expect(sha(originalEnum)).toBe(previous.enumVocabularyHash);
  expect(sha(prompt)).toBe(previous.promptHash);

  expect(originalEnum).toHaveLength(121);
  expect(new Set(originalEnum.map((value) => JSON.stringify(value))).size).toBe(121);
  expect(tinyEnum).toEqual(originalEnum.slice(0, 3));
  expect(tinyEnum).toHaveLength(3);
  expect(new Set(tinyEnum.map((value) => JSON.stringify(value))).size).toBe(3);
  expect(deltaPaths(cRhNbSchema, schema)).toEqual([
    "properties.renderHints.items.enum:changed",
  ]);

  const beforeRenderHints = cRhNbSchema.properties!.renderHints;
  const afterRenderHints = schema.properties!.renderHints;
  expect(afterRenderHints.type).toBe("array");
  expect(afterRenderHints.type).toBe(beforeRenderHints.type);
  expect(afterRenderHints.minItems).toBeUndefined();
  expect(afterRenderHints.maxItems).toBeUndefined();
  expect(afterRenderHints.items!.type).toBe(beforeRenderHints.items!.type);
  expect(itemWithoutEnum(afterRenderHints.items!)).toEqual(itemWithoutEnum(beforeRenderHints.items!));

  const envelope = buildGeminiStructuredRequestEnvelope(request);
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
  const restored = structuredClone(envelope.body) as {
    generationConfig: { responseJsonSchema: unknown };
  };
  restored.generationConfig.responseJsonSchema = cRhNbSchema;
  expect(sha(restored)).toBe(previous.wireHash);

  const metrics = extendedMetrics(schema);
  expect(metrics).toMatchObject({
    valid: true,
    jsonSerializable: true,
    depth: 3,
    propertyCount: 1,
    requiredCount: 1,
    enumValueCount: 3,
    descriptionChars: 0,
    arrayCount: 1,
    enumCount: 1,
    unsupportedConstructs: [],
    undefinedPaths: [],
    nonFiniteNumberPaths: [],
    missingRequiredProperties: [],
  });
  return {
    previous,
    envelope,
    metrics,
    deltas: deltaPaths(cRhNbSchema, schema),
  };
}

describe("C-RH-TE tiny-enum preflight", () => {
  it("replaces only the 121-value item enum with its deterministic first three values", async () => {
    const check = await preflight();
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline.json"), JSON.stringify({
      passed: true,
      deltas: check.deltas,
      cRhNbWrapperSchemaHash: check.previous.noBoundsWrapperSchemaHash,
      tinyEnumWrapperSchemaHash: sha(schema),
      originalItemSchemaHash: sha(cRhNbSchema.properties!.renderHints.items),
      tinyEnumItemSchemaHash: sha(schema.properties!.renderHints.items),
      itemSchemaOutsideEnumHash: sha(itemWithoutEnum(schema.properties!.renderHints.items!)),
      originalEnumCount: originalEnum.length,
      originalEnumHash: sha(originalEnum),
      tinyEnumCount: tinyEnum.length,
      tinyEnumHash: sha(tinyEnum),
      tinyEnumValues: tinyEnum,
      tinyEnumSelectionRule,
      promptHash: sha(prompt),
      restoredCRhNbWireHash: check.previous.wireHash,
      nonSchemaWireMatchesCRhNb: true,
      metrics: check.metrics,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_RENDER_HINTS_TINY_ENUM_CANARY !== "1")(
  "single authorized live C-RH-TE canary",
  () => {
    it("dispatches one request and records only secret-safe acceptance evidence", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifactPath = join(ROOT, "result.json");
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const result: Record<string, unknown> = {
        id: "C-RH-TE",
        deltas: check.deltas,
        cRhNbWrapperSchemaHash: check.previous.noBoundsWrapperSchemaHash,
        tinyEnumWrapperSchemaHash: sha(schema),
        originalItemSchemaHash: sha(cRhNbSchema.properties!.renderHints.items),
        tinyEnumItemSchemaHash: sha(schema.properties!.renderHints.items),
        itemSchemaOutsideEnumHash: sha(itemWithoutEnum(schema.properties!.renderHints.items!)),
        originalEnumCount: originalEnum.length,
        originalEnumHash: sha(originalEnum),
        tinyEnumCount: tinyEnum.length,
        tinyEnumHash: sha(tinyEnum),
        tinyEnumSelectionRule,
        metrics: check.metrics,
        model: request.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${request.model}:generateContent`,
        imageCount: 0,
        promptHash: sha(prompt),
        wireHash: sha(check.envelope.body),
        nonSchemaWireMatchesCRhNb: true,
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
        if (++calls !== 1) throw new Error("C_RH_TE_RETRY_FORBIDDEN");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(result.endpoint);
        expect(sha(JSON.parse(String(init?.body)))).toBe(result.wireHash);
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
