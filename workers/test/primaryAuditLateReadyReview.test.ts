// Offline review of the EXISTING runner's actual timer/q code. The runner is
// read as source, never imported, spawned or supplied real bindings/credentials.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { AuditShutdownLatch } from "./auditShutdownLatch";

afterEach(() => { vi.useRealTimers(); });
const source = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
function actualBlocks(corruptRecovery = false) {
  const boundedStart = source.indexOf("async function bounded<T>");
  const boundedEnd = source.indexOf('\nit("derived audit config', boundedStart);
  const finallyStart = source.indexOf("    shutdownLatch.beginShutdown();");
  const qStart = finallyStart;
  const qEnd = source.indexOf("    if (owner && exitPromise && closePromise)", qStart);
  const latchStart = source.indexOf("  const shutdownLatch = new AuditShutdownLatch({");
  const latchEnd = source.indexOf("  let exitPromise:", latchStart);
  const eventsStart = source.indexOf('    owner.on("message", raw => {');
  const eventsEnd = source.indexOf("    const startup =", eventsStart);
  const recoveryStart = source.indexOf('    try {\n    observe("finalCheckpoint")');
  const recoveryEnd = source.indexOf("\n  }\n  if (finalizationFailure)", recoveryStart);
  expect(boundedStart).toBeGreaterThan(0); expect(boundedEnd).toBeGreaterThan(boundedStart);
  expect(finallyStart).toBeGreaterThan(0); expect(qEnd).toBeGreaterThan(qStart);
  expect(latchEnd).toBeGreaterThan(latchStart); expect(eventsEnd).toBeGreaterThan(eventsStart);
  expect(recoveryEnd).toBeGreaterThan(recoveryStart);
  const compiled = transpileModule(`${source.slice(boundedStart, boundedEnd)}
    ${source.slice(latchStart, latchEnd)}
    ${source.slice(eventsStart, eventsEnd)}
    async function shutdownOnce() { ${source.slice(qStart, qEnd)} }
    async function finalizeCapture() {
      shutdownLatch.beginFinalization(); ${source.slice(recoveryStart, recoveryEnd)}
    }`, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
  }).outputText;
  let onMessage!: (raw: unknown) => void;
  let saved: { event: string; snapshotSha256: string; snapshot: unknown } | null = null;
  const hash = (input: string) => createHash("sha256").update(input).digest("hex");
  const observe = vi.fn(async (event: string) => {
    context.artifact.shutdownLatch = actualLatch.snapshot();
    const snapshot = structuredClone(context.artifact);
    saved = { event, snapshot, snapshotSha256: hash(JSON.stringify(snapshot)) };
  });
  const context = { artifact: { hotkeyRegistrationProven: false, shutdownRequested: false,
      shutdownLatch: null as ReturnType<AuditShutdownLatch["snapshot"]> | null,
      currentDefaultE2E: { fixedHashes: {}, diskRecovery: false }, cleanupFailed: false, classification: "offline" },
    owner: { send: vi.fn(), on: (_event: string, listener: (raw: unknown) => void) => { onMessage = listener; } },
    ownerExited: false, AuditShutdownLatch, observe, expect, hash, fs,
    writes: Promise.resolve(), finalizationFailure: null as unknown, checkpoint: "offline_fake_not_a_path",
    readLatestAuditCheckpoint: async () => corruptRecovery && saved?.event === "finalCheckpoint"
      ? { ...saved, snapshotSha256: "offline_tampered" } : saved,
    RUN_CURRENT_SOURCE_V4: false, RUN_CURRENT_DEFAULT_E2E: true, RUN_EYE_APERTURE: false,
    RUN_EYE_APERTURE_V2: false, RUN_SAVED_V4_FACE_GEOMETRY: false, RUN_V4_OPEN_GEOMETRY: false,
    durableObserve: vi.fn(async (stage: string) => { await observe(stage); }), setTimeout, clearTimeout };
  const functions = runInNewContext(`${compiled}; ({ bounded, shutdownOnce, shutdownLatch, finalizeCapture });`, context) as {
    bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<{ done: true; value: T } | { done: false }>;
    shutdownOnce(): Promise<void>;
    shutdownLatch: AuditShutdownLatch;
    finalizeCapture(): Promise<void>;
  };
  const actualLatch = functions.shutdownLatch;
  return { context, message: (raw: unknown) => onMessage(raw), ...functions };
}

it("actual runner discharges late-registration shutdown exactly once without reopening timed-out health", async () => {
  vi.useFakeTimers();
  const runner = actualBlocks();
  let localReady!: (value: string) => void;
  const ready = new Promise<string>(resolve => { localReady = resolve; });
  const health = vi.fn();
  const started = runner.bounded(ready, 30);
  await vi.advanceTimersByTimeAsync(30);
  const result = await started;
  expect(result).toEqual({ done: false });
  if (result.done) health();
  await runner.shutdownOnce();
  const neverExited = new Promise<void>(() => {});
  const teardown = runner.bounded(neverExited, 30);
  setTimeout(() => {
    runner.message({ kind: "hotkeys_registered" }); runner.message({ kind: "hotkeys_registered" });
    localReady("loopback-only-fake");
  }, 10);
  await vi.advanceTimersByTimeAsync(30);
  expect(await teardown).toEqual({ done: false });
  expect(runner.context.artifact.hotkeyRegistrationProven).toBe(true);
  expect(runner.context.artifact.shutdownRequested).toBe(true);
  expect(runner.context.owner.send).toHaveBeenCalledExactlyOnceWith({ command: "q", registrationProven: true });
  expect(health).not.toHaveBeenCalled();
});

it.each([false, true])("actual finalizer seals recovery success/failure without reopening dispatch (corrupt=%s)", async corrupt => {
  const runner = actualBlocks(corrupt);
  await runner.shutdownOnce(); await runner.finalizeCapture();
  expect(runner.shutdownLatch.snapshot().phase).toBe("finalized");
  expect(runner.context.artifact.currentDefaultE2E.diskRecovery).toBe(!corrupt);
  expect(runner.context.artifact.cleanupFailed).toBe(corrupt);
  expect(Boolean(runner.context.finalizationFailure)).toBe(corrupt);
  expect(runner.context.durableObserve).toHaveBeenLastCalledWith("auditLifecycleFinalized");
  runner.message({ kind: "hotkeys_registered" });
  expect(runner.context.owner.send).not.toHaveBeenCalled();
  expect(() => runner.shutdownLatch.assertCapturing()).toThrow("audit_run_consumed");
});

it("actual runner with already registered hotkeys sends q once despite repeated events", async () => {
  const runner = actualBlocks();
  runner.context.artifact.hotkeyRegistrationProven = true;
  await runner.shutdownOnce();
  runner.message({ kind: "hotkeys_registered" }); await runner.shutdownLatch.tryQ();
  expect(runner.context.owner.send).toHaveBeenCalledExactlyOnceWith({ command: "q", registrationProven: true });
  expect(runner.context.durableObserve).toHaveBeenCalledExactlyOnceWith("shutdownRequested");
  expect(runner.context.artifact.shutdownRequested).toBe(true);
});

it("actual callback stays open during capture but cannot mutate artifacts after finalization", async () => {
  const runner = actualBlocks();
  runner.message({ kind: "hotkeys_registered" }); await runner.shutdownLatch.tryQ();
  expect(runner.context.owner.send).not.toHaveBeenCalled();
  runner.shutdownLatch.assertCapturing();
  await runner.shutdownOnce();
  runner.shutdownLatch.beginFinalization(); runner.shutdownLatch.finalize();
  const snapshot = structuredClone(runner.context.artifact);
  runner.message({ kind: "q_sent" }); runner.message({ kind: "hotkeys_registered" });
  expect(runner.context.artifact).toEqual(snapshot);
  expect(() => runner.shutdownLatch.assertCapturing()).toThrow("audit_run_consumed");
  expect(source.indexOf("shutdownLatch.beginFinalization();")).toBeLessThan(source.indexOf('observe("finalCheckpoint")'));
  expect(source.indexOf('durableObserve("auditLifecycleFinalized")')).toBeGreaterThan(source.indexOf('durableObserve("currentDefaultE2EDiskRecoveryChecked")'));
});

it("an already exited owner is not sent q even with registered hotkeys", async () => {
  const runner = actualBlocks();
  runner.context.artifact.hotkeyRegistrationProven = true; runner.context.ownerExited = true;
  await runner.shutdownOnce();
  expect(runner.context.owner.send).not.toHaveBeenCalled();
});

it("pins the actual failed-run evidence without substituting an offline simulation for a real exit", () => {
  const file = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261006-001/summary.json.checkpoint-000011.json";
  const { snapshot } = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(snapshot).toMatchObject({ startupAttempts: 1, healthAttempts: 0, qSentCount: 0,
    devServerReadyReceived: true, hotkeyRegistrationProven: true, cleanupFailed: true,
    ownerExitObserved: false, ownerCloseObserved: false, wrapperExitObserved: false, ptyExitObserved: false });
  expect(snapshot.currentDefaultE2E).toMatchObject({ generationPosts: 0, accounting: "not_attempted", result: null, png: null });
  expect(snapshot.lifecycle.find((item: { stage: string }) => item.stage === "localProxyReady").elapsedMs).toBe(83946);
  expect(snapshot.lifecycle.some((item: { stage: string }) => /healthRequestStarted|qSent|shutdownRequested/.test(item.stage))).toBe(false);
});
