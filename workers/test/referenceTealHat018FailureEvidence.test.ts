// Consumed live evidence only. No provider/remote imports or historical rewrites.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-018";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D018's post-handler propagation boundary without inventing its missing PNG or accounting", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("817dc0c7f2a586b4e5da5d5dcbcff27d3adaf5bba9ef4e785de0693633c2de1a");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(54);
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    const e = s.currentDefaultE2E;
    expect(e).toMatchObject({ runId: "a881928a6c28519b93874f884aaaccea", generationPosts: 1,
      providerRetry: 0, httpStatus: 503, elapsedMs: 50372, accounting: "unknown", result: null,
      png: null, propagationLink: null, diskRecovery: true,
      httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
        codeAmbiguous: false, inspectionTruncated: false } } });
    expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
    const stages: string[] = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
    expect(stages).toHaveLength(24);
    expect(stages.slice(-4)).toEqual(["production_png_finished", "production_baseline_returned", "handler_returned", "propagation_started"]);
    expect(stages).not.toContain("propagation_finished");
    for (const stage of ["geminiPrimary_invoked", "geminiPrimary_returned", "gemmaPrimary_invoked", "gemmaPrimary_returned"])
      expect(stages.filter(v => v === stage)).toHaveLength(1);
    expect(stages).not.toContain("faceGeometry_invoked"); // Not equivalent to authoritative geometry call accounting.
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      serverSidePreviewDeletionIndependentlyConfirmed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(s.shutdownLatch.phase).toBe("finalized");
    const prior = JSON.parse(readFileSync(root.replace(/018$/, "017") + "/summary.json", "utf8")).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prior.preprocessing);
    const changedHashes = Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prior.fixedHashes[k]).map(k => k.replaceAll("\\", "/"));
    expect(changedHashes).toEqual(["src/outfitIdentity.ts"]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-018-failure-review-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointCount: files.length, checkpointIntegrity: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, reportedErrorCode: "1102", observedStages: stages,
      productionPngFinishedMarker: true, recoveredPng: false, recoveredAnalysis: false,
      recoveredProviderCalls: null, providerAccounting: "unknown", geometryInvocationMarkerObserved: false,
      remoteCpuMeasurementAvailable: false, failingFunctionProven: false, markerReceiptTimesAreStageLatency: false,
      startup: 1, health: 1, e2ePosts: 1, retry: 0, offlineProviderCalls: 0,
      samePreprocessing: true, changedHashes, gracefulCleanup: true, qCount: 1,
      remoteDeletionIndependentlyConfirmed: false, productionConfigUnchanged: true,
      latestPatternFixDelivery: "unobserved", qualityGoalComplete: false,
      nextBoundary: "offline_audit_propagation_cost_review_not_unchanged_live_retry",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("D018_FAILURE_REVIEW", out);
  } finally { network.mockRestore(); }
});
