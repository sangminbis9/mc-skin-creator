import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertProviderCalls, providerCallsOf, validRunId, type ProviderCalls } from "./primaryAuditLifecycle";

export type LocalStage = "unstableDevStartRequested" | "unstableDevReturned"
  | "remoteStartupRequested" | "remoteForwardingReady"
  | "healthRequestStarted" | "healthResponseReceived" | "canarySelected"
  | "sourceHashVerified" | "payloadPreparedInMemory" | "canaryFetchInvoked"
  | "canaryHeadersReceived" | "finalBodyParsed" | "timeoutObserved"
  | "statusProbeAttempted" | "workerStopRequested" | "workerStopCompleted";
export type Checkpoint = (stage: LocalStage) => Promise<void>;
export type ExceptionDiagnostic = {
  name: string | null; constructor: string | null; code: string | null;
  causeName: string | null; causeCode: string | null;
  messageClassified: "headers_timeout" | "connect_timeout" | "fetch_failed" | "aborted" | "wrangler_startup" | "unknown";
  repoOrWranglerTopFrame: string | null;
};
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "HeadersTimeoutError",
  "ConnectTimeoutError", "UserError", "FatalError", "RemoteSessionAuthenticationError", "MissingConfigError", "APIError"]);
const ERROR_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ERR_MODULE_NOT_FOUND"]);
// A syntactically bounded arbitrary string could still be a credential. Only
// recognized names/codes and canonical frame filenames leave process memory.
export function exceptionDiagnostic(error: unknown, phase: "startup" | "health" | "execution"): ExceptionDiagnostic {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
  const name = (input: unknown) => typeof input === "string" && ERROR_NAMES.has(input) ? input : null;
  const code = (input: unknown) => typeof input === "string" && ERROR_CODES.has(input) ? input : null;
  const names = [name(value.name), name(cause.name)];
  const codes = [code(value.code), code(cause.code)];
  const messages = [value.message, cause.message].filter((input): input is string => typeof input === "string")
    .map(input => input.slice(0, 2048).toLowerCase());
  let messageClassified: ExceptionDiagnostic["messageClassified"] = phase === "startup" ? "wrangler_startup" : "unknown";
  if (codes.includes("UND_ERR_HEADERS_TIMEOUT") || names.includes("HeadersTimeoutError") || messages.some(m => m.includes("headers timeout"))) messageClassified = "headers_timeout";
  else if (codes.includes("UND_ERR_CONNECT_TIMEOUT") || names.includes("ConnectTimeoutError") || messages.some(m => m.includes("connect timeout"))) messageClassified = "connect_timeout";
  else if (names.includes("AbortError") || codes.includes("UND_ERR_ABORTED")) messageClassified = "aborted";
  else if (messages.some(m => m.includes("fetch failed"))) messageClassified = "fetch_failed";
  const stack = typeof value.stack === "string" ? value.stack : "";
  const frame = stack.split(/\r?\n/).slice(1, 20).map(line => {
    const wrangler = line.match(/(?:[/\\])wrangler[/\\]wrangler-dist[/\\]cli\.js:(\d{1,7}):(\d{1,7})(?:\)|\s*$)/);
    if (wrangler) return `wrangler/wrangler-dist/cli.js:${wrangler[1]}:${wrangler[2]}`;
    const repo = line.match(/(?:[/\\])workers[/\\]test[/\\](primaryAuditRunnerSupport\.ts|productionPrimaryCloudflareAudit\.test\.ts):(\d{1,7}):(\d{1,7})(?:\)|\s*$)/);
    return repo ? `workers/test/${repo[1]}:${repo[2]}:${repo[3]}` : null;
  }).find(Boolean) ?? null;
  return { name: names[0], constructor: name(value.constructor && typeof value.constructor === "function" ? value.constructor.name : null),
    code: codes[0], causeName: names[1], causeCode: codes[1], messageClassified, repoOrWranglerTopFrame: frame };
}
// Deliberately use the shared JSON subset, not Node/Workers' differing BodyInit.
export type AuditFetcher = { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> };
export type Accounting = { dispatch: "known"; stage: string; final: boolean; providerCalls: ProviderCalls }
  | { dispatch: "unknown" };

// The immutable, versioned files are authoritative. summary.json is only a
// compatibility projection: Windows/OneDrive can refuse replacement of an
// existing destination even after the adjacent temporary file was written.
export type CheckpointRecord = { schemaVersion: 1; sequence: number; event: string; snapshotSha256: string; snapshot: unknown };
export type CheckpointWriteResult = { sequence: number; filesystemRetryCount: number; summaryProjectionFailed: boolean };
export type CheckpointIo = {
  writeVersion(path: string, text: string): Promise<void>;
  replaceSummary(temporary: string, destination: string, text: string): Promise<void>;
};
const defaultCheckpointIo: CheckpointIo = {
  async writeVersion(path, text) {
    const file = await open(path, "wx");
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
  },
  async replaceSummary(temporary, destination, text) {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, destination);
  },
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const versionName = (path: string, sequence: number) => `${path}.checkpoint-${String(sequence).padStart(6, "0")}.json`;
const versionPattern = (path: string) => new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.checkpoint-(\\d+)\\.json$`);
function filesystemCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
export async function readLatestAuditCheckpoint(path: string): Promise<CheckpointRecord | null> {
  const directory = dirname(path);
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (filesystemCode(error) === "ENOENT") return null; throw error; }
  const pattern = versionPattern(path);
  const versions = names.map(name => ({ name, sequence: Number(pattern.exec(name)?.[1]) }))
    .filter(entry => Number.isSafeInteger(entry.sequence) && entry.sequence > 0)
    .sort((a, b) => b.sequence - a.sequence);
  for (const version of versions) {
    try {
      const record = JSON.parse(await readFile(join(directory, version.name), "utf8")) as CheckpointRecord;
      if (record.schemaVersion !== 1 || record.sequence !== version.sequence || typeof record.event !== "string"
        || !record.event || !record.snapshot || typeof record.snapshot !== "object"
        || record.snapshotSha256 !== sha256(JSON.stringify(record.snapshot))) continue;
      return record;
    } catch { /* A crashed, incomplete newest file cannot supersede the previous good version. */ }
  }
  return null;
}
export async function atomicCheckpoint(
  path: string, artifact: unknown, event = "checkpoint", io: CheckpointIo = defaultCheckpointIo,
): Promise<CheckpointWriteResult> {
  const serialized = JSON.stringify(artifact);
  if (serialized === undefined) throw new TypeError("Audit checkpoint must be serializable");
  const previous = await readLatestAuditCheckpoint(path);
  const directory = dirname(path);
  const names = await readdir(directory);
  const pattern = versionPattern(path);
  const highestSeen = Math.max(0, ...names.map(name => Number(pattern.exec(name)?.[1]) || 0));
  const next = Math.max(previous?.sequence ?? 0, highestSeen) + 1;
  let retries = 0;
  let sequence = next;
  for (;;) {
    const record: CheckpointRecord = { schemaVersion: 1, sequence, event,
      snapshotSha256: sha256(serialized), snapshot: artifact };
    try {
      await io.writeVersion(versionName(path, sequence), `${JSON.stringify(record, null, 2)}\n`);
      break;
    } catch (error) {
      const completed = await readLatestAuditCheckpoint(path);
      if (completed?.sequence === sequence && completed.event === event
        && completed.snapshotSha256 === sha256(serialized)) break;
      if (!["EPERM", "EACCES", "EEXIST"].includes(filesystemCode(error) ?? "") || retries >= 2) throw error;
      retries++;
      sequence++;
      await new Promise(resolve => setTimeout(resolve, 20 * retries));
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let summaryProjectionFailed = false;
  try { await io.replaceSummary(temporary, path, `${JSON.stringify(artifact, null, 2)}\n`); }
  catch { summaryProjectionFailed = true; }
  finally { try { await unlink(temporary); } catch (error) { if (filesystemCode(error) !== "ENOENT") summaryProjectionFailed = true; } }
  return { sequence, filesystemRetryCount: retries, summaryProjectionFailed };
}
export function accountingOf(value: unknown, runId: string): Accounting {
  if (!value || typeof value !== "object") return { dispatch: "unknown" };
  const state = value as Record<string, unknown>;
  if (state.runId !== runId || !validRunId(runId) || typeof state.stage !== "string"
    || !/^(created|request_entered|primary_started|gemini_dispatch_started|gemini_returned|gemini_failed|gemma_dispatch_started|gemma_returned|gemma_failed|photo_analysis_completed|response_ready)$/.test(state.stage)) return { dispatch: "unknown" };
  try {
    const counters = state as unknown as ProviderCalls;
    assertProviderCalls(counters);
    return { dispatch: "known", stage: state.stage, final: typeof state.finalOk === "boolean", providerCalls: providerCallsOf(counters) };
  } catch { return { dispatch: "unknown" }; }
}
export async function healthReady(worker: AuditFetcher, token: string, checkpoint: Checkpoint): Promise<boolean> {
  await checkpoint("healthRequestStarted");
  const response = await worker.fetch("http://audit.invalid/primary-audit-health", {
    headers: { "x-primary-audit-token": token },
  });
  await checkpoint("healthResponseReceived");
  const body = await response.json() as { ok?: boolean; runtime?: { marker?: string; aiBinding?: boolean; aiRunType?: string; aiGatewayType?: string } };
  return response.ok && body.ok === true && body.runtime?.marker === "cloudflare_remote_worker"
    && body.runtime.aiBinding === true && body.runtime.aiRunType === "function" && body.runtime.aiGatewayType === "function";
}
function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: string; cause?: unknown };
  return ["AbortError", "TimeoutError", "HeadersTimeoutError"].includes(value.name ?? "")
    || value.code === "UND_ERR_HEADERS_TIMEOUT" || (value.cause !== error && isTimeout(value.cause));
}
export async function accountedRequest<T extends { auditState?: unknown }>(
  worker: AuditFetcher, token: string, runId: string, body: string, checkpoint: Checkpoint,
): Promise<{ httpStatus?: number; result?: T; accounting: Accounting; failure?: "timeout" | "request_failure" }> {
  await checkpoint("canaryFetchInvoked");
  try {
    const response = await worker.fetch("http://audit.invalid/primary-audit", {
      method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId }, body,
    });
    await checkpoint("canaryHeadersReceived");
    const result = await response.json() as T;
    await checkpoint("finalBodyParsed");
    return { httpStatus: response.status, result, accounting: accountingOf(result.auditState, runId) };
  } catch (error) {
    if (!isTimeout(error)) return { accounting: { dispatch: "unknown" }, failure: "request_failure" };
    await checkpoint("timeoutObserved");
    await checkpoint("statusProbeAttempted");
    // Exactly one status attempt. Missing isolate-local state is not evidence of
    // non-entry; only a found matching run can establish a dispatch lower bound.
    try {
      const response = await worker.fetch(`http://audit.invalid/primary-audit-status?runId=${runId}`, {
        headers: { "x-primary-audit-token": token },
      });
      const state = await response.json() as { found?: boolean };
      return { failure: "timeout", accounting: response.ok && state.found === true
        ? accountingOf(state, runId) : { dispatch: "unknown" } };
    } catch { return { failure: "timeout", accounting: { dispatch: "unknown" } }; }
  }
}
