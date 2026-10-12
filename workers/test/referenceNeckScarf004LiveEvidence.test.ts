// Read-only consumed C-004 recovery. Never import a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { measureReferenceAccessoryRetention } from "../src/referenceOutfitRetention";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { freshAuditOutput } from "./freshAuditOutput";
import { preserveObservedKneeDistressing } from "../src/outfitIdentity";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-004";
const bytes = readFileSync(`${root}/summary.json`), summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

// Replay the consumed run's selected design, not a new winner chosen by a
// later ranking change. Current selection is compared in its own audit test.
function replaySavedDesign(plan: SkinPlan) {
  const style = trace.injectedParameters.faceStyle, design = trace.referenceStyle.design;
  const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, plan)!;
  const composition = composeReferenceStyleAtlas(baseline, plan, design, style);
  expect(validateReferenceAtlasCraft(composition.atlas, baseline, plan, style,
    buildReferenceCraftPlan(plan, design, composition)).ok).toBe(true);
  return composition.atlas;
}

it("recovers the immutable successful run without claiming the uncalled Gemma primary schema was accepted", () => {
  expect(sha(bytes)).toBe("5a5589bfe40eee3780770f30c88960d434506b491817990dfc1d47d6ad60bbbe");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const [i, name] of names.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const final = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(final.event).toBe("auditLifecycleFinalized"); expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "b8c34cce8db410974d08edf242cdbc3c", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 32781, diskRecovery: true });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 200, elapsedMs: 21746 }),
    expect.objectContaining({ stage: "faceGeometry", completion: "returned", elapsedMs: 6983 }),
  ]);
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization).toMatchObject({ status: "VALID" });
  expect(run.result.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
  const previous = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-003/summary.json", "utf8")).currentDefaultE2E;
  expect(run.contract.gemmaSchemaSha256).toBe("6003f93e1d9134ef6675d61f8615b52154eea7a423fae6adab46e5c14dd8dde3");
  const { gemmaSchemaSha256: _new, ...currentContract } = run.contract;
  const { gemmaSchemaSha256: _old, ...previousContract } = previous.contract;
  void _new; void _old;
  expect(currentContract).toEqual(previousContract);
});

it("separates preserved scarf/belt/flower observations from the same-run knee planning omission", () => {
  expect(trace.primary.observed).toEqual(trace.renderAnalysis.observed);
  expect(trace.primary.observed.clothing).toContain("distressed ripped knee detail on the viewer's right leg");
  expect(saved.outfitPlan.lower.kneeDistressing).toBeUndefined();
  expect(saved.outfitPlan.accessories).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "scarf", color: "#ded2b6", source: "observed" }),
    expect.objectContaining({ kind: "belt", color: "#c8798c", source: "observed" }),
  ]));
  expect(trace.primary.renderHints).toMatchObject({ hairAccessory: "flower", hairAccessoryColor: "white", neckAccessory: "scarf" });
  expect(saved.headIdentityPlan.ownership).toMatchObject({ execution: "resolved", covering: false });
  expect(trace.selectedFamilies).toEqual({ face: "clean_masculine_soft", hair: "long_wavy_with_bangs", outfit: "casual_knit_cardigan" });
  expect(trace.referenceStyle).toMatchObject({ status: "reference_style_accepted", craftValidation: "pass" });
});

it("replays the consumed production PNG's saved design exactly and produces fresh enlarged review views", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const png = readFileSync(`${root}/skin.png`), image = await decodePng(png);
    expect(sha(png)).toBe("9309ddf0530c490b69857bec85d2f1874f7f8d413dc94e021606d59ea311a15e");
    expect(sha(image.rgba)).toBe("96f17ab919feeaf74a6a8df90338bd0022dcda657ee07020014792d46df01b81");
    expect([image.width, image.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
    expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true, featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
    const replay = replaySavedDesign(saved);
    expect(sha(replay.rgba)).toBe(sha(image.rgba));
    expect(measureReferenceAccessoryRetention(image, saved.outfitPlan, trace.injectedParameters.features.skinTone).valid).toBe(true);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    const output = freshAuditOutput("evaluation-artifacts/reference-neck-scarf-004-review-20261010-");
    for (const view of renderSkinViews(image)) writeFileSync(`${output}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_review", sourceRun: run.runId,
      summarySha256: sha(bytes), pngSha256: sha(png), exactSavedPlanReplay: true,
      preserved: ["neck_scarf_not_head_covering", "cream_scarf", "pink_belt", "flower_observation", "long_wavy_family"],
      earliestKneeLoss: "NORMALIZED_PRESERVED_PLAN_LOST", schemaCompatibility: "Gemma_primary_not_called_unverified",
      consumedLiveCalls: { geminiPrimary: 1, gemmaPrimary: 0, faceGeometry: 1, retry: 0 }, newProviderCalls: 0,
      historicalArtifactsUnchanged: true }, null, 2), { flag: "wx" });
    console.info("C004_REVIEW", output);
  } finally { network.mockRestore(); }
}, 60_000);

it("confirms graceful cleanup without inferring remote preview deletion", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true,
    cleanupFailed: false, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});

it("preserves the actual C-004 knee observation with six localized offline pixels and no source repair", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const analysis = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const immutable = JSON.stringify([analysis, saved]);
    const plan = { ...saved, outfitPlan: preserveObservedKneeDistressing(saved.outfitPlan, analysis) };
    expect(plan.outfitPlan.lower.kneeDistressing).toMatchObject({ parts: ["leftLeg"], exposedSkin: false, source: "observed" });
    expect(plan.facePixelPlan).toBe(saved.facePixelPlan);
    expect(plan.hairPlan).toBe(saved.hairPlan);
    expect(plan.headIdentityPlan).toBe(saved.headIdentityPlan);
    const atlas = replaySavedDesign(plan);
    const before = await decodePng(readFileSync(`${root}/skin.png`)), rect = CLASSIC_LAYOUT.leftLeg.base.front;
    const changes = [];
    for (let i = 0; i < 4096; i++) {
      expect(atlas.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(ch => atlas.rgba[i * 4 + ch] !== before.rgba[i * 4 + ch])) {
        expect([rect.x + 1, rect.x + 2]).toContain(i % 64);
        expect([rect.y + 5, rect.y + 6, rect.y + 7]).toContain(Math.floor(i / 64));
        changes.push(i);
      }
    }
    expect(changes).toHaveLength(6);
    expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
    expect(measureReferenceAccessoryRetention(atlas, plan.outfitPlan, trace.injectedParameters.features.skinTone).valid).toBe(true);
    const png = await encodePng(atlas);
    expect((await decodePng(png)).rgba).toEqual(atlas.rgba);
    expect(JSON.stringify([analysis, saved])).toBe(immutable);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/reference-neck-scarf-004-knee-offline-20261010-");
    writeFileSync(`${output}/after.png`, png, { flag: "wx" });
    for (const [name, image] of [["before", before], ["after", atlas]] as const) {
      const front = renderSkinViews(image).find(v => v.name === "front")!.image;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_saved_C004_not_new_live", providerCalls: 0,
      sourceSummarySha256: sha(bytes), sourceRun: run.runId, firstLoss: "NORMALIZED_PRESERVED_PLAN_LOST",
      cue: plan.outfitPlan.lower.kneeDistressing, beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(atlas.rgba),
      changedPixels: changes.length, unrelatedPixelsChanged: 0, craft: "pass", finalAtlas: "pass",
      analysisUnchanged: true, historicalArtifactsUnchanged: true }, null, 2), { flag: "wx" });
    console.info("C004_KNEE_OFFLINE", output);
  } finally { network.mockRestore(); }
}, 60_000);
