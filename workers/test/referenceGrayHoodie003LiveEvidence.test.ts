// Immutable same-run evidence review; no live runner import or provider access.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { PhotoAnalysis } from "../src/analysis";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-003";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers F003, verifies live sleeve/graphic delivery, and preserves unresolved hair losses", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("ad3447747ebe2e327264b48917944bdce0c26536bcd796801918186d33644f8a");
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
    expect(e).toMatchObject({ runId: "2a484036f2a0b55e071ef57b2b8d891c", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 39364, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 34654 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, st = t.injectedParameters.faceStyle;
    expect(p.outfitPlan.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326" });
    expect(t.primary.observed.hair).toContain("ashy gray color"); expect(st.hairColor).toBe("#3b2a1e");
    expect(t.primary.renderHints.overallHairLength).toBe("jaw");
    expect(t.renderAnalysis.renderHints.overallHairLength).toBe("chest");
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, st);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("368f46868e9d775681660fcd35ad52274ab1920988664411414d77cbb291237a");
    expect(sha(actual.rgba)).toBe("85b869022a37ad817be5bb36a66db5dcb0e609b300715d9149cd037b6d9db44a");
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(replay.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, st, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    const withoutGraphic = structuredClone(p); withoutGraphic.outfitPlan.upper.pattern.kind = "none";
    const noGraphicBase = buildProceduralSourceAtlas(t.injectedParameters.features, st, withoutGraphic)!;
    const noGraphic = composeReferenceStyleAtlas(noGraphicBase, withoutGraphic, d, st).atlas;
    const graphicPixels: number[] = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== noGraphic.rgba[i * 4 + ch])) graphicPixels.push(i);
    // Removing the print also re-enables 12 existing plain-cloth fold cells.
    // Distinguish the 14 ink cells from those protected material-finish cells.
    const front = CLASSIC_LAYOUT.body.base.front;
    const at = (x: number, y: number) => (front.y + y) * 64 + front.x + x;
    const inkCells = [3, 4, 5, 6, 7, 8].flatMap(y => [at(3, y), at(4, y)]).concat(at(2, 5), at(5, 5));
    const foldCells = [3, 4, 5, 6, 7, 8].flatMap(y => [at(1, y), at(6, y)]);
    expect(graphicPixels).toEqual([...inkCells, ...foldCells].sort((a, b) => a - b));
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-003-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_immutable_live_evidence_review", sourceRoot: root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointIntegrity: true, checkpoints: files.length,
      httpStatus: 200, elapsedMs: e.elapsedMs, actualPngExactReplay: true, pngSha256: sha(png), craftPass: true, atlasPass: true,
      startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 1, liveGeometry: 0, providerRetry: 0,
      offlineProviderCalls: 0, gracefulCleanup: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      selectedFamilies: t.selectedFamilies, graphicPixels, inkCells: inkCells.length, printProtectedFoldCells: foldCells.length,
      sleeve: p.outfitPlan.upper.leftSleeve,
      unresolved: ["gray observed but brown parameter", "primary jaw normalized to chest"],
      qualityGoalComplete: false, nextBoundary: "offline_hair_color_binding_and_relative_length_scope",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F003_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("isolates field-scoped gray material against the saved F003 plan without inventing missing prompt context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    const t = s.currentDefaultE2E.result.propagationTrace;
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, old = t.injectedParameters;
    const features = refineFeatureColorsFromAnalysis(a, old.features);
    expect(features.hairColor).toBe("#9a9a9a");
    expect({ ...features, hairColor: old.features.hairColor }).toEqual(old.features);
    const style = { ...old.faceStyle, hairColor: features.hairColor };
    const base = buildProceduralSourceAtlas(features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style);
    const actual = await decodePng(readFileSync(`${root}/skin.png`));
    // The immutable live plan already contains the erroneous chest drape.
    // A palette-only experiment must recolor that owned hair, not pretend
    // that this replay also repairs length or that its pixels are clothing.
    const ownedBodyHair = new Set(replay.diagnostic.surfaces.filter(c => c.part !== "head" && c.owner === "hair").map(c => {
      const r = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return (r.y + c.y) * 64 + r.x + c.x;
    }));
    let changedHead = 0, changedBodyHair = 0;
    for (let i = 0; i < 4096; i++) {
      expect(replay.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(ch => replay.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
        if (Math.floor(i / 64) < 16) changedHead++;
        else { expect(ownedBodyHair.has(i), `non-hair body change:${i}`).toBe(true); changedBodyHair++; }
      }
    }
    expect(changedHead).toBeGreaterThan(0);
    expect(validateFinalAtlas(replay.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(replay.atlas, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(base, p, d, style).atlas.rgba).toEqual(replay.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-003-material-replay-20261011-");
    writeFileSync(`${out}/after.png`, await encodePng(replay.atlas), { flag: "wx" });
    for (const v of renderSkinViews(replay.atlas)) writeFileSync(`${out}/after-${v.name}.png`,
      await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_plan_palette_counterfactual_not_live",
      sourceRoot: root, sourceSummarySha256: sha(bytes), runId: s.currentDefaultE2E.runId,
      observedHair: a.observed.hair, beforeColor: old.faceStyle.hairColor, afterColor: style.hairColor,
      changedHead, changedBodyHair, unrelatedBodyChanged: 0, alphaChanged: 0, planUnchanged: true,
      beforeRgbaSha256: sha(actual.rgba), afterRgbaSha256: sha(replay.atlas.rgba),
      craftPass: true, atlasPass: true, deterministic: true, providerCalls: 0,
      fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      lengthRepairNotIncludedInThisPaletteReplay: true }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("F003_MATERIAL_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
