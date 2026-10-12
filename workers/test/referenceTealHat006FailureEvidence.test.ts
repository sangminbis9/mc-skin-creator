// Consumed evidence only; no runner import, source image read, or inference.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-006";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("preserves D006 reported 1102 and observed production completion without inventing a recovered PNG or ledger", () => {
  const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
  expect(sha(bytes)).toBe("4070a2047efcc694d843d5ab76b9697a329d483f8c3966547cfb445e408d8bc9");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(54);
  for (const [i, file] of files.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s.currentDefaultE2E).toMatchObject({ runId: "fe99d7b88c8272bc45f9aaebb60b42de",
    generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 40373,
    accounting: "unknown", result: null, png: null, diskRecovery: true,
    httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
      codeAmbiguous: false, inspectionTruncated: false } } });
  expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  const stages = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
  expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
  expect(stages).toHaveLength(24);
  expect(stages.slice(-4)).toEqual(["production_png_finished", "production_baseline_returned", "handler_returned", "propagation_started"]);
  expect(stages).not.toContain("propagation_finished");
  for (const stage of ["geminiPrimary_invoked", "geminiPrimary_returned", "gemmaPrimary_invoked", "gemmaPrimary_returned"])
    expect(stages.filter((value: string) => value === stage)).toHaveLength(1);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  expect(s.shutdownLatch.phase).toBe("finalized");
  const prior = JSON.parse(readFileSync(root.replace(/006$/, "005") + "/summary.json", "utf8"));
  const { browserRuntime: browserNow, ...preprocessing } = s.currentDefaultE2E.preprocessing;
  const { browserRuntime: browserBefore, ...previousPreprocessing } = prior.currentDefaultE2E.preprocessing;
  expect(preprocessing).toEqual(previousPreprocessing);
  expect(browserNow).toContain("Chrome/154.0.0.0");
  expect(browserBefore).toContain("Chrome/155.0.0.0");
  const changes = Object.keys(s.currentDefaultE2E.fixedHashes).filter(f =>
    s.currentDefaultE2E.fixedHashes[f] !== prior.currentDefaultE2E.fixedHashes[f]).map(f => f.replaceAll("\\", "/"));
  expect(changes.sort()).toEqual(["src/generate.ts", "src/headOwnership.ts", "src/headwearFootprint.ts",
    "src/outfitIdentity.ts", "src/outfitRenderer.ts", "src/referenceFaceFinish.ts", "src/referenceStyleSelection.ts", "src/skinPack.ts"]);
  const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-006-failure-review-20261010-");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
    sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId, checkpointCount: files.length,
    observedStages: stages, providerAccounting: "unknown", pngAvailable: false,
    productionPngFinishMarkerObserved: true, productionHandlerReturnObserved: true,
    auditPropagationStartObserved: true, auditPropagationFinishObserved: false,
    remoteCpuMeasurementAvailable: false, failureFunctionNotProven: true,
    startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCalls: 0,
    checkpointIntegrity: true, gracefulCleanup: true, sameDerivatives: true,
    browserRuntimeEqual: false, browserRuntime: browserNow, previousBrowserRuntime: browserBefore,
    nextBoundary: "reduce_advisory_remote_replay_cost_without_changing_production_or_claiming_unverified_pixels",
  }, null, 2), { flag: "wx" });
  console.info("D006_FAILURE_REVIEW", out);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
