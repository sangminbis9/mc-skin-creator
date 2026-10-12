// Consumed evidence only: no remote runner or provider imports.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-019";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D019's reference-atlas boundary without treating missing telemetry as zero calls", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("0ac4c69f3cd343e729dc830fba75553a5ad59ce491cfc5cca881584aefd044bf");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(48);
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    const e = s.currentDefaultE2E;
    expect(e).toMatchObject({ runId: "a5edae386a6716075b1a878370e6fd60", generationPosts: 1,
      providerRetry: 0, httpStatus: 503, elapsedMs: 37308, accounting: "unknown", result: null,
      png: null, propagationLink: null, diskRecovery: true,
      httpObservation: { stage: "json_parse", rejectedBody: { format: "html", reportedErrorCode: "1102",
        codeAmbiguous: false, inspectionTruncated: false } } });
    expect(s.providerCalls).toBeNull(); expect(s.providerAccounting).toBe("unknown");
    expect(existsSync(`${root}/skin.png`)).toBe(false);
    expect(s.terminalStageEvidence.scope).toBe("best_effort_cli_log_observation_not_provider_accounting");
    const stages: string[] = s.terminalStageEvidence.observations.map((o: { stage: string }) => o.stage);
    expect(stages).toHaveLength(18);
    expect(stages.slice(-3)).toEqual(["production_source_atlas_started", "production_source_atlas_finished",
      "production_reference_atlas_started"]);
    for (const stage of ["geminiPrimary_invoked", "geminiPrimary_returned", "gemmaPrimary_invoked", "gemmaPrimary_returned"])
      expect(stages.filter(v => v === stage)).toHaveLength(1);
    for (const stage of ["production_reference_atlas_finished", "production_png_finished", "handler_returned",
      "propagation_started", "propagation_projection_started", "faceGeometry_invoked"])
      expect(stages).not.toContain(stage);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      serverSidePreviewDeletionIndependentlyConfirmed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(s.shutdownLatch.phase).toBe("finalized");
    const priorBytes = readFileSync(root.replace(/019$/, "018") + "/summary.json");
    expect(sha(priorBytes)).toBe("817dc0c7f2a586b4e5da5d5dcbcff27d3adaf5bba9ef4e785de0693633c2de1a");
    const prior = JSON.parse(priorBytes.toString());
    expect(e.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
    expect(e.fixedHashes).toEqual(prior.currentDefaultE2E.fixedHashes);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-019-failure-review-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_evidence_review", root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointCount: files.length, checkpointIntegrity: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, reportedErrorCode: "1102", observedStages: stages,
      recoveredPng: false, recoveredAnalysis: false, recoveredProviderCalls: null, providerAccounting: "unknown",
      geometryInvocationMarkerObserved: false, remoteCpuMeasurementAvailable: false, failingFunctionProven: false,
      markerReceiptTimesAreStageLatency: false, startup: 1, health: 1, e2ePosts: 1, retry: 0, offlineProviderCalls: 0,
      samePreprocessing: true, productionFixedHashesEqualToD018: true, gracefulCleanup: true, qCount: 1,
      remoteDeletionIndependentlyConfirmed: false, productionConfigUnchanged: true,
      auditOnlyCauseSupported: false, latestPatternFixDelivery: "unobserved", qualityGoalComplete: false,
      nextBoundary: "offline_reference_selection_resource_review_not_unchanged_live_retry",
    }, null, 2), { flag: "wx" });
    writeFileSync(`${out}/REPORT.md`, ["# D019 consumed evidence review", "",
      "- HTTP 503 after 37,308 ms; bounded HTML inspection reported 1102.",
      "- All 48 checkpoint hashes and the final snapshot verified; source evidence remains immutable.",
      "- Last best-effort marker: production_reference_atlas_started. No audit propagation substage observed.",
      "- D018 reached propagation_started with identical production fixed hashes and preprocessing.",
      "- This does not prove a specific failing function or remote CPU/memory amount; audit-only cause is not supported.",
      "- Provider accounting remains unknown. Invocation/return markers do not supply HTTP results or authoritative counts.",
      "- No PNG or analysis recovered. D017 evidence must not fill these gaps.",
      "- Startup/health/E2E POST: 1/1/1; retry 0. Literal q once; local owned-process and temporary-file cleanup passed.",
      "- Remote preview deletion was not independently confirmed. Production config unchanged.",
      "- This review made zero provider calls. Next: offline resource review, not unchanged live resampling.",
      ""].join("\n"), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("D019_FAILURE_REVIEW", out);
  } finally { network.mockRestore(); }
});
