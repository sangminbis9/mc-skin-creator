// Read-only recovery of one consumed run. No live runner imports or inferred fields.
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
it("recovers F011 exact output, accepted crop/geometry, and observed downstream loss boundaries", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-011";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("7fc5628e3a5c1180f15a2031a15c924702fb709ff5cb782b109d3f0f94fd56a5");
    expect(sha(png)).toBe("45820cb806fdfd8a43c9ed3d3a1c7a6d922a87b39f4b14c1c3a9587da02815cf");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(versions).toHaveLength(69);
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
    expect(e).toMatchObject({ runId: "32830bd413fa4b0f852239e4710618cb", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 32307, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 200, elapsedMs: 21111 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "faceGeometry", completion: "returned", httpStatus: null, elapsedMs: 8254 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization.status).toBe("VALID");
    expect(r.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    expect(e.cropReplay).toMatchObject({ geometryAttemptObserved: true, matchesActualWire: true,
      actualWireCropSha256: "d6eb766f7230c143bae17c22ba29aa0f22d1e71d77c7f950717b2e2f013cc4f7",
      replayEligibility: { status: "eligible", reason: "localized_face_retained" },
      diagnostics: { faceCropDimensions: { width: 106, height: 109 } } });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    // Record what actually happened, not the hoped-for previous-run branch.
    expect(t.primary.observed.hair).not.toContain("jaw/shoulder");
    expect(t.primary.observed.hair).toContain("tapered around ears");
    expect(t.primary.renderHints.overallHairLength).toBe("jaw");
    expect(t.renderAnalysis.renderHints.overallHairLength).toBe("ear");
    expect(d.hair.family).toBe("short_soft_feminine");
    expect(t.primary.observed.clothing).toContain("tonal dark cross emblem");
    expect(p.outfitPlan.upper.pattern.kind).toBe("none");
    expect(style.hairColor).toBe("#9a9a9a"); expect(style.hat).toBe("none");
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style), selection = selectReferenceStyleAtlas(base, p, d, style);
    expect(replay.atlas.rgba).toEqual(actual.rgba); expect(selection.selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    expect((await decodePng(await encodePng(actual))).rgba).toEqual(actual.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-011-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), pngSha256: sha(png),
      rgbaSha256: sha(actual.rgba), runId: e.runId, checkpointCount: versions.length, checkpointIntegrity: true,
      actualPngExactReplay: true, atlasPass: true, referenceCraftPass: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1,
      liveGeminiPrimary: 1, liveGemmaPrimary: 0, liveGemmaGeometry: 1, retry: 0, offlineProviderCalls: 0,
      gracefulTeardown: true, productionConfigUnchanged: true,
      serverSidePreviewDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      selectedFamilies: t.selectedFamilies, ambiguousEndpointBranchLiveExercised: false,
      outerHairCells: selection.selected!.quality.metrics.actualOuterHairCells,
      lengthBoundary: { primary: "jaw", normalized: "ear", phrase: "tapered around ears", status: "needs_offline_scope_audit" },
      graphicBoundary: { primary: "tonal dark cross emblem", plan: "none", status: "needs_offline_attachment_audit" },
      qualityGoalComplete: false }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F011_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
