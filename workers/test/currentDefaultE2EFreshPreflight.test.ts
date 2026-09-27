// Offline-only companion. Never imports the CLI runner or the historical-writing suite.
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Env } from "../src/types";
import { E2E_MARKER } from "./audit/currentDefaultE2E";
import { E2E_ROOT, createE2EState, runCurrentDefaultE2E, type prepareCurrentDefaultE2E } from "./audit/currentDefaultE2ELive";
import { projectE2EGateTrace, classifyE2E409 } from "./audit/currentDefaultE2EGateTrace";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const excluded = "test/currentDefaultE2EGates.test.ts";
const protectedPaths = [excluded,
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-001",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-002",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-003",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006",
  "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-007",
  "evaluation-artifacts/current-default-v3-e2e-409-gate-audit-20260926-001"];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function inventory() {
  const files = protectedPaths.flatMap(file => fs.statSync(file).isFile() ? [file]
    : fs.readdirSync(file, { recursive: true }).map(String).map(name => path.join(file, name))
      .filter(name => fs.statSync(name).isFile()));
  return Object.fromEntries(files.sort().map(file => [file, hash(fs.readFileSync(file))]));
}
let root: string;
let before: ReturnType<typeof inventory>;
const checks: string[] = [];
beforeAll(() => {
  before = inventory();
  root = fs.mkdtempSync(path.resolve("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => {
  const after = inventory();
  expect(after).toEqual(before);
  fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify({ mode: "offline_only",
    excludedTest: excluded, historicalFilesUnchanged: true, preservedHashes: before,
    completedChecks: checks, remoteStartupAttempts: 0, providerCalls: 0 }, null, 2), { flag: "wx" });
  console.info(`OFFLINE_PREFLIGHT_ARTIFACT ${root}`);
});

it("pins the unused 008 selector/root without importing or executing the remote runner", () => {
  const runner = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  expect(runner).toContain('process.env.RUN_CURRENT_DEFAULT_V3_E2E === "approved-29002888-20260927-008"');
  expect(E2E_ROOT).toBe(path.resolve("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008"));
  expect(fs.existsSync(E2E_ROOT)).toBe(false);
  expect(runner).toContain('expect(fs.existsSync(root)).toBe(false)');
  expect(runner).toContain('fs.mkdirSync(root, { recursive: false })');
  expect(createE2EState(prepared()).runId).not.toBe(createE2EState(prepared()).runId);
  const self = fs.readFileSync("test/currentDefaultE2EFreshPreflight.test.ts", "utf8");
  expect(self).not.toMatch(/from ["'][^"']*currentDefaultE2EGates|import\(["'][^"']*primaryAuditCliProtectedHealth/);
  checks.push("fresh_selector_root_and_run_id");
});

it("omits only the face-geometry CLI override for E2E and preserves legacy primary-only args", () => {
  // Importing this fixture exposes pure helpers only (require.main guard); no child or socket is started.
  const { auditFeatureArgs } = createRequire(import.meta.url)("./fixtures/primaryAuditCliHealthPty.cjs") as {
    auditFeatureArgs(mode?: string): string[];
  };
  const legacy = ["--var", "FACE_GEOMETRY_ENRICHMENT_ENABLED:false",
    "--var", "IDENTITY_GEOMETRY_ENRICHMENT_ENABLED:false", "--var", "SYNCHRONOUS_ENHANCEMENTS_ENABLED:false"];
  expect(auditFeatureArgs()).toEqual(legacy);
  expect(auditFeatureArgs("primary-only")).toEqual(legacy);
  expect(auditFeatureArgs("current-default-e2e")).toEqual(legacy.slice(2));
  expect(auditFeatureArgs("current-default-e2e").join(" ")).not.toContain("FACE_GEOMETRY_ENRICHMENT_ENABLED");
  expect(() => auditFeatureArgs("unrecognized")).toThrow("invalid_audit_feature_mode");
  const fixture = fs.readFileSync("test/fixtures/primaryAuditCliHealthPty.cjs", "utf8");
  expect(fixture).toContain('[__filename, "bridge", pipe, config, envFile, featureMode]');
  expect(fixture).toContain('const featureArgs = auditFeatureArgs(process.argv[6] || "primary-only")');
  expect(fixture).toContain('...featureArgs], {');
  const runner = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  expect(runner).toContain('auditFeatureMode: RUN_CURRENT_DEFAULT_E2E ? "current-default-e2e" : "primary-only"');
  expect(runner).toContain('configName, tokenFile!, artifact.auditFeatureMode]');
  checks.push("only_e2e_face_geometry_override_removed_legacy_modes_preserved");
});

function prepared() {
  // An early context rejection never reads an image. No image is persisted or required here.
  return { payload: { image: "in_memory_only", analysisImage: "in_memory_only" } } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
}
async function rejection(missing: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_network_forbidden"); }));
  const { default: production } = await import("../src/index");
  const handler = vi.spyOn(production, "fetch");
  const { default: worker } = await import("./primaryFaceMeasurementAuditWorker");
  const provider = vi.fn(() => { throw new Error("provider_forbidden_in_gate_test"); });
  const env: Record<string, unknown> & Pick<Env, "MCSKIN_KV"> = {
    // These deliberately invalid contexts return before the production handler or KV can run.
    MCSKIN_KV: {} as Env["MCSKIN_KV"], PRIMARY_AUDIT_TOKEN: "offline-test-token", GEMINI_API_KEY: "offline-test-key",
    AI: { run: provider, gateway: () => ({ run: provider }) }, VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", FACE_GEOMETRY_ENRICHMENT_ENABLED: "true" };
  if (missing === "gateway") env.AI = { run: provider };
  else delete env[missing];
  const response = await worker.fetch(new Request("https://offline.invalid/current-default-e2e-audit", {
    method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": "offline-test-token",
      "x-primary-audit-run-id": "a".repeat(32), "x-current-default-e2e": E2E_MARKER }, body: "{}",
  }), env as Env);
  expect(handler).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

it.each([
  ["GEMINI_API_KEY", "gemini_api_key_missing"], ["AI", "ai_binding_missing"],
  ["gateway", "ai_gateway_not_function"], ["VISION_MODEL", "vision_model_mismatch"],
  ["WORKERS_VISION_MODEL", "workers_vision_model_mismatch"],
  ["FACE_GEOMETRY_ENRICHMENT_ENABLED", "face_geometry_flag_mismatch"],
])("preserves the fixed first context predicate %s and zero dispatch", async (field, code) => {
  const response = await rejection(field);
  expect(response.status).toBe(409);
  const trace = projectE2EGateTrace(response.body.e2eGateTrace, response.status);
  expect(trace).toMatchObject({ failureStage: "context", failureCode: code, routeEntered: true,
    handlerInvocationStarted: false, handlerInvocationReturned: false,
    providerAttemptIntent: 0, providerAttemptStarted: 0, responseFinalized: true });
  expect(classifyE2E409(trace)).toBe("PRE_PROVIDER_E2E_GATE_FAILURE");
  checks.push(code);
});

it("recovers sequential checkpoints and the exact early 409 trace only in a new root", async () => {
  const response = await rejection("GEMINI_API_KEY");
  const state = createE2EState(prepared());
  const file = path.join(root, "summary.json");
  expect(await readLatestAuditCheckpoint(file)).toBeNull();
  await atomicCheckpoint(file, state, "offlineSmokeOne");
  await atomicCheckpoint(file, state, "offlineSmokeTwo");
  const smoke = await readLatestAuditCheckpoint(file);
  expect(smoke?.sequence).toBe(2);
  expect(smoke?.snapshotSha256).toBe(hash(JSON.stringify(state)));
  const events: string[] = [];
  const post = vi.fn(async () => response);
  await runCurrentDefaultE2E(state, prepared(), post, async event => {
    events.push(event); await atomicCheckpoint(file, state, event);
  }, root);
  const recovered = await readLatestAuditCheckpoint(file);
  expect(recovered?.sequence).toBe(6);
  expect(recovered?.snapshotSha256).toBe(hash(JSON.stringify(state)));
  expect(recovered?.snapshot).toEqual(state);
  expect(state.e2eGateTrace).toEqual(projectE2EGateTrace(response.body.e2eGateTrace, 409));
  expect(state.gateBoundary).toBe("PRE_PROVIDER_E2E_GATE_FAILURE");
  expect(events).toEqual(["currentDefaultE2EGenerateIntent", "currentDefaultE2EPostStarted",
    "currentDefaultE2EGateTraceCaptured", "currentDefaultE2EInvalidEnvelope"]);
  expect(post).toHaveBeenCalledTimes(1);
  await expect(runCurrentDefaultE2E(state, prepared(), post, async () => {}, root)).rejects.toThrow("already_consumed");
  expect(post).toHaveBeenCalledTimes(1);
  for (const name of fs.readdirSync(root)) {
    expect(fs.readFileSync(path.join(root, name), "utf8"))
      .not.toMatch(/offline-test-token|offline-test-key|in_memory_only|data:image|base64,|requestBody/);
  }
  checks.push("sequential_checkpoint_hash_recovery_and_early_trace_persistence");
});

it("rejects absent or partial diagnostics instead of treating historical 409 as zero dispatch", () => {
  expect(projectE2EGateTrace(undefined, 409)).toBeNull();
  expect(projectE2EGateTrace({ failureCode: "gemini_api_key_missing" }, 409)).toBeNull();
  expect(classifyE2E409(null)).toBe("UNKNOWN_409_BOUNDARY");
  checks.push("historical_unknown_not_reinterpreted");
});
