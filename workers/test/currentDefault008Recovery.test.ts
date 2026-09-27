import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { buildQuantizedLayoutVariants } from "../src/identityQuantization";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex,
  normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { observedQualifiedScalpCloseHair } from "../src/scalpCloseHairEvidence";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import type { RawImage } from "../src/png";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers consumed 008 failure and diagnoses stored evidence offline without another request", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const files = readdirSync(root).filter(name => name.endsWith(".json"));
    const hashes = Object.fromEntries(files.map(name => [name, sha(readFileSync(`${root}/${name}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = files.filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name)).sort();
    for (const [i, name] of checkpoints.entries()) {
      const record = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(record.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
      health: { status: "passed", httpStatus: 200 }, qSentCount: 1, cleanupFailed: false,
      wranglerGracefulTeardownPathCompleted: true, ownedProcessInventoryClean: true,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const live = summary.currentDefaultE2E, result = live.result;
    expect(live).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 500,
      accounting: "known", diskRecovery: true, png: null });
    expect(live.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
      failureStage: "handler_response", failureCode: "production_handler_http_error",
      providerAttemptIntent: 3, providerAttemptStarted: 3 });
    expect(result).toMatchObject({ ok: false, errorCode: "SKIN_RENDER_FAILED", contract: "primary_compact_v3_legacy_suffix" });
    expect(result.bindingAttempts.map((attempt: { stage: string }) => attempt.stage))
      .toEqual(["geminiPrimary", "gemmaPrimary", "faceGeometry"]);
    expect(result.diagnostics.primaryDiagnostic.providerAttempts.find((attempt: { outcome: string }) => attempt.outcome === "failed"))
      .toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(result.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true,
      normalizationPass: true, richValidationPass: true });
    expect(result.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    for (const [file, expected] of Object.entries(live.fixedHashes)) expect(sha(readFileSync(file))).toBe(expected);
    const saved = result.diagnostics.normalizedPrimary;
    const geometry = acceptedFaceGeometry(result.diagnostics.geometry.acceptedGeometry);
    expect(geometry).toEqual(result.diagnostics.geometry.acceptedGeometry);
    const rows = [];
    for (const { enriched, diagnosticFieldDelimiter } of [
      { enriched: false, diagnosticFieldDelimiter: false },
      { enriched: true, diagnosticFieldDelimiter: false },
      { enriched: false, diagnosticFieldDelimiter: true },
      { enriched: true, diagnosticFieldDelimiter: true },
    ]) {
      // Missing rich fields use explicit fixed helper context, never claimed as recovered live data.
      // Diagnostic punctuation only: same source meaning; never rewrite stored provider evidence.
      const hair = saved.observed.hair + (diagnosticFieldDelimiter ? "." : "");
      const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...saved,
        observed: { ...saved.observed, hair },
        identityPrompt: hair, outfitPrompt: saved.observed.clothing,
        ...(enriched ? { faceIdentityGeometry: geometry } : {}) }));
      expect(observedQualifiedScalpCloseHair(analysis)).toBe(false);
      const features = refineFeatureColorsFromAnalysis(analysis,
        fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const layouts = buildQuantizedLayoutVariants(analysis, 3);
      const candidates = buildFacePixelPlanVariants(analysis, 3);
      let stage = "buildSkinPlan", error: string | null = null;
      let plan = null, style = null, atlasAccepted = false;
      let finalHead: RawImage | null = null;
      log.mockClear();
      try {
        plan = buildSkinPlan(analysis);
        stage = "buildFaceStyle";
        style = buildFaceStyle(analysis, features, plan.hairPlan);
        stage = "buildProceduralFallbackAtlas";
        const atlas = buildProceduralFallbackAtlas(features, style, plan, (name, image) => {
          if (name === "final_head") finalHead = { ...image, rgba: new Uint8Array(image.rgba) };
        });
        atlasAccepted = atlas !== null;
        stage = atlasAccepted ? "accepted" : "atlas_rejected";
      } catch (e) { error = e instanceof Error ? e.message : "unknown_exception"; }
      expect(error).toBeNull();
      expect(plan?.hairPlan.template).toBe("bald");
      expect(style?.hairstyle).toBe(diagnosticFieldDelimiter ? "bald" : "long");
      expect(atlasAccepted).toBe(diagnosticFieldDelimiter);
      rows.push({ enriched, diagnosticFieldDelimiter, stage, error, atlasAccepted, features, layouts, candidates,
        hairPlan: plan?.hairPlan ?? null, facePixelPlan: plan?.facePixelPlan ?? null,
        style, finalAtlas: finalHead ? validateFinalAtlas(finalHead) : null,
        craft: finalHead && style && plan ? validateAtlasCraft(finalHead, style, undefined, undefined, plan) : null,
        rendererDiagnostics: log.mock.calls.map(call => call.map(String)) });
    }
    const output = mkdtempSync(`${root}/offline-recovery-`);
    writeFileSync(`${output}/verification.json`, JSON.stringify({ mode: "offline_consumed_008_recovery",
      additionalProviderCalls: 0, checkpointsVerified: checkpoints.length, preservedHashes: hashes,
      liveFailure: { httpStatus: 500, code: result.errorCode, gate: live.e2eGateTrace },
      hairEvidence: { observed: saved.observed.hair, fallback: saved.fallbackFeatures.hairstyle,
        qualifiedCropPredicate: false, newHairFixExercised: false }, rows,
      limitation: "Partial stored primary projection. Helper fields are not recovered live evidence; offline failures do not alone prove an exact live validator predicate." }, null, 2), { flag: "wx" });
    for (const [name, expected] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(expected);
    expect(network).not.toHaveBeenCalled();
    console.info(`008_RECOVERED ${output}`);
  } finally { network.mockRestore(); log.mockRestore(); }
}, 30_000);
