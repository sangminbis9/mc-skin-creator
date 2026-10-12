import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies 030 local deadline without claiming provider completion or cancellation", () => {
  const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-030";
  const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result;
  const history = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-Tm20cl/verification.json", "utf8"));
  for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  for (const [i, file] of files.entries()) { const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256); }
  expect(JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8")).snapshot).toEqual(s);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, ownerResultFlushed: true, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerExitObserved: true, ownerCloseObserved: true, wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
  expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 503, accounting: "known", diskRecovery: true, png: null });
  const changed = Object.entries(e.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file.replaceAll("\\", "/"));
  expect(changed).toEqual(["src/outfitIdentity.ts"]);
  const prior = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-029/summary.json", "utf8")).currentDefaultE2E;
  for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(prior.preprocessing[key]);
  expect(r.bindingAttempts).toMatchObject([{ stage: "geminiPrimary", started: true, completion: "returned", httpStatus: 503 },
    { stage: "gemmaPrimary", started: true, completion: "pending", httpStatus: null, elapsedMs: null }]);
  expect(r.bindingAttempts).toHaveLength(2);
  const primary = r.diagnostics.primaryDiagnostic;
  expect(primary.providerAttempts[1]).toMatchObject({ status: 503, providerStatus: "UNAVAILABLE", fallbackEligible: true });
  expect(primary.providerAttempts[3]).toMatchObject({ outcome: "failed", status: 504, providerStatus: "DEADLINE_EXCEEDED",
    origin: "LOCAL_DEADLINE", configuredDeadlineMs: 45000, deadlineTimerFired: true });
  expect(r.diagnostics.primaryValidation).toBeNull(); expect(r.diagnostics.normalizedPrimary).toBeNull();
  expect(r.diagnostics.geometry).toBeNull(); expect(r.diagnostics.failedFaceMeasurement).toBeUndefined();
  expect(e.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerAttemptIntent: 2, providerAttemptStarted: 2, responseStatus: 503, failureStage: "handler_response" });
  const out = mkdtempSync("evaluation-artifacts/current-030-failure-verification-20260928-");
  writeFileSync(`${out}/verification.json`, JSON.stringify({ summarySha256: sha(bytes), checkpointCount: files.length,
    historicalFilesPreserved: Object.keys(history.preservedHashes).length, offlineProductionChangesAfterLive: changed,
    liveAccounting: { startup: 1, health: 1, post: 1, geminiStarted: 1, gemmaStarted: 1, geometry: 0, retry: 0 },
    observedGemmaCompletion: false, remoteCancellationObserved: false, png: null, offlineProviderCalls: 0,
    limitation: "Local deadline terminated the handler wait; native inference final outcome and cancellation are unobserved. No schema/semantic conclusion and no retry." }, null, 2));
  console.info(`FAILURE_030_VERIFICATION ${out}`);
});
