import { boundedHealthProbe, HEALTH_WATCHDOG_MS } from "./primaryAuditRemoteReadiness";
import type { AuditFetcher } from "./primaryAuditRunnerSupport";

// Offline fake-adapter exercise ONLY. No real Wrangler child implementation is
// supplied: installed Windows CLI shutdown is not proven graceful. Never use a
// fake requestShutdown result as evidence that the installed CLI supports it.
export type FakeCliChild = {
  exited: Promise<{ code: number | null; signal: string | null }>;
  start(onMessage: (raw: unknown) => void, onStderr: (raw: string) => void): void;
  requestShutdown(): Promise<void>;
  verifyOwnedProcessesGone(): Promise<boolean>;
};

export function localProxyUrl(raw: unknown): string | null {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.event !== "DEV_SERVER_READY" || !Number.isInteger(message.port)
    || (message.port as number) < 1 || (message.port as number) > 65535) return null;
  // Keep IPC-owned address transient. Explicit future --ip / --local-protocol
  // would constrain this to HTTP loopback; IPC itself has no protocol field.
  const ip = message.ip;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "[::1]") return null;
  return `http://${ip === "127.0.0.1" ? ip : "[::1]"}:${message.port}`;
}

export function classifyCliStderr(raw: string): "auth" | "build" | "unknown" {
  const text = raw.slice(0, 4096).toLowerCase();
  if (/authentication|not authenticated|unauthorized|unable to authenticate/.test(text)) return "auth";
  if (/build failed|build failure|failed to build/.test(text)) return "build";
  return "unknown";
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number) {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ status: "timeout" }>(resolve => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([operation.then(value => ({ status: "complete" as const, value })), deadline]);
  } finally { clearTimeout(timer); }
}

export async function exerciseCliAuditLifecycle(child: FakeCliChild, fetcher: AuditFetcher,
  options = { localReadyMs: 30_000, healthMs: HEALTH_WATCHDOG_MS, shutdownMs: 10_000 }) {
  const state = {
    cliStartRequested: false, cliChildSpawned: false, cliLocalProxyReady: false,
    healthRequestStarted: false, healthHeadersReceived: false, healthPassed: false,
    shutdownRequested: false, cliExited: false, cleanupVerified: false,
    childExitedBeforeHealth: false,
    messageClassified: "unknown" as "auth" | "build" | "unknown",
    exitCodeClass: "not_observed" as "not_observed" | "zero" | "nonzero" | "no_code",
    signalClass: "none" as "none" | "SIGINT" | "SIGTERM" | "SIGHUP" | "other",
    readiness: "startup_error" as "startup_error" | "local_ready_timeout" | "child_exited" | "health_timeout" | "health_failed" | "ready",
    cleanup: "cleanup_failed" as "cleanup_failed" | "verified",
    providerDispatches: 0, jpegReads: 0,
    installedCliGracefulShutdownProven: false, liveStartupAllowed: false,
  };
  let active = true;
  let exited = false;
  let resolveLocal!: (url: string) => void;
  const local = new Promise<string>(resolve => { resolveLocal = resolve; });
  const exit = child.exited.then(result => {
    exited = true;
    if (active) {
      state.cliExited = true;
      state.childExitedBeforeHealth = !state.healthRequestStarted;
      state.exitCodeClass = result.code === 0 ? "zero" : result.code === null ? "no_code" : "nonzero";
      state.signalClass = result.signal === null ? "none"
        : ["SIGINT", "SIGTERM", "SIGHUP"].includes(result.signal) ? result.signal as "SIGINT" | "SIGTERM" | "SIGHUP" : "other";
    }
    return "exited" as const;
  });
  try {
    state.cliStartRequested = true;
    child.start(raw => {
      if (!active || state.cliLocalProxyReady || exited) return;
      const url = localProxyUrl(raw);
      if (!url) return;
      state.cliLocalProxyReady = true;
      resolveLocal(url);
    }, raw => { if (active) state.messageClassified = classifyCliStderr(raw); });
    state.cliChildSpawned = true;
    const start = await bounded(Promise.race([local, exit]), options.localReadyMs);
    if (start.status === "timeout") state.readiness = "local_ready_timeout";
    else if (start.value === "exited" || exited) state.readiness = "child_exited";
    else {
      const url = start.value;
      const health = await Promise.race([
        boundedHealthProbe({ fetch: (_url, init) => fetcher.fetch(`${url}/primary-audit-health`, init) },
          "offline-fake-audit-token", stage => {
            if (!active || exited) return;
            if (stage === "healthRequestStarted") state.healthRequestStarted = true;
            if (stage === "healthHeadersReceived") state.healthHeadersReceived = true;
          }, options.healthMs),
        exit,
      ]);
      if (health === "exited" || exited) state.readiness = "child_exited";
      else {
        state.healthPassed = health.status === "passed";
        state.readiness = health.status === "passed" ? "ready" : health.status === "timeout" ? "health_timeout" : "health_failed";
      }
    }
  } catch { state.readiness = "startup_error"; }
  finally {
    try {
      const cleaned = await bounded((async () => {
        if (!exited && state.cliChildSpawned) {
          state.shutdownRequested = true;
          await child.requestShutdown();
        }
        if (state.cliChildSpawned) await exit;
        return state.cliChildSpawned && await child.verifyOwnedProcessesGone();
      })(), options.shutdownMs);
      state.cleanupVerified = cleaned.status === "complete" && cleaned.value
        && state.exitCodeClass === "zero" && state.signalClass === "none";
      state.cleanup = state.cleanupVerified ? "verified" : "cleanup_failed";
    } catch { state.cleanup = "cleanup_failed"; }
    active = false; // Late IPC/HTTP/exit cannot mutate returned evidence.
  }
  return state;
}
