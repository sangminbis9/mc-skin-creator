import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiApiError, generateGeminiStructuredJson, generateWorkersAiStructuredJson,
  type StructuredProviderAttempt } from "../src/gemini";
import type { Env } from "../src/types";
import { attemptsOf } from "./primaryFaceMeasurementAuditWorker";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const request = (events: StructuredProviderAttempt[]) => ({
  model: "gemini-test",
  imageDataUrls: [] as string[],
  prompt: "offline test",
  responseSchema: { type: "object", properties: {} },
  maxOutputTokens: 32,
  timeoutCapMs: 45_000,
  onProviderAttempt: (event: StructuredProviderAttempt) => events.push(event),
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("primary timeout origin trace", () => {
  it("marks a local Workers AI deadline even if the binding later fulfills", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const events: StructuredProviderAttempt[] = [];
    const pending = generateWorkersAiStructuredJson({ AI: { run } as unknown as Ai } as Env, request(events));
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, providerStatus: "DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(run).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ provider: "workers_ai", outcome: "failed", status: 504,
      providerStatus: "DEADLINE_EXCEEDED",
      origin: "LOCAL_DEADLINE", deadlineTimerFired: true, configuredDeadlineMs: 45_000, attemptOrdinal: 1 });
    expect(events.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(45_000);
    finish({ response: "{}" });
    await Promise.resolve();
    expect(events.map(event => event.outcome)).toEqual(["started", "failed"]);
  });

  it("keeps the same binding-rejected 504 separate from a local timer", async () => {
    vi.useFakeTimers();
    const events: StructuredProviderAttempt[] = [];
    const run = vi.fn(async () => { throw new GeminiApiError("safe binding error", 504, "DEADLINE_EXCEEDED"); });
    await expect(generateWorkersAiStructuredJson({ AI: { run } as unknown as Ai } as Env, request(events)))
      .rejects.toMatchObject({ status: 504, providerStatus: "DEADLINE_EXCEEDED" });
    expect(events.at(-1)).toMatchObject({ outcome: "failed", status: 504,
      providerStatus: "DEADLINE_EXCEEDED",
      origin: "BINDING_REJECTION", deadlineTimerFired: false, configuredDeadlineMs: 45_000 });
    expect(events.at(-1)?.elapsedMs).toBeLessThan(45_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late binding rejection after the local timeout winner", async () => {
    vi.useFakeTimers();
    let fail!: (reason: Error) => void;
    const events: StructuredProviderAttempt[] = [];
    const run = vi.fn(() => new Promise<unknown>((_resolve, reject) => { fail = reject; }));
    const pending = generateWorkersAiStructuredJson({ AI: { run } as unknown as Ai } as Env, request(events));
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    fail(new Error("late private provider prose"));
    await Promise.resolve();
    expect(events.map(event => event.outcome)).toEqual(["started", "failed"]);
    expect(events.at(-1)?.origin).toBe("LOCAL_DEADLINE");
  });

  it("traces the Gemini local timer without changing its abort or fallback policy", async () => {
    vi.useFakeTimers();
    const events: StructuredProviderAttempt[] = [];
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }));
    const pending = generateGeminiStructuredJson({ GEMINI_API_KEY: "offline-test-key" } as Env,
      { ...request(events), timeoutCapMs: 10, allowWorkersAiFallback: false });
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, providerStatus: "DEADLINE_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ provider: "gemini", outcome: "failed",
      origin: "LOCAL_DEADLINE", deadlineTimerFired: true, fallbackEligible: false });
  });

  it("preserves eligible fallback order and rejects ineligible Gemini errors", async () => {
    const events: StructuredProviderAttempt[] = [];
    const run = vi.fn(async () => ({ response: "{}" }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      code: 400, status: "FAILED_PRECONDITION", message: "safe location error",
    } }, { status: 400 })));
    await generateGeminiStructuredJson({ GEMINI_API_KEY: "offline-test-key", AI: { run } as unknown as Ai } as Env,
      { ...request(events), timeoutCapMs: 100 });
    expect(events.map(event => [event.provider, event.outcome, event.attemptOrdinal])).toEqual([
      ["gemini", "started", 1], ["gemini", "failed", 1],
      ["workers_ai", "started", 2], ["workers_ai", "completed", 2],
    ]);
    expect(events[1]).toMatchObject({ fallbackEligible: true, fallbackReason: "provider_failed_precondition" });
    expect(run).toHaveBeenCalledOnce();

    events.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      code: 400, status: "INVALID_ARGUMENT", message: "safe invalid request",
    } }, { status: 400 })));
    await expect(generateGeminiStructuredJson({ GEMINI_API_KEY: "offline-test-key", AI: { run } as unknown as Ai } as Env,
      { ...request(events), timeoutCapMs: 100 })).rejects.toMatchObject({ status: 400 });
    expect(events.map(event => event.provider)).toEqual(["gemini", "gemini"]);
    expect(events.at(-1)).toMatchObject({ fallbackEligible: false, fallbackReason: "invalid_argument" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("records a successful binding attempt without inventing a failure origin", async () => {
    const events: StructuredProviderAttempt[] = [];
    const result = await generateWorkersAiStructuredJson({ AI: {
      run: vi.fn(async () => ({ response: "{}" })),
    } as unknown as Ai } as Env, request(events));
    expect(result).toEqual({ response: "{}" });
    expect(events.at(-1)).toMatchObject({ outcome: "completed", deadlineTimerFired: false });
    expect(events.at(-1)?.origin).toBeUndefined();
  });

  it("audit projection retains only the fixed safe allowlist", () => {
    const projected = attemptsOf([{ provider: "workers_ai", model: "safe-model", outcome: "failed",
      traceVersion: 1, providerAttemptKind: "workers_ai_binding", attemptOrdinal: 2,
      origin: "LOCAL_DEADLINE", elapsedMs: 45_000, configuredDeadlineMs: 45_000,
      deadlineTimerFired: true, status: 504, providerStatus: "DEADLINE_EXCEEDED",
      message: "PRIVATE_PROVIDER_RESPONSE", outputDiagnostic: { resultType: "secret" } as never,
    }]);
    expect(projected[0]).toMatchObject({ origin: "LOCAL_DEADLINE", deadlineTimerFired: true,
      elapsedMs: 45_000, configuredDeadlineMs: 45_000, httpStatus: 504 });
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_PROVIDER_RESPONSE|secret|message|outputDiagnostic/);
  });

  it("persists the fixed trace through the existing versioned checkpoint reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "primary-timeout-trace-"));
    await mkdir(root, { recursive: true });
    const path = join(root, "summary.json");
    const sequence = attemptsOf([{ provider: "workers_ai", model: "safe-model", outcome: "failed",
      traceVersion: 1, providerAttemptKind: "workers_ai_binding", attemptOrdinal: 2,
      origin: "LOCAL_DEADLINE", elapsedMs: 45_000, configuredDeadlineMs: 45_000,
      deadlineTimerFired: true, status: 504, providerStatus: "DEADLINE_EXCEEDED",
      message: "PRIVATE_PROVIDER_RESPONSE",
    }]);
    const snapshot = { primary: { primaryElapsedMs: 46_216, geminiElapsedMs: 1000,
      gemmaElapsedMs: 45_000, providerSequence: sequence } };
    await atomicCheckpoint(path, snapshot, "primary_completed");
    const restored = await readLatestAuditCheckpoint(path);
    expect(restored?.snapshot).toEqual(snapshot);
    expect(JSON.stringify(restored)).not.toContain("PRIVATE_PROVIDER_RESPONSE");
  });

  it.skipIf(!process.env.PRIMARY_TIMEOUT_TRACE_ARTIFACT_ROOT)("recovers the live trace from its authoritative checkpoint", async () => {
    const path = join(process.env.PRIMARY_TIMEOUT_TRACE_ARTIFACT_ROOT!, "summary.json");
    const restored = await readLatestAuditCheckpoint(path);
    expect(restored?.event).toBe("finalCheckpoint");
    expect(restored?.snapshotSha256).toBe(createHash("sha256")
      .update(JSON.stringify(restored?.snapshot)).digest("hex"));
    const snapshot = restored?.snapshot as { primary?: { providerSequence?: Array<Record<string, unknown>> } };
    expect(snapshot.primary?.providerSequence?.every(attempt => attempt.traceVersion === 1)).toBe(true);
  });
});
