/** Health-gated diagnostic: known-good control first, exact C-RH-V2 only after PASS. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_HINT_GROUPS,
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

const ROOT = resolve("evaluation-artifacts/compact-v2-health-gated-20260910");
const CONTROL_BASELINE = resolve(
  "evaluation-artifacts/compact-render-hints-tiny-enum-remeasure-20260909/result.json",
);
const TARGET_BASELINE = resolve(
  "evaluation-artifacts/compact-render-hints-v2-canary-20260910/result.json",
);
const TARGET_REMEASURE = resolve(
  "evaluation-artifacts/compact-render-hints-v2-canary-20260910/remeasure-result.json",
);
const LIVE_RESULT = join(ROOT, "result.json");
const CLIENT_TIMEOUT_MS = "45000";
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

const compactV2Subtree = (COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema).properties!.renderHints;
const targetSchema: Schema = {
  type: "object",
  properties: { renderHints: structuredClone(compactV2Subtree) },
  required: ["renderHints"],
  additionalProperties: false,
};

const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const controlRequest: GeminiStructuredRequest = {
  model: "gemini-3.6-flash",
  imageDataUrls: [],
  prompt: `${COMPACT_PHOTO_ANALYSIS_PROMPT}${referenceSuffix}`,
  responseSchema: controlSchema,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
};
const targetRequest: GeminiStructuredRequest = {
  model: "gemini-3.6-flash",
  imageDataUrls: [],
  prompt: `${COMPACT_PHOTO_ANALYSIS_V2_PROMPT}${referenceSuffix}`,
  responseSchema: targetSchema,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
};

async function preflight() {
  const controlBaseline = JSON.parse(await readFile(CONTROL_BASELINE, "utf8")) as Record<string, unknown>;
  const targetBaseline = JSON.parse(await readFile(TARGET_BASELINE, "utf8")) as Record<string, unknown>;
  const targetRemeasure = JSON.parse(await readFile(TARGET_REMEASURE, "utf8")) as Record<string, unknown>;
  const controlEnvelope = buildGeminiStructuredRequestEnvelope(controlRequest);
  const targetEnvelope = buildGeminiStructuredRequestEnvelope(targetRequest);

  expect(controlSchema.properties!.renderHints.items!.enum).toEqual(["warm", "cool", "neutral"]);
  expect(controlBaseline).toMatchObject({
    id: "C-RH-TE-R1",
    exactWireEquality: true,
    schemaHash: sha(controlSchema),
    promptHash: sha(controlRequest.prompt),
    wireHash: sha(controlEnvelope.body),
    tinyEnumHash: sha(["warm", "cool", "neutral"]),
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

  const groupOrder = Object.keys(COMPACT_HINT_GROUPS);
  const groupHashes = Object.fromEntries(groupOrder.map((group) => {
    const groupSchema = compactV2Subtree.properties![group];
    return [group, {
      schemaHash: sha(groupSchema),
      enumHash: sha(groupSchema.items!.enum),
      enumValues: groupSchema.items!.enum!.length,
      minItems: groupSchema.minItems ?? null,
      maxItems: groupSchema.maxItems ?? null,
    }];
  }));
  expect(targetBaseline).toMatchObject({
    id: "C-RH-V2",
    subtreeHash: "35ebc2243ef257420b4c4d134ac7fe855652933b9bc4c2ec01f62748d4fcb88d",
    wrapperSchemaHash: "d7526c76479ca315ba812b4ad0f1c02ab82489f13c8f4cd55203b65d97380e72",
    groupOrderHash: sha(groupOrder),
    groupHashes,
    promptHash: "79c535a45a11857a4d498549b11ff625043c362e6a3706abdff2c9dd6bbd3e2a",
    wireHash: "0d881692de475a9e0ea5a43e0468b26663ef999b9e0540a972cce3d060c07cb2",
    model: targetRequest.model,
    apiFamily: "generateContent",
    apiVersion: "v1beta",
    endpoint: `/v1beta/models/${targetRequest.model}:generateContent`,
    imageCount: 0,
  });
  expect(targetRemeasure).toMatchObject({
    subtreeHash: targetBaseline.subtreeHash,
    wrapperSchemaHash: targetBaseline.wrapperSchemaHash,
    groupOrderHash: targetBaseline.groupOrderHash,
    groupHashes: targetBaseline.groupHashes,
    promptHash: targetBaseline.promptHash,
    wireHash: targetBaseline.wireHash,
    clientTimeoutMs: 45000,
    exactWireEquality: true,
  });
  expect(sha(compactV2Subtree)).toBe(targetBaseline.subtreeHash);
  expect(sha(targetSchema)).toBe(targetBaseline.wrapperSchemaHash);
  expect(sha(targetRequest.prompt)).toBe(targetBaseline.promptHash);
  expect(sha(targetEnvelope.body)).toBe(targetBaseline.wireHash);
  expect(JSON.stringify(targetSchema.properties!.renderHints)).toBe(JSON.stringify(compactV2Subtree));

  for (const envelope of [controlEnvelope, targetEnvelope]) {
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
  return { controlBaseline, targetBaseline, controlEnvelope, targetEnvelope, groupHashes };
}

describe("health-gated compact v2 canary preflight", () => {
  it("reconstructs both stored wires and preserves the 45 second contract", async () => {
    const check = await preflight();
    expect(sha(check.controlEnvelope.body)).toBe(check.controlBaseline.wireHash);
    expect(sha(check.targetEnvelope.body)).toBe(check.targetBaseline.wireHash);
    expect(CLIENT_TIMEOUT_MS).toBe("45000");
  });
});

describe.skipIf(process.env.COMPACT_V2_HEALTH_GATED_CANARY !== "1")(
  "authorized health control then conditional target",
  () => {
    it("never dispatches target unless the known-good control fully passes", async () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const check = await preflight();
      await mkdir(ROOT, { recursive: true });
      const artifact: {
        controlExactEquality: boolean;
        targetExactEquality: boolean;
        maxProviderCalls: number;
        totalProviderCalls: number;
        control: CallResult;
        target: CallResult;
        classification: string | null;
      } = {
        controlExactEquality: true,
        targetExactEquality: true,
        maxProviderCalls: 2,
        totalProviderCalls: 0,
        control: {
          id: "control", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          schemaValidation: false, completed: false,
          schemaHash: sha(controlSchema), promptHash: sha(controlRequest.prompt),
          wireHash: sha(check.controlEnvelope.body), tinyEnumValues: ["warm", "cool", "neutral"],
          clientTimeoutMs: 45000,
        },
        target: {
          id: "target", attemptedCalls: 0, httpStatus: null, providerCode: null,
          providerStatus: null, providerMessage: null, jsonReturned: false,
          schemaValidation: false, completed: false,
          subtreeHash: sha(compactV2Subtree), wrapperSchemaHash: sha(targetSchema),
          promptHash: sha(targetRequest.prompt), wireHash: sha(check.targetEnvelope.body),
          groupOrderHash: sha(Object.keys(COMPACT_HINT_GROUPS)), groupHashes: check.groupHashes,
          clientTimeoutMs: 45000,
        },
        classification: null,
      };
      await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let active: { record: CallResult; wireHash: string } | null = null;
      let stageCalls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!active) throw new Error("HEALTH_GATED_CANARY_WITHOUT_ACTIVE_STAGE");
        if (++stageCalls !== 1) throw new Error("HEALTH_GATED_CANARY_RETRY_FORBIDDEN");
        if (++artifact.totalProviderCalls > artifact.maxProviderCalls) {
          throw new Error("HEALTH_GATED_CANARY_BUDGET_EXCEEDED");
        }
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(`/v1beta/models/gemini-3.6-flash:generateContent`);
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
          const validator = active.record.id === "control"
            ? new Ajv({ allErrors: true }).compile(controlSchema)
            : new Ajv({ allErrors: true }).compile(targetSchema);
          active.record.schemaValidation = active.record.jsonReturned && validator(parsed) === true;
          active.record.schemaErrorCount = validator.errors?.length ?? 0;
          active.record.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        }
        await writeFile(LIVE_RESULT, JSON.stringify(artifact, null, 2));
        return response;
      });

      const run = async (record: CallResult, request: GeminiStructuredRequest, wireHash: string) => {
        active = { record, wireHash };
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
        await run(artifact.control, controlRequest, sha(check.controlEnvelope.body));
        const controlPassed = artifact.control.httpStatus === 200
          && artifact.control.jsonReturned
          && artifact.control.schemaValidation;
        if (controlPassed) {
          await run(artifact.target, targetRequest, sha(check.targetEnvelope.body));
          artifact.classification = artifact.target.httpStatus === 200
            && artifact.target.jsonReturned
            && artifact.target.schemaValidation
            ? "grouped_renderHints_accepted"
            : artifact.target.httpStatus === 400
              && artifact.target.providerStatus === "INVALID_ARGUMENT"
              ? "grouped_renderHints_incompatible"
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
