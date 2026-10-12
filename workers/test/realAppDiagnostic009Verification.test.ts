// Immutable evidence verification only: no remote runner or provider imports.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-009");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const trace = run.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers the finalized one-shot checkpoint and graceful lifecycle", () => {
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(records).toHaveLength(32);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  }
  const last = JSON.parse(fs.readFileSync(path.join(root, records.at(-1)!), "utf8"));
  expect(last).toMatchObject({ event: "auditLifecycleFinalized", sequence: 32,
    snapshotSha256: "07c8a331a828d2985299c7e795513107ed7592b06e83a65476319b89ca359718" });
  expect(last.snapshot).toEqual(summary);
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
    health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
  expect(run).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
    accounting: "known", diskRecovery: true });
});

it("records one eligible primary failure then one strict-valid Gemma with no geometry", () => {
  expect(run.result.bindingAttempts.map((v: { stage: string }) => v.stage))
    .toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
  expect(run.result.bindingAttempts[1]).toMatchObject({ elapsedMs: 30450, deadlineMs: 50000, completion: "returned" });
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.cropReplay).toMatchObject({ geometryAttemptObserved: false,
    replayEligibility: { reason: "localized_face_unavailable" } });
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("links actual dark formal material and exact replay to the valid saved PNG", async () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    analysis: { sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa" },
    generation: { sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d" } });
  expect(trace.skinPlan.skinPlan.outfitPlan.formalSuit).toMatchObject({ jacketColor: "#242326",
    shirtColor: "#eeeae1", tieColor: "#242326", trouserColor: "#242326" });
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  const bytes = fs.readFileSync(path.join(root, "skin.png"));
  expect(sha(bytes)).toBe("fc9ff884ed2fee05f588ee6bc833d88634bc7a214fc371e0e99cf72bfc42eae0");
  const png = await decodePng(bytes);
  expect([png.width, png.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(png).ok).toBe(true);
  let darkMaterialPixels = 0;
  for (let i = 0; i < png.rgba.length; i += 4)
    if (png.rgba[i] === 36 && png.rgba[i + 1] === 35 && png.rgba[i + 2] === 38 && png.rgba[i + 3] === 255)
      darkMaterialPixels++;
  expect(darkMaterialPixels).toBeGreaterThan(0);
});

it("retains the actual missed part/opening and contradictory sleeve evidence, not expected source labels", () => {
  expect(run.result.diagnostics.providerAppearance.renderHints.hairSides.hairPart).toBe("none");
  expect(run.result.diagnostics.providerAppearance.renderHints.fringe.fringeOpening).toBe("none");
  expect(trace.injectedParameters.faceStyle).toMatchObject({ hairPart: "none", fringeOpening: "none" });
  expect(trace.primary.observed.clothing).toContain("formal suit jacket");
  expect(trace.primary.fallbackFeatures.sleeveLength).toBe("short");
  expect(trace.skinPlan.skinPlan.outfitPlan.upper.leftSleeve.length).toBe("short");
  // Evidence of a visible defect, NOT an assertion that short sleeves are correct.
});
