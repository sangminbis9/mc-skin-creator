// Offline verification of consumed H -002. Never imports a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-002";
const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers every immutable checkpoint and exact bounded same-run accounting", () => {
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "3ba50f10efa380c86b985666eff10b9c", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 38312, diskRecovery: true });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null }),
  ]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    providerStatus: "FAILED_PRECONDITION", fallbackEligible: true,
  }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization.status).toBe("MISSING");
  expect(run.result.diagnostics.geometry).toBeNull();
});

it("links the final valid PNG to accepted reference grammar and observed pink chest bow", async () => {
  const bytes = readFileSync(`${root}/skin.png`), image = await decodePng(bytes);
  expect(sha(bytes)).toBe("cda6e9fe2741aba6d43eadaded1fccb3f725f9835a3dab3468e77b043b87df64");
  expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([image.width, image.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.referenceStyle).toMatchObject({ status: "reference_style_accepted", acceptedCandidates: 6,
    craftValidation: "pass", constraints: { ok: true, violations: [] } });
  const plan = trace.skinPlan.skinPlan;
  expect(plan.headIdentityPlan.ownership.execution).toBe("resolved");
  expect(plan.headIdentityPlan.ownership.cells.some((c: { sourceGroupId: string }) => c.sourceGroupId === "head-accessory-region")).toBe(false);
  expect(plan.headIdentityPlan.ownership.cells.filter((c: { sourceGroupId: string }) => c.sourceGroupId === "head-ribbon-footprint")).toHaveLength(9);
  expect(plan.outfitPlan.accessories).toContainEqual(expect.objectContaining({ kind: "bow", color: "#c8798c", source: "observed" }));
  expect(plan.outfitPlan.provenance).toContainEqual(expect.objectContaining({ target: "accessories.bow.color", evidence: "a pink bow at the center of the chest" }));
});

it("records remaining evidence boundaries without inventing braids or laundering sleeve color", () => {
  expect(trace.primary.observed.hair).not.toMatch(/braid/i);
  expect(trace.projectionChanges).not.toContain("primary.observed.hair:truncated");
  expect(trace.selectedFamilies.hair).toBe("long_straight_with_bangs");
  expect(trace.primary.observed.clothing).toContain("puffed pink sleeves");
  // Historical result: this documents the earliest next loss, not desired behavior.
  const upper = trace.skinPlan.skinPlan.outfitPlan.upper;
  expect(upper.leftSleeve.color).toBe(upper.baseColor);
  expect(upper.rightSleeve.color).toBe(upper.baseColor);
  expect(upper.baseColor).toBe("#eeeae1");
});

it("observes clean graceful shutdown and unchanged production config", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
