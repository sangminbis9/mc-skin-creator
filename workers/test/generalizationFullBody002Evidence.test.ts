// Immutable failure evidence only: never imports a live runner or calls a provider.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

const root = path.resolve("evaluation-artifacts/generalization-v3-e2e-full-body-layered-20261008-002");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers every immutable checkpoint and preserves a terminal single-use run", () => {
  const names = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(31);
  for (const name of names) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  }
  const final = JSON.parse(fs.readFileSync(path.join(root, names.at(-1)!), "utf8"));
  expect(final).toMatchObject({ event: "auditLifecycleFinalized", sequence: 31,
    snapshotSha256: "76630fec6b7c7f6d5efaae7fff8a7560e4519b3e24d26f8c91f7a5ed1d5a1226" });
  expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "ccb36828e545265fe3f08c6c995beb96", generationPosts: 1,
    providerRetry: 0, httpStatus: 503, elapsedMs: 55108, accounting: "known", diskRecovery: true });
});

it("does not equate production timeout with a returned provider failure or infer a late result", () => {
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", started: true, completion: "returned",
      httpStatus: 400, elapsedMs: 1772, deadlineMs: 45000 }),
    expect.objectContaining({ stage: "gemmaPrimary", started: true, completion: "pending",
      httpStatus: null, elapsedMs: null, deadlineMs: 50000 }),
  ]);
  const attempts = run.result.diagnostics.primaryDiagnostic.providerAttempts;
  expect(attempts.map((v: { outcome: string }) => v.outcome)).toEqual(["started", "failed", "started", "failed"]);
  expect(attempts[1]).toMatchObject({ status: 400, providerStatus: "FAILED_PRECONDITION",
    fallbackEligible: true, fallbackReason: "provider_failed_precondition" });
  expect(attempts[3]).toMatchObject({ origin: "LOCAL_DEADLINE", elapsedMs: 50000,
    deadlineTimerFired: true, configuredDeadlineMs: 50000 });
  expect(run.result.diagnostics.primaryValidation).toBeNull();
  expect(run.result.diagnostics.normalizedPrimary).toBeNull();
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.result.propagationTrace).toMatchObject({
    evidenceScope: "this_request_only_not_historical_recovery", primary: null,
    parameterEvidence: "unverified", selectedFamilies: null, injectedParameters: null,
    skinPlan: { skinPlan: null }, finalPng: null, replay: null,
  });
  expect(run.png).toBeNull();
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
});

it("links transmitted derivatives to the frozen approved source and preserves handler accounting", () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    source: { caseId: "full-body-layered", bytes: 669646,
      sha256: "9b482fd0d2e88566fc3a75340f4047b3a55e20aabe56dbb502b5c022dbe7a5be" },
    analysis: { width: 597, height: 896, bytes: 115138,
      sha256: "bd4ebb493a17d16bf630d6f8b329ebef5e88228e45c84ee23b44e5575626ae71" },
    generation: { width: 299, height: 448, bytes: 37776,
      sha256: "a11ac58f8c93feb2f45c89216a460d92e79ec8a553c8f72cc6554e55d4f0aa8a" } });
  expect(run.e2eGateTrace).toMatchObject({ routeEntered: true, payloadValidated: true,
    preprocessingValidated: true, handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerAttemptIntent: 2, providerAttemptStarted: 2, failureStage: "handler_response",
    failureCode: "production_handler_http_error", responseStatus: 503 });
  // Generic primary-only counters are not the accounting source for this E2E route.
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("proves graceful local teardown without asserting unobserved remote cancellation/deletion", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
    health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false,
    shutdownLatch: { phase: "finalized", qClaimed: true, qDispatched: true, qFailed: false } });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
});
