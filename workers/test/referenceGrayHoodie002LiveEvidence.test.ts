// Offline recovery of immutable, same-run evidence. Never starts a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { PhotoAnalysis } from "../src/analysis";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import * as layeredCrown from "../src/referenceLayeredCrown";

const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-002";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers F002 and preserves the observed gray / fallback brown contradiction without repair", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  // F002 predates crown relief. Preserve exact historical pixels rather than
  // silently treating the later four-cell topology change as a color change.
  const historicalCrown = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("830ab974ceeeb9608bcac42209de483702760ca5761527fd88710ebae0b53b3a");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(67);
    for (const [i, file] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true,
      ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
      ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    const e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    expect(e).toMatchObject({ runId: "3ce0d9b29db5e1cffd242b04baca1abd", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 50814, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 46467 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.hair).toContain("ash-gray");
    expect(t.primary.fallbackFeatures.hairColor).toBe("dark-brown");
    expect(t.injectedParameters.faceStyle.hairColor).toBe("#3b2a1e");
    expect(t.selectedFamilies).toEqual({ face: "dark_stylish", hair: "medium_layered", outfit: "dark_hoodie_streetwear" });
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, st = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, st);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("14e81d7a24e0fa4ee3b0e7556fbc5128be95506c36e5aee0a34fe07b494aef2f");
    expect(sha(actual.rgba)).toBe("45595b79262ad7fcc85d3a2673192ce201aa757dfde1d59f47fcdfac5fa58813");
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(replay.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, st, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-002-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_immutable_live_evidence_review", sourceRoot: root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointIntegrity: true, checkpoints: files.length,
      httpStatus: 200, elapsedMs: e.elapsedMs, actualPngExactReplay: true, historicalPreReliefCrown: true, pngSha256: sha(png), craftPass: true, atlasPass: true,
      startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 1, liveGeometry: 0, providerRetry: 0,
      offlineProviderCalls: 0, gracefulCleanup: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      observed: t.primary.observed, selectedFamilies: t.selectedFamilies,
      hairColor: { observed: t.primary.observed.hair, providerFallback: t.primary.fallbackFeatures.hairColor,
        injected: st.hairColor, classification: "OBSERVED_GRAY_FALLBACK_BROWN_PARAMETER_BROWN", repairApplied: false },
      outfit: { primarySleeve: t.primary.fallbackFeatures.sleeveLength, injectedStyleSleeve: st.sleeveLength,
        planSleeve: p.outfitPlan.upper.leftSleeve.length, pattern: p.outfitPlan.upper.pattern },
      localization: r.diagnostics.localization, qualityGoalComplete: false,
      nextBoundary: "offline_observed_hair_color_selection_contract_review",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F002_EVIDENCE_REVIEW", out);
  } finally { historicalCrown.mockRestore(); network.mockRestore(); }
}, 60_000);

it("replays the bounded hair-material binding fix against F002 without reconstructing missing analysis", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const historicalCrown = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    const t = s.currentDefaultE2E.result.propagationTrace;
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const oldFeatures = t.injectedParameters.features, oldStyle = t.injectedParameters.faceStyle;
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, planSnapshot = JSON.stringify(p);
    const features = refineFeatureColorsFromAnalysis(a, oldFeatures);
    const gray = fallbackFeaturesToHex({ ...a.fallbackFeatures, hairColor: "gray" }).hairColor;
    expect(features.hairColor).toBe(gray);
    expect({ ...features, hairColor: oldFeatures.hairColor }).toEqual(oldFeatures);
    const st = { ...oldStyle, hairColor: features.hairColor };
    const base = buildProceduralSourceAtlas(features, st, p)!;
    const after = composeReferenceStyleAtlas(base, p, d, st);
    const actual = await decodePng(readFileSync(`${root}/skin.png`));
    let headChanged = 0, bodyChanged = 0;
    for (let i = 0; i < actual.rgba.length; i += 4) {
      expect(after.atlas.rgba[i + 3]).toBe(actual.rgba[i + 3]);
      if (actual.rgba.slice(i, i + 4).some((v, k) => v !== after.atlas.rgba[i + k])) {
        if (Math.floor(i / 4 / 64) < 16) headChanged++; else bodyChanged++;
      }
    }
    expect(headChanged).toBeGreaterThan(0); expect(bodyChanged).toBe(0);
    expect(JSON.stringify(p)).toBe(planSnapshot);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, base, p, st, buildReferenceCraftPlan(p, d, after)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(base, p, d, st).atlas.rgba).toEqual(after.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-material-replay-20261011-");
    for (const view of renderSkinViews(after.atlas)) writeFileSync(`${out}/after-${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/after.png`, await encodePng(after.atlas), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_plan_palette_counterfactual_not_live",
      sourceRoot: root, sourceSummarySha256: sha(bytes), providerCalls: 0, actualBeforeRgbaSha256: sha(actual.rgba),
      afterRgbaSha256: sha(after.atlas.rgba), observedHair: a.observed.hair, providerFallbackColor: a.fallbackFeatures.hairColor,
      beforeColor: oldStyle.hairColor, afterColor: st.hairColor, headChanged, bodyChanged, alphaChanged: 0,
      planUnchanged: true, historicalPreReliefCrown: true, missingProseReconstructed: false, craftPass: true, atlasPass: true, deterministic: true,
      earliestLoss: "NORMALIZED_PRESERVED_PARAMETER_LOST", boundary: "comma_and_medium_length_material_binding",
      remaining: ["hoodie_sleeve_plan_conflicts_with_style", "observed_black_cross_graphic_not_in_plan"],
      freshLiveAfterFix: false, qualityGoalComplete: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("F002_MATERIAL_REPLAY", out);
  } finally { historicalCrown.mockRestore(); network.mockRestore(); }
}, 60_000);
