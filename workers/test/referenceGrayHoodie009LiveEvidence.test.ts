// Read-only recovery of one consumed live run. No remote runner imports.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers F009 exact gray hair and dark-cross long-sleeve delivery without claiming predicative branch coverage", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-009";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("8fbf1a9d3c905b2ac04339e3a88ae2a6b6bf0dd14a0cc1e4bdd57ef2b4a30ad6");
    expect(sha(png)).toBe("1cb66cbefc0c3b2bb7c7aa5cb782c4bcfecc92f95abcf7745e9c450ee7954880");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(67);
    for (const [i, f] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === files.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(e).toMatchObject({ runId: "db7e508a469807ff2cf7098f4b46a9e4", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 42474, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 37697 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", numericCount: 13,
      numericParse: "passed", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.hair).toContain("Straight, ash-grey hair");
    expect(t.primary.observed.hair).not.toMatch(/hair is .*colou?r/i);
    expect(t.primary.fallbackFeatures.hairColor).toBe("dark-brown");
    expect(t.primary.fallbackFeatures.sleeveLength).toBe("short");
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    const immutable = JSON.stringify(t);
    expect(style.hairColor).toBe("#9a9a9a"); expect(style.hat).toBe("none");
    // The open forehead is not an absent-hint default: it is already present
    // in this run's primary categorical output and survives normalization.
    expect(t.primary.renderHints.fringeOpening).toBe("center");
    expect(t.renderAnalysis.renderHints.fringeOpening).toBe("center");
    expect(style.fringeOpening).toBe("center");
    expect(p.facePixelPlan.layout.hairlineDepthByColumn).toEqual([3, 3, 3, 0, 0, 3, 3, 3]);
    expect(p.hairPlan.structure.fringe.openingColumns).toEqual([3, 4]);
    expect(p.headIdentityPlan.ownership.covering).toBe(false);
    expect(d.hair.family).toBe("medium_layered");
    expect(d.candidates.hair.some((v: { family: string }) => v.family === "hoodie_beanie_compatible")).toBe(false);
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326", source: "observed" });
    for (const sleeve of [p.outfitPlan.upper.leftSleeve, p.outfitPlan.upper.rightSleeve])
      expect(sleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style), selection = selectReferenceStyleAtlas(base, p, d, style);
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(replay.atlas.rgba).toEqual(actual.rgba);
    expect(selection.selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    expect((await decodePng(await encodePng(actual))).rgba).toEqual(actual.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-009-evidence-review-20261011-");
    for (const v of renderSkinViews(actual)) writeFileSync(`${out}/${v.name}.png`,
      await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, sourceSummarySha256: sha(bytes),
      pngSha256: sha(png), rgbaSha256: sha(actual.rgba), runId: e.runId, checkpointIntegrity: true, checkpointCount: files.length,
      actualPngExactReplay: true, atlasPass: true, referenceCraftPass: true, httpStatus: 200, elapsedMs: e.elapsedMs,
      startup: 1, health: 1, post: 1, liveGemini: 1, liveGemma: 1, liveGeometry: 0, providerRetry: 0, offlineProviderCalls: 0,
      gracefulTeardown: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      selectedFamilies: t.selectedFamilies, outerHairCells: selection.selected!.quality.metrics.actualOuterHairCells,
      pattern: p.outfitPlan.upper.pattern, sleeveLength: p.outfitPlan.upper.leftSleeve.length,
      hairColor: { observed: t.primary.observed.hair, providerFallback: t.primary.fallbackFeatures.hairColor, injected: style.hairColor },
      livePredicativeColorBranchExercised: false, currentHairColorDeliveryVerified: true,
      openingTrace: { primary: "center", normalized: "center", injected: "center",
        layoutDepthByColumn: p.facePixelPlan.layout.hairlineDepthByColumn,
        structureOpeningColumns: p.hairPlan.structure.fringe.openingColumns,
        missingPrimaryOpeningInventedByRenderer: false, universalOpeningQualityEstablished: false },
      fringe: { bangs: t.renderAnalysis.renderHints.bangs, length: t.renderAnalysis.renderHints.bangsLength,
        density: t.renderAnalysis.renderHints.bangsDensity, opening: t.renderAnalysis.renderHints.fringeOpening,
        part: t.renderAnalysis.renderHints.hairPart },
      localization: r.diagnostics.localization, qualityGoalComplete: false,
      nextBoundary: "inspect_semantic_fringe_opening_vs_actual_front_mask_without_inventing_source_cues" }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F009_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
