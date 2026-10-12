// Read-only evidence recovery. Never imports or invokes a live runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { narrowDenseSemanticOpening } from "../src/semanticFringeOpening";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers F010 same-run dense fringe delivery and separates ambiguous length promotion", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-010";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("561f8bd744066569d60e57c85727c8da13dac3202b843d93db662b9565ff1a01");
    expect(sha(png)).toBe("5e25f91be5efd366b2ba6f521c20bb28668eded215eb1f9bcd664e43dc96d95a");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    // The finalized snapshot reports the prior count; include the final envelope itself.
    expect(versions).toHaveLength(67);
    for (const [i, f] of versions.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === versions.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(e).toMatchObject({ runId: "1e2071507c5721e7a05d2620f4dcc82c", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 38142, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 429 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 33975 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "RESOURCE_EXHAUSTED", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization.status).toBe("EXPLICIT_NULL");
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    const immutable = JSON.stringify(t);
    for (const hints of [t.primary.renderHints, t.renderAnalysis.renderHints, style]) {
      expect(hints).toMatchObject({ bangs: "straight", bangsLength: "brow", bangsDensity: "dense", fringeOpening: "center", hairPart: "none" });
      expect(narrowDenseSemanticOpening(hints)).toBe(true);
    }
    expect(p.facePixelPlan.layout.geometryUsage.hairline).toBe(false);
    expect(p.facePixelPlan.layout.hairlineDepthByColumn).toEqual([2, 2, 2, 0, 2, 2, 2, 2]);
    expect(p.hairPlan.structure.fringe.openingColumns).toEqual([3]);
    expect(p.facePixelPlan.pixels.some((v: { cluster: string; x: number; y: number }) => v.cluster === "fringe" && v.x === 4 && v.y === 1)).toBe(true);
    expect(style.hairColor).toBe("#9a9a9a"); expect(style.hat).toBe("none");
    expect(p.headIdentityPlan.ownership.covering).toBe(false);
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326", source: "observed" });
    // This is a separate observed normalization boundary, not proof of a correct source length.
    expect(t.primary.observed.hair).toContain("jaw/shoulder length");
    expect(t.primary.renderHints.overallHairLength).toBe("jaw");
    expect(t.renderAnalysis.renderHints.overallHairLength).toBe("shoulder");
    expect(d.hair.family).toBe("long_straight_with_bangs");
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style), selection = selectReferenceStyleAtlas(base, p, d, style);
    expect(replay.atlas.rgba).toEqual(actual.rgba); expect(selection.selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(replay.diagnostic.surfaces.some(c => c.part === "head" && c.face === "front"
      && c.layer === "base" && c.owner === "hair" && c.x === 4 && c.y === 1)).toBe(true);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    expect((await decodePng(await encodePng(actual))).rgba).toEqual(actual.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-010-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), pngSha256: sha(png),
      rgbaSha256: sha(actual.rgba), runId: e.runId, checkpointCount: versions.length, checkpointIntegrity: true,
      actualPngExactReplay: true, atlasPass: true, referenceCraftPass: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1,
      liveGemini: 1, liveGemma: 1, liveGeometry: 0, retry: 0, offlineProviderCalls: 0,
      gracefulTeardown: true, productionConfigUnchanged: true,
      serverSidePreviewDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      selectedFamilies: t.selectedFamilies, denseFringeBranchLiveExercised: true,
      layoutDepthByColumn: p.facePixelPlan.layout.hairlineDepthByColumn, openingColumns: p.hairPlan.structure.fringe.openingColumns,
      outerHairCells: selection.selected!.quality.metrics.actualOuterHairCells,
      lengthBoundary: { primary: "jaw", normalized: "shoulder", phrase: "jaw/shoulder length", status: "needs_offline_scope_audit" },
      qualityGoalComplete: false }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F010_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
