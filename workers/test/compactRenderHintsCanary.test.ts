/** Opt-in C-RH diagnostic only; the compact candidate and production caller stay unchanged. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_HINT_ORDER,
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

const ROOT = resolve("evaluation-artifacts/compact-render-hints-canary-20260909");
const PREVIOUS = resolve("evaluation-artifacts/compact-primary-20260909/canary-1.json");
const fullSchema = COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema;
const compactSubtree = fullSchema.properties!.renderHints;
const schema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(compactSubtree) },
  required: ["renderHints"],
  additionalProperties: false,
};
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
  const previous = JSON.parse(await readFile(PREVIOUS, "utf8")) as Record<string, unknown>;
  expect(previous).toMatchObject({
    id: 1,
    model: request.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${request.model}:generateContent`,
    imageCount: 0,
    attemptedCalls: 1,
    httpStatus: 400,
    completed: true,
  });
  expect(sha(prompt)).toBe(previous.promptHash);

  const wrapped = schema.properties!.renderHints;
  expect(sha(wrapped)).toBe(sha(compactSubtree));
  expect(JSON.stringify(wrapped)).toBe(JSON.stringify(compactSubtree));
  expect(wrapped).toEqual({
    type: "array",
    minItems: COMPACT_HINT_ORDER.length,
    maxItems: COMPACT_HINT_ORDER.length,
    items: compactSubtree.items,
  });
  expect(wrapped.items).toEqual(compactSubtree.items);
  expect(wrapped.items!.enum).toEqual(compactSubtree.items!.enum);
  expect(wrapped.description).toBeUndefined();

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
  restored.generationConfig.responseJsonSchema = COMPACT_PHOTO_ANALYSIS_SCHEMA;
  expect(sha(restored)).toBe(previous.wireHash);
  const metrics = extendedMetrics(schema);
  expect(metrics).toMatchObject({
    valid: true,
    jsonSerializable: true,
    depth: 3,
    propertyCount: 1,
    requiredCount: 1,
    enumValueCount: compactSubtree.items!.enum!.length,
    descriptionChars: 0,
    arrayCount: 1,
    enumCount: 1,
    unsupportedConstructs: [],
    undefinedPaths: [],
    nonFiniteNumberPaths: [],
    missingRequiredProperties: [],
  });
  return { previous, envelope, metrics, subtreeHash: sha(compactSubtree) };
}

describe("C-RH compact renderHints-only preflight", () => {
  it("keeps the vector subtree exact and changes only the response schema from compact full", async () => {
    const check = await preflight();
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline.json"), JSON.stringify({
      passed: true,
      subtreeHash: check.subtreeHash,
      wrapperSchemaHash: sha(schema),
      enumVocabularyHash: sha(compactSubtree.items!.enum),
      itemSchemaHash: sha(compactSubtree.items),
      minItems: compactSubtree.minItems,
      maxItems: compactSubtree.maxItems,
      metrics: check.metrics,
      previousCompactFullPromptHash: check.previous.promptHash,
      restoredCompactFullWireHash: check.previous.wireHash,
      nonSchemaWireMatchesCompactFull: true,
    }, null, 2));
  });
});

describe.skipIf(process.env.COMPACT_RENDER_HINTS_CANARY !== "1")(
  "single authorized live C-RH canary",
  () => {
    it("dispatches exactly one preflighted request without retry or fallback", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifactPath = join(ROOT, "result.json");
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const result: Record<string, unknown> = {
        id: "C-RH",
        subtreeHash: check.subtreeHash,
        wrapperSchemaHash: sha(schema),
        enumVocabularyHash: sha(compactSubtree.items!.enum),
        itemSchemaHash: sha(compactSubtree.items),
        metrics: check.metrics,
        minItems: compactSubtree.minItems,
        maxItems: compactSubtree.maxItems,
        model: request.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${request.model}:generateContent`,
        imageCount: 0,
        promptHash: sha(prompt),
        wireHash: sha(check.envelope.body),
        nonSchemaWireMatchesCompactFull: true,
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
        if (++calls !== 1) throw new Error("C_RH_RETRY_FORBIDDEN");
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
