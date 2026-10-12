// Consumed live evidence only: no runner, image read, or network execution.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-003";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("pins D003 checkpoints and distinguishes stage observations from provider accounting", () => {
  const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
  expect(sha(bytes)).toBe("fc398de86706dbd34810e00a6584a9d51f30b18ebd2c65665319c4691964c0ff");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(42);
  for (const [i, file] of files.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s.currentDefaultE2E).toMatchObject({ runId: "2928c95a22fd4e6d3985f33b5316efad",
    generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 52295,
    accounting: "unknown", result: null, png: null, diskRecovery: true,
    httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
      codeAmbiguous: false, inspectionTruncated: false } } });
  expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
  const stages = ["input_verified", "handler_entered", "geminiPrimary_invoked", "geminiPrimary_returned",
    "gemmaPrimary_invoked", "gemmaPrimary_returned", "gemmaPrimary_inspection_started",
    "gemmaPrimary_inspection_finished", "faceGeometry_invoked", "faceGeometry_returned",
    "faceGeometry_inspection_started", "faceGeometry_inspection_finished"];
  expect(s.terminalStageEvidence.observations).toHaveLength(stages.length);
  for (const [i, observation] of s.terminalStageEvidence.observations.entries()) {
    expect(Object.keys(observation).sort()).toEqual(["receivedElapsedMs", "runId", "stage"]);
    expect(observation.runId).toBe(s.currentDefaultE2E.runId);
    expect(observation.stage).toBe(stages[i]);
    expect(observation.receivedElapsedMs).toBeGreaterThanOrEqual(61775);
    expect(observation.receivedElapsedMs).toBeLessThanOrEqual(61776);
  }
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  const prior = JSON.parse(readFileSync(root.replace(/003$/, "002") + "/summary.json", "utf8"));
  expect(s.currentDefaultE2E.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
  expect(s.currentDefaultE2E.fixedHashes).toEqual(prior.currentDefaultE2E.fixedHashes);
  expect(Object.keys(s.currentDefaultE2E.fixedHashes)).toHaveLength(74);
  for (const [file, hash] of Object.entries(s.currentDefaultE2E.fixedHashes))
    expect(sha(readFileSync(resolve(file))), file).toBe(hash);
  const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-003-failure-review-20261010-");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
    sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId, checkpointCount: files.length,
    classification: "reported_1102_after_observed_geometry_inspection",
    observedStages: stages, providerAccounting: "unknown", cpuVersusMemory: "unobserved",
    handlerReturnObserved: false, auditPropagationObserved: false, pngAvailable: false,
    limitations: ["missing best-effort markers do not prove non-execution",
      "binding return and inspection finish are not provider or semantic validation success",
      "batched receipt timestamps are not stage durations"],
    startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCalls: 0,
    checkpointIntegrity: true, gracefulCleanup: true, sameDerivativesAndProductionHashes: true,
    nextBoundary: "offline_post_geometry_production_work_cost_and_failure_attribution",
  }, null, 2), { flag: "wx" });
  console.info("D003_FAILURE_REVIEW", out);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
