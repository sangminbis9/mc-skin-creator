// Immutable live recovery and an explicitly offline plan counterfactual.
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
import * as layeredCrown from "../src/referenceLayeredCrown";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers F004 and isolates footwear-top noun collision without another provider call", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  // Historical F004 / footwear-only counterfactual predates the independent
  // tousled crown relief. Disable only that new subtraction for exact old PNG
  // verification; referenceLayeredCrown.test.ts checks current paint separately.
  const historicalCrown = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-004";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("185d2388a2d7343d54d8d11cfc32dd5e04506c9fc61869411c88257fbddfe918");
    expect(sha(png)).toBe("d5557342595f0f6bb4cc6fda1262231559004fd5243454d478023c0e0171398f");
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
    expect(e).toMatchObject({ runId: "103c4f9b9d2209f73141514f5db9690a", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 15902, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 11554 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "face_head_relationship_invalid", relationshipFailure: "both_ratios" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    const saved: SkinPlan = t.skinPlan.skinPlan, old = t.injectedParameters, immutable = JSON.stringify(t);
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(a.observed.clothing).toContain("White low-top sneakers");
    expect(a.observed.clothing).toContain("black cross graphic");
    expect(t.primary.renderHints.overallHairLength).toBe("jaw"); expect(a.renderHints.overallHairLength).toBe("jaw");
    expect(old.faceStyle.hairColor).toBe("#9a9a9a");
    expect(t.selectedFamilies.hair).toBe("medium_layered");
    expect(saved.outfitPlan.upper.garmentType).toBe("hoodie");
    expect(saved.outfitPlan.outerLayer.regions).toContain("hood_rim");
    expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    expect(saved.outfitPlan.upper.pattern.kind).toBe("none");
    const resolved = buildOutfitPlan(a);
    expect(resolved.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
    expect(resolved.upper.pattern).toMatchObject({ graphicShape: "cross", color: "#242326", source: "observed" });
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-004-evidence-review-20261011-");
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(sha(actual.rgba)).toBe("bad509c89f4078f3715d0401238c491c4c2e632126f1f9c74e79b5e96ed9119e");
    const results = [];
    for (const mode of ["actual-live", "offline-footwear-noun-fix"] as const) {
      const p = structuredClone(saved), style = old.faceStyle, design = t.referenceStyle.design;
      if (mode !== "actual-live") {
        p.outfitPlan.upper.leftSleeve = structuredClone(resolved.upper.leftSleeve);
        p.outfitPlan.upper.rightSleeve = structuredClone(resolved.upper.rightSleeve);
        p.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        p.outfitPlan.outerLayer = structuredClone(resolved.outerLayer);
        p.outfitPlan.outerLayerRegions = [...resolved.outerLayerRegions];
      }
      const base = buildProceduralSourceAtlas(old.features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "actual-live") expect(composed.atlas.rgba).toEqual(actual.rgba);
      else expect(selectReferenceStyleAtlas(base, p, design, style).selected!.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      expect(composeReferenceStyleAtlas(base, p, design, style).atlas.rgba).toEqual(composed.atlas.rgba);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, design, composed)).ok).toBe(true);
      const parts = ["body", "rightArm", "leftArm"] as const;
      const rects = parts.flatMap(k => [...Object.values(CLASSIC_LAYOUT[k].base), ...Object.values(CLASSIC_LAYOUT[k].overlay)]);
      let changed = 0;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== composed.atlas.rgba[i * 4 + ch])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(rects.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h), `outside:${mode}:${i}`).toBe(true);
      }
      if (mode !== "actual-live") expect(changed).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      expect(p.outfitPlan.upper.neckline).toEqual(saved.outfitPlan.upper.neckline);
      const encoded = await encodePng(composed.atlas); expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changed, unrelatedPixels: 0, craftPass: true, atlasPass: true, rgbaSha256: sha(composed.atlas.rgba),
        sleeve: p.outfitPlan.upper.leftSleeve, pattern: p.outfitPlan.upper.pattern });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: e.runId,
      checkpointIntegrity: true, checkpointCount: checkpoints.length, actualPngExactReplay: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1, liveGemini: 1, liveGemma: 1,
      liveGeometry: 0, retry: 0, offlineProviderCalls: 0, gracefulTeardown: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      hairLengthPreserved: true, grayMaterialDelivered: true, hoodiePlanDelivered: true,
      hoodedSweatshirtSpecificBranchNotExercised: true,
      remainingLiveLoss: "footwear low-top counted as second upper garment: sleeve and attached graphic blocked",
      classification: "NORMALIZED_PRESERVED_PLAN_LOST", fullAnalysisReconstructed: false,
      freshLiveFootwearFixDeliveryVerified: false, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F004_EVIDENCE_REVIEW", root);
  } finally { historicalCrown.mockRestore(); network.mockRestore(); }
}, 90_000);
