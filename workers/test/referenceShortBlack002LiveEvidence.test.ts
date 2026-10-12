// Read-only consumed live evidence. Never imports or starts the remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-short-black-sweatshirt-20261010-002";
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
const e = s.currentDefaultE2E, t = e.result.propagationTrace;
const saved: SkinPlan = t.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers all immutable checkpoints and successful strict Gemma evidence with no missing measurement fields", () => {
  expect(sha(bytes)).toBe("b451f1eb59e976b29a70f33dc6f4eccba69e4605e790d3efe353675965bc6251");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const [i, name] of names.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(e).toMatchObject({ runId: "f8ff864ba1ceeca92cbfb42891992ca3", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 36675, diskRecovery: true,
    classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED" });
  expect(e.contract.gemmaSchemaSha256).toBe("498a0ad85e255bf3f518deb216abdc18af2f45fa15a45a5a58954abb2a73a4d6");
  expect(e.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 992 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 31671 }),
  ]);
  expect(e.result.diagnostics.primaryDiagnostic.providerAttempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION",
      fallbackEligible: true, fallbackReason: "provider_failed_precondition" }),
    expect.objectContaining({ provider: "workers_ai", outcome: "completed", providerSchemaValidation: "passed", strictValidation: "passed" }),
  ]));
  expect(e.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(Object.values(t.primary.faceMeasurementEvidence.cues)).toHaveLength(8);
  for (const cue of Object.values(t.primary.faceMeasurementEvidence.cues) as Array<{provenance: string; confidence: number}>) {
    expect(cue.provenance).toBe("observed_categorical"); expect(cue.confidence).toBeGreaterThanOrEqual(0.75);
  }
  expect(e.result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(t.primary.sourceSelection.portraitRegion).toBeNull(); expect(e.result.diagnostics.geometry).toBeNull();
});

it("separates preserved clothing observation from contradictory fallback and deterministic material loss", () => {
  expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
  expect(t.primary.observed.clothing).toBe("a plain black crewneck sweatshirt and straight-leg gray pants, paired with plain white sneakers");
  expect(t.primary.fallbackFeatures).toMatchObject({ topType: "tshirt", topColor: "blue", sleeveLength: "short" });
  expect(t.selectedFamilies).toEqual({ face: "dark_stylish", hair: "medium_layered", outfit: "clean_sweatshirt_casual" });
  expect(t.injectedParameters.features).toMatchObject({ topColor: "#4d9de0", bottomColor: "#8c8c8c" });
  expect(saved.outfitPlan.upper).toMatchObject({ garmentType: "tshirt", baseColor: "#416b9d", leftSleeve: { length: "short" } });
  expect(saved.outfitPlan.lower.baseColor).toBe("#242326");
  // No missing prompt reconstruction: isolate only saved observed prose, with
  // unrelated channels deliberately empty in this authored boundary probe.
  const probe = { ...t.primary, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
  const before = JSON.stringify(probe);
  expect(refineFeatureColorsFromAnalysis(probe, t.injectedParameters.features).topColor).toBe("#22201e");
  expect(buildOutfitPlan(probe).upper.baseColor).toBe("#242326");
  // The saved plan above proves the old black-prefix leak; the current resolver
  // now preserves gray pants. This is not a provider-observation omission.
  expect(buildOutfitPlan(probe).lower.baseColor).toBe("#77777c");
  expect(JSON.stringify(probe)).toBe(before);
  expect(t.primary.renderHints).toMatchObject({ overallHairLength: "jaw", irisLightness: "dark" });
});

it("replays the actual saved design and final PNG exactly, independently of quality acceptance", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const png = readFileSync(`${root}/skin.png`), image = await decodePng(png);
    expect(sha(png)).toBe("c830e97ab692576df41c50b48c9878a30402bcba344dbf1f46fd9101724b243d");
    expect(sha(image.rgba)).toBe("28674138dc4728f1186e259e48d29bb27302a7b5e49b4ca1d3b4ad2108eacf32");
    expect([image.width, image.height]).toEqual([64, 64]); expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
    expect(Object.values(e.propagationLink).every(v => v === true)).toBe(true);
    expect(t.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true, featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
    const style = t.injectedParameters.faceStyle, design = t.referenceStyle.design;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, style, saved)!;
    const composition = composeReferenceStyleAtlas(base, saved, design, style);
    expect(sha(composition.atlas.rgba)).toBe(sha(image.rgba));
    expect(validateReferenceAtlasCraft(composition.atlas, base, saved, style,
      buildReferenceCraftPlan(saved, design, composition)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-short-black-002-review-20261010-");
    for (const view of renderSkinViews(image)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_review", sourceRun: e.runId,
      summarySha256: sha(bytes), pngSha256: sha(png), exactReplay: true, finalAtlasValid: true,
      qualityAccepted: false, earliestClothingBoundary: "observed_sweatshirt_not_recognized_by_material_binding",
      primaryContradictions: ["black_sweatshirt_prose_vs_blue_tshirt_short_fallback"],
      unresolvedPrimaryObservations: ["jaw_length_hair", "dark_eyes"],
      geometry: "not_called_invalid_localization", newProviderCalls: 0 }, null, 2), { flag: "wx" });
    console.info("B002_REVIEW", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
}, 60_000);

it("confirms bounded accounting and graceful cleanup, not independent server deletion", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(Object.values(s.prohibited).every(v => v === 0)).toBe(true);
});
