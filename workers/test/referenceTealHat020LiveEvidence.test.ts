// Immutable same-run recovery only; no remote runner/provider imports.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D020's real production PNG and distinguishes block-palette plan loss from observation failure", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(65);
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true,
      ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
      ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    const e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    expect(e).toMatchObject({ runId: "4b3ad88cf0844ee8572087c8c7462173", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 18937, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toEqual([{ stage: "geminiPrimary", started: true, completion: "returned",
      elapsedMs: 15842, httpStatus: 200, deadlineMs: 45000,
      schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" }]);
    expect(r.diagnostics.primaryDiagnostic.attempts).toBe(1);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toHaveLength(2); // start + completion, not two calls
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ provider: "gemini", outcome: "completed",
      status: 200, attemptOrdinal: 1, providerSchemaValidation: "passed", strictValidation: "passed" });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.cropReplay.replayEligibility).toEqual({ status: "coverage_unknown", reason: "localized_face_unavailable" });
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const prior = JSON.parse(readFileSync(root.replace(/020$/, "019") + "/summary.json", "utf8")).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prior.preprocessing);
    expect(Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prior.fixedHashes[k]).map(k => k.replaceAll("\\", "/")))
      .toEqual(["src/skinPost.ts"]);
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    const clothing = t.primary.observed.clothing;
    expect(clothing).toContain("pastel pixelated blocks (pink, lilac, yellow, cyan, white)");
    expect(clothing).toContain("central dark pixel face graphic");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.kind).toBe("center_graphic");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.blockColors).toBeUndefined();
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, st = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, st);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("da9c4621e73baaa871b76db9338140864de5c83c1c42eaa1c3ba09dbced2a73c");
    expect(sha(actual.rgba)).toBe("04f64565dcecb498d8f25c9908259ad63387ef608de9506e6921189af9d7fb13");
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(replay.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, st, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-020-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_immutable_live_evidence_review",
      sourceRoot: root, sourceSummarySha256: sha(bytes), runId: e.runId, checkpointIntegrity: true, checkpoints: 65,
      httpStatus: 200, elapsedMs: e.elapsedMs, actualPngExactReplay: true, pngSha256: sha(png),
      craftPass: true, atlasPass: true, startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 0,
      liveGeometry: 0, providerRetry: 0, offlineProviderCalls: 0, gracefulCleanup: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      observed: t.primary.observed, selectedFamilies: t.selectedFamilies,
      pattern: { normalizedObservation: t.renderAnalysis.observed.clothing, plan: p.outfitPlan.upper.pattern,
        classification: "NORMALIZED_PRESERVED_PATTERN_PLAN_LOST", currentBlockGrammarExercised: false,
        lossBoundary: "whole_garment_block_palette_rejected_when_parenthesized_and_coexisting_with_graphic_and_cuffs" },
      faceFinish: replay.diagnostic.faceFinish, drape: d.drape, localization: r.diagnostics.localization,
      resourceOptimizationFreshPngConfirmed: true, resourceFailureCauseProven: false,
      gemmaFallbackResourcePathExercised: false, qualityGoalComplete: false,
      nextBoundary: "offline_owned_block_palette_and_coexisting_motif_contract_review",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D020_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
