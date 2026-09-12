import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA, extractJson, validatePhotoAnalysis } from "../src/analysis";
import { buildGeminiStructuredRequestEnvelope, generateGeminiStructuredJson } from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";
import { safeProviderMessage } from "./primaryTransportSupport";

const MODEL = "gemini-3.6-flash";
const ROOT = resolve("evaluation-artifacts/primary-wire-contract-20260908");
const TINY = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const IDS = ["A", "B", "C", "D", "E", "F", "G"] as const;
type Id = typeof IDS[number];
type Body = { contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>; generationConfig: Record<string, unknown> };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Single-subtree candidate, NOT a production edit. All existing cache keys stay
// optional; values retain their existing types, and other properties stay open.
const CACHE_PROPERTIES = Object.fromEntries(Object.entries(makeAnalysis().fallbackFeatures)
  .map(([key, value]) => [key, { type: typeof value }]));
function candidateSchema() {
  return { ...PHOTO_ANALYSIS_SCHEMA, properties: { ...PHOTO_ANALYSIS_SCHEMA.properties,
    fallbackFeatures: { ...PHOTO_ANALYSIS_SCHEMA.properties.fallbackFeatures, properties: CACHE_PROPERTIES },
  } };
}

// Historical rich wire only. Production now uses Compact v3; never recapture
// this experiment through the active caller or overwrite its saved evidence.
async function capturePrimary(dataUrl: string): Promise<Body> {
  return buildGeminiStructuredRequestEnvelope({
    model: MODEL, imageDataUrls: [dataUrl],
    prompt: `${ANALYSIS_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`,
    responseSchema: PHOTO_ANALYSIS_SCHEMA, maxOutputTokens: 8192,
    allowWorkersAiFallback: false,
  }).body as Body;
}

function requestFor(id: Id, primary: Body, dataUrl: string) {
  return {
    model: MODEL,
    imageDataUrls: ["C", "D", "F"].includes(id) ? [dataUrl] : [],
    prompt: primary.contents[0].parts.at(-1)!.text!,
    responseSchema: id === "G" ? candidateSchema() : ["E", "F"].includes(id) ? PHOTO_ANALYSIS_SCHEMA : TINY,
    maxOutputTokens: Number(primary.generationConfig.maxOutputTokens),
    allowWorkersAiFallback: false,
  };
}

// Test-only ablation at the real fetch boundary; no alternate client or API family.
function wireFor(id: Id, original: Body): Body {
  const body = structuredClone(original);
  if (id === "A" || id === "C") {
    delete body.generationConfig.responseJsonSchema;
    delete body.generationConfig.responseMimeType;
  }
  return body;
}

function sanitizedBody(body: Body) {
  return {
    contents: body.contents.map(content => ({ role: content.role, parts: content.parts.map(part => part.inlineData ? {
      inlineData: { mimeType: part.inlineData.mimeType, data: "[redacted-image]", rawBytes: Buffer.from(part.inlineData.data, "base64").length },
    } : { text: "[prompt omitted]", textBytes: Buffer.byteLength(part.text ?? ""), textSha256: sha(part.text) }) })),
    generationConfig: body.generationConfig,
  };
}

async function assertFrozenGDelta(wire: Body) {
  const frozenE = JSON.parse(await readFile(join(ROOT, "E.json"), "utf8"));
  const restored = structuredClone(wire);
  const cache = (restored.generationConfig.responseJsonSchema as { properties: { fallbackFeatures: { properties?: unknown } } }).properties.fallbackFeatures;
  const source = await readFile(resolve("src/analysis.ts"), "utf8");
  const declaration = source.match(/export interface FallbackFeatures \{([^}]+)\}/)?.[1] ?? "";
  const contract = Object.fromEntries([...declaration.matchAll(/(\w+): (string|boolean);/g)].map(match => [match[1], { type: match[2] }]));
  expect(Object.keys(contract)).toHaveLength(19);
  expect(cache.properties).toEqual(contract);
  delete cache.properties;
  // Match the actual saved E, not just today's reconstruction of production.
  expect(sha(restored)).toBe(frozenE.wireSha256);
  expect(sanitizedBody(restored)).toEqual(frozenE.sanitizedWire);
  expect(Buffer.byteLength(JSON.stringify(restored))).toBe(frozenE.serializedBytes);
  expect(wire.contents.every(content => content.parts.every(part => !part.inlineData))).toBe(true);
  expect(frozenE).toMatchObject({ model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta", endpoint: `/v1beta/models/${MODEL}:generateContent`, imageCount: 0 });
  return { passed: true, changedPath: "generationConfig.responseJsonSchema.properties.fallbackFeatures.properties", propertyCount: 19, restoredWireSha256: sha(restored) };
}

afterEach(() => vi.restoreAllMocks());

describe("primary GenerateContent wire contract (offline)", () => {
  it("asserts G differs from the actual frozen E only in the existing 19 cache property types", async () => {
    const primary = await capturePrimary("data:image/jpeg;base64,/9j/2Q==");
    const wire = buildGeminiStructuredRequestEnvelope(requestFor("G", primary, "")).body as Body;
    const delta = await assertFrozenGDelta(wire);
    const validator = new Ajv({ allErrors: true }).compile(candidateSchema());
    expect(typeof validator).toBe("function");
    expect(validator({})).toBe(false);
    await writeFile(join(ROOT, "G-offline-delta.json"), JSON.stringify(delta, null, 2));
  });
  it("captures the real primary path and changes only image or schema along controlled branches", async () => {
    const data = "data:image/jpeg;base64,/9j/2Q==";
    const primary = await capturePrimary(data);
    const bodies = Object.fromEntries(IDS.map(id => [id, wireFor(id, buildGeminiStructuredRequestEnvelope(requestFor(id, primary, data)).body as Body)])) as Record<Id, Body>;
    expect(bodies.F).toEqual(primary);
    expect(bodies.A.contents).toEqual(bodies.B.contents);
    expect(bodies.C.contents).toEqual(bodies.D.contents);
    expect(bodies.B.contents).toEqual(bodies.E.contents);
    expect(bodies.A.generationConfig).toEqual(bodies.C.generationConfig);
    expect(bodies.B.generationConfig).toEqual(bodies.D.generationConfig);
    expect(bodies.E.generationConfig).toEqual(bodies.F.generationConfig);
    const candidate = structuredClone(bodies.G);
    delete ((candidate.generationConfig.responseJsonSchema as typeof PHOTO_ANALYSIS_SCHEMA).properties.fallbackFeatures as { properties?: unknown }).properties;
    expect(candidate).toEqual(bodies.E);
    expect(bodies.F.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: PHOTO_ANALYSIS_SCHEMA });
    expect(bodies.F.generationConfig).not.toHaveProperty("responseSchema");
    expect(bodies.F).not.toHaveProperty("response_format");
    const image = bodies.F.contents[0].parts.find(p => p.inlineData)?.inlineData;
    expect(image).toEqual({ mimeType: "image/jpeg", data: "/9j/2Q==" });
    expect(buildGeminiStructuredRequestEnvelope(requestFor("F", primary, data)).shape.imageMagicMatchesMime).toEqual([true]);
    expect(JSON.stringify(sanitizedBody(primary))).not.toContain("/9j/2Q==");
    expect(inspectGeminiResponseSchema(PHOTO_ANALYSIS_SCHEMA)).toMatchObject({ valid: true, unsupportedConstructs: [], undefinedPaths: [] });
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline-envelope.json"), JSON.stringify({ body: sanitizedBody(primary), schema: inspectGeminiResponseSchema(PHOTO_ANALYSIS_SCHEMA) }, null, 2));
  });

  it("preserves invalid-field messages but redacts keys, headers, images and long raw payloads", () => {
    const message = "Invalid generationConfig.thinkingConfig.thinkingLevel";
    expect(safeProviderMessage(message)).toBe(message);
    const unsafe = `${message} secret-test-key data:image/png;base64,AAAA Authorization: Bearer private-token\n${"a".repeat(100)}`;
    const safe = safeProviderMessage(unsafe, ["secret-test-key"])!;
    expect(safe).toContain(message);
    for (const secret of ["secret-test-key", "AAAA", "private-token", "a".repeat(100)]) expect(safe).not.toContain(secret);
    expect(safeProviderMessage({ message })).toBeNull();
    expect(safeProviderMessage("x ".repeat(2000))!.length).toBe(2000);
  });

  it("audits full schema subtrees offline without inventing a provider complexity limit", async () => {
    const findings = { unconstrainedObjects: [] as string[], nullable: [] as string[], enumTypeMismatch: [] as string[], refs: [] as string[], unions: [] as string[] };
    const visit = (node: Record<string, unknown>, path: string): void => {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.includes("null")) findings.nullable.push(path);
      if (types.includes("object") && !node.properties && node.additionalProperties === undefined) findings.unconstrainedObjects.push(path);
      if (node.$ref) findings.refs.push(path);
      if (node.anyOf || node.oneOf) findings.unions.push(path);
      if (Array.isArray(node.enum)) for (const value of node.enum) {
        const type = value === null ? "null" : typeof value;
        if (!types.includes(type) && !(type === "number" && types.includes("integer") && Number.isInteger(value))) findings.enumTypeMismatch.push(path);
      }
      for (const [name, child] of Object.entries((node.properties ?? {}) as Record<string, Record<string, unknown>>)) visit(child, `${path}.${name}`);
      if (node.items && typeof node.items === "object") visit(node.items as Record<string, unknown>, `${path}[]`);
    };
    visit(PHOTO_ANALYSIS_SCHEMA, "$schema");
    expect(findings.enumTypeMismatch).toEqual([]);
    expect(findings.refs).toEqual([]);
    expect(findings.unions).toEqual([]);
    expect(findings.unconstrainedObjects).toEqual(["$schema.fallbackFeatures"]);
    const subtrees = Object.fromEntries(Object.entries(PHOTO_ANALYSIS_SCHEMA.properties).map(([name, schema]) => [name, inspectGeminiResponseSchema(schema)]));
    for (const metrics of Object.values(subtrees)) expect(metrics.valid).toBe(true);
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, "offline-subtree-audit.json"), JSON.stringify({ findings, subtrees,
      provenBoundary: "B tiny schema HTTP200 versus E full schema HTTP400; same text/config/model/endpoint",
      exactFailingField: "not proven", candidate: "Declare existing optional fallbackFeatures property types; requires explicit authorization for live G",
      candidateSchema: candidateSchema(), candidateMetrics: inspectGeminiResponseSchema(candidateSchema()),
      note: "Open object is valid JSON Schema; its compatibility with this provider is a hypothesis, not a proven unsupported keyword. Null enum is type-consistent. No subtree has been live-tested separately.",
    }, null, 2));
  });
});

describe.skipIf(!process.env.PRIMARY_WIRE_CANARY)("bounded primary GenerateContent live canary", () => {
  it("dispatches exactly one unique authorized request and checkpoints only sanitized diagnostics", async () => {
    const id = process.env.PRIMARY_WIRE_CANARY as Id;
    expect(IDS).toContain(id);
    const key = process.env.GEMINI_API_KEY?.trim();
    expect(Boolean(key)).toBe(true);
    await mkdir(ROOT, { recursive: true });
    const prerequisites: Record<Id, Id[]> = { A: [], B: ["A"], C: ["A"], D: ["B", "C"], E: ["B", "D"], F: ["A", "B", "C", "D", "E"], G: ["A", "B", "C", "D"] };
    for (const prior of prerequisites[id]) {
      const result = JSON.parse(await readFile(join(ROOT, `${prior}.json`), "utf8"));
      expect(result.httpStatus).toBe(200);
      expect(result.responseAccepted).toBe(true);
    }
    if (id === "G") {
      expect(process.env.PRIMARY_WIRE_AUTHORIZE_CACHE_CANARY, "G requires explicit user approval after auto-review rejection").toBe("1");
      const failed = JSON.parse(await readFile(join(ROOT, "E.json"), "utf8"));
      expect(failed.httpStatus).toBe(400);
    }
    const manifest = JSON.parse(await readFile(resolve("evaluation-artifacts/generalization-20260905/annotations.json"), "utf8")) as Array<{ existing?: boolean; photoId?: number }>;
    const photoId = manifest.find(photo => !photo.existing)?.photoId;
    expect(typeof photoId).toBe("number");
    const bytes = await readFile(resolve(`evaluation-artifacts/generalization-20260905/sources/${photoId}.jpg`));
    expect(Array.from(bytes.subarray(0, 3))).toEqual([255, 216, 255]);
    const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const primary = await capturePrimary(dataUrl);
    const request = requestFor(id, primary, dataUrl);
    const envelope = buildGeminiStructuredRequestEnvelope(request);
    const wire = wireFor(id, envelope.body as Body);
    if (id === "F") expect(wire).toEqual(primary);
    const deltaAssertion = id === "G" ? await assertFrozenGDelta(wire) : null;
    const validateWireResponse = id === "G" ? new Ajv({ allErrors: true }).compile(candidateSchema()) : null;
    const result: Record<string, unknown> = {
      deltaAssertion,
      callId: id, parent: ({ A: null, B: "A", C: "A", D: "C", E: "B", F: "E", G: "E" } as const)[id],
      delta: ({ A: "baseline no schema/no image", B: "add tiny schema+required MIME pair", C: "add frozen JPEG", D: "add tiny schema+required MIME pair", E: "replace tiny with full production schema", F: "add same frozen JPEG; exact primary envelope", G: "only add existing optional fallbackFeatures property types; no other schema or envelope changes" } as const)[id],
      apiFamily: "generateContent", apiVersion: "v1beta", model: MODEL,
      route: "direct Google (no Cloudflare AI binding in local harness)",
      imageCount: request.imageDataUrls.length, imageMime: envelope.shape.imageMimeTypes,
      imageBytes: envelope.shape.imageRawBytes, imageMagicMatchesMime: envelope.shape.imageMagicMatchesMime,
      textBytes: envelope.shape.promptBytes,
      schema: id === "A" || id === "C" ? null : envelope.shape.schema,
      serializedBytes: Buffer.byteLength(JSON.stringify(wire)), wireSha256: sha(wire),
      sanitizedWire: sanitizedBody(wire), httpStatus: null, providerCode: null, providerStatus: null,
      providerMessage: null, responseAccepted: false, attempted: true, completed: false,
      strictJsonParse: null, responseSchemaValidation: null, photoAnalysisValidation: null,
    };
    // F and G share the last budget slot: exactly six possible real dispatches.
    if (id === "F" || id === "G") await writeFile(join(ROOT, "final-call-claim.json"), JSON.stringify({ callId: id }), { flag: "wx" });
    // Exclusive permanent claim BEFORE dispatch; never reuse a claimed ID.
    await writeFile(join(ROOT, `${id}.json`), JSON.stringify(result, null, 2), { flag: "wx" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let rawAnalysis: Record<string, unknown> | null = null;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (++calls > 1) throw new Error("LIVE_RETRY_FORBIDDEN");
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://generativelanguage.googleapis.com");
      expect(url.pathname).toBe(`/v1beta/models/${MODEL}:generateContent`);
      expect(JSON.parse(String(init?.body))).toEqual(envelope.body);
      result.endpoint = url.pathname;
      const response = await originalFetch(input, { ...init, body: JSON.stringify(wire) });
      result.httpStatus = response.status;
      const payload = await response.clone().json().catch(() => null);
      result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
      result.providerStatus = safeProviderMessage(payload?.error?.status, [key!]);
      result.providerMessage = safeProviderMessage(payload?.error?.message, [key!]);
      if (response.ok) {
        const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        rawAnalysis = extractJson(text);
        result.responseAccepted = id === "A" || id === "C" ? text.trim().length > 0
          : id === "B" || id === "D" ? typeof rawAnalysis?.ok === "boolean" : rawAnalysis !== null;
        result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        if (id === "G") {
          let parsed: unknown;
          try { parsed = JSON.parse(text); result.strictJsonParse = true; }
          catch { result.strictJsonParse = false; }
          result.responseSchemaValidation = result.strictJsonParse === true && validateWireResponse!(parsed) === true;
          result.responseSchemaErrorCount = validateWireResponse!.errors?.length ?? 0;
          result.photoAnalysisValidation = validatePhotoAnalysis(parsed).ok;
          result.responseAccepted = result.responseSchemaValidation;
        }
        if (id === "F") {
          const validated = validatePhotoAnalysis(rawAnalysis);
          result.photoAnalysisValidation = validated.ok;
          const block = rawAnalysis?.faceMeasurementEvidence as Record<string, unknown> | undefined;
          result.faceMeasurementEvidenceReturned = Boolean(block);
          result.referenceImageIndex = typeof block?.referenceImageIndex === "number" ? block.referenceImageIndex : null;
        }
      }
      // Persist immediately after provider reply, before application parsing can throw.
      result.completed = true;
      await writeFile(join(ROOT, `${id}.json`), JSON.stringify(result, null, 2));
      return response;
    });
    try {
      await generateGeminiStructuredJson({ GEMINI_API_KEY: key!, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env, request);
    } catch (error) {
      result.clientErrorName = error instanceof Error ? error.name : "unknown";
      result.clientMessage = safeProviderMessage(error instanceof Error ? error.message : null, [key!]);
    } finally {
      spy.mockRestore();
      result.completed = true;
      await writeFile(join(ROOT, `${id}.json`), JSON.stringify(result, null, 2));
    }
    expect(calls).toBe(1);
    console.log(JSON.stringify({ callId: id, httpStatus: result.httpStatus, providerCode: result.providerCode, providerStatus: result.providerStatus, providerMessage: result.providerMessage, responseAccepted: result.responseAccepted }));
  }, 60000);
});
