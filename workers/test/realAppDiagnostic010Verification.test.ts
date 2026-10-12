// Immutable live-evidence verification: no remote runner or provider imports.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-010");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const trace = run.result.propagationTrace;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers all immutable checkpoints and the one-shot graceful final state", () => {
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(records).toHaveLength(32);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  }
  const last = JSON.parse(fs.readFileSync(path.join(root, records.at(-1)!), "utf8"));
  expect(last).toMatchObject({ event: "auditLifecycleFinalized", sequence: 32,
    snapshotSha256: "94dfa12029db6bb669c93a26d5c4d99ad1e9ba879cc2a732aae96edafe9ef172" });
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

it("keeps eligible fallback, actual validation and prohibited call accounting separate", () => {
  expect(run.result.bindingAttempts.map((v: { stage: string }) => v.stage))
    .toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
  expect(run.result.bindingAttempts[1]).toMatchObject({ elapsedMs: 11110, deadlineMs: 50000, completion: "returned" });
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.cropReplay).toMatchObject({ geometryAttemptObserved: false,
    replayEligibility: { reason: "localized_face_unavailable" } });
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("links conservative long jacket construction and exact replay to the actual 64-square PNG", async () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    analysis: { sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa" },
    generation: { sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d" } });
  const outfit = trace.skinPlan.skinPlan.outfitPlan;
  expect(outfit.formalSuit).toMatchObject({ jacketColor: "#242326", shirtColor: "#eeeae1",
    tieColor: "#242326", trouserColor: "#242326" });
  for (const side of ["leftSleeve", "rightSleeve"]) expect(outfit.upper[side]).toMatchObject({
    length: "long", terminationRow: 11, source: "conservative",
    evidence: "conventional observed formal jacket; sleeve endpoint not explicitly observed" });
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(trace.referenceStyle.craftValidation).toBe("pass");
  expect(trace.referenceStyle.constraints).toMatchObject({ ok: true, violations: [],
    baseHairCells: 190, outerHairCells: 32 });
  expect(trace.referenceStyle.metrics).toMatchObject({ isolatedOuterPixels: 0, accidentalEyeOcclusionCells: 0 });
  const bytes = fs.readFileSync(path.join(root, "skin.png"));
  expect(bytes.length).toBe(1344);
  expect(sha(bytes)).toBe("a9fae9cbb9c0fe4ad5c57c2c0d30a9e98e9d0df987a3dde55e676da9faf85d2c");
  const png = await decodePng(bytes);
  expect([png.width, png.height]).toEqual([64, 64]);
  expect(sha(png.rgba)).toBe("4697b6adae8f127c5c33c80175d878aace8ef805e3e7c0bb238c5a2434c0fa7c");
  expect(validateFinalAtlas(png).ok).toBe(true);
});

it("preserves observed center cues without silently correcting the remaining primary length error", () => {
  const appearance = run.result.diagnostics.providerAppearance;
  expect(appearance.renderHints.hairSides.hairPart).toBe("center");
  expect(appearance.renderHints.fringe.fringeOpening).toBe("center");
  expect(appearance.renderHints.hairLength.overallHairLength).toBe("jaw");
  expect(trace.injectedParameters.faceStyle).toMatchObject({ hairPart: "center", fringeOpening: "center",
    overallHairLength: "jaw", sleeveLength: "long" });
  expect(trace.referenceStyle.design.hair).toMatchObject({ family: "medium_layered",
    evidence: ["structured jaw-length hair"] });
  // This documents a remaining source-observation limitation, not a correct source label.
});
