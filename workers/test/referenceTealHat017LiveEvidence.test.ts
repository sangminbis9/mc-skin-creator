// Immutable same-run recovery only. Never starts a remote runner or provider.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import type { PhotoAnalysis } from "../src/analysis";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-017";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D017's real hat-color delivery and isolates its remaining observed-pattern plan loss", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("50b1af0b444f88fa7d4d4f083a1617b7fd8787608d48b58b86ee7c2eaa14944d");
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
    expect(e).toMatchObject({ runId: "dc1a6ba8efe0927737d60be2c403bc2b", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 41128, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toEqual([
      { stage: "geminiPrimary", started: true, completion: "returned", elapsedMs: 4697, httpStatus: 503,
        deadlineMs: 45000, schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" },
      { stage: "gemmaPrimary", started: true, completion: "returned", elapsedMs: 33233, httpStatus: null,
        deadlineMs: 60000, schemaSha256: "498a0ad85e255bf3f518deb216abdc18af2f45fa15a45a5a58954abb2a73a4d6" },
    ]);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", status: 503, fallbackEligible: true }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const prev = JSON.parse(readFileSync(root.replace(/017$/, "016") + "/summary.json", "utf8")).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prev.preprocessing);
    expect(Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prev.fixedHashes[k]).map(k => k.replaceAll("\\", "/")))
      .toEqual(["src/generate.ts", "src/outfitIdentity.ts"]);
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.accessories).toBe("a large, fuzzy, light-blue hat covering the top of the head");
    expect(t.injectedParameters.features.hatColor).toBe("#7fc3e8");
    expect(t.primary.observed.clothing).toContain("pastel pixelated patchwork pattern consisting of pink, lavender, light blue, and yellow squares");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.kind).toBe("irregular_group");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.blockColors).toBeUndefined();
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, st = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
    const local = composeReferenceStyleAtlas(base, p, d, st);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("1c4d0fca2c7ca1a0bece170b5e2ad56b93fc80786eaeef7ef8bfce904a3217fb");
    expect(sha(actual.rgba)).toBe("aa11c332e6ec3de78bd78e4af5f11f9efe0b4c60a7c17ad018bf485d3d7353db");
    expect(local.atlas.rgba).toEqual(actual.rgba); expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(validateReferenceAtlasCraft(actual, base, p, st, buildReferenceCraftPlan(p, d, local)).ok).toBe(true);
    const hatCells = local.diagnostic.surfaces.filter(c => c.owner === "covering");
    const exactHatPixels = hatCells.filter(c => {
      const rect = CLASSIC_LAYOUT[c.part][c.layer][c.face], at = ((rect.y + c.y) * 64 + rect.x + c.x) * 4;
      return [127, 195, 232, 255].every((v, ch) => actual.rgba[at + ch] === v);
    }).length;
    expect(exactHatPixels).toBeGreaterThan(0);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-017-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_immutable_live_evidence_review",
      sourceRoot: root, sourceSummarySha256: sha(bytes), runId: e.runId, checkpointIntegrity: true, checkpoints: 57,
      httpStatus: 200, elapsedMs: e.elapsedMs, actualPngExactReplay: true, pngSha256: sha(png),
      craftPass: true, atlasPass: true, startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 1,
      liveGeometry: 0, retry: 0, offlineProviderCalls: 0, gracefulCleanup: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      hat: { observation: t.primary.observed.accessories, parameter: st.hatColor, exactHatPixels, liveDelivery: true,
        newFuzzySlashBranchExercised: false },
      pattern: { observation: t.primary.observed.clothing, normalized: t.renderAnalysis.observed.clothing,
        plan: p.outfitPlan.upper.pattern, classification: "NORMALIZED_PRESERVED_PATTERN_PLAN_LOST",
        pastelCompoundFixLiveExercise: false },
      selectedFamilies: t.selectedFamilies, localization: r.diagnostics.localization,
      faceFinish: local.diagnostic.faceFinish, drape: d.drape, qualityGoalComplete: false,
      nextBoundary: "bounded_observed_pattern_grammar_not_another_unchanged_sampling_run",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D017_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("replays only D017's observed patchwork palette and preserves saved head, lower body and family", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString()), t = s.currentDefaultE2E.result.propagationTrace;
    expect(sha(bytes)).toBe("50b1af0b444f88fa7d4d4f083a1617b7fd8787608d48b58b86ee7c2eaa14944d");
    // Only invoke observed-clothing resolution. Never reconstruct missing prompts.
    const a = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
    const pattern = buildOutfitPlan(a).upper.pattern;
    expect(pattern).toMatchObject({ construction: "pixel_blocks", source: "observed", placement: "wrap" });
    expect(pattern.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#a9d5eb", "#e1c87d"]);
    const saved = t.skinPlan.skinPlan, actual = await decodePng(readFileSync(`${root}/skin.png`));
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-017-pattern-replay-20261011-"), rows = [];
    for (const corrected of [false, true]) {
      const p = structuredClone(saved), st = t.injectedParameters.faceStyle, d = t.referenceStyle.design;
      if (corrected) p.outfitPlan.upper.pattern = pattern;
      const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
      const result = composeReferenceStyleAtlas(base, p, d, st);
      if (!corrected) expect(result.atlas.rgba).toEqual(actual.rgba);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      expect(validateReferenceAtlasCraft(result.atlas, base, p, st, buildReferenceCraftPlan(p, d, result)).ok).toBe(true);
      expect(composeReferenceStyleAtlas(base, p, d, st).atlas.rgba).toEqual(result.atlas.rgba);
      const clothParts = ["body", "leftArm", "rightArm"] as const;
      const allowed = clothParts.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
      let changedPixels = 0;
      for (let i = 0; i < 4096; i++) {
        expect(result.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if (![0, 1, 2].some(ch => actual.rgba[i * 4 + ch] !== result.atlas.rgba[i * 4 + ch])) continue;
        changedPixels++;
        expect(allowed.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
      }
      if (corrected) expect(changedPixels).toBeGreaterThan(0);
      expect(p.hairPlan).toEqual(saved.hairPlan); expect(p.facePixelPlan).toEqual(saved.facePixelPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      const visiblePalette = corrected ? pattern.blockColors!.map(hex => {
        const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let count = 0;
        for (const part of clothParts) {
          const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
            const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
            const at = result.atlas.rgba[oi + 3] === 255 ? oi : bi;
            if (rgb.every((v, ch) => result.atlas.rgba[at + ch] === v)) count++;
          }
        }
        expect(count).toBeGreaterThan(0); return { hex, visibleFrontPixels: count };
      }) : [];
      const name = corrected ? "corrected-offline" : "actual-live";
      const encoded = await encodePng(result.atlas); expect((await decodePng(encoded)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      rows.push({ name, changedPixels, unrelatedPixelDiff: 0, alphaUnchanged: true, craftPass: true, atlasPass: true,
        visiblePalette, rgbaSha256: sha(result.atlas.rgba) });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_observed_pattern_only_not_live", providerCalls: 0,
      sourceSummarySha256: sha(bytes), sourceRoot: root, runId: t.runId, pattern, rows,
      hairAndFaceAndHatUnchanged: true, missingContextNotRebuilt: true, qualityGoalComplete: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("D017_PATTERN_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
