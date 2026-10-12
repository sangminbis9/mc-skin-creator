// Read-only consumed live evidence. No runner import or provider calls.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const root = "evaluation-artifacts/reference-style-v3-e2e-floral-20261008-004";
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers all 32 immutable checkpoints and the actual successful response", () => {
  const names = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const final = JSON.parse(fs.readFileSync(path.join(root, names.at(-1)!), "utf8"));
  expect(final).toMatchObject({ event: "auditLifecycleFinalized",
    snapshotSha256: "700c0c81197069034f9088c210582575c737ed99a895309547bbbb6e79ab9385" });
  expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "1d3db03ad9aabd3c47b99ac2c97c2bf8", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 62570, diskRecovery: true });
  expect(run.result).toMatchObject({ productionStatus: 200, ok: true, errorCode: null });
});

it("observes one eligible Gemini failure and one strict-valid Gemma completion, not an inferred HTTP status", () => {
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 503, elapsedMs: 24223 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 34433 }),
  ]);
  const diagnostic = run.result.diagnostics;
  expect(diagnostic.primaryDiagnostic.providerAttempts[1]).toMatchObject({ providerStatus: "UNAVAILABLE", fallbackEligible: true });
  expect(diagnostic.primaryDiagnostic.providerAttempts[3]).toMatchObject({ outcome: "completed",
    configuredDeadlineMs: 55000, deadlineTimerFired: false, providerSchemaValidation: "passed", strictValidation: "passed" });
  expect(diagnostic.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(diagnostic.providerAppearance.faceMeasurements).toHaveLength(8);
  expect(diagnostic.failedFaceMeasurement).toBeUndefined();
  expect(diagnostic.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "face_head_relationship_invalid", relationshipFailure: "both_ratios" });
  expect(diagnostic.normalizedPrimary.sourceSelection.portraitRegion).toBeNull();
  expect(diagnostic.geometry).toBeNull();
});

it("links unchanged source derivatives and the new reminder contract to the same-run replay", () => {
  const previous = JSON.parse(fs.readFileSync("evaluation-artifacts/reference-style-v3-e2e-floral-20261008-003/summary.json", "utf8")).currentDefaultE2E;
  expect(run.preprocessing.analysis).toEqual(previous.preprocessing.analysis);
  expect(run.preprocessing.generation).toEqual(previous.preprocessing.generation);
  expect(run.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(run.contract.gemmaPromptSha256).toBe("7d177df962e54c4d758649c16acf85a66d6a83e7eb557be6af330a4f5419db64");
  expect({ ...run.contract, gemmaPromptSha256: null }).toEqual({ ...previous.contract, gemmaPromptSha256: null });
  const trace = run.result.propagationTrace;
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
});

it("preserves observed rose evidence while proving loss before outfit plan and final PNG", async () => {
  const trace = run.result.propagationTrace;
  expect(trace.primary.observed.clothing).toContain("red rose graphics on the viewer-left sleeve");
  expect(trace.primary.observed.clothing).toContain("red rose graphics on the viewer-left leg");
  expect(trace.renderAnalysis.observed.clothing).toContain("red rose graphics");
  const outfit = trace.skinPlan.skinPlan.outfitPlan;
  expect(outfit.upper.pattern).toMatchObject({ kind: "none", source: "conservative" });
  expect(outfit.lower.pattern).toMatchObject({ kind: "none", source: "conservative" });
  expect(outfit.upper.pattern.evidence).toContain("red rose graphics");
  const bytes = fs.readFileSync(path.join(root, "skin.png")), atlas = await decodePng(bytes);
  expect(sha(bytes)).toBe("42b605a6cbbc1b8565b083912ba3b496f9d692a1519e456961e2e20c10241b26");
  expect(sha(atlas.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    const r = CLASSIC_LAYOUT[part].base.front;
    let red = 0;
    for (let y = 2; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * 64 + r.x + x) * 4;
      if (atlas.rgba[i] > atlas.rgba[i + 1] * 1.7 && atlas.rgba[i] > atlas.rgba[i + 2] * 1.7) red++;
    }
    expect(red, part).toBe(0);
  }
});

it("observes graceful finalization and leaves production configuration unchanged", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
