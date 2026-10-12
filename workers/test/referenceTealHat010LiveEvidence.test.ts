// Consumed-run evidence only. No provider or source-image access.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());

it("recovers D010's finalized checkpoints, actual binding attempts and graceful teardown", () => {
  expect(sha(bytes)).toBe("26c58761d0f08a862e8f4721194d02a8271236beb252c3700682c203a9ab8eb6");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(57);
  for (const [i, name] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED",
    startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  expect(s.shutdownLatch.phase).toBe("finalized");
  const r = s.currentDefaultE2E;
  expect(r).toMatchObject({ runId: "9c9bd2d6115538898fbc217f8b5454b1", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 38075, accounting: "known", diskRecovery: true });
  expect(r.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 987 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 33537 }),
  ]);
  expect(r.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
  expect(r.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(r.result.diagnostics.geometry).toBeNull(); expect(r.cropReplay.geometryAttemptObserved).toBe(false);
  expect(r.result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(r.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  const old = JSON.parse(readFileSync(root.replace(/010$/, "009") + "/summary.json", "utf8"));
  expect(r.preprocessing).toEqual(old.currentDefaultE2E.preprocessing);
  expect(Object.keys(r.fixedHashes).filter(f => r.fixedHashes[f] !== old.currentDefaultE2E.fixedHashes[f])
    .map(f => f.replaceAll("\\", "/"))).toEqual(["src/analysis.ts", "src/observedHeadwear.ts"]);
});

it("replays the actual D010 PNG without borrowing D009 observations and preserves its next loss boundaries", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const r = s.currentDefaultE2E, t = r.result.propagationTrace, p = t.skinPlan.skinPlan;
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    const f = t.injectedParameters.features, style = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(f, style, p)!;
    const local = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("3af15ff6a21c3773d12acf2e87a0279ef892818ccff4c0d5e112ca79d49bbb22");
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(local.atlas.rgba).toEqual(actual.rgba); expect(sha(actual.rgba)).toBe(t.finalPng.rgbaSha256);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateReferenceAtlasCraft(local.atlas, base, p, style,
      buildReferenceCraftPlan(p, t.referenceStyle.design, local));
    expect(craft.ok, JSON.stringify(craft)).toBe(true);
    expect(Object.hasOwn(r.result.diagnostics.providerAppearance, "fallbackFeatures")).toBe(false);
    expect(t.primary.observed.accessories).toBe("a large, textured, teal-colored cap-like hat");
    expect(t.renderAnalysis.observed.accessories).toBe(t.primary.observed.accessories);
    expect(t.primary.fallbackFeatures.hat).toBe("cap"); expect(f.hat).toBe("cap");
    // Presence survived. This wording already matches the old cap branch, so
    // fresh success alone does not prove the new generic-hat branch executed.
    expect(f.hatColor).toBe("#22201e");
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "checker_block", source: "observed" });
    expect(p.outfitPlan.upper.pattern.blockColors).toBeUndefined();
    expect(p.outfitPlan.upper.leftSleeve.length).toBe("short");
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-010-offline-review-20261010-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_exact_replay",
      sourceRoot: root, sourceSummarySha256: sha(bytes), runId: r.runId, localExactAtlasMatch: true,
      pngSha256: sha(png), rgbaSha256: sha(actual.rgba), craftPass: true, atlasPass: true,
      selectedFamilies: t.selectedFamilies, hatCategoryPreserved: true, hatColor: f.hatColor,
      genericHatBranchLiveCausalityProven: false,
      observedHeadwear: t.primary.observed.accessories,
      observedClothing: t.primary.observed.clothing,
      nextColorBoundary: "OBSERVED_TEAL_COLORED_HEADWEAR_MATERIAL_UNRESOLVED",
      outfitPaletteBoundary: "OBSERVED_FOUR_COLOR_CHECKER_PLAN_NO_BLOCK_PALETTE",
      sleeveLength: p.outfitPlan.upper.leftSleeve.length,
      sleeveEvidenceScope: "no_explicit_length_in_retained_primary_clothing_do_not_borrow_previous_run",
      livePrimaryCalls: 2, liveGeometryCalls: 0, newProviderCalls: 0,
      checkpointIntegrity: true, gracefulCleanup: true, missingPromptsReconstructed: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D010_EXACT_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
