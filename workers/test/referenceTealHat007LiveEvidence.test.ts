// Offline review of the consumed D007 run. Never imports the remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-007";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());

it("verifies D007 durable result, exact dispatch accounting and graceful cleanup independently of test exit", () => {
  expect(sha(bytes)).toBe("052dd1dbb382c385f9fa50314b01f69bce36707a678a1467f119c473f3d77b70");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(57);
  for (const [i, file] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  const r = s.currentDefaultE2E;
  expect(r).toMatchObject({ runId: "04542fa3ad1e2df47f26e2e6d129d516", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 49127, accounting: "known", diskRecovery: true });
  expect(r.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 503 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned" }),
  ]);
  expect(r.result.diagnostics.primaryDiagnostic.attempts).toBe(2);
  expect(r.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", providerStatus: "UNAVAILABLE", fallbackEligible: true }));
  expect(r.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(r.result.diagnostics.geometry).toBeNull();
  expect(r.cropReplay.geometryAttemptObserved).toBe(false);
  expect(r.result.diagnostics.localization).toMatchObject({ status: "MALFORMED", numericParse: "failed" });
  expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
    healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  expect(s.shutdownLatch.phase).toBe("finalized");
  const previous = JSON.parse(readFileSync(root.replace(/007$/, "006") + "/summary.json", "utf8"));
  expect(r.preprocessing).toEqual(previous.currentDefaultE2E.preprocessing);
  expect(r.fixedHashes).toEqual(previous.currentDefaultE2E.fixedHashes);
}, 60_000);

it("proves deferred local atlas equality using actual same-run saved parameters and records the unresolved pattern boundary", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const r = s.currentDefaultE2E, t = r.result.propagationTrace;
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(t.replay).toMatchObject({ scope: "plan_features_only", atlasReplay: "deferred_local",
      renderAnalysisMatch: true, sourcePlanMatch: true, featuresMatch: true, finalAtlasMatch: null, selectedDesignMatch: null });
    const p: SkinPlan = t.skinPlan.skinPlan, style: FaceStyle = t.injectedParameters.faceStyle;
    const design: ReferenceStylePlan = t.referenceStyle.design;
    const features: Parameters<typeof buildProceduralSourceAtlas>[0] = t.injectedParameters.features;
    const source = buildProceduralSourceAtlas(features, style, p)!;
    expect(source).not.toBeNull();
    const local = composeReferenceStyleAtlas(source, p, design, style);
    const pngBytes = readFileSync(`${root}/skin.png`), actual = await decodePng(pngBytes);
    expect(actual.width).toBe(64); expect(actual.height).toBe(64);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(local.atlas.rgba).toEqual(actual.rgba);
    expect(sha(pngBytes)).toBe(t.finalPng.sha256);
    expect(sha(local.atlas.rgba)).toBe(t.finalPng.rgbaSha256);
    expect(features.hat).toBe("beanie"); expect(features.hatColor).toBe("#7fc3e8");
    expect(t.primary.observed.clothing).toContain("abstract geometric block pattern");
    expect(t.renderAnalysis.observed.clothing).toBe(t.primary.observed.clothing);
    expect(p.outfitPlan.upper.pattern.kind).toBe("none");
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-007-offline-review-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_evidence_exact_atlas_replay",
      sourceSummarySha256: sha(bytes), runId: r.runId, remoteReplayScope: t.replay.scope,
      localExactAtlasMatch: true, sourceImageRead: false, rawPromptReconstructed: false, missingEvidenceSupplemented: false,
      pngSha256: sha(pngBytes), rgbaSha256: sha(actual.rgba), pngDimensions: [64, 64], finalAtlasValidation: true,
      selectedFamilies: t.selectedFamilies, hatCategory: features.hat, hatColor: features.hatColor,
      patternObservedInPrimaryAndNormalized: true, planPatternKind: p.outfitPlan.upper.pattern.kind,
      patternEarliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", actualPatternPalette: ["pink", "purple", "lavender", "yellow", "light blue"],
      livePrimaryCalls: 2, liveGeometryCalls: 0, newProviderCalls: 0, checkpointIntegrity: true, gracefulCleanup: true,
      remoteCpuMeasurementAvailable: false, lowerAuditCostCausalProof: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 60_000);
