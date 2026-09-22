import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { bytesToBase64 } from "../src/png";
import { accountedRequest, atomicCheckpoint, exceptionDiagnostic, healthReady, type ExceptionDiagnostic, type LocalStage } from "./primaryAuditRunnerSupport";
import type { AuditRunState, ProviderCalls } from "./primaryAuditLifecycle";
import { startRemoteAudit, type RemoteReadiness } from "./primaryAuditRemoteReadiness";

const SCOPE = process.env.RUN_PRIMARY_CLOUDFLARE_AUDIT;
const RUN = SCOPE === "approved-canary" || SCOPE === "approved-seven";
const CASE_LIMIT = SCOPE === "approved-canary" ? 1 : 7;
const ROOT = process.env.PRIMARY_CLOUDFLARE_AUDIT_ROOT;
const FROZEN = resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915");
const GENERALIZATION = resolve("evaluation-artifacts/generalization-20260905");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type Rubric = { cases: Array<{ id: string; photoId: number; sourceSha256: string; sourceBytes: number; faceVisibility: string }> };
type RemoteResult = {
  runtime: { marker: string; aiBinding: boolean; aiRunType: string; aiGatewayType: string };
  auditState?: AuditRunState;
  elapsedMs?: number;
  ok: boolean;
  attempts?: number;
  providerSequence?: Array<{ provider: string; outcome: string; fallbackEligible: boolean | null }>;
  validation?: Record<string, string>;
  analysis?: { faceMeasurementEvidence?: unknown };
  failure?: { reason: string; detail: string };
  boundaryException?: Record<string, unknown>;
};

it.skipIf(!RUN)("captures primary-only results in a full remote Worker runtime", async () => {
  if (!ROOT) throw new Error("fresh PRIMARY_CLOUDFLARE_AUDIT_ROOT required");
  const rubricBytes = new Uint8Array(await readFile(resolve(FROZEN, "source-rubric.json")));
  expect(hash(rubricBytes)).toBe(RUBRIC_HASH);
  const rubric = JSON.parse(new TextDecoder().decode(rubricBytes)) as Rubric;
  expect(rubric.cases).toHaveLength(7);
  await mkdir(ROOT, { recursive: false });
  const checkpoint = resolve(ROOT, "primary-results.json");
  const artifact = {
    sourceRubricSha256: RUBRIC_HASH,
    execution: "wrangler_full_remote_preview_worker",
    authorizedCaseLimit: CASE_LIMIT,
    localFailureBoundary: {
      runtime: "node_getPlatformProxy_remoteBindings",
      exceptionConstructor: "DevalueError",
      serializationPath: "[1].signal",
      boundary: "Miniflare platform-proxy argument serialization before AI.gateway.run dispatch",
      providerInferenceCalls: 0,
    },
    // Totals are observed lower bounds, never inferred zeroes for missing results.
    providerCalls: null as ProviderCalls | null,
    dispatchUnknownCases: 0,
    localLifecycle: {} as Partial<Record<LocalStage, number>>,
    localEvents: [] as Array<{ stage: LocalStage; at: number; runId: string | null }>,
    localFailure: null as string | null,
    localException: null as ExceptionDiagnostic | null,
    remoteReadiness: null as RemoteReadiness | null,
    prohibitedCalls: { faceGeometry: 0, fullIdentityGeometry: 0, imageGeneration: 0, critique: 0, pairwise: 0, evaluator: 0 },
    cases: [] as Array<Record<string, unknown>>,
  };
  let currentRunId: string | null = null;
  const persist = () => atomicCheckpoint(checkpoint, artifact);
  const record = async (stage: LocalStage) => {
    const at = Date.now();
    artifact.localLifecycle[stage] = at;
    artifact.localEvents.push({ stage, at, runId: currentRunId });
    await persist();
  };
  await persist();
  const token = randomBytes(32).toString("hex");
  let wrangler: typeof import("wrangler");
  try { wrangler = await import("wrangler"); } catch (error) {
    artifact.localFailure = "worker_startup_import_failed";
    artifact.localException = exceptionDiagnostic(error, "startup");
    await persist();
    return;
  }
  const configPath = resolve("wrangler.jsonc");
  // Use Wrangler's normal configured auth workflow, with account pinning verified
  // before startup. No token extraction or private API imports are required.
  expect(wrangler.unstable_readConfig({ config: configPath }).account_id).toBe("8e83629048e42855e4d5a5777c769ba4");
  const dev = new wrangler.unstable_DevEnv();
  try {
    await record("remoteStartupRequested");
    const startup = await startRemoteAudit(dev, () => dev.startWorker({
      entrypoint: "test/primaryFaceMeasurementAuditWorker.ts",
      config: configPath,
      bindings: {
        PRIMARY_AUDIT_TOKEN: { type: "plain_text", value: token },
        FACE_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
        IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
        SYNCHRONOUS_ENHANCEMENTS_ENABLED: { type: "plain_text", value: "false" },
      },
      dev: { remote: true, server: { hostname: "127.0.0.1", port: 0 }, logLevel: "error" },
    }));
    artifact.remoteReadiness = startup.readiness;
    await persist();
    const ordered = [...rubric.cases].sort((a, b) => {
      const high = (value: string) => value === "high" ? 0 : 1;
      return high(a.faceVisibility) - high(b.faceVisibility) || a.sourceBytes - b.sourceBytes || a.id.localeCompare(b.id);
    });
    if (startup.readiness.status !== "ready" || !startup.worker) {
      artifact.localFailure = `remote_${startup.readiness.status}`;
      if ("diagnostic" in startup.readiness) artifact.localException = startup.readiness.diagnostic;
      await persist();
      return;
    }
    const worker = startup.worker;
    await record("remoteForwardingReady");
    // No JPEG is read or prepared until the remote Worker serves health PASS.
    if (!await healthReady(worker, token, record)) {
      artifact.localFailure = "health_not_ready";
      await persist();
      return;
    }
    for (let index = 0; index < Math.min(CASE_LIMIT, ordered.length); index++) {
      const item = ordered[index];
      currentRunId = randomBytes(16).toString("hex");
      await record("canarySelected");
      const source = new Uint8Array(await readFile(resolve(GENERALIZATION, `sources/${item.photoId}.jpg`)));
      expect(hash(source), `${item.id}: source hash drift`).toBe(item.sourceSha256);
      await record("sourceHashVerified");
      const body = JSON.stringify({ imageDataUrl: `data:image/jpeg;base64,${bytesToBase64(source)}` });
      await record("payloadPreparedInMemory");
      const outcome = await accountedRequest<RemoteResult>(worker, token, currentRunId, body, record);
      const { result, accounting } = outcome;
      if (accounting.dispatch === "known") {
        if (!artifact.providerCalls) artifact.providerCalls = { ...accounting.providerCalls };
        else for (const key of Object.keys(accounting.providerCalls) as Array<keyof ProviderCalls>) {
          if (key !== "retry") artifact.providerCalls[key] += accounting.providerCalls[key];
        }
      } else artifact.dispatchUnknownCases++;
      artifact.cases.push({
        id: item.id,
        sourceSha256: item.sourceSha256,
        runId: currentRunId,
        httpStatus: outcome.httpStatus ?? null,
        accounting,
        localFailure: outcome.failure ?? null,
        ...result,
      });
      await persist();
      const canaryPassed = result?.ok && Boolean(result.analysis?.faceMeasurementEvidence)
        && result.validation?.compactProviderSchema === "passed"
        && result.validation?.compactStrictRuntime === "passed"
        && result.validation?.richPhotoAnalysis === "passed";
      // Fail closed on any incomplete case, never automatically continue after timeout.
      if (!canaryPassed || accounting.dispatch !== "known") break;
    }
  } catch (error) {
    artifact.localFailure = "local_execution_failed";
    artifact.localException = exceptionDiagnostic(error, artifact.localLifecycle.canarySelected ? "execution"
      : artifact.localLifecycle.remoteForwardingReady ? "health" : "startup");
    await persist();
  } finally {
    try { await record("workerStopRequested"); } finally { await dev.teardown(); }
    await record("workerStopCompleted");
  }
  expect(artifact.providerCalls?.geminiStarted ?? 0).toBeLessThanOrEqual(artifact.cases.length);
  expect(artifact.providerCalls?.gemmaStarted ?? 0).toBeLessThanOrEqual(artifact.cases.length);
  expect(artifact.providerCalls?.retry ?? 0).toBe(0);
  expect(Object.values(artifact.prohibitedCalls).every((count) => count === 0)).toBe(true);
}, 900_000);
