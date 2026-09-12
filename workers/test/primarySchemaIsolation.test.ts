/** Opt-in diagnostic experiment only. Never changes production or reuses its six-call budget. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA } from "../src/analysis";
import { buildGeminiStructuredRequestEnvelope, generateGeminiStructuredJson } from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { safeProviderMessage } from "./primaryTransportSupport";

const ROOT = resolve("evaluation-artifacts/primary-schema-isolation-20260909");
const BASE = resolve("evaluation-artifacts/primary-wire-contract-20260908");
const MODEL = "gemini-3.6-flash";
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; [key: string]: unknown };
const full = () => structuredClone(PHOTO_ANALYSIS_SCHEMA) as Schema;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function without(name: string) {
  const schema = full();
  delete schema.properties![name];
  schema.required = schema.required!.filter(key => key !== name);
  return schema;
}
function only(name: string, subtree = full().properties![name]): Schema {
  return { type: "object", properties: { [name]: subtree }, required: [name], additionalProperties: false };
}
function prefix(name: string, start: number, end: number): Schema {
  const subtree = full().properties![name];
  const keys = Object.keys(subtree.properties!).slice(start, end);
  return { ...subtree, properties: Object.fromEntries(keys.map(key => [key, subtree.properties![key]])), required: subtree.required!.filter(key => keys.includes(key)) };
}

function metrics(schema: Schema) {
  const extra = { arrayCount: 0, objectCount: 0, enumCount: 0, additionalPropertiesCount: 0, nullableUnionCount: 0, descriptionBytes: 0 };
  const visit = (node: Schema) => {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object")) extra.objectCount++;
    if (types.includes("array")) extra.arrayCount++;
    if (Array.isArray(node.enum)) extra.enumCount++;
    if (node.additionalProperties !== undefined) extra.additionalPropertiesCount++;
    if (types.includes("null") && types.length > 1) extra.nullableUnionCount++;
    if (typeof node.description === "string") extra.descriptionBytes += Buffer.byteLength(node.description);
    for (const child of Object.values(node.properties ?? {})) visit(child);
    for (const key of ["items", "additionalProperties"]) if (typeof node[key] === "object" && node[key] !== null) visit(node[key] as Schema);
    for (const key of ["anyOf", "oneOf", "prefixItems"]) if (Array.isArray(node[key])) (node[key] as Schema[]).forEach(visit);
  };
  visit(schema);
  return { ...inspectGeminiResponseSchema(schema), ...extra };
}

type Result = { id: string; httpStatus: number | null; completed: boolean; wireHash: string; [key: string]: unknown };
async function records(): Promise<Result[]> {
  await mkdir(ROOT, { recursive: true });
  const files = (await readdir(ROOT)).filter(name => /^call-[1-4]\.json$/.test(name)).sort();
  return Promise.all(files.map(name => readFile(join(ROOT, name), "utf8").then(JSON.parse)));
}
function next(history: Result[]): { id: string; schema: Schema; delta: string } | null {
  if (history.length >= 4 || history.some(result => !result.completed || ![200, 400].includes(result.httpStatus!))) return null;
  if (!history.length) return { id: "H1", schema: without("renderHints"), delta: "E minus renderHints property and its required entry only" };
  const h1 = history[0];
  if (h1.httpStatus === 400) {
    if (history.length === 1) return { id: "H3", schema: without("faceMeasurementEvidence"), delta: "E minus faceMeasurementEvidence only (no root required entry existed)" };
    if (history.length === 2) return history[1].httpStatus === 200
      ? { id: "H4", schema: only("faceMeasurementEvidence"), delta: "Exact production faceMeasurementEvidence subtree alone in specified root wrapper" }
      : { id: "H4", schema: without("inferred"), delta: "E minus inferred property and its required entry only" };
    return null;
  }
  if (history.length === 1) return { id: "H2", schema: only("renderHints"), delta: "Exact production renderHints subtree alone in specified root wrapper" };
  const count = Object.keys(full().properties!.renderHints.properties!).length;
  const half = Math.ceil(count / 2);
  if (history[1].httpStatus === 400) {
    const start = history.length === 2 || history[2].httpStatus === 400 ? 0 : half;
    const end = history.length === 2 ? half : history[2].httpStatus === 400 ? Math.ceil(half / 2) : count;
    return { id: history.length === 2 ? "H3" : "H4", schema: only("renderHints", prefix("renderHints", start, end)), delta: `Specific-subtree branch: unchanged renderHints children in production property order [${start},${end})` };
  }
  // Composition branch: deterministic prefix loading, not arbitrary field hunting.
  const end = history.length === 2 ? half : history[2].httpStatus === 200 ? Math.ceil((half + count) / 2) : Math.ceil(half / 2);
  const schema = full();
  schema.properties!.renderHints = prefix("renderHints", 0, end);
  return { id: history.length === 2 ? "H3" : "H4", schema, delta: `Complexity branch: full remainder plus unchanged renderHints prefix [0,${end}) of ${count}` };
}

async function frozenRequest() {
  const frozen = JSON.parse(await readFile(join(BASE, "E.json"), "utf8"));
  const request = { model: MODEL, imageDataUrls: [] as string[],
    prompt: `${ANALYSIS_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`,
    responseSchema: full(), maxOutputTokens: 8192, allowWorkersAiFallback: false };
  const envelope = buildGeminiStructuredRequestEnvelope(request);
  expect(sha(envelope.body)).toBe(frozen.wireSha256);
  expect(JSON.stringify(full())).toBe(JSON.stringify(frozen.sanitizedWire.generationConfig.responseJsonSchema));
  expect(frozen).toMatchObject({ model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta", endpoint: `/v1beta/models/${MODEL}:generateContent`, httpStatus: 400 });
  return { request, envelope, frozen };
}

describe("adaptive primary schema isolation offline", () => {
  it("audits every production subtree and detects unsupported keywords programmatically", async () => {
    const fullMetrics = metrics(full());
    expect(fullMetrics).toMatchObject({ valid: true, propertyCount: 140, serializedBytes: 11653, depth: 6, unsupportedConstructs: [] });
    const subtrees = Object.fromEntries(Object.entries(full().properties!).map(([name, node]) => [name, metrics(node)]));
    for (const result of Object.values(subtrees)) expect(result.valid).toBe(true);
    expect(metrics({ type: "string", pattern: "unsupported-control" }).unsupportedConstructs).toContain("pattern");
    expect(metrics({ type: ["object", "null"], additionalProperties: false, properties: { x: { type: "array", items: { type: "string", enum: ["a", "b"], description: "한" } } }, required: ["x"] })).toMatchObject({ objectCount: 1, arrayCount: 1, enumCount: 1, enumValueCount: 2, nullableUnionCount: 1, additionalPropertiesCount: 1, descriptionBytes: 3 });
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline-audit.json"), JSON.stringify({ officialReference: "https://ai.google.dev/api/generate-content", full: fullMetrics, subtrees }, null, 2));
  });
  it("keeps exact subtrees and all non-schema E wire fields frozen", async () => {
    const { request, envelope } = await frozenRequest();
    for (const name of ["renderHints", "faceMeasurementEvidence", "inferred"]) {
      const reduced = without(name);
      expect(Object.keys(reduced.properties!)).toEqual(Object.keys(full().properties!).filter(key => key !== name));
      expect(reduced.required).toEqual(full().required!.filter(key => key !== name));
      for (const [key, child] of Object.entries(reduced.properties!)) expect(JSON.stringify(child)).toBe(JSON.stringify(full().properties![key]));
      expect(JSON.stringify(only(name).properties![name])).toBe(JSON.stringify(full().properties![name]));
      const body = structuredClone(buildGeminiStructuredRequestEnvelope({ ...request, responseSchema: reduced }).body) as Body;
      body.generationConfig.responseJsonSchema = full();
      expect(body).toEqual(envelope.body);
    }
  });
  it("uses only authorized adaptive branches, at most four requests, with no continuation after ambiguous errors", () => {
    const result = (httpStatus: number): Result => ({ id: "test", httpStatus, completed: true, wireHash: "test" });
    expect(next([])?.id).toBe("H1");
    expect(next([result(200)])?.schema).toEqual(only("renderHints"));
    expect(next([result(400)])?.schema).toEqual(without("faceMeasurementEvidence"));
    expect(next([result(400), result(400)])?.schema).toEqual(without("inferred"));
    expect(next([result(400), result(200)])?.schema).toEqual(only("faceMeasurementEvidence"));
    expect(next([result(400), result(400), result(400)])).toBeNull();
    expect(next([result(200), result(200), result(200), result(200)])).toBeNull();
    expect(next([result(504)])).toBeNull();
    expect(next([{ ...result(200), completed: false }])).toBeNull();
    expect(safeProviderMessage("Invalid schema: api_key=private-token")).not.toContain("private-token");
  });
});

describe.skipIf(!process.env.PRIMARY_SCHEMA_ISOLATION_STEP)("adaptive primary schema isolation live", () => {
  it("sends one unique text-only request, records its sanitized outcome, never retries", async () => {
    const history = await records();
    const selected = next(history);
    expect(selected, "No authorized adaptive request remains").not.toBeNull();
    expect(selected!.id).toBe(process.env.PRIMARY_SCHEMA_ISOLATION_STEP);
    const key = process.env.GEMINI_API_KEY?.trim();
    expect(Boolean(key)).toBe(true);
    const { request, envelope: fullEnvelope, frozen } = await frozenRequest();
    const requestForCall = { ...request, responseSchema: selected!.schema };
    const envelope = buildGeminiStructuredRequestEnvelope(requestForCall);
    expect(envelope.shape.schema.valid).toBe(true);
    const restored = structuredClone(envelope.body) as Body;
    restored.generationConfig.responseJsonSchema = full();
    expect(sha(restored)).toBe(frozen.wireSha256);
    expect(restored).toEqual(fullEnvelope.body);
    expect(envelope.shape.imageParts).toBe(0);
    const wireHash = sha(envelope.body);
    expect(history.some(result => result.wireHash === wireHash)).toBe(false);
    expect(wireHash).not.toBe(frozen.wireSha256);
    const validate = new Ajv({ allErrors: true }).compile(selected!.schema);
    const result: Result = { id: selected!.id, slot: history.length + 1, delta: selected!.delta, wireHash, schemaHash: sha(selected!.schema), metrics: metrics(selected!.schema), schemaTopLevelKeys: Object.keys(selected!.schema.properties ?? {}), nonSchemaWireMatchesE: true, promptHash: sha(request.prompt), model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta", endpoint: frozen.endpoint, imageCount: 0, httpStatus: null, providerCode: null, providerStatus: null, providerMessage: null, jsonParse: null, schemaValidation: null, completed: false, attempted: false };
    const path = join(ROOT, `call-${history.length + 1}.json`);
    // Exclusive permanent budget slot, before any outbound I/O.
    await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (++calls !== 1) throw new Error("RETRY_FORBIDDEN");
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://generativelanguage.googleapis.com");
      expect(url.pathname).toBe(frozen.endpoint);
      expect(sha(JSON.parse(String(init?.body)))).toBe(wireHash);
      result.attempted = true;
      await writeFile(path, JSON.stringify(result, null, 2));
      const response = await originalFetch(input, init);
      result.httpStatus = response.status;
      const payload = await response.clone().json().catch(() => null);
      result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
      result.providerStatus = safeProviderMessage(payload?.error?.status, [key!]);
      result.providerMessage = safeProviderMessage(payload?.error?.message, [key!]);
      if (response.ok) {
        const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
        let parsed: unknown;
        try { parsed = JSON.parse(text); result.jsonParse = true; } catch { result.jsonParse = false; }
        result.schemaValidation = result.jsonParse === true && validate(parsed) === true;
        result.schemaErrorCount = validate.errors?.length ?? 0;
        result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
      }
      result.completed = true;
      await writeFile(path, JSON.stringify(result, null, 2));
      return response;
    });
    try {
      await generateGeminiStructuredJson({ GEMINI_API_KEY: key!, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env, requestForCall);
    } catch (error) {
      result.clientErrorName = error instanceof Error ? error.name : "unknown";
      result.clientMessage = safeProviderMessage(error instanceof Error ? error.message : null, [key!]);
    } finally {
      spy.mockRestore();
      result.completed = true;
      await writeFile(path, JSON.stringify(result, null, 2));
    }
    expect(calls).toBe(1);
    console.log(JSON.stringify(result));
  }, 60000);
});

describe.skipIf(process.env.PRIMARY_SCHEMA_H1_REMEASURE !== "1")("single authorized H1 remeasurement", () => {
  it("requires exact prior-H1 wire equality and dispatches once without retry or fallback", async () => {
    const outputRoot = resolve("evaluation-artifacts/primary-schema-h1-remeasure-20260909");
    await mkdir(outputRoot, { recursive: true });
    const previous = JSON.parse(await readFile(join(ROOT, "call-1.json"), "utf8"));
    expect(previous).toMatchObject({ id: "H1", httpStatus: 503, attempted: true, completed: true, imageCount: 0 });
    const e = JSON.parse(await readFile(join(BASE, "E.json"), "utf8"));
    const key = process.env.GEMINI_API_KEY?.trim();
    expect(Boolean(key)).toBe(true);
    const { request, frozen } = await frozenRequest();
    const schema = without("renderHints");
    const requestForCall = { ...request, responseSchema: schema };
    const envelope = buildGeminiStructuredRequestEnvelope(requestForCall);
    const body = envelope.body as Body;
    const generationConfig = body.generationConfig;
    const equality = {
      promptHash: sha(request.prompt) === previous.promptHash,
      schemaHash: sha(schema) === previous.schemaHash,
      schemaBytes: envelope.shape.schema.serializedBytes === previous.metrics.serializedBytes,
      propertyCount: envelope.shape.schema.propertyCount === previous.metrics.propertyCount,
      requiredCount: envelope.shape.schema.requiredCount === previous.metrics.requiredCount,
      maxDepth: envelope.shape.schema.depth === previous.metrics.depth,
      wireHash: sha(body) === previous.wireHash,
      model: request.model === previous.model,
      endpoint: frozen.endpoint === previous.endpoint,
      apiVersion: previous.apiVersion === "v1beta",
      temperature: generationConfig.temperature === e.sanitizedWire.generationConfig.temperature,
      thinkingConfig: JSON.stringify(generationConfig.thinkingConfig) === JSON.stringify(e.sanitizedWire.generationConfig.thinkingConfig),
      maxOutputTokens: generationConfig.maxOutputTokens === e.sanitizedWire.generationConfig.maxOutputTokens,
      responseMimeType: generationConfig.responseMimeType === e.sanitizedWire.generationConfig.responseMimeType,
      imageCount: envelope.shape.imageParts === 0,
    };
    expect(Object.values(equality).every(Boolean)).toBe(true);
    expect(envelope.shape.schema).toMatchObject({ serializedBytes: 6910, propertyCount: 94, requiredCount: 93, depth: 6 });
    expect(generationConfig).toMatchObject({ temperature: 0, thinkingConfig: { thinkingLevel: "LOW" }, maxOutputTokens: 8192, responseMimeType: "application/json" });
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const result: Record<string, unknown> = {
      id: "H1-remeasure", priorH1Artifact: "primary-schema-isolation-20260909/call-1.json",
      equality, wireHash: sha(body), promptHash: sha(request.prompt), schemaHash: sha(schema),
      metrics: metrics(schema), model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta",
      endpoint: frozen.endpoint, imageCount: 0, temperature: generationConfig.temperature,
      thinkingConfig: generationConfig.thinkingConfig, maxOutputTokens: generationConfig.maxOutputTokens,
      responseMimeType: generationConfig.responseMimeType, httpStatus: null, providerCode: null,
      providerStatus: null, providerMessage: null, jsonReturned: null, schemaValidation: null,
      attempted: false, completed: false,
    };
    const artifactPath = join(outputRoot, "result.json");
    await writeFile(artifactPath, JSON.stringify(result, null, 2), { flag: "wx" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (++calls !== 1) throw new Error("H1_REMEASURE_RETRY_FORBIDDEN");
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://generativelanguage.googleapis.com");
      expect(url.pathname).toBe(previous.endpoint);
      expect(sha(JSON.parse(String(init?.body)))).toBe(previous.wireHash);
      result.attempted = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
      const response = await originalFetch(input, init);
      result.httpStatus = response.status;
      const payload = await response.clone().json().catch(() => null);
      result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
      result.providerStatus = safeProviderMessage(payload?.error?.status, [key!]);
      result.providerMessage = safeProviderMessage(payload?.error?.message, [key!]);
      if (response.ok) {
        const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
        let parsed: unknown;
        try { parsed = JSON.parse(text); result.jsonReturned = true; }
        catch { result.jsonReturned = false; }
        result.schemaValidation = result.jsonReturned === true && validate(parsed) === true;
        result.schemaErrorCount = validate.errors?.length ?? 0;
        result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
      }
      result.completed = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
      return response;
    });
    try {
      await generateGeminiStructuredJson({ GEMINI_API_KEY: key!, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env, requestForCall);
    } catch (error) {
      result.clientErrorName = error instanceof Error ? error.name : "unknown";
      result.clientMessage = safeProviderMessage(error instanceof Error ? error.message : null, [key!]);
    } finally {
      spy.mockRestore();
      result.completed = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
    }
    expect(calls).toBe(1);
    console.log(JSON.stringify({ httpStatus: result.httpStatus, providerStatus: result.providerStatus, providerMessage: result.providerMessage, jsonReturned: result.jsonReturned, schemaValidation: result.schemaValidation }));
  }, 60000);
});

async function h2Preflight() {
  const productionSubtree = full().properties!.renderHints;
  const schema = only("renderHints");
  const previousH1 = JSON.parse(
    await readFile(join(ROOT, "call-1.json"), "utf8"),
  ) as Record<string, unknown>;
  const wrappedSubtree = schema.properties!.renderHints;
  expect(sha(wrappedSubtree)).toBe(sha(productionSubtree));
  expect(JSON.stringify(wrappedSubtree)).toBe(JSON.stringify(productionSubtree));
  expect(schema).toEqual({ type: "object", properties: { renderHints: productionSubtree }, required: ["renderHints"], additionalProperties: false });
  const { request, envelope: fullEnvelope, frozen } = await frozenRequest();
  const requestForCall = { ...request, responseSchema: schema };
  const envelope = buildGeminiStructuredRequestEnvelope(requestForCall);
  const restored = structuredClone(envelope.body) as Body;
  restored.generationConfig.responseJsonSchema = full();
  expect(sha(restored)).toBe(frozen.wireSha256);
  expect(restored).toEqual(fullEnvelope.body);
  const promptHash = sha(request.prompt);
  expect(promptHash).toBe(previousH1.promptHash);
  expect(previousH1).toMatchObject({
    id: "H1",
    model: MODEL,
    endpoint: frozen.endpoint,
    apiVersion: "v1beta",
  });
  expect(request.model).toBe(frozen.model);
  expect(frozen).toMatchObject({ endpoint: `/v1beta/models/${MODEL}:generateContent`, apiVersion: "v1beta", imageCount: 0 });
  expect(envelope.shape).toMatchObject({ apiFamily: "generateContent", apiVersion: "v1beta", imageParts: 0, temperature: 0, maxOutputTokens: 8192, responseMimeType: "application/json" });
  expect((envelope.body as Body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  const schemaMetrics = metrics(schema);
  expect(schemaMetrics).toMatchObject({ valid: true, propertyCount: 46, requiredCount: 46, depth: 3, enumCount: 45, enumValueCount: 198, objectCount: 2, descriptionBytes: 406 });
  return { schema, schemaMetrics, requestForCall, envelope, frozen, promptHash, subtreeHash: sha(productionSubtree) };
}

describe("H2 renderHints-only preflight", () => {
  it("keeps the production subtree byte-identical and every non-schema E wire field fixed", async () => {
    const outputRoot = resolve("evaluation-artifacts/primary-schema-h2-20260909");
    await mkdir(outputRoot, { recursive: true });
    const check = await h2Preflight();
    await writeFile(join(outputRoot, "offline.json"), JSON.stringify({
      passed: true, subtreeHash: check.subtreeHash, wrapperSchemaHash: sha(check.schema), metrics: check.schemaMetrics,
      promptHash: check.promptHash, fullEWireRestoration: true, model: MODEL,
      apiFamily: "generateContent", apiVersion: "v1beta", endpoint: check.frozen.endpoint,
      temperature: 0, thinkingConfig: { thinkingLevel: "LOW" }, maxOutputTokens: 8192,
      responseMimeType: "application/json", imageCount: 0,
    }, null, 2));
  });
});

describe.skipIf(process.env.PRIMARY_SCHEMA_H2_LIVE !== "1")("single authorized H2 renderHints-only canary", () => {
  it("dispatches exactly one preflighted request without retry or fallback", async () => {
    const outputRoot = resolve("evaluation-artifacts/primary-schema-h2-20260909");
    await mkdir(outputRoot, { recursive: true });
    const key = process.env.GEMINI_API_KEY?.trim();
    expect(Boolean(key)).toBe(true);
    const check = await h2Preflight();
    const validate = new Ajv({ allErrors: true }).compile(check.schema);
    const result: Record<string, unknown> = {
      id: "H2", subtree: "production PhotoAnalysis.renderHints byte-identical",
      subtreeHash: check.subtreeHash, wrapperSchemaHash: sha(check.schema), metrics: check.schemaMetrics,
      wireHash: sha(check.envelope.body), promptHash: check.promptHash,
      model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta", endpoint: check.frozen.endpoint,
      imageCount: 0, temperature: 0, thinkingConfig: { thinkingLevel: "LOW" }, maxOutputTokens: 8192,
      responseMimeType: "application/json", subtreeEquality: true, nonSchemaWireMatchesE: true,
      httpStatus: null, providerCode: null, providerStatus: null, providerMessage: null,
      jsonReturned: null, schemaValidation: null, attempted: false, completed: false,
    };
    const artifactPath = join(outputRoot, "result.json");
    await writeFile(artifactPath, JSON.stringify(result, null, 2), { flag: "wx" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (++calls !== 1) throw new Error("H2_RETRY_FORBIDDEN");
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://generativelanguage.googleapis.com");
      expect(url.pathname).toBe(check.frozen.endpoint);
      expect(sha(JSON.parse(String(init?.body)))).toBe(result.wireHash);
      result.attempted = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
      const response = await originalFetch(input, init);
      result.httpStatus = response.status;
      const payload = await response.clone().json().catch(() => null);
      result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
      result.providerStatus = safeProviderMessage(payload?.error?.status, [key!]);
      result.providerMessage = safeProviderMessage(payload?.error?.message, [key!]);
      if (response.ok) {
        const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
        let parsed: unknown;
        try { parsed = JSON.parse(text); result.jsonReturned = true; }
        catch { result.jsonReturned = false; }
        result.schemaValidation = result.jsonReturned === true && validate(parsed) === true;
        result.schemaErrorCount = validate.errors?.length ?? 0;
        result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
      }
      result.completed = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
      return response;
    });
    try {
      await generateGeminiStructuredJson({ GEMINI_API_KEY: key!, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env, check.requestForCall);
    } catch (error) {
      result.clientErrorName = error instanceof Error ? error.name : "unknown";
      result.clientMessage = safeProviderMessage(error instanceof Error ? error.message : null, [key!]);
    } finally {
      spy.mockRestore();
      result.completed = true;
      await writeFile(artifactPath, JSON.stringify(result, null, 2));
    }
    expect(calls).toBe(1);
    console.log(JSON.stringify({ httpStatus: result.httpStatus, providerStatus: result.providerStatus, providerMessage: result.providerMessage, jsonReturned: result.jsonReturned, schemaValidation: result.schemaValidation }));
  }, 60000);
});
