import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-013";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers consumed 013 failure without treating pending Gemma completion as cancellation or success", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(name => name.endsWith(".json"));
    const hashes = Object.fromEntries(names.map(name => [name, sha(readFileSync(`${root}/${name}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = names.filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name)).sort();
    expect(checkpoints).toHaveLength(29);
    for (const [index, name] of checkpoints.entries()) {
      const record = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(record.sequence).toBe(index + 1);
      expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
      health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
      ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false, productionAdditionalDiff: 0,
      serverSidePreviewDeletionIndependentlyConfirmed: false });
    const state = summary.currentDefaultE2E, result = state.result;
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, accounting: "known",
      httpStatus: 503, png: null, cropReplay: null, diskRecovery: true,
      classification: "CURRENT_DEFAULT_V3_E2E_FAILED" });
    expect(state.e2eGateTrace).toMatchObject({ contextValidated: true, payloadValidated: true,
      preprocessingValidated: true, handlerInvocationStarted: true, handlerInvocationReturned: true,
      providerDispatchObserved: true, providerAttemptIntent: 2, providerAttemptStarted: 2,
      responseStatus: 503, failureStage: "handler_response", failureCode: "production_handler_http_error" });
    expect(result).toMatchObject({ ok: false, errorCode: "provider_unavailable",
      contract: "primary_compact_v3_legacy_suffix", generationMode: null, features: null });
    expect(result.bindingAttempts).toHaveLength(2);
    expect(result.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", started: true,
      completion: "returned", httpStatus: 503 });
    expect(result.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", started: true,
      completion: "pending", httpStatus: null, elapsedMs: null });
    const attempts = result.diagnostics.primaryDiagnostic.providerAttempts;
    expect(attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(["started", "failed", "started", "failed"]);
    expect(attempts[1]).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash",
      status: 503, providerStatus: "UNAVAILABLE", fallbackEligible: true, fallbackReason: "provider_failure" });
    expect(attempts[3]).toMatchObject({ provider: "workers_ai", model: "@cf/google/gemma-4-26b-a4b-it",
      status: 504, providerStatus: "DEADLINE_EXCEEDED", origin: "LOCAL_DEADLINE",
      elapsedMs: 45000, deadlineTimerFired: true });
    expect(result.diagnostics.primaryValidation).toBeNull();
    expect(result.diagnostics.normalizedPrimary).toBeNull();
    expect(result.diagnostics.geometry).toBeNull();
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    expect(result.inputs.analysis).toMatchObject({ width: 597, height: 896, bytes: 110605,
      sha256: "a98165d2ed43a031cfbd182871417a3555f31474a630df6a6be34278b5e317f3" });
    expect(result.inputs.generation).toMatchObject({ width: 299, height: 448, bytes: 37408,
      sha256: "ec7cdfde25a13bbdd3d2c9bd28d512b6fdaf635d214c2a6fde6eb5edacf9ccf7" });
    for (const [file, expected] of Object.entries(state.fixedHashes)) expect(sha(readFileSync(file))).toBe(expected);
    const output = mkdtempSync("evaluation-artifacts/current-013-failure-verification-20260927-");
    writeFileSync(`${output}/verification.json`, JSON.stringify({ mode: "offline_only", providerCallsThisVerification: 0,
      liveSummarySha256: hashes["summary.json"], checkpointCount: checkpoints.length,
      checkpointIntegrity: true, productionHashesUnchanged: true,
      source: "currentDefaultE2E.result.bindingAttempts and primaryDiagnostic, not generic top-level counters",
      providerAttemptsStarted: 2, completedBindingResponses: 1, pendingBindingResponses: 1,
      primaryOutcome: "provider_unavailable", remoteGemmaCompletionOrCancellation: "unobserved",
      pngObtained: false, likenessPropagation: "not_measured", teardownPassed: true,
      nextBoundary: "fresh provider result requires new bounded live authorization" }, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled();
    console.info(`LIVE_013_FAILURE_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
});
