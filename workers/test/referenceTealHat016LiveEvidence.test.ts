// Offline recovery and isolated replay of one consumed, immutable live run.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import type { PhotoAnalysis } from "../src/analysis";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-016";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D016 and isolates its two compound-description material losses without inventing missing context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("d258e145877dd435063dcb6804d19d6dbf808452417cf35f03879b3fb5712701");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(57);
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
    expect(e).toMatchObject({ runId: "83ab739598141e95d7346bd48abcabf4", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 47641, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toEqual([
      { stage: "geminiPrimary", started: true, completion: "returned", elapsedMs: 1254, httpStatus: 400,
        deadlineMs: 45000, schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" },
      { stage: "gemmaPrimary", started: true, completion: "returned", elapsedMs: 42558, httpStatus: null,
        deadlineMs: 60000, schemaSha256: "498a0ad85e255bf3f518deb216abdc18af2f45fa15a45a5a58954abb2a73a4d6" },
    ]);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
      fallbackEligible: true, fallbackReason: "provider_failed_precondition" }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION",
      validationReason: "face_head_relationship_invalid", relationshipFailure: "head_height_ratio" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const prev = JSON.parse(readFileSync(root.replace(/016$/, "015") + "/summary.json", "utf8")).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prev.preprocessing);
    expect(Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prev.fixedHashes[k]).map(k => k.replaceAll("\\", "/")))
      .toEqual(["src/generate.ts", "src/outfitIdentity.ts"]);
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.accessories).toBe("a large, light blue, fuzzy/textured hat");
    expect(t.primary.fallbackFeatures.hatColor).toBe("black");
    expect(t.injectedParameters.features.hatColor).toBe("#22201e");
    expect(t.primary.observed.clothing).toContain("pastel checkered/pixelated pattern");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.blockColors).toEqual(["#c8798c", "#b6a2cc", "#d5af3f"]);
    expect(t.referenceStyle.design.drape.eligible).toBe(false);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("2865aca522a191d484b5246a40b3e908c0b750d994c0c1353202bf672948f987");
    expect(sha(actual.rgba)).toBe("3a07600acba06c47489c872b5efa4e061857dd257816aad671b17eaf96752d6e");
    expect([actual.width, actual.height]).toEqual([64, 64]);
    // Omitted prompts stay empty only to invoke observed-only material resolvers.
    // Keep all saved construction/family/context; do not synthesize a full plan.
    const a = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
    const refined = refineFeatureColorsFromAnalysis(a, t.injectedParameters.features), pattern = buildOutfitPlan(a).upper.pattern;
    expect(refined.hatColor).toBe("#7fc3e8");
    expect(pattern.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#e1c87d"]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-016-material-transfer-20261011-"), rows = [];
    for (const [name, hat, pastel] of [["actual-live", false, false], ["hat-only-offline", true, false],
      ["pastel-only-offline", false, true], ["combined-offline", true, true]] as const) {
      const p = structuredClone(t.skinPlan.skinPlan), d = t.referenceStyle.design;
      const f = { ...t.injectedParameters.features }, st = { ...t.injectedParameters.faceStyle };
      if (hat) { f.hatColor = refined.hatColor; st.hatColor = refined.hatColor; }
      if (pastel) p.outfitPlan.upper.pattern = pattern;
      const base = buildProceduralSourceAtlas(f, st, p)!, result = composeReferenceStyleAtlas(base, p, d, st);
      if (!hat && !pastel) expect(result.atlas.rgba).toEqual(actual.rgba);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      expect(validateReferenceAtlasCraft(result.atlas, base, p, st, buildReferenceCraftPlan(p, d, result)).ok).toBe(true);
      expect(composeReferenceStyleAtlas(base, p, d, st).atlas.rgba).toEqual(result.atlas.rgba);
      const clothRects = (["body", "leftArm", "rightArm"] as const).flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
      const covering = new Set(result.diagnostic.surfaces.filter(c => c.owner === "covering").map(c => {
        const rect = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return (rect.y + c.y) * 64 + rect.x + c.x;
      }));
      let changedPixels = 0, coveringPixels = 0;
      for (let i = 0; i < 4096; i++) {
        expect(result.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if (![0, 1, 2].some(ch => result.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) continue;
        changedPixels++;
        if (hat && covering.has(i)) { coveringPixels++; continue; }
        expect(pastel && clothRects.some(rect => i % 64 >= rect.x && i % 64 < rect.x + rect.w && Math.floor(i / 64) >= rect.y && Math.floor(i / 64) < rect.y + rect.h)).toBe(true);
      }
      if (hat || pastel) expect(changedPixels).toBeGreaterThan(0);
      if (hat) expect(coveringPixels).toBeGreaterThan(0);
      expect(p.hairPlan).toEqual(t.skinPlan.skinPlan.hairPlan); expect(p.facePixelPlan).toEqual(t.skinPlan.skinPlan.facePixelPlan);
      expect(p.headIdentityPlan).toEqual(t.skinPlan.skinPlan.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(t.skinPlan.skinPlan.outfitPlan.lower);
      const encoded = await encodePng(result.atlas); expect((await decodePng(encoded)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      rows.push({ name, changedPixels, coveringPixels, unrelatedPixelDiff: 0, alphaUnchanged: true,
        craftPass: true, atlasPass: true, rgbaSha256: sha(result.atlas.rgba) });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "immutable_live_recovery_and_offline_material_ablation",
      sourceRoot: root, sourceSummarySha256: sha(bytes), liveRunId: e.runId, checkpointIntegrity: true, checkpoints: 57,
      httpStatus: 200, elapsedMs: e.elapsedMs, exactActualReplay: true,
      liveAccounting: { startup: 1, health: 1, post: 1, geminiPrimary: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      offlineProviderCalls: 0, gracefulCleanup: true, productionConfigUnchanged: true,
      serverSidePreviewDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      localization: r.diagnostics.localization, materialLossStage: "observed_prose_to_hat_color_and_pattern_palette",
      observedAccessories: t.primary.observed.accessories, observedClothing: t.primary.observed.clothing,
      beforeHatColor: t.injectedParameters.features.hatColor, afterHatColor: refined.hatColor,
      beforePalette: t.skinPlan.skinPlan.outfitPlan.upper.pattern.blockColors, afterPalette: pattern.blockColors,
      hairNotReconstructed: true, missingPromptsNotReconstructed: true, currentFixFreshLiveVerified: false,
      qualityGoalComplete: false, rows }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D016_MATERIAL_EVIDENCE", out);
  } finally { network.mockRestore(); }
}, 60_000);
