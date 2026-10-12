// Recover immutable F007 evidence; any repaired output is explicitly offline.
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
it("recovers F007 hair delivery and isolates matte chest-ink attachment loss without inference", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-007";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("f3f611e49726f4ffcd277d8492c3163372332315667b70a793415f3d658dd790");
    expect(sha(png)).toBe("759afce4ad0a409ff3cb5677fa354fa3b712245a232a56fe6e7bc030d2da8e7d");
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
    expect(e).toMatchObject({ runId: "9bcceb3456efbc2b1ed831b405f34bde", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 38933, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 34516 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    const saved: SkinPlan = t.skinPlan.skinPlan, params = t.injectedParameters, immutable = JSON.stringify(t);
    // Only the saved subset required for outfit planning, not a reconstructed full analysis.
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(a.observed.clothing).toContain("large, matte black cross graphic on the center chest");
    const design = t.referenceStyle.design, style = params.faceStyle;
    expect(style.hat).toBe("none"); expect(saved.headIdentityPlan.ownership!.covering).toBe(false);
    expect(design.hair.family).toBe("medium_layered");
    expect(design.candidates.hair.some((v: { family: string }) => v.family === "hoodie_beanie_compatible")).toBe(false);
    expect(saved.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", color: "#eeeae1" });
    expect(saved.outfitPlan.upper.pattern.graphicShape).toBeUndefined();
    const resolved = buildOutfitPlan(a);
    expect(resolved.upper.pattern).toMatchObject({ graphicShape: "cross", color: "#242326", surfaceParts: ["body"] });
    expect(a.fallbackFeatures.sleeveLength).toBe("short");
    expect(resolved.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    expect(resolved.upper.rightSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    // The audit deliberately omits generated outfitPrompt. Do not recreate it.
    // These observed-first subplans are recovered only conditional on the
    // already saved hoodie category. A missing prompt could change upperType;
    // do not mistake that incompatible hypothetical branch for this live run.
    expect(saved.outfitPlan.upper.garmentType).toBe("hoodie");
    const omittedContextAudit = [];
    for (const outfitPrompt of ["", "short-sleeved hoodie with a white star on the chest",
      "long blue jacket over red shirt, gray trousers and black shoes"]) {
      const variant = buildOutfitPlan({ ...a, outfitPrompt });
      expect(variant.upper.pattern).toEqual(resolved.upper.pattern);
      const matchesStoredCategory = variant.upper.garmentType === saved.outfitPlan.upper.garmentType;
      if (matchesStoredCategory) {
        expect(variant.upper.leftSleeve).toEqual(resolved.upper.leftSleeve);
        expect(variant.upper.rightSleeve).toEqual(resolved.upper.rightSleeve);
      } else {
        expect(variant.upper.garmentType).toBe("jacket");
        expect(variant.upper.leftSleeve.length).toBe("short");
      }
      omittedContextAudit.push({ syntheticContext: true, garmentType: variant.upper.garmentType,
        matchesStoredCategory, sleeve: variant.upper.leftSleeve.length });
    }
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-007-evidence-review-20261011-");
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const results = [];
    for (const mode of ["actual-live", "offline-matte-attachment-fix", "offline-affected-sleeve-and-graphic-subplans"] as const) {
      const p = structuredClone(saved);
      if (mode !== "actual-live") {
        p.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        p.outfitPlan.outerLayer.regions = p.outfitPlan.outerLayer.regions.filter(v => v !== "graphic_depth");
        p.outfitPlan.outerLayerRegions = p.outfitPlan.outerLayerRegions.filter(v => v !== "graphic_depth");
      }
      if (mode === "offline-affected-sleeve-and-graphic-subplans") {
        p.outfitPlan.upper.leftSleeve = structuredClone(resolved.upper.leftSleeve);
        p.outfitPlan.upper.rightSleeve = structuredClone(resolved.upper.rightSleeve);
        p.outfitPlan.outerLayer.regions = [...new Set([...p.outfitPlan.outerLayer.regions, "cuffs" as const])];
        p.outfitPlan.outerLayerRegions = [...new Set([...p.outfitPlan.outerLayerRegions, "cuffs" as const])];
      }
      const base = buildProceduralSourceAtlas(params.features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "actual-live") expect(composed.atlas.rgba).toEqual(actual.rgba);
      const selection = selectReferenceStyleAtlas(base, p, design, style);
      expect(selection.selected!.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, design, composed)).ok).toBe(true);
      const changed = Array.from({ length: 4096 }, (_, i) => i).filter(i =>
        [0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== composed.atlas.rgba[i * 4 + ch]));
      const rects = [CLASSIC_LAYOUT.body.base.front, CLASSIC_LAYOUT.body.overlay.front,
        ...(mode === "offline-affected-sleeve-and-graphic-subplans"
          ? [...Object.values(CLASSIC_LAYOUT.rightArm.base), ...Object.values(CLASSIC_LAYOUT.rightArm.overlay),
            ...Object.values(CLASSIC_LAYOUT.leftArm.base), ...Object.values(CLASSIC_LAYOUT.leftArm.overlay)] : [])];
      for (const i of changed) expect(rects.some(z => i % 64 >= z.x && i % 64 < z.x + z.w && Math.floor(i / 64) >= z.y && Math.floor(i / 64) < z.y + z.h)).toBe(true);
      if (mode !== "actual-live") expect(changed.length).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      if (mode !== "offline-affected-sleeve-and-graphic-subplans") expect(p.outfitPlan.upper.leftSleeve).toEqual(saved.outfitPlan.upper.leftSleeve);
      expect(p.outfitPlan.upper.neckline).toEqual(saved.outfitPlan.upper.neckline);
      const encoded = await encodePng(composed.atlas); expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed.length, unrelatedPixels: 0, craftPass: true, atlasPass: true,
        rgbaSha256: sha(composed.atlas.rgba), outerHairCells: selection.selected!.quality.metrics.actualOuterHairCells,
        hairFamily: design.hair.family, pattern: p.outfitPlan.upper.pattern, leftSleeve: p.outfitPlan.upper.leftSleeve });
    }
    expect(results.map(v => v.changedPixels)).toEqual([0, 14, 294]);
    expect(results.every(v => v.outerHairCells === 38)).toBe(true);
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: e.runId,
      checkpointIntegrity: true, checkpointCount: checkpoints.length, actualPngExactReplay: true,
      httpStatus: e.httpStatus, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1, liveGemini: 1, liveGemma: 1,
      liveGeometry: 0, retry: 0, offlineProviderCalls: 0, gracefulTeardown: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      currentWornCoveringGateLiveVerified: true, priorCrossBranchesExercised: false,
      earliestLoss: "matte before named ink stops observedAttachedChestGraphic; explicit black cross becomes generic white graphic",
      classification: "NORMALIZED_PRESERVED_PLAN_LOST", fullAnalysisReconstructed: false,
      omittedOutfitPromptRecovered: false, recoveredScope: "observed_first_subplans_conditional_on_saved_hoodie_category",
      omittedContextAudit,
      primarySleeveCategory: a.fallbackFeatures.sleeveLength, repairedSleeveProvenance: "strongly_implied",
      freshLiveMatteAttachmentFixVerified: false, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F007_EVIDENCE_REVIEW", root);
  } finally { network.mockRestore(); }
}, 90_000);
