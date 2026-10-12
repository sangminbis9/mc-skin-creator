// Consumed D001 is read-only. No remote runner, credentials or inference.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-001";
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("pins D001's reported 1102 without inventing a provider failure or CPU-versus-memory origin", () => {
  expect(sha(bytes)).toBe("e3311c1fa2a95a871d1a738195b15ff1e83c94ecb4e0f31696f769553f15b388");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(30);
  for (const [i, file] of files.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s.currentDefaultE2E).toMatchObject({ runId: "cf7fa8a77ec84c2f61f4d17996be2207",
    generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 43304, accounting: "unknown",
    result: null, png: null, diskRecovery: true, gateBoundary: "unobserved",
    httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
      codeAmbiguous: false, inspectionTruncated: false } } });
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-001-failure-review-20261010-");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review",
    root, sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId,
    classification: "remote_error_page_reports_resource_limit_1102", cpuVersusMemory: "unobserved",
    failingComponent: "unobserved", providerAccounting: "unknown", pngAvailable: false,
    startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCalls: 0,
    checkpointIntegrity: true, gracefulCleanup: true, productionConfigUnchanged: true,
    prior503sSameCause: "not_proven", qualityConclusion: "unavailable_no_primary_or_png",
    nextBoundary: "offline_resource_profile_of_production_render_and_audit_replay",
  }, null, 2), { flag: "wx" });
  console.info("D001_FAILURE_REVIEW", out);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
