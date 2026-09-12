/** Opt-in C-RH-V2 remeasurement; the previous wire and 45s timeout are immutable. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  geminiProviderErrorDiagnostic,
  generateGeminiStructuredJson,
} from "../src/gemini";
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
const PREVIOUS_RESULT = join(ROOT, "result.json");
const PREVIOUS_HARNESS = resolve("test/compactRenderHintsV2Canary.test.ts");
const REMEASURE_RESULT = join(ROOT, "remeasure-result.json");
const CLIENT_TIMEOUT_MS = "45000";
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

function currentGroupHashes() {
  return Object.fromEntries(Object.keys(COMPACT_HINT_GROUPS).map((group) => {
    const groupSchema = sourceSubtree.properties![group];
    return [group, {
      schemaHash: sha(groupSchema),
      enumHash: sha(groupSchema.items!.enum),
      enumValues: groupSchema.items!.enum!.length,
      minItems: groupSchema.minItems ?? null,
      maxItems: groupSchema.maxItems ?? null,
    }];
  }));
}

async function preflight() {
  const previous = JSON.parse(await readFile(PREVIOUS_RESULT, "utf8")) as Record<string, unknown>;
  const previousHarness = await readFile(PREVIOUS_HARNESS, "utf8");
  const envelope = buildGeminiStructuredRequestEnvelope(request);
  const groupOrder = Object.keys(COMPACT_HINT_GROUPS);
  const groupHashes = currentGroupHashes();

  expect(previous).toMatchObject({
    id: "C-RH-V2",
    subtreeEqual: true,
    subtreeHash: sha(sourceSubtree),
    wrapperSchemaHash: sha(schema),
    groupOrderHash: sha(groupOrder),
    groupHashes,
    metrics: {
      serializedBytes: 2832,
      propertyCount: 16,
      requiredCount: 16,
      depth: 4,
      arrayCount: 15,
      enumDeclarationCount: 15,
      enumValueCount: 175,
      largestSingleEnum: 16,
      unsupportedConstructs: [],
    },
    model: request.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${request.model}:generateContent`,
    imageCount: 0,
    promptHash: sha(prompt),
    wireHash: sha(envelope.body),
    nonSchemaWireMatchesCompactV2Full: true,
    attemptedCalls: 1,
    httpStatus: null,
    jsonReturned: false,
    schemaValidation: false,
    completed: true,
    clientErrorName: "GeminiApiError",
  });
  expect(previousHarness).toContain(`GEMINI_STRUCTURED_TIMEOUT_MS: "${CLIENT_TIMEOUT_MS}"`);
  expect(JSON.stringify(schema.properties!.renderHints)).toBe(JSON.stringify(sourceSubtree));
  expect(Object.keys(sourceSubtree.properties ?? {})).toEqual(groupOrder);
  expect(sourceSubtree.required).toEqual(groupOrder);
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
  return { previous, envelope, groupOrder, groupHashes };
}

describe("C-RH-V2 exact-wire remeasurement preflight", () => {
  it("matches every stored wire identity field and the 45 second timeout", async () => {
    const check = await preflight();
    expect(sha(check.envelope.body)).toBe(check.previous.wireHash);
    expect(check.groupOrder).toHaveLength(15);
  });
});

describe.skipIf(process.env.COMPACT_RENDER_HINTS_V2_REMEASURE !== "1")(
  "single authorized C-RH-V2 remeasurement",
  () => {
    it("dispatches the identical request exactly once", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const result: Record<string, unknown> = {
        id: "C-RH-V2-remeasure",
        previousResultHash: sha(check.previous),
        subtreeHash: sha(sourceSubtree),
        wrapperSchemaHash: sha(schema),
        groupOrderHash: sha(check.groupOrder),
        groupHashes: check.groupHashes,
        promptHash: sha(prompt),
        wireHash: sha(check.envelope.body),
        model: request.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${request.model}:generateContent`,
        imageCount: 0,
        temperature: 0,
        thinkingConfigHash: sha({ thinkingLevel: "LOW" }),
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: "application/json",
        clientTimeoutMs: Number(CLIENT_TIMEOUT_MS),
        exactWireEquality: true,
        attemptedCalls: 0,
        httpStatus: null,
        providerCode: null,
        providerStatus: null,
        providerMessage: null,
        jsonReturned: false,
        schemaValidation: false,
        completed: false,
        classification: null,
      };
      await writeFile(REMEASURE_RESULT, JSON.stringify(result, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let calls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (++calls !== 1) throw new Error("C_RH_V2_REMEASURE_RETRY_FORBIDDEN");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(result.endpoint);
        expect(sha(JSON.parse(String(init?.body)))).toBe(result.wireHash);
        result.attemptedCalls = 1;
        await writeFile(REMEASURE_RESULT, JSON.stringify(result, null, 2));
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
        await writeFile(REMEASURE_RESULT, JSON.stringify(result, null, 2));
        return response;
      });
      try {
        await generateGeminiStructuredJson({
          GEMINI_API_KEY: apiKey!,
          GEMINI_STRUCTURED_TIMEOUT_MS: CLIENT_TIMEOUT_MS,
        } as Env, request);
      } catch (error) {
        const diagnostic = geminiProviderErrorDiagnostic(error);
        result.clientErrorName = error instanceof Error ? error.name : "unknown";
        result.clientDiagnosticStatus = diagnostic.httpStatus;
        result.clientDiagnosticProviderStatus = diagnostic.providerStatus;
        result.clientDiagnosticMessage = safeProviderMessage(diagnostic.message, [apiKey!]);
      } finally {
        spy.mockRestore();
        result.completed = true;
        result.classification = result.httpStatus === 200
          && result.jsonReturned === true
          && result.schemaValidation === true
          ? "grouped_renderHints_accepted"
          : result.httpStatus === 400 && result.providerStatus === "INVALID_ARGUMENT"
            ? "grouped_renderHints_incompatible"
            : "inconclusive_provider_failure";
        await writeFile(REMEASURE_RESULT, JSON.stringify(result, null, 2));
      }
      expect(calls).toBe(1);
    }, 60_000);
  },
);
