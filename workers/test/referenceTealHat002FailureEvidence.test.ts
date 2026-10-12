// Immutable consumed D002; no remote runner or provider calls.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-002";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("preserves repeated 1102 after audit optimization without inferring unseen provider accounting", () => {
  const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
  expect(sha(bytes)).toBe("07786b038736fad4fc564fbc4e4f45d3eeff710fe27947bef602613d6a361954");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(30);
  for (const [i, f] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s.currentDefaultE2E).toMatchObject({ runId: "5fcff5807e57b97d6191e94bb3d256d8",
    generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 54900, accounting: "unknown",
    result: null, png: null, diskRecovery: true, gateBoundary: "unobserved",
    httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
      codeAmbiguous: false, inspectionTruncated: false } } });
  expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  const prior = JSON.parse(readFileSync(root.replace(/002$/, "001") + "/summary.json", "utf8"));
  expect(s.currentDefaultE2E.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
  expect(s.currentDefaultE2E.fixedHashes).toEqual(prior.currentDefaultE2E.fixedHashes);
  for (const [file, hash] of Object.entries(s.currentDefaultE2E.fixedHashes))
    expect(sha(readFileSync(resolve(file))), file).toBe(hash);
  const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-002-failure-review-20261010-");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
    sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId,
    classification: "reported_1102_persists_after_selected_design_audit_optimization",
    cpuVersusMemory: "unobserved", failingComponent: "unobserved", providerAccounting: "unknown",
    priorAndCurrentReachedAuditReplay: "unobserved", pngAvailable: false,
    startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCalls: 0,
    checkpointIntegrity: true, gracefulCleanup: true, sameDerivativesAndProductionHashes: true,
    qualityConclusion: "unavailable_no_primary_or_png",
    nextBoundary: "resource_failure_stage_and_CPU_versus_memory_evidence_before_another_live_run",
  }, null, 2), { flag: "wx" });
  console.info("D002_FAILURE_REVIEW", out);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
