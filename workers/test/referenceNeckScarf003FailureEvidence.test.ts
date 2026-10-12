// Immutable, read-only recovery. No remote runner imports and no provider calls.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT } from "../src/gemmaPhotoAnalysis";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-003";
const bytes = readFileSync(`${root}/summary.json`);
const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, d = e.result.diagnostics;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers all 31 immutable checkpoints and the finalized authoritative summary", () => {
  expect(sha(bytes)).toBe("a0e2a4b74068553efbc71bc7f08c313768057363c0d3a7108e3e216eb0333919");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(31);
  for (const [i, name] of names.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const final = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(final.event).toBe("auditLifecycleFinalized"); expect(final.snapshot).toEqual(s);
  expect(e.diskRecovery).toBe(true);
});

it("keeps binding success distinct from strict-valid analysis and PNG success", () => {
  expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, accounting: "known",
    httpStatus: 502, elapsedMs: 41265, png: null, propagationLink: null });
  expect(e.result.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(d.primaryDiagnostic.providerAttempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "gemini", outcome: "failed", status: 400,
      providerStatus: "FAILED_PRECONDITION", fallbackEligible: true, fallbackReason: "provider_failed_precondition" }),
    expect.objectContaining({ provider: "workers_ai", outcome: "completed", providerSchemaValidation: "passed",
      strictValidation: "failed", deadlineTimerFired: false }),
  ]));
  expect(d.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: false,
    strictErrors: ["faceMeasurements[3]:evidenceContract", "faceMeasurements[4]:evidenceContract"],
    normalizationPass: false, richValidationPass: false });
  expect(d.normalizedPrimary).toBeNull(); expect(d.geometry).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
});

it("pins only the captured failed cue and proves the existing prompt already specified the contract", () => {
  expect(COMPACT_FACE_ORDER[3]).toBe("browEyeDistance");
  expect(COMPACT_FACE_ORDER[4]).toBe("browSlope");
  expect(d.failedFaceMeasurement).toEqual({ index: 3, cue: "browEyeDistance", value: "unknown",
    provenance: "unknown", confidence: 0.9, allowedValuesForCue: ["close", "normal", "high", "unknown"], faceVisible: true });
  // The recorded hash includes the production single-image reference suffix.
  const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
  expect(sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix)).toBe(e.contract.gemmaPromptSha256);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain('Unavailable evidence must be exactly {"value":"unknown","provenance":"unknown","confidence":0}');
  // The second cue's error path is known; its actual tuple was not captured.
  // Do not reconstruct it from the first cue or any historical response.
  expect(e.result.analysis).toEqual({});
});

it("confirms one-shot health and graceful local cleanup without claiming remote deletion", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
