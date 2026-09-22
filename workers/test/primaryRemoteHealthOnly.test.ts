import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { atomicCheckpoint, exceptionDiagnostic, type AuditFetcher, type ExceptionDiagnostic } from "./primaryAuditRunnerSupport";
import { boundedHealthProbe, HEALTH_WATCHDOG_MS, REMOTE_READINESS_TIMEOUT_MS, startRemoteAudit, type RemoteReadiness } from "./primaryAuditRemoteReadiness";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("health watchdog is local only; one GET, no signal/retry, safe body", async () => {
  const fetch = vi.fn<AuditFetcher["fetch"]>(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, providerCalls: 0,
    secret: "never-store", runtime: { marker: "cloudflare_remote_worker", aiBinding: true,
      aiRunType: "function", aiGatewayType: "function", secret: "never-store" } }) }));
  const events: string[] = [];
  const result = await boundedHealthProbe({ fetch }, "fake-token", stage => events.push(stage));
  expect(result.status).toBe("passed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("signal");
  expect(events).toEqual(["healthRequestStarted", "healthHeadersReceived", "healthBodyParsed"]);
  expect(JSON.stringify(result)).not.toMatch(/never-store|fake-token/);
});
it("health watchdog returns before unresolved headers; late response cannot alter lifecycle", async () => {
  vi.useFakeTimers();
  let finish!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void;
  const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>(res => { finish = res; }));
  const events: string[] = [];
  const pending = boundedHealthProbe({ fetch }, "fake-token", stage => events.push(stage), 20);
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).status).toBe("timeout");
  finish({ ok: false, status: 503, json: async () => ({ secret: "never-store" }) });
  await Promise.resolve(); await Promise.resolve();
  expect(events).toEqual(["healthRequestStarted"]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.skipIf(process.env.RUN_REMOTE_HEALTH_ONLY !== "approved")("runs one authorized readiness-gated remote health ONLY", async () => {
  const root = process.env.REMOTE_HEALTH_ARTIFACT_ROOT;
  if (!root) throw new Error("fresh REMOTE_HEALTH_ARTIFACT_ROOT required");
  await mkdir(root, { recursive: false });
  const artifact = {
    startHead: "0b9d6dec4346076736ad21d92b4125481808efc1", branch: "main",
    productionDiffPreflight: 0, readinessTimeoutMs: REMOTE_READINESS_TIMEOUT_MS, healthWatchdogMs: HEALTH_WATCHDOG_MS,
    lifecycle: [] as Array<{ stage: string; at: number }>,
    remoteReadiness: null as RemoteReadiness | null,
    health: null as Awaited<ReturnType<typeof boundedHealthProbe>> | null,
    safeException: null as ExceptionDiagnostic | null,
    startupAttempts: 0, healthAttempts: 0, stopCompleted: false, tokenDiscarded: false,
    prohibited: { primaryPostAttempts: 0, jpegReads: 0, jpegHashVerification: 0, jpegBase64Conversions: 0,
      jpegTransmissions: 0, Gemini: 0, Gemma: 0, retry: 0, geometry: 0, imageGeneration: 0,
      critique: 0, pairwise: 0, evaluator: 0 },
    classification: "not_started",
  };
  const checkpoint = resolve(root, "health-results.json");
  const persist = () => atomicCheckpoint(checkpoint, artifact);
  let writes = Promise.resolve();
  const observe = (stage: string) => {
    artifact.lifecycle.push({ stage, at: Date.now() });
    if (stage === "startWorkerRequested") artifact.startupAttempts++;
    if (stage === "healthRequestStarted") artifact.healthAttempts++;
    writes = writes.then(persist);
    void writes.catch(() => {});
  };
  await persist();
  // Prevent Wrangler logging credentials/events outside the safe artifact too.
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  let token = randomBytes(32).toString("hex");
  let dev: InstanceType<typeof import("wrangler")["unstable_DevEnv"]> | null = null;
  try {
    const wrangler = await import("wrangler");
    const config = resolve("wrangler.jsonc");
    expect(wrangler.unstable_readConfig({ config }).account_id).toBe("8e83629048e42855e4d5a5777c769ba4");
    dev = new wrangler.unstable_DevEnv();
    observe("devEnvCreated");
    const outcome = await startRemoteAudit(dev, () => dev!.startWorker({
      config, entrypoint: "test/primaryFaceMeasurementAuditWorker.ts",
      bindings: {
        PRIMARY_AUDIT_TOKEN: { type: "plain_text", value: token },
        FACE_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
        IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
        SYNCHRONOUS_ENHANCEMENTS_ENABLED: { type: "plain_text", value: "false" },
      },
      dev: { remote: true, server: { hostname: "127.0.0.1", port: 0 }, logLevel: "none", watch: false },
    }), REMOTE_READINESS_TIMEOUT_MS, observe);
    artifact.remoteReadiness = outcome.readiness;
    if (outcome.readiness.status !== "ready" || !outcome.worker) {
      artifact.classification = `blocked_readiness_${outcome.readiness.status}`;
      if ("diagnostic" in outcome.readiness) artifact.safeException = outcome.readiness.diagnostic;
    } else {
      artifact.health = await boundedHealthProbe(outcome.worker, token, observe);
      artifact.safeException = artifact.health.diagnostic;
      artifact.classification = artifact.health.status === "passed"
        ? "READY_FOR_PRIMARY_CANARY_AFTER_REMOTE_HEALTH_PASS" : `blocked_health_${artifact.health.status}`;
    }
  } catch (error) {
    artifact.safeException = exceptionDiagnostic(error, artifact.remoteReadiness?.status === "ready" ? "health" : "startup");
    artifact.classification = "blocked_local_or_startup_exception";
  } finally {
    if (dev) {
      observe("workerStopRequested");
      try { await dev.teardown(); artifact.stopCompleted = true; observe("workerStopCompleted"); }
      catch (error) { artifact.safeException = exceptionDiagnostic(error, "startup"); artifact.classification = "blocked_stop_failure"; }
    }
    token = "";
    artifact.tokenDiscarded = true;
    await writes;
    await persist();
    vi.restoreAllMocks();
  }
  expect(artifact.startupAttempts).toBeLessThanOrEqual(1);
  expect(artifact.healthAttempts).toBeLessThanOrEqual(1);
  if (artifact.remoteReadiness?.status !== "ready") expect(artifact.healthAttempts).toBe(0);
  expect(Object.values(artifact.prohibited).every(value => value === 0)).toBe(true);
}, 120_000);
