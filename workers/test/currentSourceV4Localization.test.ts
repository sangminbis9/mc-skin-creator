import { readFileSync, existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ANALYSIS_SHA, CURRENT_SOURCE_V4_ROOT, CURRENT_SOURCE_V4_SELECTOR, createCurrentSourceV4State,
  currentSourceV4Contract, runCurrentSourceV4 } from "./audit/currentSourceV4LocalizationLive";
import { createAuditState } from "./primaryAuditLifecycle";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION, validateStructuredLocalization } from "../src/compactPhotoAnalysisV4";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";
import { encodePng, bytesToBase64 } from "../src/png";
import type { createIdentityCrops } from "../src/generate";

afterEach(() => vi.unstubAllGlobals());
const region = { subjectBox: { left: .05, top: .02, right: .95, bottom: .98 },
  headBox: { left: .2, top: .05, right: .8, bottom: .6 },
  faceBox: { left: .28, top: .15, right: .72, bottom: .52 }, confidence: .9 };
const input = { imageDataUrl: "synthetic-only", input: { sha256: ANALYSIS_SHA, width: 597, height: 896 },
  source: { sha256: "0c5a890f0e54275e2851a66f5f6ba92578c0d4feabf83c826aafa57cbf7a1d5a" } };
function primary(runId: string) {
  return { ok: true, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
    auditState: { ...createAuditState(runId), stage: "response_ready", finalOk: true, geminiStarted: 1, geminiCompleted: 1 },
    providerSequence: [{ provider: "gemini", model: "gemini-3.8-flash", outcome: "completed" }],
    contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true },
    validation: { richPhotoAnalysis: "passed" }, validatedLocalization: { portraitImageIndex: 0, region },
    localizationTrace: { traceVersion: 2, contractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      carrier: "structured_region", status: "VALID", fieldPresent: true, shapeValidation: "passed",
      regionValidation: "passed", validationReason: null },
    analysis: { quality: "pass", visibleRegions: { face: true }, sourceSelection: { portraitImageIndex: 0, portraitRegion: region },
      identityCropContext: { hairTexture: "coily", hairVolume: "flat", overallHairLength: "cropped",
        sideHairAsymmetry: "none", headCovering: false } } };
}

it("pins only the new selector/root and unchanged installed V4/geometry contracts", () => {
  expect(CURRENT_SOURCE_V4_SELECTOR).toBe("approved-29002888-v4-localization-20260926-002");
  expect(CURRENT_SOURCE_V4_ROOT).toMatch(/current-source-v4-localization-29002888-live-20260926-002$/);
  const contract = currentSourceV4Contract();
  expect(contract.geometry.timeoutMs).toBe(25000);
  expect(contract.version).toBe(PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION);
  expect(existsSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json")).toBe(true);
  const runner = readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  expect(runner).toContain('RUN_CURRENT_SOURCE_V4 && artifact.health.status === "passed"');
  expect(runner).toContain('process.env.RUN_CURRENT_SOURCE_V4_LOCALIZATION === CURRENT_SOURCE_V4_SELECTOR');
});

it.each(["wire", "core", "localization", "null_region", "missing_trace", "unknown_accounting", "wrong_model", "missing_context"])(
  "never dispatches geometry on %s failure", async kind => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_only"); }));
    const state = createCurrentSourceV4State();
    const body = primary(state.primaryRunId);
    if (kind === "wire") body.contractValidation.providerWireSchemaValid = false;
    if (kind === "core") body.contractValidation.primaryCoreValid = false;
    if (kind === "localization") body.contractValidation.localizationValid = false;
    if (kind === "null_region") Object.assign(body.analysis.sourceSelection, { portraitRegion: null });
    if (kind === "missing_trace") Object.assign(body, { localizationTrace: undefined });
    if (kind === "unknown_accounting") body.auditState.runId = "invalid";
    if (kind === "wrong_model") body.providerSequence[0].model = "unapproved-model";
    if (kind === "missing_context") Object.assign(body.analysis, { identityCropContext: null });
    const post = vi.fn(async () => ({ status: 200, body })), cropper = vi.fn();
    await runCurrentSourceV4(state, input, post, async () => {}, cropper);
    expect(post).toHaveBeenCalledTimes(1); expect(cropper).not.toHaveBeenCalled();
    expect(state.geometryPosts).toBe(0); expect(state.acceptedGeometry).toBeNull();
    await expect(runCurrentSourceV4(state, input, post, async () => {}, cropper)).rejects.toThrow("already_consumed");
    expect(post).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

it("stops on failed authoritative intent persistence before any POST", async () => {
  const state = createCurrentSourceV4State(), post = vi.fn(), cropper = vi.fn();
  await expect(runCurrentSourceV4(state, input, post, async () => { throw new Error("checkpoint_failed"); }, cropper))
    .rejects.toThrow("checkpoint_failed");
  expect(post).not.toHaveBeenCalled(); expect(cropper).not.toHaveBeenCalled();
});

it("does not retry a lost primary response or invent provider zero counts", async () => {
  const state = createCurrentSourceV4State(), post = vi.fn(async () => { throw new Error("lost"); });
  await runCurrentSourceV4(state, input, post, async () => {});
  expect(post).toHaveBeenCalledTimes(1); expect(state.primaryAccounting.dispatch).toBe("unknown");
  expect(state.geometryPosts).toBe(0); expect(state.classification).toBe("V4_PRIMARY_RESPONSE_UNOBSERVED");
});

it("sends only one same-run crop after all gates, preserves geometry, and stores no image payload", async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_only"); }));
  const state = createCurrentSourceV4State();
  const png = await encodePng({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255) });
  const cropData = `data:image/png;base64,${bytesToBase64(png)}`;
  const cropper = vi.fn(async () => ({ faceDataUrl: cropData, diagnostics: {
    cropMode: "subject_aware", quality: { usableForFaceGeometry: true } } })) as unknown as typeof createIdentityCrops;
  const geometry = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json", "utf8"))
    .currentDefaultE2E.result.diagnostics.geometry.acceptedGeometry;
  const post = vi.fn(async (route: string, image: string, id: string) => {
    if (route === "/primary-audit-v4-structured-localization") {
      expect(image).toBe(input.imageDataUrl); return { status: 200, body: primary(id) };
    }
    expect(route).toBe("/face-geometry-direct-audit"); expect(image).toBe(cropData);
    return { status: 200, body: { ok: true, providerShapeValid: true, errors: [], geometry,
      inputMode: "direct_frozen_face_crop", crop: null,
      auditState: { ...createAuditState(id), stage: "response_ready", finalOk: true, gemmaStarted: 1, gemmaCompleted: 1 } } };
  });
  await runCurrentSourceV4(state, input, post, async () => {}, cropper);
  expect(post).toHaveBeenCalledTimes(2); expect(cropper).toHaveBeenCalledTimes(1);
  expect(state.classification).toBe("V4_LOCALIZATION_AND_GEOMETRY_ACQUIRED");
  expect(state.acceptedGeometry).toEqual(geometry);
  expect(state.localization?.status).toBe("captured");
  expect(state.primaryPosts).toBe(1); expect(state.geometryPosts).toBe(1);
  expect(JSON.stringify(state)).not.toMatch(/data:image|base64|synthetic-only/);
  expect(fetch).not.toHaveBeenCalled();
});

// Offline follow-through for the observed V4 rejection. These are synthetic
// predicate examples, never reconstructed or salvaged provider coordinates.
it.each([
  ["head_width_ratio", .25, .3],
  ["head_height_ratio", .3, .2],
  ["both_ratios", .25, .2],
] as const)("V4 safe trace distinguishes %s without accepting its region", (kind, width, height) => {
  const synthetic = { subjectBox: { left: 0, top: 0, right: 1, bottom: 1 },
    headBox: { left: 0, top: 0, right: width, bottom: height },
    faceBox: { left: 0, top: 0, right: .25, bottom: .2 }, confidence: .9 };
  const validation = validateStructuredLocalization(true, synthetic);
  expect(validation.localizationValid).toBe(false); expect(validation.region).toBeNull();
  expect(validation.trace).toMatchObject({ status: "INVALID_REGION", shapeValidation: "passed",
    regionValidation: "failed", validationReason: "face_head_relationship_invalid" });
  const safeTrace = auditLocalizationTrace(validation.trace);
  expect(safeTrace).toHaveProperty("relationshipFailure", kind);
  expect(safeTrace).not.toHaveProperty("headBox");
});

it("accepts the existing exact ratio boundary without widening the validator", () => {
  const exact = { subjectBox: { left: 0, top: 0, right: 1, bottom: 1 },
    headBox: { left: 0, top: 0, right: .25 * 1.02, bottom: .2 * 1.08 },
    faceBox: { left: 0, top: 0, right: .25, bottom: .2 }, confidence: .9 };
  expect(validateStructuredLocalization(true, exact).localizationValid).toBe(true);
});
