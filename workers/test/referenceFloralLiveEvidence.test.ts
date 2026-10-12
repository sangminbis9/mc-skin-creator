// Read-only recovery of one consumed run; never imports a runner or sends requests.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-floral-20261008-001";
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

it("recovers all immutable checkpoints and a finalized consumed E2E without interpreting test success as generation success", () => {
  const names = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(30);
  for (const name of names) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  }
  const final = JSON.parse(fs.readFileSync(path.join(root, names.at(-1)!), "utf8"));
  expect(final).toMatchObject({ sequence: 30, event: "auditLifecycleFinalized",
    snapshotSha256: "6ed2c18f6fb2c5e4829268ee11dbf63f04eed91641bec2f74231f234df4ea76f" });
  expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "70a5f8e1dbb210107f1cf9ffd8ba20ab", generationPosts: 1,
    providerRetry: 0, httpStatus: 503, elapsedMs: 20981, accounting: "unknown", diskRecovery: true });
  expect(summary.shutdownLatch).toEqual({ phase: "finalized", qClaimed: true, qDispatched: true, qFailed: false });
});

it("retains the observed HTTP/JSON boundary, not an invented provider failure or zero inference count", () => {
  expect(run.httpObservation).toMatchObject({ stage: "json_parse", httpStatus: 503,
    jsonRootType: null, exception: { name: "SyntaxError" } });
  expect(run.classification).toBe("BLOCKED: E2E HTTP response JSON unavailable; provider accounting unknown");
  expect(run.result).toBeNull(); expect(run.e2eGateTrace).toBeNull(); expect(run.gateBoundary).toBe("unobserved");
  expect(run.png).toBeNull(); expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
  // The generic primary-only counters cannot fill missing E2E binding evidence.
  expect(run.accounting).not.toBe("known");
});

it("preserves exact photo provenance and derivative identities without sending the target atlas", () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    source: { caseId: "reference-floral-001", width: 1024, height: 1536, bytes: 1848048,
      sha256: "8f61eb41759196a303a94514d96173b08e2f51add2135296cd9028c8ae84e950" },
    analysis: { width: 597, height: 896, bytes: 37315,
      sha256: "37bc492664ae92e9d3f1719f96e45bd3156ec6a16d71c2f8a727af39f2b76a2b" },
    generation: { width: 299, height: 448, bytes: 13870,
      sha256: "9107658b3e168cef7b9f5bf2611ed95d3fc51e3ac335329aa9d96a20c3a065fa" } });
  expect(run.contract.version).toBe("primary_compact_v3_legacy_suffix");
});

it("records one graceful shutdown and clean local ownership without claiming remote deletion or cancellation", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, devServerReadyReceived: true,
    wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
});
