// Offline finalized-run recovery only. No remote runner import or network calls.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { validateFinalAtlas } from "../src/skinPost";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-006");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const trace = run.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";

it("recovers all authoritative checkpoints and a distinct finalized single-use run", async () => {
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest).toMatchObject({ sequence: 32, event: "auditLifecycleFinalized",
    snapshotSha256: "2d6d71d7b18f0d2b67bf33bce590f4764019c4f8d021e3da237ea9c43558e670" });
  expect(latest?.snapshot).toEqual(summary);
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n));
  expect(records).toHaveLength(32);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(run).toMatchObject({ runId: "12d5e60f6f0449e3fa2f7e94f528f61d", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true,
    classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED" });
});

it("uses the current reinforced V3 wire and exact production derivatives without source mutation", () => {
  expect(run.contract).toMatchObject({ version: "primary_compact_v3_legacy_suffix", primaryTimeoutMs: 45000,
    geminiPromptSha256: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix),
    gemmaPromptSha256: sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix),
    geminiSchemaSha256: sha(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)),
    gemmaSchemaSha256: sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)) });
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    source: { sha256: "f20d7f8ee7a7de7020077b20496e11e976abd7b0b7f31d6df04740ea2c19a273", bytes: 964297 },
    analysis: { sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa", bytes: 47293, width: 896, height: 896 },
    generation: { sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d", bytes: 17732, width: 448, height: 448 } });
  // Preserve the historical pre-fix source identity; the separately tested
  // charcoal material fix must not rewrite or invalidate this consumed run.
  const recordedMaterial = Object.entries(run.fixedHashes).find(([file]) => file.replace(/\\/g, "/") === "src/outfitIdentity.ts");
  expect(recordedMaterial?.[1]).toBe("d3f9826ff501ffe37f0ad8da27ee2a362573dbf5ba06c32aafef3af8048c46b6");
  for (const [file, expected] of Object.entries(run.fixedHashes))
    if (file !== recordedMaterial?.[0]) expect(sha(fs.readFileSync(file))).toBe(expected);
});

it("records one eligible Gemini failure and one successful Gemma binding with no geometry or retry", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 } });
  expect(run.result.bindingAttempts.map((v: { stage: string }) => v.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", status: 503, providerStatus: "UNAVAILABLE", fallbackEligible: true }));
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "workers_ai", outcome: "completed", providerSchemaValidation: "passed", strictValidation: "passed" }));
  expect(run.result.bindingAttempts[1].completion).toBe("returned");
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization.status).toBe("MISSING");
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.cropReplay).toMatchObject({ geometryAttemptObserved: false,
    replayEligibility: { reason: "localized_face_unavailable" } });
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("preserves actually observed center part and opening through normalization, parameters and plans", () => {
  const provider = run.result.diagnostics.providerAppearance;
  expect(provider.renderHints.hairSides.hairPart).toBe("center");
  expect(provider.renderHints.fringe.fringeOpening).toBe("center");
  expect(provider.observed.hair).toContain("central gap");
  for (const a of [run.result.diagnostics.normalizedPrimary, trace.primary, trace.renderAnalysis])
    expect(a.renderHints).toMatchObject({ hairPart: "center", fringeOpening: "center" });
  expect(trace.injectedParameters.faceStyle).toMatchObject({ hairPart: "center", fringeOpening: "center" });
  const plan = trace.skinPlan.skinPlan;
  expect(plan.hairPlan.part).toBe("center");
  expect(plan.hairPlan.structure.partChannel.direction).toBe("center");
  expect(plan.hairPlan.structure.fringe.openingColumns).toEqual([3, 4]);
  expect(plan.facePixelPlan.layout).toMatchObject({ fringeOpening: "center",
    hairlineDepthByColumn: [2, 2, 2, 0, 0, 2, 2, 2] });
  // A different, observed primary error remains visible. Do not rewrite it into
  // a short-center-part fixture to claim selection/likeness was fully fixed.
  expect(provider.renderHints.hairLength.overallHairLength).toBe("jaw");
  expect(provider.observed.hair).toContain("reaches the jawline");
  expect(trace.selectedFamilies.hair).toBe("medium_layered");
  expect(plan.hairPlan.template).toBe("medium_bob");
});

it("binds same-run replay and decoded final atlas to the actually captured input and PNG", async () => {
  expect(trace.runId).toBe(run.runId);
  expect(trace.inputs).toEqual({ analysisSha256: run.preprocessing.analysis.sha256,
    generationSha256: run.preprocessing.generation.sha256 });
  expect(Object.values(run.propagationLink)).toEqual([true, true, true, true, true]);
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  const bytes = fs.readFileSync(path.join(root, "skin.png"));
  expect(sha(bytes)).toBe("54d59c54b7fa52e59bb3f4e4c2f4734be83046f9159831c3dcea77a2700c658d");
  const atlas = await decodePng(bytes);
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  expect(sha(atlas.rgba)).toBe("9bef52100dde65679845cca621a956a38eb54d58a480f02c92bbfdfe8e78a562");
  expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
  const at = (x: number, y: number, outer = false) => {
    const i = ((8 + y) * 64 + (outer ? 40 : 8) + x) * 4;
    return [...atlas.rgba.subarray(i, i + 4)];
  };
  // Central forehead skin survives the composite: no opaque outer cell covers
  // it, and its base luminance exceeds the adjacent dark fringe.
  for (const x of [3, 4]) {
    expect(at(x, 2)[3]).toBe(255);
    expect(at(x, 2, true)[3]).toBe(0);
    expect(at(x, 2).slice(0, 3).reduce((a, b) => a + b, 0))
      .toBeGreaterThan(at(0, 2).slice(0, 3).reduce((a, b) => a + b, 0));
  }
});

it("preserves the independent observed short-side endpoint rather than treating jaw-length back evidence as long sides", async () => {
  const provider = run.result.diagnostics.providerAppearance;
  expect(provider.renderHints.hairLength.sideHairLength).toBe("short");
  for (const a of [run.result.diagnostics.normalizedPrimary, trace.primary, trace.renderAnalysis])
    expect(a.renderHints).toMatchObject({ sideHairLength: "short", overallHairLength: "jaw" });
  expect(trace.injectedParameters.faceStyle).toMatchObject({ sideHairLength: "short", overallHairLength: "jaw" });
  const plan = trace.skinPlan.skinPlan;
  expect(plan.hairPlan.headMask.semanticSilhouette).toMatchObject({
    sideEndpointCue: "short", endpointCue: "jaw", sideWidthFamily: "narrow" });
  expect(plan.hairPlan.headMask.endpointRows).toEqual({ left: 4, right: 4 });
  const atlas = await decodePng(fs.readFileSync(path.join(root, "skin.png")));
  for (const face of ["left", "right"] as const) {
    const points = plan.hairPlan.headMask.faces[face] as { y: number }[];
    expect(Math.max(...points.map(p => p.y))).toBe(4);
    expect(plan.hairPlan.headMask.widthByRow[face].slice(5)).toEqual([0, 0, 0]);
    const owned = plan.headIdentityPlan.ownership.cells as { face: string; y: number; owner: string }[];
    expect(owned.filter(c => c.face === face && c.y > 4 && /^hair_/.test(c.owner))).toEqual([]);
    // Check actual saved output, not just claimed ownership: below the short
    // side endpoint there is no raised hair shell on either physical side.
    const r = CLASSIC_LAYOUT.head.overlay[face];
    for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++)
      expect(atlas.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3]).toBe(0);
  }
  // The longer back is still attributable to the actually returned jaw cue.
  // Do not turn that primary mismatch into a fabricated short overall cut.
  const back = plan.hairPlan.headMask.faces.back as { y: number }[];
  expect(Math.max(...back.map(p => p.y))).toBe(6);
  expect(trace.selectedFamilies.hair).toBe("medium_layered");
});

it("proves one q and complete cleanup while preserving previous evidence", () => {
  expect(summary).toMatchObject({ qSentCount: 1, cleanupFailed: false, wrapperExitObserved: true,
    wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, shutdownLatch: { phase: "finalized", qDispatched: true, qFailed: false } });
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-005/summary.json")))
    .toBe("b514b5673c6f86049755107e46631e8e774a2fd665c3d37a13ca2cc4d7fa6628");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json")))
    .toBe("c47ee4e58111e816a5cd1c27150028b229724e5b9f2ecce7e0e120796a706561");
});

it("stores no raw provider/request/prompt/image/base64 or credentials", () => {
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
