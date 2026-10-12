// Offline consumed evidence review. Never imports the remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { assertHistoricalFallbackBrowPresentation } from "./historicalSingletonEyePresentation";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
const bytes = readFileSync(`${root}/summary.json`), summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E, result = run.result, trace = result.propagationTrace;
const plan: SkinPlan = trace.skinPlan.skinPlan;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("preserves the historical block-pattern loss and verifies its current observed-only plan repair", () => {
  // Empty unavailable prompt fields isolate the saved observed fields; they are
  // not a reconstruction of the original provider request or its full context.
  const analysis = { ...trace.primary, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
  const immutable = JSON.stringify(analysis);
  expect(analysis.observed.clothing).toBe(trace.renderAnalysis.observed.clothing);
  expect(analysis.observed.clothing).toContain("pixelated, blocky pattern in pastel shades of pink, lavender, and light blue");
  expect(analysis.visibleRegions.upperBody).toBe(true);
  expect(analysis.renderHints.garmentTexture).toBe("knit");
  const resolved = buildOutfitPlan(analysis);
  expect(plan.outfitPlan.upper.pattern.kind).toBe("none");
  expect(resolved.upper.pattern).toMatchObject({ kind: "checker_block", construction: "pixel_blocks", source: "observed" });
  expect(resolved.upper.pattern.evidence).toContain("pixelated, blocky pattern");
  expect(resolved.upper.pattern.blockColors).toHaveLength(3);
  // Observed print and material texture are orthogonal. No texture-category
  // rewrite is needed to preserve this garment's explicit pattern evidence.
  const counterfactual = buildOutfitPlan({ ...analysis, renderHints: { ...analysis.renderHints, garmentTexture: "patterned" } });
  expect(counterfactual.upper.pattern).toEqual(resolved.upper.pattern);
  expect(JSON.stringify(analysis)).toBe(immutable);
});

it("verifies D005 durable checkpoints and exact primary/fallback accounting", () => {
  expect(sha(bytes)).toBe("c68f89606fd8bbd98a0936a4809a9e5628c8d9533d6ee5dba0dc550675f4efa3");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(57);
  for (const [i, file] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "3328360fb55aa99bffd95139e5d177dd", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 41253, accounting: "known", diskRecovery: true });
  expect(result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned" }),
  ]);
  expect(result.diagnostics.primaryDiagnostic.attempts).toBe(2);
  expect(result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true,
  }));
  expect(result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(result.diagnostics.geometry).toBeNull();
  expect(result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(run.cropReplay).toMatchObject({ geometryAttemptObserved: false,
    replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
  const prior = JSON.parse(readFileSync(root.replace(/005$/, "004") + "/summary.json", "utf8"));
  expect(run.preprocessing).toEqual(prior.currentDefaultE2E.preprocessing);
  const changed = Object.keys(run.fixedHashes).filter(file => run.fixedHashes[file] !== prior.currentDefaultE2E.fixedHashes[file]);
  expect(changed.map(f => f.replaceAll("\\", "/")).sort())
    .toEqual(["src/generate.ts", "src/generationObservation.ts", "src/types.ts"]);
}, 60_000);

it("distinguishes complete phase reachability from stage durations and verifies graceful teardown", () => {
  const observed = summary.terminalStageEvidence.observations;
  expect(observed).toHaveLength(25);
  expect(observed.slice(8, 22).map((o: { stage: string }) => o.stage)).toEqual([
    "production_primary_returned", "production_primary_diagnostic_finished", "production_crop_started",
    "production_crop_returned", "production_enrichment_finished", "production_render_context_started",
    "production_render_context_finished", "production_source_atlas_started", "production_source_atlas_finished",
    "production_reference_atlas_started", "production_reference_atlas_finished", "production_png_started",
    "production_png_finished", "production_baseline_returned",
  ]);
  expect(observed.slice(-3).map((o: { stage: string }) => o.stage))
    .toEqual(["handler_returned", "propagation_started", "propagation_finished"]);
  for (const o of observed) {
    expect(Object.keys(o).sort()).toEqual(["receivedElapsedMs", "runId", "stage"]);
    expect(o.runId).toBe(run.runId);
  }
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
    health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});

it("replays D005 with only the declared fallback-brow presentation delta and isolates saved hat/pattern losses", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const png = readFileSync(`${root}/skin.png`), atlas = await decodePng(png);
    expect(sha(png)).toBe("e3e0e80adbf57044c390a91db3b70e88322afa2a87486af2b207eeeed7b7d6a0");
    expect(sha(atlas.rgba)).toBe("28155e9d5478ef54374ebe1e59c103ecfb5934c4c0f78188defac0ea06fe2163");
    expect([atlas.width, atlas.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
    expect(trace.primary.observed).toEqual(trace.renderAnalysis.observed);
    expect(trace.primary.observed.accessories).toContain("light-blue hat");
    expect(trace.primary.fallbackFeatures).toMatchObject({ hat: "cap", hatColor: "black" });
    // Render AnalysisSummary intentionally omits fallbackFeatures; the exact
    // replay's injected style/feature fields are the observed downstream values.
    expect(trace.injectedParameters.faceStyle.hat).toBe("cap");
    expect(trace.injectedParameters.features.hat).toBe("cap");
    expect(trace.primary.observed.clothing).toContain("pixelated, blocky pattern");
    expect(plan.headIdentityPlan.ownership).toMatchObject({ execution: "resolved", covering: false });
    expect(plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "covering")).toHaveLength(0);
    expect(plan.outfitPlan.upper.pattern.kind).toBe("none");
    expect(trace.selectedFamilies).toEqual({ face: "cute_pastel", hair: "long_straight_with_bangs", outfit: "pastel_hoodie_streetwear" });
    expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
      featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
    const headStages: Array<{ stage: string; frontOuterTopRows: number[]; sha256: string }> = [];
    const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, plan,
      (stage, image) => {
        const rect = CLASSIC_LAYOUT.head.overlay.front;
        const pixels: number[] = [];
        for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
          const at = ((rect.y + y) * 64 + rect.x + x) * 4;
          pixels.push(...image.rgba.slice(at, at + 4));
        }
        headStages.push({ stage, frontOuterTopRows: pixels, sha256: sha(new Uint8Array(pixels)) });
      })!;
    const beforeHead = headStages.find(s => s.stage === "before_authoritative_head")!;
    const afterHead = headStages.find(s => s.stage === "after_authoritative_head")!;
    expect(beforeHead).toBeDefined(); expect(afterHead).toBeDefined();
    expect(beforeHead.sha256).not.toBe(afterHead.sha256);
    const authoritativeHeadChangedCells = Array.from({ length: 16 }, (_, i) => i)
      .filter(i => [0, 1, 2, 3].some(c => beforeHead.frontOuterTopRows[i * 4 + c] !== afterHead.frontOuterTopRows[i * 4 + c]));
    expect(authoritativeHeadChangedCells.length).toBeGreaterThan(0);
    const replay = composeReferenceStyleAtlas(baseline, plan, trace.referenceStyle.design, trace.injectedParameters.faceStyle);
    const intentionalEyePresentation = assertHistoricalFallbackBrowPresentation(replay.atlas, atlas, baseline,
      plan, trace.injectedParameters.faceStyle, trace.referenceStyle.design);
    const output = freshAuditOutput("evaluation-artifacts/reference-teal-hat-005-review-20261010-");
    for (const view of renderSkinViews(atlas)) writeFileSync(`${output}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_review",
      sourceRoot: root, sourceRun: run.runId, sourceSummarySha256: sha(bytes), checkpointCount: 57,
      finalPngSha256: sha(png), finalRgbaSha256: sha(atlas.rgba), exactSavedDesignReplay: false,
      intentionalEyePresentation, outsideEyePresentationExact: true,
      liveAccounting: { startup: 1, health: 1, e2ePosts: 1, geminiPrimary: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      newProviderCalls: 0, completeProductionPhaseReachability: true,
      stageTimingAvailable: false, prior1102CauseResolved: false,
      headStages, authoritativeHeadChangedCells,
      earliestObservedLoss: { hat: "normalized_hat_preserved_head_ownership_missing",
        hatColor: "primary_narrative_light_blue_conflicts_with_primary_black_category",
        pixelPattern: "normalized_pattern_preserved_outfit_plan_none" },
      primaryLocalization: "invalid_region", geometrySkippedByGate: true,
      baselineAcquired: true, qualityGoalComplete: false,
      nextBoundary: "offline_cap_ownership_and_material_provenance_before_new_live",
      historicalArtifactsUnchanged: true, productionConfigUnchanged: true, gracefulCleanup: true,
    }, null, 2), { flag: "wx" });
    console.info("D005_REVIEW", output);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
}, 60_000);
