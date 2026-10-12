// Read-only verification of consumed H-005; never imports a live runner.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-005";
const bytes = readFileSync(`${root}/summary.json`);
const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers all 31 authoritative checkpoints and preserves consumed H-004", () => {
  expect(sha(bytes)).toBe("1cc60c97e2b80ebd3332b862b3d1744a5e2623c1bdd3acf53f3ddef11cb38850");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(31);
  for (const [i, file] of files.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8")).snapshot).toEqual(s);
  const previous = readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-004/summary.json");
  expect(sha(previous)).toBe("2ee9f94be2939da93bfbf8468e4cf2f692a8be34a13210183d4ff2fbfaa9ef06");
  const prior = JSON.parse(previous.toString()).currentDefaultE2E;
  expect(e.runId).not.toBe(prior.runId);
  for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(prior.preprocessing[key]);
  expect(e.contract).toEqual(prior.contract);
});

it("distinguishes Gemini HTTP failure from Gemma local deadline and unobserved binding completion", () => {
  expect(e).toMatchObject({ runId: "a4dc688222d51bd33e9baa04a8588263", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 503, elapsedMs: 59453, diskRecovery: true });
  expect(e.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", started: true, completion: "returned", httpStatus: 400 }),
    expect.objectContaining({ stage: "gemmaPrimary", started: true, completion: "pending", httpStatus: null, elapsedMs: null }),
  ]);
  const attempts = e.result.diagnostics.primaryDiagnostic.providerAttempts;
  expect(attempts).toHaveLength(4);
  expect(attempts[1]).toMatchObject({ outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
    fallbackEligible: true, fallbackReason: "provider_failed_precondition" });
  expect(attempts[3]).toMatchObject({ outcome: "failed", status: 504, providerStatus: "DEADLINE_EXCEEDED",
    origin: "LOCAL_DEADLINE", elapsedMs: 55000, deadlineTimerFired: true });
  expect(e.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerAttemptIntent: 2, providerAttemptStarted: 2, responseStatus: 503, failureStage: "handler_response" });
});

it("does not manufacture validation, geometry or hair/bow delivery evidence after primary failure", () => {
  expect(s.classification).toBe("CURRENT_DEFAULT_V3_E2E_FAILED");
  for (const key of ["primaryValidation", "normalizedPrimary", "localization", "geometry"])
    expect(e.result.diagnostics[key]).toBeNull();
  expect(e.png).toBeNull(); expect(e.propagationLink).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(e.result.bindingAttempts.some((a: { stage: string }) => /geometry/i.test(a.stage))).toBe(false);
  expect(Object.values(s.prohibited).every(v => v === 0)).toBe(true);
});

it("confirms one-shot graceful finalization and the recorded production config equality", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  // The pinned summary/checkpoints prove the then-current source identity.
  // A historical failure record must not require future production bytes to freeze forever.
  expect(e.fixedHashes["wrangler.jsonc"]).toBe(s.productionConfigHashBefore);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
