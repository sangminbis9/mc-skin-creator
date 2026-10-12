// Offline, read-only recovery of the consumed D011 run; never infer its missing analysis.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-011";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D011 checkpoints and its reference-atlas boundary without inventing provider accounting", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("1a4d91ad475d963a56012d6b48343445a481b761e16e06e0ab7b957ca08830b3");
    const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    expect(files).toHaveLength(48);
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s.currentDefaultE2E).toMatchObject({ runId: "16bdc1dee28d85ff43211256affebff1",
      generationPosts: 1, providerRetry: 0, httpStatus: 503, elapsedMs: 53064,
      accounting: "unknown", result: null, png: null, diskRecovery: true,
      httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
        codeAmbiguous: false, inspectionTruncated: false } } });
    expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
    const stages = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
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
    const prior = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010/summary.json", "utf8"));
    expect(s.currentDefaultE2E.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
    const changedHashes = Object.keys(s.currentDefaultE2E.fixedHashes).filter(f =>
      s.currentDefaultE2E.fixedHashes[f] !== prior.currentDefaultE2E.fixedHashes[f]).map(f => f.replaceAll("\\", "/"));
    expect(changedHashes).toEqual(["src/generate.ts", "src/observedFrontHairDrape.ts", "src/outfitIdentity.ts", "src/referenceLooseHair.ts", "src/referenceStyleTemplates.ts"]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-011-failure-review-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      sourceSummarySha256: sha(bytes), checkpointCount: files.length, checkpointIntegrity: true,
      runId: s.currentDefaultE2E.runId, observedStages: stages, providerAccounting: "unknown", recoveredProviderCalls: null,
      pngAvailable: false, recoveredPrimaryAnalysisAvailable: false, receivedElapsedIsStageLatency: false,
      cloudflareReportedErrorCode: "1102", remoteCpuMeasurementAvailable: false, failingFunctionProven: false,
      startup: 1, health: 1, e2ePosts: 1, retries: 0, newProviderCallsInOfflineReview: 0,
      gracefulCleanup: true, samePreprocessing: true, changedHashes,
      nextBoundary: "offline_reference_selection_resource_profile_on_saved_D010_not_reconstructed_D011",
    }, null, 2), { flag: "wx" });
    console.info("D011_FAILURE_REVIEW", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
});
