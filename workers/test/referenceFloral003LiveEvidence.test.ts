// Read-only consumed live evidence and explicitly synthetic contract replay.
// Never imports a remote runner, requests a provider, or reconstructs missing output.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
  validateGemmaNamedPhotoAnalysis, adaptGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { semanticFixture, wireFixture, namedGemmaFixture } from "./compactV3Support";
import { withoutGemmaEvidenceReminder } from "./gemmaEvidencePromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";

const root = "evaluation-artifacts/reference-style-v3-e2e-floral-20261008-003";
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers every authoritative version and preserves the actual HTTP502, not the runner exit as generation success", () => {
  const names = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(31);
  for (const name of names) {
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  const final = JSON.parse(fs.readFileSync(path.join(root, names.at(-1)!), "utf8"));
  expect(final).toMatchObject({ sequence: 31, event: "auditLifecycleFinalized",
    snapshotSha256: "0fa2abef7551eaa4cfedf0643f62057b3d34d34b7d8bf66b9258b00b2788f5ca" });
  expect(final.snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "30ea1a2e0d42967faf30b8c6971f52d9", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 502, elapsedMs: 40761, diskRecovery: true,
    classification: "CURRENT_DEFAULT_V3_E2E_FAILED", png: null });
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
});

it("separates completed Gemma binding and valid provider shape from rejected runtime evidence", () => {
  const result = run.result, primary = result.diagnostics.primaryDiagnostic;
  expect(result).toMatchObject({ productionStatus: 502, ok: false, errorCode: "ai_failed" });
  expect(primary).toMatchObject({ ok: false, attempts: 2, reason: "invalid_response" });
  expect(primary.providerAttempts).toHaveLength(4);
  expect(primary.providerAttempts[1]).toMatchObject({ provider: "gemini", status: 400,
    providerStatus: "FAILED_PRECONDITION", elapsedMs: 1149, fallbackEligible: true });
  expect(primary.providerAttempts[3]).toMatchObject({ provider: "workers_ai", outcome: "completed",
    elapsedMs: 36087, configuredDeadlineMs: 55000, deadlineTimerFired: false,
    providerSchemaValidation: "passed", strictValidation: "failed" });
  expect(result.bindingAttempts.map((x: { stage: string }) => x.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(result.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: false, strictErrors: ["faceMeasurements[3]:evidenceContract", "faceMeasurements[4]:evidenceContract"] });
  expect(result.diagnostics.normalizedPrimary).toBeNull();
  expect(result.diagnostics.geometry).toBeNull();
  expect(result.diagnostics.failedFaceMeasurement).toEqual({ index: 3, cue: "browEyeDistance",
    value: "unknown", provenance: "unknown", confidence: 0.8, faceVisible: true,
    allowedValuesForCue: ["close", "normal", "high", "unknown"] });
  expect(COMPACT_FACE_ORDER[3]).toBe("browEyeDistance");
  expect(COMPACT_FACE_ORDER[4]).toBe("browSlope");
  // No exact tuple for index4 was stored; do not impute the index3 values to it.
});

it("matches the actual prompt and schema hashes and proves unknown/unknown/0 was already instructed", () => {
  const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
  // Remove only the two exact later-reviewed instructions, never rewrite this consumed run.
  const historicalPrompt = withoutGemmaEvidenceReminder(withoutTiedHairObservation(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT));
  expect(sha(historicalPrompt + suffix)).toBe(run.contract.gemmaPromptSha256);
  expect(sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA))).toBe(run.contract.gemmaSchemaSha256);
  expect(historicalPrompt).toContain("use unknown/unknown/0 for unavailable evidence");
  expect(historicalPrompt).toContain("Use value unknown, provenance unknown, confidence 0");
});

it("reproduces only the captured tuple in a synthetic fixture: shape accepts, adapter preserves, strict normalization rejects", () => {
  const compact = wireFixture(semanticFixture("plain"));
  compact.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  const cue = run.result.diagnostics.failedFaceMeasurement;
  compact.faceMeasurements[cue.index] = { value: cue.value, provenance: cue.provenance, confidence: cue.confidence };
  const named = namedGemmaFixture(compact), before = JSON.stringify(named);
  expect(validateGemmaNamedPhotoAnalysis(named)).toEqual([]);
  const adapted = adaptGemmaNamedPhotoAnalysis(named);
  expect(adapted.ok).toBe(true);
  if (!adapted.ok) throw new Error("synthetic_adapter_failed");
  expect(adapted.compact.faceMeasurements).toEqual(compact.faceMeasurements);
  expect(validateCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 }))
    .toEqual(["faceMeasurements[3]:evidenceContract"]);
  expect(normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 }))
    .toEqual({ ok: false, errors: ["faceMeasurements[3]:evidenceContract"] });
  expect(JSON.stringify(named)).toBe(before);
});

it("retains exact unknown/unknown/0 as valid without accepting positive confidence for any cue", () => {
  const base = wireFixture(semanticFixture("plain"));
  base.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  expect(validateCompactPhotoAnalysisV3(base, { imageCount: 1 })).toEqual([]);
  expect(normalizeCompactPhotoAnalysisV3(base, { imageCount: 1 }).ok).toBe(true);
  for (let index = 0; index < COMPACT_FACE_ORDER.length; index++) {
    const invalid = structuredClone(base);
    invalid.faceMeasurements![index].confidence = 0.8;
    expect(validateCompactPhotoAnalysisV3(invalid, { imageCount: 1 }))
      .toEqual([`faceMeasurements[${index}]:evidenceContract`]);
  }
});

it("preserves exact derivative identity and observes one graceful cleanup with unchanged production config", () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    analysis: { bytes: 37315, width: 597, height: 896, sha256: "37bc492664ae92e9d3f1719f96e45bd3156ec6a16d71c2f8a727af39f2b76a2b" },
    generation: { bytes: 13870, width: 299, height: 448, sha256: "9107658b3e168cef7b9f5bf2611ed95d3fc51e3ac335329aa9d96a20c3a065fa" } });
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
