// Immutable same-run recovery only. Never imports a remote runner or provider.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-021";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D021's local Gemma deadline without inventing provider completion, cancellation or image evidence", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("912ba4af468681da052b8dd78a59d8944e16c07bf4dd6bec9d2e107fe8016c49");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(43); // snapshot counter precedes the finalization write
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_FAILED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
      ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      serverSidePreviewDeletionIndependentlyConfirmed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(s.shutdownLatch.phase).toBe("finalized");
    const e = s.currentDefaultE2E, r = e.result;
    expect(e).toMatchObject({ runId: "084a24ecbddb57fe2cfc7d255bc36920", generationPosts: 1,
      providerRetry: 0, httpStatus: 503, elapsedMs: 64610, accounting: "known", diskRecovery: true,
      png: null, propagationLink: null });
    expect(r).toMatchObject({ productionStatus: 503, ok: false, errorCode: "provider_unavailable",
      contract: "primary_compact_v3_legacy_suffix" });
    expect(r.bindingAttempts).toEqual([
      { stage: "geminiPrimary", started: true, completion: "returned", elapsedMs: 1157, httpStatus: 400,
        deadlineMs: 45000, schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" },
      { stage: "gemmaPrimary", started: true, completion: "pending", elapsedMs: null, httpStatus: null,
        deadlineMs: 60000, schemaSha256: "498a0ad85e255bf3f518deb216abdc18af2f45fa15a45a5a58954abb2a73a4d6" },
    ]);
    expect(r.diagnostics.primaryDiagnostic.attempts).toBe(2);
    const attempts = r.diagnostics.primaryDiagnostic.providerAttempts;
    expect(attempts).toHaveLength(4); // start + terminal diagnostic per attempt, not four calls
    expect(attempts[1]).toMatchObject({ provider: "gemini", outcome: "failed", status: 400,
      providerStatus: "FAILED_PRECONDITION", fallbackEligible: true, fallbackReason: "provider_failed_precondition",
      deadlineTimerFired: false, attemptOrdinal: 1 });
    expect(attempts[3]).toMatchObject({ provider: "workers_ai", outcome: "failed", status: 504,
      providerStatus: "DEADLINE_EXCEEDED", origin: "LOCAL_DEADLINE", elapsedMs: 60000,
      configuredDeadlineMs: 60000, deadlineTimerFired: true, attemptOrdinal: 2 });
    for (const key of ["primaryValidation", "normalizedPrimary", "localization", "geometry"])
      expect(r.diagnostics[key]).toBeNull();
    expect(r.propagationTrace).toMatchObject({ primary: null, selectedFamilies: null,
      parameterEvidence: "unverified", skinPlan: { skinPlan: null }, finalPng: null });
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    const priorRoot = root.replace(/021$/, "020");
    const priorBytes = readFileSync(`${priorRoot}/summary.json`);
    expect(sha(priorBytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const prior = JSON.parse(priorBytes.toString()).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prior.preprocessing);
    expect(r.inputs).toEqual(prior.result.inputs);
    const changedProductionFiles = Object.keys(e.fixedHashes)
      .filter(k => e.fixedHashes[k] !== prior.fixedHashes[k]).map(k => k.replaceAll("\\", "/"));
    expect(changedProductionFiles.length).toBeGreaterThan(0);
    expect(changedProductionFiles).toContain("src/identityPlans.ts");
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-021-failure-review-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointCount: files.length, checkpointIntegrity: true,
      httpStatus: 503, elapsedMs: 64610, startup: 1, health: 1, e2ePosts: 1,
      geminiPrimaryStarted: 1, geminiPrimaryReturned: 1, geminiStatus: 400,
      geminiProviderStatus: "FAILED_PRECONDITION", fallbackEligible: true,
      gemmaPrimaryStarted: 1, gemmaBindingCompletion: "pending", gemmaHttpStatus: null,
      gemmaLocalDeadlineMs: 60000, gemmaRemoteCompletionObserved: false,
      remoteInferenceCancellationConfirmed: false, geometryCalls: 0,
      providerRetry: 0, offlineProviderCalls: 0, recoveredPng: false, recoveredAnalysis: false,
      samePreprocessing: true, changedProductionFiles,
      latestAccumulatedFixDelivery: "unobserved_provider_failed_before_primary_validation",
      gracefulCleanup: true, qCount: 1, remoteDeletionIndependentlyConfirmed: false,
      productionConfigUnchanged: true, qualityGoalComplete: false,
      nextBoundary: "offline_remaining_reference_quality_review_no_unchanged_live_retry",
    }, null, 2), { flag: "wx" });
    writeFileSync(`${out}/REPORT.md`, ["# D021 consumed live evidence", "",
      "- E2E HTTP 503 after 64,610 ms. No analysis, plan or final PNG was returned.",
      "- Gemini: one request, HTTP 400 FAILED_PRECONDITION; existing policy allowed fallback.",
      "- Gemma: one binding invocation, local 60,000 ms deadline. Binding completion remained pending.",
      "- The 504 diagnostic is a LOCAL_DEADLINE, not an observed Gemma HTTP response.",
      "- Remote completion/cancellation is not established. No additional request was sent.",
      "- Startup/health/E2E POST 1/1/1; primary invocations 2; geometry/retry/other inference 0.",
      "- All 43 checkpoint hashes and final snapshot equality passed. D020 remains immutable.",
      "- Source preprocessing and both derivative identities equal D020; production fixes differ as recorded.",
      "- Literal q once; wrapper/PTY/owner exit, owned inventory and temporary cleanup passed.",
      "- Production config unchanged. Remote preview deletion was not independently confirmed.",
      "- Local runner exit 0 proves lifecycle checks, not successful generation.",
      "- Latest cumulative quality changes remain OFFLINE-proven, not fresh-live-confirmed.",
      "- Goal remains incomplete. Continue offline evidence review; no unchanged live resampling.", ""].join("\n"), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${priorRoot}/summary.json`)).toEqual(priorBytes);
    expect(network).not.toHaveBeenCalled(); console.info("D021_FAILURE_REVIEW", out);
  } finally { network.mockRestore(); }
});
