/** Opt-in C-RH-V2 diagnostic only; compact v2 and production stay unchanged. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_HINT_GROUPS,
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
} from "../src/compactPhotoAnalysis";
import {
  buildGeminiStructuredRequestEnvelope,
  generateGeminiStructuredJson,
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

const ROOT = resolve("evaluation-artifacts/compact-render-hints-v2-canary-20260910");
const FULL_RESULT = resolve("evaluation-artifacts/compact-primary-v2-20260909/canary-a.json");
const fullSchema = COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema;
const sourceSubtree = fullSchema.properties!.renderHints;
const schema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(sourceSubtree) },
  required: ["renderHints"],
  additionalProperties: false,
};
const prompt = `${COMPACT_PHOTO_ANALYSIS_V2_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`;
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

function extendedMetrics(value: Schema) {
  let arrayCount = 0;
  let enumDeclarationCount = 0;
  let largestSingleEnum = 0;
  let minItemsCount = 0;
  let maxItemsCount = 0;
  const visit = (node: Schema): void => {
    if (node.type === "array") arrayCount += 1;
    if (node.minItems !== undefined) minItemsCount += 1;
    if (node.maxItems !== undefined) maxItemsCount += 1;
    if (Array.isArray(node.enum)) {
      enumDeclarationCount += 1;
      largestSingleEnum = Math.max(largestSingleEnum, node.enum.length);
    }
    Object.values(node.properties ?? {}).forEach(visit);
    if (node.items) visit(node.items);
  };
  visit(value);
  return {
    ...inspectGeminiResponseSchema(value),
    arrayCount,
    enumDeclarationCount,
    largestSingleEnum,
    minItemsCount,
    maxItemsCount,
  };
}

async function preflight() {
  const previous = JSON.parse(await readFile(FULL_RESULT, "utf8")) as Record<string, unknown>;
  expect(previous).toMatchObject({
    id: "A",
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
  expect(sha(prompt)).toBe(previous.promptHash);
  expect(sha(fullSchema)).toBe(previous.schemaHash);

  const wrapped = schema.properties!.renderHints;
  expect(sha(wrapped)).toBe(sha(sourceSubtree));
  expect(JSON.stringify(wrapped)).toBe(JSON.stringify(sourceSubtree));
  expect(wrapped).toEqual(sourceSubtree);
  expect(schema).toEqual({
    type: "object",
    properties: { renderHints: sourceSubtree },
    required: ["renderHints"],
    additionalProperties: false,
  });

  const expectedGroups = Object.keys(COMPACT_HINT_GROUPS);
  expect(Object.keys(wrapped.properties ?? {})).toEqual(expectedGroups);
  expect(wrapped.required).toEqual(expectedGroups);
  const groupHashes = Object.fromEntries(expectedGroups.map((group) => {
    const sourceGroup = sourceSubtree.properties![group];
    const wrappedGroup = wrapped.properties![group];
    expect(JSON.stringify(wrappedGroup), group).toBe(JSON.stringify(sourceGroup));
    expect(wrappedGroup.type, group).toBe("array");
    expect(wrappedGroup.minItems, group).toBeUndefined();
    expect(wrappedGroup.maxItems, group).toBeUndefined();
    expect(wrappedGroup.items?.type, group).toBe("string");
    expect(Array.isArray(wrappedGroup.items?.enum), group).toBe(true);
    return [group, {
      schemaHash: sha(wrappedGroup),
      enumHash: sha(wrappedGroup.items!.enum),
      enumValues: wrappedGroup.items!.enum!.length,
      minItems: wrappedGroup.minItems ?? null,
      maxItems: wrappedGroup.maxItems ?? null,
    }];
  }));

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
  const restoredFull = structuredClone(envelope.body) as {
    generationConfig: { responseJsonSchema: unknown };
  };
  restoredFull.generationConfig.responseJsonSchema = COMPACT_PHOTO_ANALYSIS_V2_SCHEMA;
  expect(sha(restoredFull)).toBe(previous.wireHash);

  const metrics = extendedMetrics(schema);
  expect(metrics).toMatchObject({
    valid: true,
    jsonSerializable: true,
    propertyCount: 16,
    requiredCount: 16,
    depth: 4,
    arrayCount: 15,
    enumDeclarationCount: 15,
    largestSingleEnum: 16,
    minItemsCount: 0,
    maxItemsCount: 0,
    unsupportedConstructs: [],
    undefinedPaths: [],
    nonFiniteNumberPaths: [],
    missingRequiredProperties: [],
  });
  return {
    previous,
    envelope,
    metrics,
    subtreeHash: sha(sourceSubtree),
    wrapperSchemaHash: sha(schema),
    groupHashes,
  };
}

describe("C-RH-V2 grouped renderHints-only preflight", () => {
  it("keeps the exact 15-group subtree and changes only the response schema", async () => {
    const check = await preflight();
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline.json"), JSON.stringify({
      passed: true,
      subtreeEqual: true,
      subtreeHash: check.subtreeHash,
      wrapperSchemaHash: check.wrapperSchemaHash,
      groupOrder: Object.keys(COMPACT_HINT_GROUPS),
      groupHashes: check.groupHashes,
      metrics: check.metrics,
      promptHash: check.previous.promptHash,
      restoredCompactV2FullWireHash: check.previous.wireHash,
      nonSchemaWireMatchesCompactV2Full: true,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_RENDER_HINTS_V2_CANARY !== "1")(
  "single authorized live C-RH-V2 canary",
  () => {
    it("dispatches exactly one preflighted request without retry or fallback", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifactPath = join(ROOT, "result.json");
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const result: Record<string, unknown> = {
        id: "C-RH-V2",
        subtreeEqual: true,
        subtreeHash: check.subtreeHash,
        wrapperSchemaHash: check.wrapperSchemaHash,
        groupOrderHash: sha(Object.keys(COMPACT_HINT_GROUPS)),
        groupHashes: check.groupHashes,
        metrics: check.metrics,
        model: request.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${request.model}:generateContent`,
        imageCount: 0,
        promptHash: sha(prompt),
        wireHash: sha(check.envelope.body),
        nonSchemaWireMatchesCompactV2Full: true,
        attemptedCalls: 0,
        httpStatus: null,
        providerCode: null,
        providerStatus: null,
        providerMessage: null,
        jsonReturned: false,
        schemaValidation: false,
        completed: false,
      };
      await writeFile(artifactPath, JSON.stringify(result, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let calls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (++calls !== 1) throw new Error("C_RH_V2_RETRY_FORBIDDEN");
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
          result.schemaValidation = result.jsonReturned === true && validate(parsed) === true;
          result.schemaErrorCount = validate.errors?.length ?? 0;
          result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        }
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
    }, 60_000);
  },
);
