// Read-only recovery of a consumed run. No live runner imports or network.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-002";
const bytes = readFileSync(`${root}/summary.json`);
const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers all 29 consecutive snapshots and the finalized authoritative state", () => {
  expect(sha(bytes)).toBe("831e143aad0e79d04d0bf6a13dd8d5ef67429a9e454d0ad03089ce67c8c3ce3e");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(29);
  for (const [i, name] of names.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const final = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(final.event).toBe("auditLifecycleFinalized");
  expect(final.snapshot).toEqual(s);
  expect(e.diskRecovery).toBe(true);
});

it("does not convert an E2E HTTP 503 into an inferred provider result or zero calls", () => {
  expect(e).toMatchObject({ runId: "be71cb50483c0834df769cd3f7714422", generationPosts: 1,
    providerRetry: 0, accounting: "unknown", httpStatus: 503, elapsedMs: 19953,
    gateBoundary: "unobserved", result: null, e2eGateTrace: null,
    httpObservation: { stage: "json_parse", httpStatus: 503, jsonRootType: null,
      exception: { name: "SyntaxError" } } });
  expect(s.providerAccounting).toBe("unknown");
  expect(s.classification).toBe("BLOCKED: E2E HTTP response JSON unavailable; provider accounting unknown");
  expect(e.png).toBeNull(); expect(e.propagationLink).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
});

it("pins the authorized source and actual production derivatives under the unchanged V3 contract", () => {
  expect(e.preprocessing.source).toMatchObject({ caseId: "reference-neck-scarf-001",
    sha256: "37a05c13ed0b640d15f6b7596e9ca8090876d51545b585c2ca3a09a6819f41f8" });
  expect(e.preprocessing.analysis).toMatchObject({ width: 597, height: 896, bytes: 45541,
    sha256: "1e80b7e237ed1060621b5af5901ce3de8d6bd73e328226fb7b554a0bf16ce6be" });
  expect(e.preprocessing.generation).toMatchObject({ width: 299, height: 448, bytes: 16081,
    sha256: "8a1f5ded9d3ba76fc869767096074dc8aa6a705dace90c57b4cd8b1cc0ca69aa" });
  expect(e.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(e.contract).toMatchObject({ version: "primary_compact_v3_legacy_suffix",
    primaryTimeoutMs: 45000, gemmaPrimaryTimeoutMs: 55000, geometryTimeoutMs: 25000 });
});

it("confirms one-shot health and complete graceful local cleanup without claiming remote deletion", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
