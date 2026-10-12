// Immutable F006 live recovery, followed by a separately labelled offline repair.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers F006 without inference and isolates its graphic-of-a-cross plan loss", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-006";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("85d1fdb2a9d0e2498de32a2d67c2977b8259187ad11dd672b6a1a22f60a3e4eb");
    expect(sha(png)).toBe("a6f0195b68526c0acd702fbe01baa2940821660d1904e86eea9479a580c24868");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const checkpoints = readdirSync(sourceRoot).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(checkpoints).toHaveLength(67);
    for (const [i, f] of checkpoints.entries()) {
      const c = JSON.parse(readFileSync(`${sourceRoot}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === checkpoints.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(e).toMatchObject({ runId: "124a59dc49647321563a5c207a053cda", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 26230, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 21861 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    const saved: SkinPlan = t.skinPlan.skinPlan, params = t.injectedParameters, immutable = JSON.stringify(t);
    // This is only the saved subset required by outfit planning, not a rebuilt full analysis.
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(a.observed.clothing).toContain("large black graphic of a cross on the center chest");
    expect(t.primary.fallbackFeatures.sleeveLength).toBe("long");
    expect(saved.outfitPlan.upper.leftSleeve).toMatchObject({ length: "long", source: "observed" });
    expect(saved.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", color: "#242326" });
    expect(saved.outfitPlan.upper.pattern.graphicShape).toBeUndefined();
    const resolved = buildOutfitPlan(a);
    expect(resolved.upper.pattern).toMatchObject({ graphicShape: "cross", color: "#242326", surfaceParts: ["body"] });
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-006-evidence-review-20261011-");
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const design = t.referenceStyle.design, style = params.faceStyle;
    const changed = (other: Uint8Array) => Array.from({ length: 4096 }, (_, i) => i)
      .filter(i => [0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== other[i * 4 + ch]));
    const results = [];
    for (const mode of ["actual-live", "offline-cross-attachment-fix"] as const) {
      const p = structuredClone(saved);
      if (mode !== "actual-live") {
        p.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        // Remove only the obsolete generic graphic relief, leaving other regions untouched.
        p.outfitPlan.outerLayer.regions = p.outfitPlan.outerLayer.regions.filter(v => v !== "graphic_depth");
        p.outfitPlan.outerLayerRegions = p.outfitPlan.outerLayerRegions.filter(v => v !== "graphic_depth");
      }
      const base = buildProceduralSourceAtlas(params.features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "actual-live") expect(composed.atlas.rgba).toEqual(actual.rgba);
      expect(selectReferenceStyleAtlas(base, p, design, style).selected!.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      expect(composeReferenceStyleAtlas(base, p, design, style).atlas.rgba).toEqual(composed.atlas.rgba);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, design, composed)).ok).toBe(true);
      const rects = [CLASSIC_LAYOUT.body.base.front, CLASSIC_LAYOUT.body.overlay.front];
      for (const i of changed(composed.atlas.rgba)) {
        const x = i % 64, y = Math.floor(i / 64);
        expect(rects.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h), `outside:${mode}:${i}`).toBe(true);
      }
      if (mode !== "actual-live") expect(changed(composed.atlas.rgba).length).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      expect(p.outfitPlan.upper.leftSleeve).toEqual(saved.outfitPlan.upper.leftSleeve);
      const encoded = await encodePng(composed.atlas); expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changed: changed(composed.atlas.rgba).length, unrelatedPixels: 0,
        craftPass: true, atlasPass: true, rgbaSha256: sha(composed.atlas.rgba), pattern: p.outfitPlan.upper.pattern });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: e.runId,
      checkpointIntegrity: true, checkpointCount: checkpoints.length, actualPngExactReplay: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1, liveGemini: 1, liveGemma: 1,
      liveGeometry: 0, retry: 0, offlineProviderCalls: 0, gracefulTeardown: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      actualLongSleevesAndDarkInk: true, priorFeaturingBranchExercised: false,
      earliestLoss: "graphic of a cross loses graphicShape in observedAttachedChestGraphic",
      classification: "NORMALIZED_PRESERVED_PLAN_LOST", fullAnalysisReconstructed: false,
      freshLiveCrossAttachmentFixVerified: false, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F006_EVIDENCE_REVIEW", root);
  } finally { network.mockRestore(); }
}, 90_000);
