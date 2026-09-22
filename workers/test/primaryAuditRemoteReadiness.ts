import type { EventEmitter } from "node:events";
import { exceptionDiagnostic, type AuditFetcher, type ExceptionDiagnostic } from "./primaryAuditRunnerSupport";

export type RemoteReadiness =
  | { status: "ready"; observed: "reloadComplete" }
  | { status: "startup_error"; diagnostic: ExceptionDiagnostic }
  | { status: "build_failed"; diagnostic: ExceptionDiagnostic }
  | { status: "timeout" };
export type RemoteAuditWorker = AuditFetcher & { ready: Promise<void> };
type Lifecycle = Pick<EventEmitter, "on" | "off"> & {
  proxy: { runtimeMessageMutex: { drained(): Promise<void> } };
};

// Local orchestration deadline only, never a provider or request-body timeout.
export const REMOTE_READINESS_TIMEOUT_MS = 30_000;
export type RemoteStartupStage = "listenersRegistered" | "startWorkerRequested" | "startWorkerReturned"
  | "localProxyReady" | "remoteReadinessWaitStarted" | "remoteReloadCompleteObserved"
  | "proxyMessageDrainCompleted" | "remoteReadinessReady" | "remoteStartupErrorObserved"
  | "remoteBuildFailedObserved" | "remoteReadinessTimeout";
export async function startRemoteAudit<W extends RemoteAuditWorker>(
  dev: Lifecycle, start: () => Promise<W>, timeoutMs = REMOTE_READINESS_TIMEOUT_MS,
  observe: (stage: RemoteStartupStage) => void = () => {},
): Promise<{ readiness: RemoteReadiness; worker: W | null }> {
  let settled = false;
  let resolveResult!: (result: { readiness: RemoteReadiness; worker: W | null }) => void;
  const result = new Promise<{ readiness: RemoteReadiness; worker: W | null }>(resolve => { resolveResult = resolve; });
  const finish = (readiness: RemoteReadiness, worker: W | null = null) => {
    if (settled) return;
    settled = true;
    observe(readiness.status === "ready" ? "remoteReadinessReady" : readiness.status === "startup_error"
      ? "remoteStartupErrorObserved" : readiness.status === "build_failed" ? "remoteBuildFailedObserved" : "remoteReadinessTimeout");
    clearTimeout(timer);
    dev.off("reloadComplete", onReload);
    dev.off("error", onError);
    dev.off("buildFailed", onBuildFailed);
    resolveResult({ readiness, worker });
  };
  const eventCause = (event: unknown) => event && typeof event === "object" && "cause" in event
    ? (event as { cause: unknown }).cause : event;
  const onError = (event: unknown) => finish({ status: "startup_error", diagnostic: exceptionDiagnostic(eventCause(event), "startup") });
  const onBuildFailed = (event: unknown) => finish({ status: "build_failed", diagnostic: exceptionDiagnostic(eventCause(event), "startup") });
  const onReload = (event: unknown) => {
    if (settled) return;
    // Never retain proxyData (which contains preview credentials). Reject local
    // runtime events: only the installed remote config path can open this gate.
    const config = event && typeof event === "object" ? (event as { config?: { dev?: { remote?: boolean } } }).config : undefined;
    if (config?.dev?.remote !== true) return;
    observe("remoteReloadCompleteObserved");
    void Promise.resolve().then(async () => {
      const worker = await localReady; // local proxy ready is necessary, NOT sufficient
      await dev.proxy.runtimeMessageMutex.drained(); // play delivery scheduled before external reloadComplete
      if (settled) return;
      observe("proxyMessageDrainCompleted");
      finish({ status: "ready", observed: "reloadComplete" }, worker);
    }).catch(onError);
  };
  const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
  // Register before invoking start: synchronous/early events must not be lost.
  dev.on("reloadComplete", onReload);
  dev.on("error", onError);
  dev.on("buildFailed", onBuildFailed);
  observe("listenersRegistered");
  observe("remoteReadinessWaitStarted");
  const startup = Promise.resolve().then(() => { observe("startWorkerRequested"); return start(); })
    .then(worker => { if (!settled) observe("startWorkerReturned"); return worker; });
  const localReady = startup.then(async worker => {
    await worker.ready;
    if (!settled) observe("localProxyReady");
    return worker;
  });
  void localReady.catch(onError);
  return result;
}

export const HEALTH_WATCHDOG_MS = 20_000;
export type HealthStage = "healthRequestStarted" | "healthHeadersReceived" | "healthBodyParsed";
export async function boundedHealthProbe(worker: AuditFetcher, token: string,
  observe: (stage: HealthStage) => void, timeoutMs = HEALTH_WATCHDOG_MS) {
  let active = true;
  let timer!: ReturnType<typeof setTimeout>;
  const record = (stage: HealthStage) => { if (active) observe(stage); };
  const operation = (async () => {
    record("healthRequestStarted");
    const response = await worker.fetch("http://audit.invalid/primary-audit-health", {
      headers: { "x-primary-audit-token": token },
    });
    record("healthHeadersReceived");
    const raw = await response.json();
    record("healthBodyParsed");
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const source = body.runtime && typeof body.runtime === "object" ? body.runtime as Record<string, unknown> : {};
    const runtime = {
      marker: source.marker === "cloudflare_remote_worker" ? "cloudflare_remote_worker" : null,
      aiBinding: source.aiBinding === true,
      aiRunType: source.aiRunType === "function" ? "function" : null,
      aiGatewayType: source.aiGatewayType === "function" ? "function" : null,
    };
    const passed = response.ok && body.ok === true && runtime.marker !== null && runtime.aiBinding
      && runtime.aiRunType !== null && runtime.aiGatewayType !== null && body.providerCalls === 0;
    return { status: passed ? "passed" as const : "failed" as const, httpStatus: response.status,
      body: { ok: body.ok === true, runtime, providerCalls: body.providerCalls === 0 ? 0 : null }, diagnostic: null };
  })().catch(error => ({ status: "failed" as const, httpStatus: null, body: null, diagnostic: exceptionDiagnostic(error, "health") }));
  const deadline = new Promise<{ status: "timeout"; httpStatus: null; body: null; diagnostic: ExceptionDiagnostic }>(resolve => {
    timer = setTimeout(() => resolve({ status: "timeout", httpStatus: null, body: null,
      diagnostic: exceptionDiagnostic({ name: "TimeoutError" }, "health") }), timeoutMs);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { active = false; clearTimeout(timer); }
}
