// Offline read-only verification of consumed H -003; no remote runner imports.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-003";
const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers all immutable checkpoints and the bounded provider sequence", () => {
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "e1f9ebec1cf988d34cc2f60b0d796cf4", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 20455, diskRecovery: true });
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

it("links the exact valid PNG to the same-run plan and delivered cropped hem", async () => {
  const bytes = readFileSync(`${root}/skin.png`), image = await decodePng(bytes);
  expect(sha(bytes)).toBe("6ba5a893bfe32dc7b815dc28ec20294f9716728fc3b6b6ba4b2285df309cfc06");
  expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([image.width, image.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(trace.referenceStyle).toMatchObject({ status: "reference_style_accepted",
    craftValidation: "pass", constraints: { ok: true, violations: [] } });
  const plan = trace.skinPlan.skinPlan;
  expect(plan.outfitPlan.upper.hem).toEqual({ endRow: 8, skinGapRows: 0,
    source: "observed", evidence: "crop top; skin gap unobserved" });
  expect(plan.outfitPlan.lower.waistRow).toBe(8);
  const front = CLASSIC_LAYOUT.body.base.front;
  const colors: string[] = [];
  for (let y = 8; y < 12; y++) for (let x = 0; x < front.w; x++) {
    const offset = ((front.y + y) * 64 + front.x + x) * 4;
    colors.push(`#${[...image.rgba.slice(offset, offset + 3)].map(v => v.toString(16).padStart(2, "0")).join("")}`);
  }
  expect(colors).toContain(plan.outfitPlan.lower.baseColor);
  expect(plan.outfitPlan.accessories).toContainEqual(expect.objectContaining({ kind: "bow", color: "#c8798c", source: "observed" }));
});

it("preserves observed tied sections without falsely declaring observed braids or sleeve success", () => {
  expect(trace.primary.observed.hair).toContain("Two thin sections of hair are tied");
  expect(trace.primary.observed.hair).not.toMatch(/braid/i);
  expect(trace.renderAnalysis.observed.hair).toBe(trace.primary.observed.hair);
  expect(trace.renderAnalysis.observed.clothing).toBe(trace.primary.observed.clothing);
  expect(trace.projectionChanges).not.toContain("primary.observed.hair:truncated");
  expect(trace.selectedFamilies.hair).toBe("long_straight_with_bangs");
  expect(trace.primary.observed.clothing).toContain("sleeveless crop top with pink ruffled sleeves");
  expect(trace.skinPlan.skinPlan.outfitPlan.upper.leftSleeve.length).toBe("sleeveless");
  expect(trace.skinPlan.skinPlan.outfitPlan.upper.rightSleeve.length).toBe("sleeveless");
});

it("observes complete graceful shutdown and production config preservation", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
