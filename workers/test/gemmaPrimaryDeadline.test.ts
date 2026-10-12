import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { priorGemmaTupleSchema } from "./historicalGemmaTuple";
import { runPhotoAnalysis } from "../src/analysis";
import { generateSkin } from "../src/generate";
import { withinDeadline } from "../src/deadline";
import { GEMMA_PRIMARY_TIMEOUT_MS, GeminiApiError, buildGeminiStructuredRequestEnvelope,
  generateGeminiStructuredJson, generateWorkersAiStructuredJson, workersAiStructuredInput,
  type GeminiStructuredRequest, type StructuredProviderAttempt } from "../src/gemini";
import type { Env } from "../src/types";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { withoutGemmaEvidenceReminder } from "./gemmaEvidencePromptSupport";
import { withoutGemmaSourceEvidenceReminder } from "./gemmaSourceEvidencePromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";

const model = "@cf/google/gemma-4-26b-a4b-it";
const payload = namedGemmaFixture(wireFixture(semanticFixture("plain")));
const image = "data:image/png;base64,AQID"; // synthetic unit-test input, no image/network access
const envFor = (run: ReturnType<typeof vi.fn>) => ({ GEMINI_API_KEY: "offline-test-key",
  VISION_MODEL: "gemini-3.8-flash", WORKERS_VISION_MODEL: model, GEMINI_STRUCTURED_TIMEOUT_MS: "45000",
  AI: { run } as unknown as Ai, MCSKIN_KV: { put: vi.fn(async () => {}) } as unknown as KVNamespace } as Env);
const request = (events: StructuredProviderAttempt[]) => ({ model: "gemini-3.8-flash", imageDataUrls: [],
  prompt: "offline test", responseSchema: { type: "object", properties: {} }, maxOutputTokens: 32,
  timeoutCapMs: 45_000, workersAiTimeoutCapMs: GEMMA_PRIMARY_TIMEOUT_MS,
  onProviderAttempt: (event: StructuredProviderAttempt) => events.push(event) });
async function started() { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: 503, status: "UNAVAILABLE",
    message: "offline provider unavailable" } }, { status: 503 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("finite primary Gemma deadline without retry or contract changes", () => {
  it("replays the observed 55,414ms boundary with the old and new local caps without changing either wire", async () => {
    expect(GEMMA_PRIMARY_TIMEOUT_MS).toBe(60000);
    const oldEvents: StructuredProviderAttempt[] = [], newEvents: StructuredProviderAttempt[] = [];
    const oldRequest = { ...request(oldEvents), workersAiTimeoutCapMs: 55000 };
    const newRequest = request(newEvents);
    expect(buildGeminiStructuredRequestEnvelope(oldRequest)).toEqual(buildGeminiStructuredRequestEnvelope(newRequest));
    expect(workersAiStructuredInput(oldRequest, model)).toEqual(workersAiStructuredInput(newRequest, model));
    const oldRun = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ response: payload }), 55414)));
    const oldPending = generateWorkersAiStructuredJson(envFor(oldRun), oldRequest);
    const rejected = expect(oldPending).rejects.toMatchObject({ status: 504, providerStatus: "DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(55000); await rejected;
    const savedEvents = JSON.stringify(oldEvents);
    await vi.advanceTimersByTimeAsync(414);
    expect(JSON.stringify(oldEvents)).toBe(savedEvents);
    const newRun = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ response: payload }), 55414)));
    const newPending = generateWorkersAiStructuredJson(envFor(newRun), newRequest);
    await vi.advanceTimersByTimeAsync(55414);
    await expect(newPending).resolves.toEqual({ response: payload });
    expect(newEvents.at(-1)).toMatchObject({ outcome: "completed", elapsedMs: 55414, deadlineTimerFired: false });
    expect(oldRun).toHaveBeenCalledOnce(); expect(newRun).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps finite sequential provider caps below the existing frontend request deadline", () => {
    const client = readFileSync("../src/lib/cloudflareAI.ts", "utf8");
    expect(client).toContain("const GENERATION_TIMEOUT_MS = 150_000;");
    // Upper bounds on provider waiting only; processing/KV overhead is not a guarantee.
    expect(45000 + GEMMA_PRIMARY_TIMEOUT_MS + 25000).toBe(130000);
    expect(150000 - (45000 + GEMMA_PRIMARY_TIMEOUT_MS + 25000)).toBe(20000);
  });

  it.each([1000, 46434, 49999, 51900, 54999, 55414, 59999])("accepts strict-valid primary completion at %i ms through the unchanged V3 path", async ms => {
    const run = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ response: payload }), ms)));
    const pending = runPhotoAnalysis(envFor(run), image);
    await started(); await vi.advanceTimersByTimeAsync(ms);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.providerAttempts?.at(-1)).toMatchObject({ provider: "workers_ai", outcome: "completed",
      configuredDeadlineMs: 60000, deadlineTimerFired: false, providerSchemaValidation: "passed", strictValidation: "passed" });
    if (result.ok) expect(result.analysis.renderHints).toEqual(semanticFixture("plain").renderHints);
    expect(fetch).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
    // Signal is deliberately not invented based on declarations alone.
    expect(run.mock.calls[0]).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails once at 60s and late fulfillment cannot mutate attempts, validation, or the public failure response", async () => {
    let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const env = envFor(run);
    const responseCallback = vi.fn();
    const pending = generateSkin(env, image).then(result => { responseCallback(result); return result; });
    await started(); await vi.advanceTimersByTimeAsync(60000);
    const response = await pending;
    expect(response).toMatchObject({ status: 503, success: false, body: { ok: false, errorCode: "provider_unavailable" } });
    const saved = JSON.stringify(response);
    const diagnostic = JSON.parse(String(vi.mocked(env.MCSKIN_KV.put).mock.calls[0]?.[1] ?? "null"));
    expect(diagnostic).toMatchObject({ ok: false, attempts: 2, providerAttempts: [
      expect.objectContaining({ provider: "gemini", outcome: "started", configuredDeadlineMs: 45000 }),
      expect.objectContaining({ provider: "gemini", outcome: "failed", fallbackEligible: true }),
      expect.objectContaining({ provider: "workers_ai", outcome: "started", configuredDeadlineMs: 60000 }),
      expect.objectContaining({ provider: "workers_ai", outcome: "failed", origin: "LOCAL_DEADLINE",
        deadlineTimerFired: true, configuredDeadlineMs: 60000, elapsedMs: 60000 }),
    ] });
    const kvCalls = vi.mocked(env.MCSKIN_KV.put).mock.calls.length;
    finish({ response: payload }); await vi.advanceTimersByTimeAsync(5000);
    expect(JSON.stringify(response)).toBe(saved);
    expect(vi.mocked(env.MCSKIN_KV.put).mock.calls).toHaveLength(kvCalls);
    expect(responseCallback).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a single local-deadline classification after a late binding rejection", async () => {
    let fail!: (e: Error) => void;
    const run = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    const events: StructuredProviderAttempt[] = [];
    const pending = generateWorkersAiStructuredJson(envFor(run), request(events));
    const failed = expect(pending).rejects.toMatchObject({ status: 504, providerStatus: "DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(60000); await failed;
    const before = JSON.stringify(events);
    fail(new Error("offline late rejection")); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(events)).toBe(before);
    expect(events.map(x => x.outcome)).toEqual(["started", "failed"]);
    expect(events.at(-1)?.origin).toBe("LOCAL_DEADLINE"); expect(run).toHaveBeenCalledOnce();
  });

  it("distinguishes an early binding-rejected 504 and clears its timer", async () => {
    const run = vi.fn(async () => { throw new GeminiApiError("offline binding failure", 504, "DEADLINE_EXCEEDED"); });
    const events: StructuredProviderAttempt[] = [];
    await expect(generateWorkersAiStructuredJson(envFor(run), request(events))).rejects.toMatchObject({ status: 504 });
    expect(events.at(-1)).toMatchObject({ origin: "BINDING_REJECTION", deadlineTimerFired: false,
      configuredDeadlineMs: 60000 });
    expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the Gemini 45s deadline and abort behavior intact before the sole eligible fallback", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal; return new Promise<Response>(() => {});
    }));
    const run = vi.fn(async () => ({ response: payload }));
    const pending = runPhotoAnalysis(envFor(run), image);
    await started(); await vi.advanceTimersByTimeAsync(45000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.providerAttempts?.[1]).toMatchObject({ provider: "gemini", origin: "LOCAL_DEADLINE",
      configuredDeadlineMs: 45000, deadlineTimerFired: true, fallbackEligible: true });
    expect(signal?.aborted).toBe(true); expect(run).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not broaden fallback eligibility for INVALID_ARGUMENT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT",
      message: "offline invalid request" } }, { status: 400 })));
    const run = vi.fn(); const events: StructuredProviderAttempt[] = [];
    await expect(generateGeminiStructuredJson(envFor(run), request(events))).rejects.toMatchObject({ status: 400 });
    expect(events.at(-1)).toMatchObject({ fallbackEligible: false, fallbackReason: "invalid_argument" });
    expect(run).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves geometry and other model caps instead of globally extending structured calls", async () => {
    const run = vi.fn(() => new Promise(() => {})); const events: StructuredProviderAttempt[] = [];
    const base: GeminiStructuredRequest = { ...request(events) }; delete base.workersAiTimeoutCapMs;
    const pending = generateWorkersAiStructuredJson(envFor(run), { ...base, timeoutCapMs: 25000,
      allowWorkersAiFallback: false });
    const failure = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(25000); await failure;
    expect(events.at(-1)).toMatchObject({ configuredDeadlineMs: 25000, origin: "LOCAL_DEADLINE" });
    events.length = 0;
    const other = generateWorkersAiStructuredJson({ ...envFor(run), WORKERS_VISION_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct" }, request(events));
    const otherFailure = expect(other).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(45000); await otherFailure;
    expect(events.at(-1)?.configuredDeadlineMs).toBe(45000);
  });

  it("keeps the V4 opt-in fallback at its existing 45s cap", async () => {
    const run = vi.fn(() => new Promise(() => {}));
    const pending = runPhotoAnalysis(envFor(run), image,
      { expectedContractVersion: "primary_compact_v4_structured_localization" });
    await started(); await vi.advanceTimersByTimeAsync(45000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.providerAttempts?.at(-1)).toMatchObject({ provider: "workers_ai", origin: "LOCAL_DEADLINE",
      configuredDeadlineMs: 45000, deadlineTimerFired: true });
    expect(run).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("hard-caps the explicit Gemma primary budget at 60s", async () => {
    const run = vi.fn(() => new Promise(() => {})); const events: StructuredProviderAttempt[] = [];
    const pending = generateWorkersAiStructuredJson(envFor(run), { ...request(events), workersAiTimeoutCapMs: 180000 });
    const failure = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(60000); await failure;
    expect(events.at(-1)).toMatchObject({ configuredDeadlineMs: 60000, origin: "LOCAL_DEADLINE" });
    expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not put either deadline in the Gemini or Gemma provider wire", () => {
    const current = request([]); const old: GeminiStructuredRequest = { ...current }; delete old.workersAiTimeoutCapMs;
    expect(buildGeminiStructuredRequestEnvelope(current)).toEqual(buildGeminiStructuredRequestEnvelope(old));
    expect(workersAiStructuredInput(current, model)).toEqual(workersAiStructuredInput(old, model));
    expect(JSON.stringify(workersAiStructuredInput(current, model))).not.toMatch(/Timeout|timeout|55000|60000/);
  });

  it("preserves the consumed D012 Gemini and Gemma prompt/schema hashes", async () => {
    const bytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-012/summary.json");
    const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(hash(bytes)).toBe("082609a45cfcc66c6cddf2ccdac04b2189288b366820ce5313c9c369e0bccead");
    const contract = JSON.parse(bytes.toString()).currentDefaultE2E.contract;
    const compact = await import("../src/compactPhotoAnalysisV3");
    const gemma = await import("../src/gemmaPhotoAnalysis");
    const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
    expect(hash(JSON.stringify(compact.COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(contract.geminiSchemaSha256);
    expect(hash(compact.COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix)).toBe(contract.geminiPromptSha256);
    expect(hash(JSON.stringify(gemma.GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA))).toBe(contract.gemmaSchemaSha256);
    expect(hash(gemma.GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix)).toBe(contract.gemmaPromptSha256);
    expect(contract).toMatchObject({ primaryTimeoutMs: 45000, gemmaPrimaryTimeoutMs: 55000,
      geometryTimeoutMs: 25000, version: "primary_compact_v3_legacy_suffix" });
  });

  it("isolates the historical timeout contract from later reviewed prompt instructions and verifies current live hashes", async () => {
    const stored = JSON.parse(readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-007/summary.json", "utf8"));
    const contract = stored.currentDefaultE2E.contract;
    const compact = await import("../src/compactPhotoAnalysisV3");
    const gemma = await import("../src/gemmaPhotoAnalysis");
    const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
    const hash = (v: string) => createHash("sha256").update(v).digest("hex");
    expect(hash(JSON.stringify(compact.COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(contract.geminiSchemaSha256);
    expect(hash(withoutTiedHairObservation(compact.COMPACT_PHOTO_ANALYSIS_V3_PROMPT) + suffix)).toBe(contract.geminiPromptSha256);
    expect(hash(JSON.stringify(priorGemmaTupleSchema()))).toBe(contract.gemmaSchemaSha256);
    // Later, independently tested instruction reinforcement is not a timeout wire delta.
    expect(hash(withoutGemmaEvidenceReminder(withoutTiedHairObservation(gemma.GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)) + suffix)).toBe(contract.gemmaPromptSha256);
    // Pin H-005 after reversing only the later source-evidence reminder.
    // Its exact H-007 inverse is independently verified in the new prompt test.
    const current = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-005/summary.json", "utf8")).currentDefaultE2E.contract;
    expect(hash(compact.COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix)).toBe(current.geminiPromptSha256);
    expect(hash(withoutGemmaSourceEvidenceReminder(gemma.GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT) + suffix)).toBe(current.gemmaPromptSha256);
    expect(hash(JSON.stringify(compact.COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(current.geminiSchemaSha256);
    expect(hash(JSON.stringify(priorGemmaTupleSchema()))).toBe(current.gemmaSchemaSha256);
  });

  it("clears the deadline timer on a synchronous operation rejection without aborting or retrying", async () => {
    const operation = vi.fn(() => { throw new Error("offline operation failure"); });
    const abort = vi.fn();
    await expect(withinDeadline(operation, 50000, () => new Error("deadline"), abort)).rejects.toThrow("offline operation failure");
    expect(operation).toHaveBeenCalledOnce(); expect(abort).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
