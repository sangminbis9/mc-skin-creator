// Read-only consumed H baseline: no runner imports or inference.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-001";
const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies immutable checkpoints, one bounded request and explicit provider accounting", () => {
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "2ff823c5f79182e3b0aeb5b1852e4ab1", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 35952, diskRecovery: true });
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

it("links actual 64x64 PNG to the same-run evidence without claiming authored-family acceptance", async () => {
  const bytes = readFileSync(`${root}/skin.png`), image = await decodePng(bytes);
  expect(sha(bytes)).toBe("14c81250b981d758d500cb999b8d7247649686a1a020e34dc909ebfc28aff081");
  expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([image.width, image.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  const trace = run.result.propagationTrace;
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.referenceStyle).toMatchObject({ status: "source_grammar_preserved",
    preservedReason: "unresolved_complex_head_grammar", acceptedCandidates: 0 });
  expect(trace.selectedFamilies).toBeNull();
});

it("observes clean graceful teardown, without claiming independently verified remote deletion", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
