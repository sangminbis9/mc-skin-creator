// Read-only recovery: late audit validation is not production acceptance.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-012";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("separates D012's local deadline from the later valid binding result and preserves consumed evidence", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("082609a45cfcc66c6cddf2ccdac04b2189288b366820ce5313c9c369e0bccead");
    const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    expect(files).toHaveLength(44);
    for (const [i, name] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    const e = s.currentDefaultE2E, r = e.result, d = r.diagnostics;
    expect(e).toMatchObject({ runId: "244d6e4d194ef7e6d5f17c02ae1e9c0a", generationPosts: 1,
      providerRetry: 0, httpStatus: 503, elapsedMs: 59442, accounting: "known", png: null, diskRecovery: true });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_unavailable", productionStatus: 503 });
    expect(d.primaryDiagnostic).toMatchObject({ ok: false, attempts: 2, reason: "provider_unavailable" });
    const terminal = d.primaryDiagnostic.providerAttempts.filter((a: { outcome: string }) => a.outcome !== "started");
    expect(terminal).toHaveLength(2);
    expect(terminal[0]).toMatchObject({ provider: "gemini", status: 400, providerStatus: "FAILED_PRECONDITION",
      fallbackEligible: true, fallbackReason: "provider_failed_precondition" });
    expect(terminal[1]).toMatchObject({ provider: "workers_ai", outcome: "failed", status: 504,
      providerStatus: "DEADLINE_EXCEEDED", origin: "LOCAL_DEADLINE", elapsedMs: 55000,
      configuredDeadlineMs: 55000, deadlineTimerFired: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned",
      elapsedMs: 55414, deadlineMs: 55000, httpStatus: null });
    expect(d.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    // A non-abortable binding may settle after Promise.race already rejected.
    // Passive inspection does not make that late result a production primary success.
    expect(d.normalizedPrimary).not.toBeNull(); expect(d.geometry).toBeNull();
    expect(r.propagationTrace).toMatchObject({ selectedFamilies: null, injectedParameters: null,
      skinPlan: { skinPlan: null }, finalPng: null });
    const stages: string[] = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
    expect(stages.indexOf("production_primary_returned")).toBeLessThan(stages.indexOf("gemmaPrimary_returned"));
    for (const absent of ["production_crop_started", "production_reference_atlas_started", "production_png_finished", "faceGeometry_invoked"])
      expect(stages).not.toContain(absent);
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    const prior = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-011/summary.json", "utf8"));
    expect(e.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
    const changed = Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prior.currentDefaultE2E.fixedHashes[k])
      .map(k => k.replaceAll("\\", "/"));
    expect(changed).toEqual(["src/referenceStyleConstraints.ts"]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-012-failure-review-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      summarySha256: sha(bytes), checkpointCount: files.length, checkpointIntegrity: true,
      classification: "GEMMA_LOCAL_DEADLINE_WITH_LATE_VALID_RESULT", productionSucceeded: false,
      gemini: { calls: 1, status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true },
      gemma: { calls: 1, deadlineMs: 55000, deadlineFired: true, bindingReturnedMs: 55414,
        httpStatus: null, lateProviderShapePass: true, lateStrictPass: true, lateRichPass: true },
      startup: 1, health: 1, e2ePosts: 1, geometryCalls: 0, retries: 0, offlineProviderCalls: 0,
      pngAvailable: false, referenceRendererReached: false, cpuOptimizationLiveEffect: "unobserved",
      changedProductionHashes: changed, samePreprocessing: true, qCount: 1, gracefulCleanup: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      nextBoundary: "offline_deadline_timing_review_not_same_run_retry",
    }, null, 2), { flag: "wx" });
    console.info("D012_FAILURE_REVIEW", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
});
