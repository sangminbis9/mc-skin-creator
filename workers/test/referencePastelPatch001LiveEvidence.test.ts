// Immutable same-run recovery, not a reconstructed primary response or new inference.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import { buildReferenceLooseHair } from "../src/referenceLooseHair";
import { historicalLooseHairCollision } from "./historicalLooseHairCollision";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("recovers A001 actual PNG and keeps primary omissions separate from deterministic losses", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const historicalCollision = historicalLooseHairCollision();
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-patch-20261011-001";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("2087712629e1f730296e371a0f522d1df0c41723b079bd7314e8d2ab6dbc92ec");
    expect(sha(png)).toBe("ffc0e7242d3a19042ad7328666f24edec6fdbc4b22d0b1b4caafb18079fa62d2");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(versions).toHaveLength(67);
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
    expect(e).toMatchObject({ runId: "4abc8dd7ef09aaf8d9a8e8054a82106c", generationPosts: 1, providerRetry: 0,
      httpStatus: 200, elapsedMs: 42755, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 429, elapsedMs: 1332 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 38466 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(r.diagnostics.geometry).toBeNull();
    expect(e.cropReplay).toMatchObject({ geometryAttemptObserved: false, actualWireCropSha256: null,
      replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters, style = params.faceStyle;
    // Do not invent omitted prompts. Replay the complete saved executable plan.
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, style, p)!;
    const replay = composeReferenceStyleAtlas(base, p, d, style), selection = selectReferenceStyleAtlas(base, p, d, style);
    expect(replay.atlas.rgba).toEqual(actual.rgba); expect(selection.selected!.composition.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, d, replay)).ok).toBe(true);
    expect((await decodePng(await encodePng(actual))).rgba).toEqual(actual.rgba);
    expect(t.primary.renderHints.hairPart).toBe("center");
    expect(t.renderAnalysis.renderHints.hairPart).toBe("left");
    expect(t.primary.observed.hair).toContain("viewer-left side has a small purple bow");
    expect(t.primary.observed.hair).toContain("face-framing locks extending to the jawline");
    expect(d.drape.eligible).toBe(false);
    expect(replay.diagnostic.looseHair.frontEvidence).toBeNull();
    // Rear length was supported, but accessory collision removes the whole
    // curtain. This diagnostic does NOT propose deleting the observed belt.
    expect(replay.diagnostic.looseHair.rearEvidence).toBeNull();
    const withoutAccessories = buildReferenceLooseHair({ ...p, outfitPlan: { ...p.outfitPlan, accessories: [] } }, d, style);
    expect(withoutAccessories.rearEvidence).toBe("source_supported_unseen_completion");
    expect(withoutAccessories.points.some(c => c.face === "back")).toBe(true);
    expect(t.primary.observed.clothing).toContain("pastel gradient of pink, yellow, purple, and light blue");
    expect(p.outfitPlan.upper.pattern.kind).toBe("none");
    expect(p.outfitPlan.upper.colorBlocks).toHaveLength(1);
    const out = freshAuditOutput("evaluation-artifacts/reference-pastel-patch-001-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), pngSha256: sha(png),
      rgbaSha256: sha(actual.rgba), runId: e.runId, checkpointCount: versions.length, checkpointIntegrity: true,
      actualPngExactReplay: true, replayCollisionPolicy: "historical_whole_group_drop", atlasPass: true, referenceCraftPass: true, httpStatus: e.httpStatus, elapsedMs: e.elapsedMs,
      startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 1, liveGemmaGeometry: 0, retry: 0,
      offlineProviderCalls: 0, gracefulTeardown: true, productionConfigUnchanged: true,
      serverSidePreviewDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      selectedFamilies: t.selectedFamilies, sourceProjectionChanges: t.projectionChanges,
      boundaries: {
        part: { primary: "center", normalized: "left", classification: "PRIMARY_OBSERVED_NORMALIZATION_LOST" },
        frontLength: { observedEndpoint: "jawline", overall: "chest", frontDrapeAuthorized: false,
          classification: "SOURCE_VISIBLE_PRIMARY_MISSED", note: "overall length does not authorize chest-length front locks" },
        rearLength: { sourceCompletion: "long hair down the back", actualRearDrape: false,
          withoutAccessoriesRearDrape: true, classification: "PARAMETER_PRESERVED_PLAN_LOST",
          note: "accessory collision drops entire curtain; preserve actual belt in any subsequent repair" },
        upperPalette: { primary: ["pink", "yellow", "purple", "light blue"], planBlockCount: 1,
          classification: "OBSERVED_PALETTE_LOST_BEFORE_FINAL_PLAN_EXACT_STAGE_PENDING",
          note: "gradient observation is not evidence of checker blocks; audit color normalization before choosing a repair" },
      }, qualityGoalComplete: false }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("A001_EVIDENCE_REVIEW", out);
  } finally { historicalCollision.mockRestore(); network.mockRestore(); }
}, 60_000);
