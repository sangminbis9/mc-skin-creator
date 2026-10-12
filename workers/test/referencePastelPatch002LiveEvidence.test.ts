// Saved executable plan replay only. No missing primary fields are reconstructed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const cases = [
  { suffix: "002", summaryHash: "345a923d623d084c3f93d18765e485896613c9286381559350a4438c59357499",
    pngHash: "fc78dc349f9b4c6c6a9fba0b2de1a33807f66a45e8bca0a9cbca4940cc6390ab",
    runId: "dcabaf65f20208d245fb016eb5e66392", elapsedMs: 45553,
    geminiCompletion: "returned", geminiStatus: 429, geminiElapsed: 971, gemmaElapsed: 41518,
    clause: "puff-sleeve top with a pastel gradient pattern of purple, pink, and yellow",
    colors: ["#a38cab", "#d9a5af", "#e1c87d"], boundary: "optional_pattern_noun_and_attached_puff_sleeve_garment_modifier" },
  { suffix: "003", summaryHash: "11f8958168639ee4b3cab7de597f176bbf1a125e8d08c02297797d4fc258d638",
    pngHash: "b96a470a68ffa954a8e5b3317bbd99e6d3aed63e77667dacbe06f63fa903a86e",
    runId: "4e65148750ade578190904014f09b377", elapsedMs: 79502,
    geminiCompletion: "threw", geminiStatus: null, geminiElapsed: 45000, gemmaElapsed: 31225,
    clause: "pastel rainbow color gradient (purple, blue, pink, yellow) and ruffled sleeves",
    colors: ["#a38cab", "#819cba", "#d9a5af", "#e1c87d"], boundary: "parenthesized_explicit_palette_and_closed_construction_suffix" },
];
it.each(cases)("recovers A$suffix lifecycle and exact PNG, then isolates its complete gradient palette loss offline", async f => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = `evaluation-artifacts/reference-style-v3-e2e-pastel-patch-20261011-${f.suffix}`;
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe(f.summaryHash);
    expect(sha(png)).toBe(f.pngHash);
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(versions).toHaveLength(67); // Final lifecycle envelope follows the projected count.
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
    expect(e).toMatchObject({ runId: f.runId, generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: f.elapsedMs, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: f.geminiCompletion, httpStatus: f.geminiStatus, elapsedMs: f.geminiElapsed });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: f.gemmaElapsed });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    const immutable = JSON.stringify(t), actual = await decodePng(png);
    const base = buildProceduralSourceAtlas(params.features, style, p)!;
    const before = composeReferenceStyleAtlas(base, p, d, style);
    expect(before.atlas.rgba).toEqual(actual.rgba);
    expect(selectReferenceStyleAtlas(base, p, d, style).selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, before)).ok).toBe(true);
    expect(t.primary.renderHints.hairPart).toBe("center"); expect(t.renderAnalysis.renderHints.hairPart).toBe("center");
    expect(before.diagnostic.looseHair.rearEvidence).toBe("source_supported_unseen_completion");
    expect(before.diagnostic.looseHair.points.some(c => c.face === "back")).toBe(true);
    if (f.suffix === "003") {
      expect(before.diagnostic.looseHair.frontEvidence).toBe("observed_shoulder_drape");
      expect(before.diagnostic.looseHair.points.filter(c => c.face === "front")).toHaveLength(20);
      expect(before.diagnostic.looseHair.points.filter(c => c.face === "back")).toHaveLength(40);
    }
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain(f.clause);
    expect(p.outfitPlan.upper.pattern.kind).toBe("none");
    // Authored complete carrier exercises only the bounded garment parser.
    const carrier = makeAnalysis(); carrier.observed.clothing = t.primary.observed.clothing;
    carrier.visibleRegions.upperBody = t.primary.visibleRegions.upperBody; carrier.outfitPrompt = "";
    const pattern = buildOutfitPlan(carrier).upper.pattern;
    expect(pattern).toMatchObject({ construction: "stepped_gradient", gradientColors: f.colors });
    const plan = structuredClone(p); plan.outfitPlan.upper.pattern = pattern;
    const afterBase = buildProceduralSourceAtlas(params.features, style, plan)!;
    const after = composeReferenceStyleAtlas(afterBase, plan, d, style);
    expect(selectReferenceStyleAtlas(afterBase, plan, d, style).selected!.composition.atlas.rgba).toEqual(after.atlas.rgba);
    expect(composeReferenceStyleAtlas(afterBase, plan, d, style).atlas.rgba).toEqual(after.atlas.rgba);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, afterBase, plan, style, buildReferenceCraftPlan(plan, d, after)).ok).toBe(true);
    expect(after.diagnostic.looseHair).toEqual(before.diagnostic.looseHair);
    const allowed = new Set<number>();
    for (const part of ["body", "leftArm", "rightArm"] as const) {
      const end = part === "body" ? Math.min(p.outfitPlan.lower.waistRow, p.outfitPlan.upper.hem ? p.outfitPlan.upper.hem.endRow - 1 : 12)
        : p.outfitPlan.upper[part === "leftArm" ? "leftSleeve" : "rightSleeve"].terminationRow - 1;
      for (const face of ["front", "back", "left", "right"] as const) {
        const rect = CLASSIC_LAYOUT[part].base[face];
        for (let y = 1; y < end; y++) for (let x = 0; x < rect.w; x++) allowed.add((rect.y + y) * 64 + rect.x + x);
      }
    }
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++; expect(allowed.has(i), `outside upper cloth ${i}`).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
    const rect = CLASSIC_LAYOUT.body.base.front, visible = new Set<string>();
    const bodyEnd = Math.min(p.outfitPlan.lower.waistRow, p.outfitPlan.upper.hem ? p.outfitPlan.upper.hem.endRow - 1 : 12);
    for (let y = 1; y < bodyEnd; y++) for (let x = 0; x < rect.w; x++) {
      const i = ((rect.y + y) * 64 + rect.x + x) * 4;
      visible.add("#" + [...after.atlas.rgba.subarray(i, i + 3)].map(v => v.toString(16).padStart(2, "0")).join(""));
    }
    for (const color of pattern.gradientColors!) expect(visible.has(color), color).toBe(true);
    const out = freshAuditOutput(`evaluation-artifacts/reference-pastel-patch-${f.suffix}-evidence-review-20261011-`);
    for (const [name, atlas] of [["live", actual], ["offline-after", after.atlas]] as const) {
      const encoded = await encodePng(atlas); expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), pngSha256: sha(png),
      runId: e.runId, checkpointCount: versions.length, checkpointIntegrity: true, actualPngExactReplay: true,
      httpStatus: 200, elapsedMs: e.elapsedMs, startup: 1, health: 1, post: 1, liveGeminiPrimary: 1,
      liveGemmaPrimary: 1, liveGemmaGeometry: 0, retry: 0, offlineProviderCalls: 0, gracefulTeardown: true,
      serverSidePreviewDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      productionConfigUnchanged: true, part: { primary: "center", normalized: "center" },
      liveRearHair: before.diagnostic.looseHair, selectedFamilies: t.selectedFamilies,
      firstLoss: "NORMALIZED_PRESERVED_PLAN_LOST", primaryPatternObservation: "gradient_not_checker_blocks",
      parserBoundary: f.boundary,
      fullAnalysisReconstructed: false, repairMode: "offline_saved_plan_pattern_transfer", pattern,
      freshLivePaletteFixVerified: false, changedUpperClothPixels: changed, unrelatedChangedPixels: 0,
      liveRgbaSha256: sha(actual.rgba), offlineAfterRgbaSha256: sha(after.atlas.rgba), craftPass: true, atlasPass: true,
      sourceProjectionChanges: t.projectionChanges, qualityGoalComplete: false }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info(`A${f.suffix}_EVIDENCE_REVIEW`, out);
  } finally { network.mockRestore(); }
}, 60_000);
