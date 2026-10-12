// Read-only verification of consumed reference C. Never import the live runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001";
const bytes = readFileSync(`${root}/summary.json`);
const summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const saved = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers immutable checkpoints and the actual single successful Gemini E2E", () => {
  expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "134bbd9026785ff77591646e351ce8d1", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 33254, diskRecovery: true });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 200, elapsedMs: 30092 }),
  ]);
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(run.result.diagnostics.geometry).toBeNull();
});

it("separates preserved observations from the earliest accessory palette loss", () => {
  expect(trace.primary.observed).toEqual(trace.renderAnalysis.observed);
  expect(trace.primary.observed.clothing).toContain("pale cream knitted scarf");
  expect(trace.primary.observed.accessories).toContain("off-white fringed scarf wrapped around neck");
  expect(trace.primary.observed.accessories).toContain("Pink belt visible at the waistband");
  expect(saved.outfitPlan.accessories).toEqual([
    expect.objectContaining({ kind: "scarf", color: "#c5aa82", source: "observed" }),
    expect.objectContaining({ kind: "belt", color: "#c5aa82", source: "observed" }),
  ]);
  expect(trace.primary.observed.hair).toContain("white daisy hair clip");
  expect(saved.headIdentityPlan.ownership.execution).toBe("preserve_existing_grammar");
  expect(trace.referenceStyle).toMatchObject({ status: "source_grammar_preserved", renderAttempts: 0,
    preservedReason: "unresolved_complex_head_grammar", craftValidation: "pass" });
  expect(trace.selectedFamilies).toBeNull();
  // These are historical failure assertions, not desired production behavior.
});

it("replays the saved plan exactly and writes only fresh diagnostic views", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const png = readFileSync(`${root}/skin.png`), image = await decodePng(png);
    expect(sha(png)).toBe("c7c8a5c440683e60a19bce90bdf53656f6ea095ed4b5a4fd1318557d599904af");
    expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
    expect([image.width, image.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
    expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
      generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
      featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
    const replay = buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, saved)!;
    expect(sha(replay.rgba)).toBe(sha(image.rgba));
    expect(network).not.toHaveBeenCalled();
    expect(sha(readFileSync(`${root}/summary.json`))).toBe(sha(bytes));
    const output = freshAuditOutput("evaluation-artifacts/reference-neck-scarf-001-review-20261010-");
    for (const view of renderSkinViews(image))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image,
        view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/summary.json`, JSON.stringify({ evidence: "read_only_consumed_live_review",
      sourceRun: run.runId, sourceSummarySha256: sha(bytes), pngSha256: sha(png), exactSavedPlanReplay: true,
      localNetworkCalls: 0, consumedLiveCalls: { gemini: 1, gemma: 0, geometry: 0 },
      earliestPaletteLoss: "NORMALIZED_PRESERVED_PLAN_COLOR_LOST",
      sourceNeckScarfPreserved: true, primaryPinkBeltObserved: true, savedAccessoryColors: ["#c5aa82", "#c5aa82"],
      referenceStyleBoundary: "unresolved_complex_head_grammar", historicalArtifactsUnchanged: true,
    }, null, 2), { flag: "wx" });
    console.log("C001_REVIEW", output);
  } finally { network.mockRestore(); }
}, 30_000);

it("verifies graceful teardown while keeping unobserved remote deletion unclaimed", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
