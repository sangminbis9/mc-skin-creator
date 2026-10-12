// Immutable live recovery and exact saved-plan replay. No live runner imports.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { PhotoAnalysis } from "../src/analysis";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers F008 delivered outfit and the remaining observed-gray/parameter-brown boundary", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-008";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("408d1c31bbd000db7624783b97f00cc8036d13b7b1b9087166a6ff7154ae5f0d");
    expect(sha(png)).toBe("5bd259de84a16314eeb46f794ee29f99b163172fbc6d9dcfeda02100f95576e7");
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
    expect(e).toMatchObject({ runId: "90bc485a45f7917f016766273f6c3b6c", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 16423, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 429 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 12340 });
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", providerStatus: "RESOURCE_EXHAUSTED", fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "MALFORMED", numericCount: 9, numericParse: "failed" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.clothing).toContain("large, dark graphic of a cross on the chest");
    expect(t.primary.observed.clothing).not.toContain("matte");
    expect(t.primary.observed.hair).toContain("The hair is a medium ash-gray color");
    expect(t.primary.fallbackFeatures.hairColor).toBe("dark-brown");
    expect(t.primary.fallbackFeatures.sleeveLength).toBe("short");
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    const immutable = JSON.stringify(t);
    expect(style.hairColor).toBe("#3b2a1e"); expect(style.hat).toBe("none");
    expect(p.headIdentityPlan.ownership.covering).toBe(false);
    expect(d.hair.family).toBe("medium_layered");
    expect(d.candidates.hair.some((v: { family: string }) => v.family === "hoodie_beanie_compatible")).toBe(false);
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326", source: "observed" });
    for (const sleeve of [p.outfitPlan.upper.leftSleeve, p.outfitPlan.upper.rightSleeve])
      expect(sleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style);
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(replay.atlas.rgba).toEqual(actual.rgba);
    const selection = selectReferenceStyleAtlas(base, p, d, style);
    expect(selection.selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-008-evidence-review-20261011-");
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
      sleeveSource: p.outfitPlan.upper.leftSleeve.source, primarySleeveCategory: t.primary.fallbackFeatures.sleeveLength,
      liveMatteBranchExercised: false, liveGraphicOfCrossBranchExercised: true, liveWornCoveringGateVerified: true,
      hairColor: { observed: t.primary.observed.hair, providerFallback: t.primary.fallbackFeatures.hairColor,
        injected: style.hairColor, classification: "OBSERVED_GRAY_FALLBACK_BROWN_PARAMETER_BROWN" },
      localization: r.diagnostics.localization, qualityGoalComplete: false,
      nextBoundary: "bounded_predicative_hair_material_color_binding_offline_review" }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F008_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("replays the F008 predicative material fix as an offline hair-color-only isolation", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-008";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("408d1c31bbd000db7624783b97f00cc8036d13b7b1b9087166a6ff7154ae5f0d");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    // Saved fields needed for color refinement only. Omitted model prose is
    // not recovered, and no claim of a reconstructed full analysis is made.
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const params = t.injectedParameters, p = t.skinPlan.skinPlan, d = t.referenceStyle.design;
    const immutable = JSON.stringify(t), oldStyle = params.faceStyle, oldFeatures = params.features;
    const refined = refineFeatureColorsFromAnalysis(a, oldFeatures);
    expect(refined.hairColor).toBe("#9a9a9a");
    expect({ ...refined, hairColor: oldFeatures.hairColor }).toEqual(oldFeatures);
    // Newly bound observed material wins without needing the absent generated
    // prompt. These are synthetic sensitivity checks, not inferred live values.
    for (const identityPrompt of ["", "black hair", "white bow with blue jacket"])
      expect(refineFeatureColorsFromAnalysis({ ...a, identityPrompt }, oldFeatures).hairColor).toBe("#9a9a9a");
    const actual = await decodePng(png);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-008-color-replay-20261011-");
    const results = [];
    for (const mode of ["actual-live", "offline-predicative-material-fix"] as const) {
      const features = mode === "actual-live" ? oldFeatures : refined;
      const style = mode === "actual-live" ? oldStyle : { ...oldStyle, hairColor: refined.hairColor };
      const base = buildProceduralSourceAtlas(features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, d, style);
      const selected = selectReferenceStyleAtlas(base, p, d, style);
      expect(selected.selected!.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      if (mode === "actual-live") expect(composed.atlas.rgba).toEqual(actual.rgba);
      let headChanged = 0, bodyChanged = 0;
      for (let i = 0; i < actual.rgba.length; i += 4) {
        expect(composed.atlas.rgba[i + 3]).toBe(actual.rgba[i + 3]);
        if (actual.rgba.slice(i, i + 4).some((v, k) => v !== composed.atlas.rgba[i + k])) {
          if (Math.floor(i / 4 / 64) < 16) headChanged++; else bodyChanged++;
        }
      }
      expect(bodyChanged).toBe(0);
      if (mode !== "actual-live") expect(headChanged).toBeGreaterThan(0);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, d, composed)).ok).toBe(true);
      const encoded = await encodePng(composed.atlas);
      expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${out}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${out}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, hairColor: style.hairColor, rgbaSha256: sha(composed.atlas.rgba), headChanged, bodyChanged,
        outerHairCells: selected.selected!.quality.metrics.actualOuterHairCells, alphaChanges: 0, atlasPass: true, referenceCraftPass: true });
    }
    expect(results.map(v => v.outerHairCells)).toEqual([38, 38]);
    expect(JSON.stringify(t)).toBe(immutable);
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, sourceSummarySha256: sha(bytes),
      actualPngSha256: sha(png), actualPngExactReplay: true, fullAnalysisReconstructed: false,
      recoveredScope: "observed_hair_material_to_color_parameter_only", freshLiveFixVerified: false,
      currentPrimaryCategoryConflict: "observed_ash_gray_vs_fallback_dark_brown",
      earliestLoss: "normalized_observation_to_refined_hair_color_parameter", plansUnchanged: true,
      offlineProviderCalls: 0, qualityGoalComplete: false, results }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F008_COLOR_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
