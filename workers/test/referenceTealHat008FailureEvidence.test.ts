// Consumed evidence only: no remote runner, source image reads, or inference.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-008";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("preserves D008's last reference-atlas marker without inferring missing output or provider accounting", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("11819afec8b67a4e2c9d8e205c6f9c8f8e6332e2d3bfcccad6dfb04fdd2e1baa");
    const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    expect(files).toHaveLength(48);
    for (const [i, file] of files.entries()) {
      const checkpoint = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(checkpoint.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s.currentDefaultE2E).toMatchObject({ runId: "390984f022f3c99cb640fc270c3f1317",
      generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 40236,
      accounting: "unknown", result: null, png: null, diskRecovery: true,
      httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
        codeAmbiguous: false, inspectionTruncated: false } } });
    expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    const stages = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
    expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
    expect(stages).toHaveLength(18);
    expect(stages.slice(-3)).toEqual(["production_source_atlas_started", "production_source_atlas_finished", "production_reference_atlas_started"]);
    for (const stage of ["production_reference_atlas_finished", "production_png_finished", "handler_returned", "propagation_started"])
      expect(stages).not.toContain(stage);
    for (const stage of ["geminiPrimary_invoked", "geminiPrimary_returned", "gemmaPrimary_invoked", "gemmaPrimary_returned"])
      expect(stages.filter((v: string) => v === stage)).toHaveLength(1);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      serverSidePreviewDeletionIndependentlyConfirmed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(s.shutdownLatch.phase).toBe("finalized");
    const prior = JSON.parse(readFileSync(root.replace(/008$/, "007") + "/summary.json", "utf8"));
    expect(s.currentDefaultE2E.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
    const changedHashes = Object.keys(s.currentDefaultE2E.fixedHashes).filter(f =>
      s.currentDefaultE2E.fixedHashes[f] !== prior.currentDefaultE2E.fixedHashes[f]).map(f => f.replaceAll("\\", "/"));
    expect(changedHashes).toEqual(["src/outfitIdentity.ts"]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-008-failure-review-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId, checkpointCount: files.length,
      observedStages: stages, providerAccounting: "unknown", recoveredProviderCalls: null,
      pngAvailable: false, recoveredPrimaryAnalysisAvailable: false,
      productionReferenceAtlasStartObserved: true, productionReferenceAtlasFinishObserved: false,
      remoteCpuMeasurementAvailable: false, failureFunctionNotProven: true,
      startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCallsInOfflineReview: 0,
      checkpointIntegrity: true, gracefulCleanup: true, samePreprocessing: true, changedHashes,
      nextBoundary: "offline_reference_atlas_resource_review_without_reconstructing_missing_D008_analysis",
    }, null, 2), { flag: "wx" });
    writeFileSync(`${out}/REPORT.md`, ["# D-008 consumed-run recovery", "",
      "- E2E HTTP 503 after 40,236 ms; non-JSON HTML reported error 1102. No final PNG or primary analysis recovered.",
      "- Startup 1, protected health 1 (PASS), E2E POST 1, retry 0. Live test exit 0 is not E2E success.",
      "- Gemini/Gemma primary invoked/returned markers each observed once. Exact provider ledger, statuses, durations and geometry count remain unknown.",
      "- Last best-effort marker: production_reference_atlas_started. No completion marker. This does not identify a failing function or CPU versus memory cause.",
      "- All 48 checkpoints verify; final snapshot equals summary. q once, wrapper/PTY/owner exit and inventory cleanup pass; temporary token/config removed. Remote preview deletion is not independently confirmed.",
      "- D-007 preprocessing is identical; pinned production hash delta is outfitIdentity.ts only. Historical evidence is unchanged.",
      "- Next: offline review of reference-atlas resource use on saved inputs, explicitly not a reconstruction of D-008. No live retry.", ""].join("\n"), { flag: "wx" });
    console.info("D008_FAILURE_REVIEW", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
});
