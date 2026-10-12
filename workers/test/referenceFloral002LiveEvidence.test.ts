// Immutable consumed live evidence only. No runner imports, inference, or replay.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-floral-20261008-002";
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

it("recovers 31 immutable checkpoints and preserves the actual failed production result", () => {
  const names = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(31);
  for (const name of names) {
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const final = JSON.parse(fs.readFileSync(path.join(root, names.at(-1)!), "utf8"));
  expect(final).toMatchObject({ sequence: 31, event: "auditLifecycleFinalized",
    snapshotSha256: "f9ee216fe2eb73dda3a1f858ad609862cac5b05d07878adf428eeef6ec6ce40d" });
  expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "3243508e66f19791e7e43bb0ad69bcd7", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 503, elapsedMs: 55021, diskRecovery: true,
    classification: "CURRENT_DEFAULT_V3_E2E_FAILED", png: null });
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
});

it("distinguishes validated late binding completion from production adoption and preserves exact call accounting", () => {
  const result = run.result;
  expect(result).toMatchObject({ productionStatus: 503, ok: false, errorCode: "provider_unavailable" });
  expect(result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 1302 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 51900, deadlineMs: 50000 }),
  ]);
  const primary = result.diagnostics.primaryDiagnostic;
  expect(primary.ok).toBe(false); expect(primary.attempts).toBe(2);
  expect(primary.providerAttempts).toHaveLength(4);
  expect(primary.providerAttempts[1]).toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
  expect(primary.providerAttempts[3]).toMatchObject({ outcome: "failed", origin: "LOCAL_DEADLINE",
    configuredDeadlineMs: 50000, elapsedMs: 50000, deadlineTimerFired: true });
  expect(result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(result.diagnostics.geometry).toBeNull();
  expect(run.e2eGateTrace).toMatchObject({ handlerInvocationReturned: true, responseStatus: 503,
    providerAttemptIntent: 2, providerAttemptStarted: 2, failureStage: "handler_response" });
});

it("uses the same approved photo derivatives and completes one graceful teardown", () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    analysis: { bytes: 37315, width: 597, height: 896,
      sha256: "37bc492664ae92e9d3f1719f96e45bd3156ec6a16d71c2f8a727af39f2b76a2b" },
    generation: { bytes: 13870, width: 299, height: 448,
      sha256: "9107658b3e168cef7b9f5bf2611ed95d3fc51e3ac335329aa9d96a20c3a065fa" } });
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
