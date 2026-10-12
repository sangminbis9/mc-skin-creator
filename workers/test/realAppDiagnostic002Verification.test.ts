// Offline-only verification of the approved, consumed diagnostic run.
// No live selector, runner import, inference, or historical reconstruction.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));

it("recovers the sealed single-run checkpoint and proves the actual budget and graceful teardown", async () => {
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest?.sequence).toBe(31);
  expect(latest?.event).toBe("auditLifecycleFinalized");
  expect(latest?.snapshot).toEqual(summary);
  for (const file of fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n))) {
    const record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(summary).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED",
    startupAttempts: 1, healthAttempts: 1, qSentCount: 1, cleanupFailed: false,
    wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, productionAdditionalDiff: 0,
    shutdownLatch: { phase: "finalized", qClaimed: true, qDispatched: true, qFailed: false } });
  const run = summary.currentDefaultE2E;
  expect(run).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
    accounting: "known", diskRecovery: true, runId: "f54d8162b6c32d63700b0f70246ba375" });
  expect(run.result.bindingAttempts.map((a: { stage: string }) => a.stage))
    .toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
    fallbackEligible: true, fallbackReason: "provider_failed_precondition" }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization.status).toBe("MISSING");
  expect(run.cropReplay.geometryAttemptObserved).toBe(false);
  expect(run.cropReplay.replayEligibility.reason).toBe("localized_face_unavailable");
  // The consumed run is historical evidence, not a permanent lock on later
  // fixes. Only separately tested outfit, reference presentation and explicit
  // categorical fringe-window propagation files may differ.
  const changed = Object.entries(run.fixedHashes)
    .filter(([file, hash]) => sha(fs.readFileSync(file)) !== hash)
    .map(([file]) => file.replace(/\\/g, "/")).sort();
  expect(changed).toEqual(["src/headOwnership.ts", "src/identityPlans.ts", "src/outfitIdentity.ts", "src/outfitRenderer.ts", "src/referenceFaceFinish.ts",
    "src/referenceStyleRenderer.ts", "src/referenceStyleSelection.ts", "src/referenceStyleTemplates.ts"]);
});

it("links accepted analysis, families, exact parameters and plans to the saved 64x64 atlas", async () => {
  const run = summary.currentDefaultE2E;
  const trace = run.result.propagationTrace;
  expect(run.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(trace.inputs).toEqual({ analysisSha256: run.preprocessing.analysis.sha256,
    generationSha256: run.preprocessing.generation.sha256 });
  expect(trace.runId).toBe(run.runId);
  expect(Object.values(run.propagationLink)).toEqual([true, true, true, true, true]);
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ context: "primary_only", renderAnalysisMatch: true,
    sourcePlanMatch: true, featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(trace.selectedFamilies).toEqual({ face: "clean_masculine_soft", hair: "short_soft_feminine",
    outfit: "preserve_existing" });
  const png = fs.readFileSync(path.join(root, "skin.png"));
  const atlas = await decodePng(png);
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
  expect(sha(png)).toBe(trace.finalPng.sha256);
  expect(sha(atlas.rgba)).toBe(trace.finalPng.rgbaSha256);
});

it("separates the actual primary hair miss from the observed suit's earliest plan loss", () => {
  const run = summary.currentDefaultE2E;
  const provider = run.result.diagnostics.providerAppearance;
  const trace = run.result.propagationTrace;
  expect(provider.observed.clothing).toMatch(/formal suit jacket/i);
  expect(provider.observed.clothing).toMatch(/white collared shirt/i);
  expect(provider.observed.clothing).toMatch(/dark navy or black necktie/i);
  expect(trace.primary.observed.clothing).toBe(provider.observed.clothing);
  expect(trace.renderAnalysis.observed.clothing).toBe(provider.observed.clothing);
  expect(provider.renderHints.hairSides.hairPart).toBe("none");
  expect(provider.renderHints.fringe.fringeOpening).toBe("none");
  expect(trace.primary.renderHints.hairPart).toBe("none");
  const outfit = trace.skinPlan.skinPlan.outfitPlan;
  expect(outfit.upper).toMatchObject({ garmentType: "jacket", collar: "lapel", baseColor: "#242326" });
  expect(outfit.upper.colorBlocks.map((b: { id: string }) => b.id)).toEqual(["upper_base"]);
  expect(outfit.accessories.find((a: { kind: string }) => a.kind === "tie").color).toBe("#eeeae1");
  expect(trace.injectedParameters.faceStyle.neckAccessoryColor).toBe("#22201e");
  expect(trace.primary.renderHints).toMatchObject({ mouthShape: "small", mouthOpening: "closed" });
  expect(trace.injectedParameters.familyDesign.face.mouthCells).toBe(2);
});

it("stores no raw provider payload, prompt, image/base64, header or credential in JSON artifacts", () => {
  const forbidden = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const violations = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      // Aggregate fixed codes instead of allocating assertions per ownership
      // cell in every immutable checkpoint. Never include matched secret text.
      if (/data:image\//i.test(value)) violations.add("image_data_url");
      if (/Bearer\s+[A-Za-z0-9_-]+/i.test(value)) violations.add("authorization_value");
      if (/(?:AIza|cfut_)[A-Za-z0-9_-]{20,}/.test(value)) violations.add("credential_value");
      if (/[A-Za-z0-9+/]{160,}={0,2}/.test(value)) violations.add("base64_value");
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (forbidden.test(key)) violations.add("forbidden_payload_key");
      scan(item);
    }
  };
  for (const file of fs.readdirSync(root).filter(n => n.endsWith(".json")))
    scan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  expect([...violations]).toEqual([]);
});
