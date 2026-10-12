// Disk recovery only. Never imports the remote runner or sends a request.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004");
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const trace = run.result.propagationTrace;

it("recovers all 32 checkpoints and the finalized consumed state", async () => {
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest?.sequence).toBe(32);
  expect(latest?.event).toBe("auditLifecycleFinalized");
  expect(latest?.snapshot).toEqual(summary);
  expect(latest?.snapshotSha256).toBe("55fa55c437107f6a09bbe7a3ef743d32fbaeaffb809ded2db7884621f76e0825");
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n));
  expect(records).toHaveLength(32);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(run).toMatchObject({ runId: "b0781a59b4751257e8e6f220f422dc75", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true,
    httpObservation: { stage: "json_parsed", jsonRootType: "object", exception: null } });
});

it("proves the actual fallback sequence, gates and zero geometry inference", () => {
  expect(summary.startupAttempts).toBe(1);
  expect(summary.healthAttempts).toBe(1);
  expect(summary.health).toMatchObject({ status: "passed", httpStatus: 200 });
  expect(run.result.bindingAttempts.map((v: { stage: string }) => v.stage))
    .toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true,
    fallbackReason: "provider_failed_precondition" }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization.status).toBe("MISSING");
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.cropReplay.geometryAttemptObserved).toBe(false);
  expect(run.cropReplay.replayEligibility.reason).toBe("localized_face_unavailable");
  expect(run.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerAttemptIntent: 2, providerAttemptStarted: 2, failureCode: "none", responseStatus: 200 });
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("links the actual primary, selected parameters/plans and final PNG in this run", async () => {
  expect(run.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(run.preprocessing.analysis.sha256).toBe("bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa");
  expect(run.preprocessing.generation.sha256).toBe("9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d");
  expect(trace.runId).toBe(run.runId);
  expect(trace.inputs).toEqual({ analysisSha256: run.preprocessing.analysis.sha256,
    generationSha256: run.preprocessing.generation.sha256 });
  expect(Object.values(run.propagationLink)).toEqual([true, true, true, true, true]);
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  const bytes = fs.readFileSync(path.join(root, "skin.png"));
  expect(sha(bytes)).toBe("ccd6c1a14ab12318121823978fb9e888534e724547911065d325f3661ec165fe");
  const atlas = await decodePng(bytes);
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  expect(sha(atlas.rgba)).toBe("9883d84ea838479438170bfa3bb42e3fb7d08584f13fdfa504a585bd04119d6a");
  expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
});

it("preserves PRIMARY_MISSED hair evidence and isolates observed-dark material loss in the plan", () => {
  const provider = run.result.diagnostics.providerAppearance;
  expect(provider.renderHints.hairSides.hairPart).toBe("none");
  expect(provider.renderHints.fringe.fringeOpening).toBe("none");
  expect(trace.primary.renderHints.hairPart).toBe("none");
  expect(trace.renderAnalysis.renderHints.fringeOpening).toBe("none");
  expect(trace.skinPlan.skinPlan.hairPlan.part).toBe("none");
  // Missing optional cache is observed in the allowlisted pre-normalization
  // projection, not reconstructed from the final PNG.
  expect(Object.hasOwn(provider, "fallbackFeatures")).toBe(false);
  expect(trace.primary.fallbackFeatures.topColor).toBe("blue");
  expect(trace.primary.observed.clothing).toBe(provider.observed.clothing);
  expect(trace.renderAnalysis.observed.clothing).toBe(provider.observed.clothing);
  expect(provider.observed.clothing).toContain("dark, formal suit jacket");
  expect(provider.observed.clothing).toContain("dark necktie with diagonal white stripes");
  const plan = trace.skinPlan.skinPlan.outfitPlan;
  expect(plan.formalSuit).toMatchObject({ family: "formal_suit", jacketColor: "#416b9d",
    shirtColor: "#eeeae1", tieColor: "#eeeae1", trouserColor: "#49647d" });
  // This test proves immutable pre-fix live evidence, not that later production
  // code must keep reproducing its defect. Current material binding and the
  // exact before/after atlas are checked by formalSuitMaterialBinding.test.ts.
  expect(plan.observedConstruction).toBe(provider.observed.clothing);
  expect(trace.selectedFamilies).toEqual({ face: "dark_stylish", hair: "short_soft_feminine", outfit: "preserve_existing" });
  expect(trace.injectedParameters.faceStyle).toMatchObject({ expression: "neutral", mouthShape: "small",
    mouthOpening: "closed", lipFullness: "average", lipColor: "natural" });
  expect(trace.injectedParameters.familyDesign.face.mouthCells).toBe(2);
  expect(trace.skinPlan.skinPlan.facePixelPlan.renderContract.mouth.protected).toBe(false);
});

it("proves one q, complete graceful cleanup, recorded production identity and preserved prior runs", () => {
  expect(summary).toMatchObject({ qSentCount: 1, cleanupFailed: false, wrapperExitObserved: true,
    wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, shutdownLatch: { phase: "finalized", qDispatched: true, qFailed: false } });
  // The baseline's exact summary/checkpoint hashes bind its historical source
  // map. Comparing it to today's files would incorrectly reject a subsequent
  // authorized fix; source equality during the live run was verified then.
  expect(Object.keys(run.fixedHashes)).toHaveLength(72);
  const outfitIdentityHash = Object.entries(run.fixedHashes).find(([file]) => file.replace(/\\/g, "/") === "src/outfitIdentity.ts")?.[1];
  expect(outfitIdentityHash).toBe("bc6236f6fcb3f5f07546b642f2ee056defe0da91d2c25166742db3bcd8e05729");
  expect(sha(fs.readFileSync(path.join(root, "summary.json"))))
    .toBe("c47ee4e58111e816a5cd1c27150028b229724e5b9f2ecce7e0e120796a706561");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-003/summary.json")))
    .toBe("083f811d9a7edb02954d80307c127856057505807f3e9a99f6d02ed5022aa767");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002/summary.json")))
    .toBe("cba7996d6cecd232d3903575ddc4f62ec8e199b8942459972f8a8bb3037b2ffa");
  expect(summary.serverSidePreviewDeletionIndependentlyConfirmed).toBe(false);
});

it("stores no raw request/response/prompt, original image/base64 or credentials", () => {
  const forbidden = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const violations = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string" && /data:image\//i.test(v)) violations.add("image_data_url");
    if (typeof v === "string" && /Bearer\s+[A-Za-z0-9_-]+|(?:AIza|cfut_)[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{160,}={0,2}/.test(v))
      violations.add("credential_or_base64_value");
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") for (const [key, value] of Object.entries(v)) {
      if (forbidden.test(key)) violations.add("forbidden_payload_key"); scan(value);
    }
  };
  for (const file of fs.readdirSync(root).filter(n => n.endsWith(".json"))) scan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  expect([...violations]).toEqual([]);
});
