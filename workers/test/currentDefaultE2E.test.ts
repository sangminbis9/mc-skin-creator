import { afterEach, expect, it, vi } from "vitest";
import { encode } from "jpeg-js";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";
import { wireFixture, namedGemmaFixture } from "./compactV3Support";
import { E2E_MARKER, imageIdentity, boundedProjection, analysisProjection, digest } from "./audit/currentDefaultE2E";
import { captureCurrentDefaultPropagation } from "./audit/currentDefaultPropagation";
import { base64ToBytes, decodePng, type RawImage } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { createE2EState, runCurrentDefaultE2E, type prepareCurrentDefaultE2E } from "./audit/currentDefaultE2ELive";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { classifyPortraitLocalization, validatePhotoAnalysis } from "../src/analysis";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { GENERATION_STAGES } from "../src/generationObservation";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("supports the bounded parameter-only audit mode without claiming remote atlas replay", async () => {
  const s = await setup(undefined, false, false, false, false, false);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const body = await (await s.worker.fetch(s.request({ "x-e2e-propagation-trace": "primary_png_parameters_v2" }), s.env)).json();
  expect(body.productionStatus).toBe(200); expect(body.ok).toBe(true);
  expect(body.propagationTrace).toMatchObject({ parameterEvidence: "verified_same_run_plan_features",
    replay: { scope: "plan_features_only", finalAtlasMatch: null, selectedDesignMatch: null, atlasReplay: "deferred_local" } });
  expect(body.propagationTrace.injectedParameters.features).toEqual(body.features);
  expect(body.propagationTrace.finalPng.sha256).toBe(await digest(base64ToBytes(body.skinPngBase64)));
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(log.mock.calls.map(c => String(c[0]).split("|")[2])).toContain("propagation_finished");
}, 30_000);
it.each([undefined, "fallback"] as const)("links contemporaneous primary, selected families, parameters, plan and PNG without another inference (%s)", async failure => {
  const s = await setup(failure, false, false, false, false, false);
  const stageLog = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await s.worker.fetch(s.request({ "x-e2e-propagation-trace": "primary_png_propagation_v1" }), s.env);
  expect(response.status).toBe(200);
  const stages = stageLog.mock.calls.filter(c => String(c[0]).startsWith("MCSKIN_E2E_STAGE_V1|"))
    .map(c => String(c[0]).split("|")[2]);
  expect(stages.slice(0, 3)).toEqual(["input_verified", "handler_entered", "geminiPrimary_invoked"]);
  expect(stages).toContain(`${failure ? "gemmaPrimary" : "geminiPrimary"}_inspection_finished`);
  expect(stages.filter(s => !/^propagation_(?:projection|png|normalization|plan|features|parameters)_/.test(s)).slice(-3))
    .toEqual(["handler_returned", "propagation_started", "propagation_finished"]);
  expect(stages.some(s => s.startsWith("faceGeometry_"))).toBe(false);
  // An ineligible crop still enters/returns crop preparation; it does NOT
  // establish an eligible crop or license a geometry dispatch.
  expect(stages.filter(s => s.startsWith("production_")))
    .toEqual(GENERATION_STAGES.map(s => `production_${s}`));
  const body = await response.json();
  const trace = body.propagationTrace;
  expect(trace).toMatchObject({ version: "primary_png_propagation_v1", runId: "a".repeat(32),
    providerStage: failure ? "gemmaPrimary" : "geminiPrimary",
    evidenceScope: "this_request_only_not_historical_recovery",
    parameterEvidence: "verified_exact_same_run_replay", replay: {
      context: "primary_only", renderAnalysisMatch: true, sourcePlanMatch: true,
      featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true },
    finalPng: { width: 64, height: 64, validation: { ok: true } },
  });
  expect(trace.primary).toEqual(body.diagnostics.normalizedPrimary);
  expect(body.diagnostics.providerAppearance.observed).toEqual(s.fixture.observed);
  expect(trace.primary.inferred).toBeDefined();
  expect(body.analysis.referenceStyle).toEqual(trace.referenceStyle);
  expect(trace.selectedFamilies).toEqual(Object.fromEntries(["face", "hair", "outfit"].map(k =>
    [k, body.analysis.referenceStyle.design[k].family])));
  expect(trace.skinPlan.skinPlan).toEqual(body.analysis.skinPlan);
  expect(trace.injectedParameters.features).toEqual(body.features);
  expect(trace.injectedParameters.faceStyle).toBeDefined();
  expect(trace.projectionChanges).toContain("primary.identityPrompt:omitted");
  const root = mkdtempSync("evaluation-artifacts/e2e-propagation-offline-20261006-");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared); state.runId = "a".repeat(32);
  const post = vi.fn(async () => ({ status: response.status, body }));
  await runCurrentDefaultE2E(state, prepared, post, event => atomicCheckpoint(`${root}/summary.json`, state, event), root);
  expect(state.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect((await readLatestAuditCheckpoint(`${root}/summary.json`))?.snapshot).toEqual(JSON.parse(JSON.stringify(state)));
  const png = readFileSync(`${root}/skin.png`);
  expect(await digest(png)).toBe(trace.finalPng.sha256);
  const persisted = readFileSync(`${root}/summary.json`, "utf8");
  expect(persisted).not.toMatch(/offline-token|offline-only|Synthetic primary portrait evidence|data:image|base64,/);
  expect(post).toHaveBeenCalledTimes(1); expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0); expect(fetch).not.toHaveBeenCalled();
  // A changed plan cannot license invented parameters, even for a valid PNG.
  const tampered = structuredClone(body); tampered.analysis.skinPlan.hairPlan.template = "unobserved";
  const compact = normalizeCompactPhotoAnalysisV3(s.fixture, { imageCount: 1 });
  const normalized = compact.ok ? validatePhotoAnalysis(compact.analysis) : null;
  expect(normalized?.ok).toBe(true);
  const unverified = await captureCurrentDefaultPropagation({ primary: normalized?.ok ? normalized.analysis : null,
    geometry: null, providerStage: "geminiPrimary", body: tampered, runId: trace.runId, inputs: trace.inputs, verifyReplay: true }, boundedProjection, digest);
  expect(unverified.injectedParameters).toBeNull(); expect(unverified.parameterEvidence).toBe("unverified");
}, 30_000);

it("preserves reference selection and complete nested ownership while redacting credential/image/prompt fields", () => {
  const cells = Array.from({ length: 768 }, (_, index) => ({ index, owner: "hair_base" }));
  const value = analysisProjection({ inferred: { lowerBody: { value: "black trousers" } },
    referenceStyle: { design: { outfit: { family: "preserve_existing" } } },
    identityPrompt: "must not be stored", observed: { hair: "Bearer fake-secret" },
    skinPlan: { headIdentityPlan: { ownership: { cells } } }, headers: "private", imageDataUrl: "data:image/jpeg;base64,private" });
  expect(value).toMatchObject({ inferred: { lowerBody: { value: "black trousers" } },
    referenceStyle: { design: { outfit: { family: "preserve_existing" } } }, observed: { hair: "[redacted]" } });
  expect(JSON.stringify(value)).not.toMatch(/must not be stored|fake-secret|private/);
  expect(boundedProjection({ trace: value })).toMatchObject({ trace: { skinPlan: { headIdentityPlan: { ownership: { cells } } } } });
});

it("keeps audit diagnostics passive: direct production returns the same PNG and tan pixels", async () => {
  const s = await setup(undefined, false, false, false, false, false, true);
  const audited = await (await s.worker.fetch(s.request({ "x-e2e-propagation-trace": "primary_png_propagation_v1" }), s.env)).json();
  const production = (await import("../src/index")).default;
  // Two local mocked handler invocations, not two external/provider attempts.
  const direct = await (await production.fetch(new Request("https://internal.invalid/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }), s.env)).json();
  expect(direct.ok).toBe(true); expect(audited.skinPngBase64).toBe(direct.skinPngBase64);
  expect(audited.analysis).toEqual(analysisProjection(direct.analysis));
  const atlas = await decodePng(base64ToBytes(direct.skinPngBase64));
  expect([...atlas.rgba.slice((22 * 64 + 22) * 4, (22 * 64 + 22) * 4 + 3)]).toEqual([197, 170, 130]);
  expect(audited.propagationTrace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(s.gatewayRun).toHaveBeenCalledTimes(2); expect(s.nativeRun).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}, 30_000);

it("verifies parameters against the accepted geometry context without another provider call", async () => {
  const s = await setup(undefined, false, false, false, "022", true);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await s.worker.fetch(s.request({ "x-e2e-propagation-trace": "primary_png_propagation_v1" }), s.env);
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.propagationTrace).toMatchObject({ parameterEvidence: "verified_exact_same_run_replay",
    replay: { context: "accepted_geometry", sourcePlanMatch: true, selectedDesignMatch: true, finalAtlasMatch: true } });
  expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.eyes).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  const stages = log.mock.calls.map(c => String(c[0]).split("|")[2]);
  expect(stages.filter(s => s?.startsWith("production_")))
    .toEqual(GENERATION_STAGES.map(s => `production_${s}`));
  expect(stages.indexOf("production_crop_returned")).toBeLessThan(stages.indexOf("faceGeometry_invoked"));
  expect(stages.indexOf("faceGeometry_inspection_finished")).toBeLessThan(stages.indexOf("production_enrichment_finished"));
}, 30_000);

it("keeps actual production PNG and dispatch unchanged when the internal phase observer throws", async () => {
  const s = await setup(undefined, false, false, false, false, false);
  const production = (await import("../src/index")).default;
  const { GENERATION_OBSERVER } = await import("../src/generationObservation");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const request = () => new Request("https://internal.invalid/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  type ObservedResponse = { ok: boolean; skinPngBase64?: string; analysis?: unknown };
  const plain = await (await production.fetch(request(), s.env)).json<ObservedResponse>();
  expect(log.mock.calls.some(c => String(c[0]).startsWith("MCSKIN_E2E_STAGE_V1|"))).toBe(false);
  const observer = vi.fn(() => { throw new Error("synthetic observation failure"); });
  const observed = await (await production.fetch(request(), { ...s.env, [GENERATION_OBSERVER]: observer })).json<ObservedResponse>();
  expect(observed.ok).toBe(true);
  expect(observed.skinPngBase64).toBe(plain.skinPngBase64);
  expect(observed.analysis).toEqual(plain.analysis);
  expect(observer.mock.calls).toHaveLength(GENERATION_STAGES.length);
  expect(s.gatewayRun).toHaveBeenCalledTimes(2); // two synthetic requests, no network
  expect(s.nativeRun).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
}, 30_000);
const jpeg = (width: number, height: number) => `data:image/jpeg;base64,${Buffer.from(encode({ width, height,
  data: Buffer.alloc(width * height * 4, 255) }, 85).data).toString("base64")}`;
const payload = { image: jpeg(299, 448), analysisImage: jpeg(597, 896) };
const identity = Promise.all([imageIdentity(payload.analysisImage), imageIdentity(payload.image)]);
function expectReferenceTanBand(atlas: RawImage) {
  // Torso front local (2,2): first horizontal band, not a vertical crossing,
  // collar or placket. Reference composition repaints the source garment
  // foundation; patterned fronts exclude material folds and legacy RGB jitter.
  // Keep an exact independent source-color expectation, not a sampled target.
  const x = 22, y = 22;
  const expected = Uint8Array.from([197, 170, 130]); // source tan #c5aa82
  expect(atlas.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)).toEqual(expected);
  expect(atlas.rgba[(y * 64 + x) * 4 + 3]).toBe(255);
}
async function setup(failure?: "fallback" | "invalid", facialHairEvidence: boolean | "canonical-combination" | "canonical-goatee" = false, croppedHairEvidence: boolean | "qualified" | "visible-scalp" | "visible-buzz" | "covered-buzz" | "cropped-contour" | "canonical-crop-alternative" | "canonical-scalp" | "visible-close-crop" | "scoped-side-length" | "mostly-visible-scalp" | "canonical-visible-crop" = false, plaidPaletteEvidence: boolean | "contradictory-dress" | "check-squares" = false, storedGeometryEvidence: boolean | "008" | "022" = false, localized = true, accepted027 = false) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden_in_offline_test"); }));
  const { default: worker } = await import("./primaryFaceMeasurementAuditWorker");
  const stored = storedGeometryEvidence ? JSON.parse(readFileSync(storedGeometryEvidence === "022"
    ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-022/summary.json"
    : storedGeometryEvidence === "008"
    ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008/summary.json"
    : "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json", "utf8")).currentDefaultE2E.result : null;
  const primary = typeof facialHairEvidence === "string" ? JSON.parse(readFileSync(
    "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-014/summary.json", "utf8"
  )).currentDefaultE2E.result.diagnostics.normalizedPrimary : stored?.diagnostics.normalizedPrimary;
  const fixtureAnalysis = primary ? makeAnalysis({ ...primary,
    // The saved allowlist has normalized region metadata, not a complete wire
    // sourceSelection. Use the explicit synthetic single-image test context.
    sourceSelection: makeAnalysis().sourceSelection,
    identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing }) : makeAnalysis();
  if (croppedHairEvidence) {
    const liveBuzz = croppedHairEvidence === "visible-buzz" || croppedHairEvidence === "covered-buzz"
      ? JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-017/summary.json", "utf8"))
        .currentDefaultE2E.result.diagnostics.normalizedPrimary.observed.hair as string : null;
    fixtureAnalysis.observed.hair = croppedHairEvidence === "cropped-contour"
      ? JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-018/summary.json", "utf8"))
        .currentDefaultE2E.result.diagnostics.normalizedPrimary.observed.hair
      : liveBuzz
      ? croppedHairEvidence === "covered-buzz" ? liveBuzz.replace("scalp visible", "scalp covered") : liveBuzz
      : croppedHairEvidence === "visible-scalp"
      ? "Very short dark hair, nearly shaved, with visible scalp."
      : croppedHairEvidence === "qualified"
      ? "Very short, almost bald hair, showing the scalp closely."
      : "Very short, closely cropped black hair following the scalp, with no visible fringe or parting.";
    fixtureAnalysis.canonicalIdentity.mustPreserve = ["Dark complexion", croppedHairEvidence === "qualified"
      ? "Bald/very short hair head silhouette" : "Closely cropped black hair", "Neutral face", "Collared shirt"];
    fixtureAnalysis.canonicalIdentity.features = fixtureAnalysis.canonicalIdentity.features.map(f => f.category === "hair"
      ? { ...f, feature: croppedHairEvidence === "qualified" ? "very short/bald hair" : "Closely cropped black hair",
        evidence: "Scalp-close dark hair with no fringe" } : f);
    fixtureAnalysis.fallbackFeatures.hairstyle = "curly";
    fixtureAnalysis.renderHints = { ...fixtureAnalysis.renderHints, hairTexture: "coily", hairVolume: "flat",
      overallHairLength: "cropped", bangs: "none", bangsLength: "none", sideHairLength: "none", hairAccessory: "none" };
  }
  if (plaidPaletteEvidence) {
    fixtureAnalysis.observed.clothing = "A collared button-down shirt with a small-scale plaid/checkered pattern in shades of blue, tan, and dark brown.";
    fixtureAnalysis.fallbackFeatures.topType = "shirt";
    if (plaidPaletteEvidence === "contradictory-dress") {
      fixtureAnalysis.observed.clothing = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019/summary.json", "utf8"))
        .currentDefaultE2E.result.diagnostics.normalizedPrimary.observed.clothing;
      fixtureAnalysis.outfitPrompt = fixtureAnalysis.observed.clothing;
      fixtureAnalysis.fallbackFeatures.topType = "dress";
    }
    fixtureAnalysis.fallbackFeatures.topAccentColor = "white";
    fixtureAnalysis.renderHints.garmentTexture = "patterned";
    fixtureAnalysis.renderHints.outerGarment = "none";
  }
  if (croppedHairEvidence === "canonical-crop-alternative" || plaidPaletteEvidence === "check-squares") {
    const accepted = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020/summary.json", "utf8"))
      .currentDefaultE2E.result.diagnostics.normalizedPrimary;
    // Accepted cue wording within a complete synthetic handler fixture, not
    // reconstruction of unrecorded provider fields or a fresh live call.
    if (croppedHairEvidence === "canonical-crop-alternative") {
      fixtureAnalysis.observed.hair = accepted.observed.hair;
      fixtureAnalysis.canonicalIdentity.mustPreserve[1] = "close-cropped/bald hair silhouette";
      fixtureAnalysis.renderHints.hairPart = "none";
    }
    if (plaidPaletteEvidence === "check-squares") {
      fixtureAnalysis.observed.clothing = accepted.observed.clothing;
      fixtureAnalysis.outfitPrompt = accepted.observed.clothing;
      fixtureAnalysis.fallbackFeatures.topColor = "blue";
    }
  }
  if (croppedHairEvidence === "canonical-scalp" || croppedHairEvidence === "visible-close-crop" || croppedHairEvidence === "scoped-side-length" || croppedHairEvidence === "mostly-visible-scalp" || croppedHairEvidence === "canonical-visible-crop") {
    const accepted = JSON.parse(readFileSync(croppedHairEvidence === "canonical-visible-crop"
      ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-026/summary.json"
      : croppedHairEvidence === "mostly-visible-scalp"
      ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-025/summary.json"
      : croppedHairEvidence === "canonical-scalp"
      ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021/summary.json"
      : croppedHairEvidence === "scoped-side-length" ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-023/summary.json"
      : "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-022/summary.json", "utf8"))
      .currentDefaultE2E.result.diagnostics.normalizedPrimary;
    // Accepted cue fields in an explicit complete synthetic wire fixture.
    // Unrecorded inference/source free text is not claimed as recovered evidence.
    for (const key of ["observed", "canonicalIdentity", "fallbackFeatures", "renderHints", "faceMeasurementEvidence", "visibleRegions"] as const)
      fixtureAnalysis[key] = structuredClone(accepted[key]);
  }
  if (typeof facialHairEvidence === "string") {
    // Use the accepted live face layout, rather than the generic smiling fixture
    // whose protected landmarks may occupy the existing mustache footprint.
    // Vary only facial corroboration; do not keep the original combination too.
    fixtureAnalysis.canonicalIdentity.features = fixtureAnalysis.canonicalIdentity.features.filter(f => !/goatee|mustache/i.test(f.evidence));
    fixtureAnalysis.canonicalIdentity.features.push({
    category: "face", feature: "Facial hair", priority: 4, confidence: "high", targetRegions: ["face.front"],
    evidence: facialHairEvidence === "canonical-combination" ? "Dark goatee and mustache" : "Dark goatee",
    });
  }
  if (accepted027) {
    const accepted = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-027/summary.json", "utf8"))
      .currentDefaultE2E.result.diagnostics.normalizedPrimary;
    // Saved accepted cues in complete synthetic provider wires, not recovery
    // of unavailable raw output or a fresh external provider measurement.
    for (const key of ["observed", "canonicalIdentity", "fallbackFeatures", "renderHints", "faceMeasurementEvidence", "visibleRegions"] as const)
      fixtureAnalysis[key] = structuredClone(accepted[key]);
  }
  const fixture = wireFixture(fixtureAnalysis);
  // Synthetic handler fixture, not historical localization recovery. Geometry
  // positives require measured-face coverage; unknown coverage is tested in
  // faceGeometryCoverageDispatch with dispatch explicitly forbidden.
  if (localized) fixture.sourceSelection.portraitEvidence += " | REGION:[0.1,0,0.9,1,0.2,0.03,0.8,0.55,0.28,0.12,0.72,0.48,0.95]";
  if (facialHairEvidence) {
    fixture.observed.face = "Oval face with groomed dark mustache and goatee.";
    fixture.canonicalIdentity.mustPreserve.push(typeof facialHairEvidence === "string" ? "Groomed goatee" : "Groomed goatee and mustache");
    fixture.fallbackFeatures!.facialHair = "none";
  }
  const gatewayRun = vi.fn(async () => failure
    ? Response.json({ error: { status: failure === "fallback" ? "FAILED_PRECONDITION" : "INVALID_ARGUMENT" } }, { status: 400 })
    : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }] } }] }));
  const nativeRun = vi.fn(async (_model: string, body: Record<string, unknown>) => {
    const schema = (body.response_format as { json_schema: { schema: { properties: Record<string, unknown> } } }).json_schema.schema;
    if ("face" in schema.properties) {
      if (stored) {
        const accepted = stored.diagnostics.geometry.acceptedGeometry;
        const wire = structuredClone(accepted);
        delete wire.source; delete wire.eyes.interEyeDistance; delete wire.eyes.verticalAsymmetry; delete wire.nose.leftRightBias;
        return { response: wire };
      }
      return { response: {} }; // Deliberate invalid optional geometry; production fail-open must be preserved.
    }
    return { response: namedGemmaFixture(fixture) };
  });
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  const env = { GEMINI_API_KEY: "offline-only", PRIMARY_AUDIT_TOKEN: "offline-token", VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", FACE_GEOMETRY_ENRICHMENT_ENABLED: "true",
    GEMINI_STRUCTURED_TIMEOUT_MS: "45000", AI: { gateway: () => ({ run: gatewayRun }), run: nativeRun }, MCSKIN_KV: kv };
  const [analysis, generation] = await identity;
  const request = (changes: Record<string, string> = {}, body: unknown = payload) => new Request("https://offline/current-default-e2e-audit", {
    method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": "offline-token",
      "x-primary-audit-run-id": "a".repeat(32), "x-current-default-e2e": E2E_MARKER,
      "x-e2e-analysis-sha": analysis.sha256, "x-e2e-generation-sha": generation.sha256, ...changes }, body: JSON.stringify(body),
  });
  return { worker, env: env as unknown as Env, gatewayRun, nativeRun, kv, request, fixture };
}
it("durably retains one wrong-slot render hint without accepting, retrying or storing the rejected array", async () => {
  const s = await setup(undefined, false, false, false, false, false);
  s.fixture.renderHints.hairLength[1] = "ear"; // Synthetic, not recovered B003 output.
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(502);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: false, skinPngBase64: null, diagnostics: {
    primaryValidation: { providerShapePass: true, strictRuntimePass: false,
      strictErrors: ["renderHints.hairLength[1]:fieldVocabulary"], normalizationPass: false, richValidationPass: false },
    failedRenderHint: { group: "hairLength", index: 1, cue: "sideHairLength", value: "ear",
      allowedValuesForCue: ["none", "short", "cheek", "jaw", "shoulder"] },
    normalizedPrimary: null,
  } });
  const root = mkdtempSync("evaluation-artifacts/e2e-rejected-render-hint-offline-20261010-");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared); state.runId = "a".repeat(32);
  const post = vi.fn(async () => ({ status: response.status, body }));
  await runCurrentDefaultE2E(state, prepared, post, async event => {
    await atomicCheckpoint(`${root}/summary.json`, state, event);
  }, root);
  const persisted = readFileSync(`${root}/summary.json`, "utf8");
  expect((await readLatestAuditCheckpoint(`${root}/summary.json`))?.snapshot).toEqual(JSON.parse(persisted));
  expect(JSON.parse(persisted).result.diagnostics.failedRenderHint).toEqual({ group: "hairLength", index: 1,
    cue: "sideHairLength", value: "ear", allowedValuesForCue: ["none", "short", "cheek", "jaw", "shoulder"] });
  expect(persisted).not.toContain(JSON.stringify(s.fixture.renderHints.hairLength));
  expect(persisted).not.toMatch(/offline-token|offline-only|Synthetic primary portrait evidence|data:image|base64,/);
  expect(post).toHaveBeenCalledTimes(1); expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "fallback"] as const)("persists only the first rejected measurement without altering the strict 502 result (%s)", async failure => {
  const s = await setup(failure, false, false, false, false, false);
  s.fixture.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  s.fixture.faceMeasurements[3] = { value: "normal", provenance: "observed_categorical", confidence: 0.5 };
  s.fixture.faceMeasurements[4] = { value: "arched", provenance: "observed_categorical", confidence: 0.5 };
  const response = await s.worker.fetch(s.request(), s.env); expect(response.status).toBe(502);
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, skinPngBase64: null, diagnostics: {
    primaryValidation: { providerShapePass: !failure, strictRuntimePass: false,
      providerErrors: failure ? ["gemma.faceMeasurements[3]:anyOf", "gemma.faceMeasurements[4]:anyOf"] : [],
      strictErrors: failure ? [] : ["faceMeasurements[3]:evidenceContract", "faceMeasurements[4]:evidenceContract"],
      normalizationPass: false, richValidationPass: false },
    failedFaceMeasurement: { index: 3, cue: "browEyeDistance", value: "normal", provenance: "observed_categorical", confidence: 0.5,
      allowedValuesForCue: ["close", "normal", "high", "unknown"], faceVisible: true }, normalizedPrimary: null, geometry: null,
  } });
  const root = mkdtempSync("evaluation-artifacts/e2e-rejected-cue-offline-20260928-");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  const post = vi.fn(async () => ({ status: response.status, body }));
  await runCurrentDefaultE2E(state, prepared, post, event => atomicCheckpoint(`${root}/summary.json`, state, event), root);
  expect((await readLatestAuditCheckpoint(`${root}/summary.json`))?.snapshot).toEqual(JSON.parse(JSON.stringify(state)));
  const persisted = readFileSync(`${root}/summary.json`, "utf8");
  expect(persisted).not.toMatch(/arched|offline-token|offline-only|data:image|base64,/);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(post).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains accepted 027 goatee/tan through default V3 without inventing scalp material (%s)", async failure => {
  const s = await setup(failure, false, false, false, false, false, true);
  const response = await s.worker.fetch(s.request(), s.env); expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { hairPlan: { surfaceMaterial?: string } } } };
  expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { hairPlan: { template: "bald" }, outfitPlan: { upper: { baseColor: "#416b9d", collarColor: "#416b9d", pattern: { color: "#c5aa82", crossedBandColors: ["#c5aa82", "#273954"] } } } } } });
  expect(body.analysis.skinPlan.hairPlan.surfaceMaterial).toBeUndefined();
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64)); expect(validateFinalAtlas(atlas).ok).toBe(true);
  expectReferenceTanBand(atlas);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([[undefined, "mostly-visible-scalp"], ["fallback", "mostly-visible-scalp"], [undefined, "canonical-visible-crop"], ["fallback", "canonical-visible-crop"]] as const)(
  "retains accepted scalp and tan cues through strict V3 handler with geometry forbidden (%s, %s)", async (failure, cue) => {
  const s = await setup(failure, false, cue, false, false, false);
  const response = await s.worker.fetch(s.request(), s.env); expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string };
  expect(body).toMatchObject({ ok: true,
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { hairPlan: { surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" },
      outfitPlan: { upper: { pattern: { color: "#c5aa82" } } } } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains accepted 022 geometry through strict default V3 handler instead of primary-only render fallback (%s)", async failure => {
  const s = await setup(failure, false, false, false, "022", true);
  const response = await s.worker.fetch(s.request(), s.env); expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string };
  expect(body).toMatchObject({ ok: true,
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true } },
    analysis: { skinPlan: { facePixelPlan: { source: "identity_geometry", candidateCost: { violations: [] },
      layout: { eyeTopology: "asymmetric", eyeOpenness: "readable", geometryUsage: { eyes: true, brows: true, nose: true, mouth: true } } } } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it("carries corroborated facial hair through the actual handler and Gemma fallback into final PNG", async () => {
  // All provider bindings are mocks; the production handler and renderer are real.
  const s = await setup("fallback", true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
    diagnostics: { normalizedPrimary: { fallbackFeatures: { facialHair: "goatee" } },
      primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64 as string))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(2); // Gemma primary + deliberately rejected optional geometry.
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains accepted explicit button shirt through strict V3 despite contradictory dress (%s)", async failure => {
  // Actual 019 clothing wording; other fields form a complete synthetic fixture.
  // Mock bindings only: this is not a new live response or full-wire recovery.
  const s = await setup(failure, false, false, "contradictory-dress", false, false);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string };
  expect(body).toMatchObject({ ok: true,
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { outfitPlan: { upper: { garmentType: "shirt" }, lower: { garmentType: "pants", waistRow: 10 } } } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("preserves qualified visible-scalp hair and tan checks through strict V3 and actual renderer (%s)", async failure => {
  const s = await setup(failure, false, "canonical-crop-alternative", "check-squares", false, false);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string };
  expect(body).toMatchObject({ ok: true,
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { hairPlan: { surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" },
      headIdentityPlan: { outerHairGroupIds: [] }, outfitPlan: { upper: { garmentType: "shirt", pattern: { kind: "checker_block", color: "#c5aa82" } } } } } });
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([[undefined, "canonical-scalp"], ["fallback", "canonical-scalp"], [undefined, "visible-close-crop"], ["fallback", "visible-close-crop"]] as const)("retains localized scalp and goatee evidence through strict V3 handler (%s/%s)", async (failure, hair) => {
  const s = await setup(failure, false, hair, false, false, false);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string };
  expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { hairPlan: { surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" },
      headIdentityPlan: { outerHairGroupIds: [] } } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains buzz cut despite absent extended side hair without inventing scalp material (%s)", async failure => {
  const s = await setup(failure, false, "scoped-side-length", false, false, false);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { hairPlan: { surfaceMaterial?: string } } } };
  expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true }, geometry: null },
    analysis: { skinPlan: { hairPlan: { surfaceOnly: true, lengthClass: "short" }, headIdentityPlan: { outerHairGroupIds: [] } } } });
  expect(body.analysis.skinPlan.hairPlan.surfaceMaterial).toBeUndefined();
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains canonical-only combination evidence through actual V3 handler (%s)", async failure => {
  const atlases = [];
  for (const evidence of ["canonical-goatee", "canonical-combination"] as const) {
    const s = await setup(failure, evidence, false, false, false, false);
    const response = await s.worker.fetch(s.request(), s.env);
    expect(response.status).toBe(200);
    const body = await response.json() as { skinPngBase64: string };
    expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
      diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true,
        normalizationPass: true, richValidationPass: true }, geometry: null } });
    const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
    expect(validateFinalAtlas(atlas).ok).toBe(true); atlases.push(atlas);
    expect(s.gatewayRun).toHaveBeenCalledTimes(1);
    expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
    expect(fetch).not.toHaveBeenCalled();
  }
  const [before, after] = atlases;
  for (const x of [2, 5]) {
    const at = ((8 + 5) * 64 + 8 + x) * 4;
    expect(after.rgba.slice(at, at + 4)).not.toEqual(before.rgba.slice(at, at + 4));
  }
  expect(after.rgba.slice(16 * 64 * 4)).toEqual(before.rgba.slice(16 * 64 * 4));
});
it.each([
  [undefined, true], ["fallback", true], [undefined, "qualified"], ["fallback", "qualified"],
  [undefined, "visible-scalp"], ["fallback", "visible-scalp"],
  [undefined, "cropped-contour"], ["fallback", "cropped-contour"],
] as const)("carries scalp-close evidence through real V3 handler to a surface-only PNG (%s / %s)", async (failure, evidence) => {
  const s = await setup(failure, false, evidence);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { hairPlan: { surfaceOnly: boolean; texture: string }; headIdentityPlan: { outerHairGroupIds: string[] } } } };
  expect(body.analysis.skinPlan.hairPlan).toMatchObject({ surfaceOnly: true, texture: "coily" });
  if (evidence === "visible-scalp") expect(body.analysis.skinPlan.hairPlan).toMatchObject({ surfaceMaterial: "scalp_shadow" });
  if (evidence === "cropped-contour") expect(body.analysis.skinPlan.hairPlan).not.toHaveProperty("surfaceMaterial");
  expect(body.analysis.skinPlan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  for (let y = 0; y < 8; y++) for (let x = 40; x < 48; x++) expect(atlas.rgba[(y * 64 + x) * 4 + 3]).toBe(0);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains visible buzz scalp through strict V3 handler and existing material renderer (%s)", async failure => {
  // Accepted -017 hair wording in otherwise synthetic complete provider fixtures.
  // This exercises real strict normalization/handler/renderer with mock bindings;
  // it is NOT a replay of the unavailable full provider wire or a live result.
  const outputs = [];
  for (const evidence of ["covered-buzz", "visible-buzz"] as const) {
    const s = await setup(failure, false, evidence, false, false, false);
    const response = await s.worker.fetch(s.request(), s.env);
    expect(response.status).toBe(200);
    const body = await response.json() as { skinPngBase64: string;
      analysis: { skinPlan: { hairPlan: { surfaceOnly: boolean; surfaceMaterial?: string };
        facePixelPlan: unknown; outfitPlan: unknown; headIdentityPlan: { outerHairGroupIds: string[] } } } };
    expect(body).toMatchObject({ ok: true,
      diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true,
        normalizationPass: true, richValidationPass: true }, geometry: null } });
    const plan = body.analysis.skinPlan;
    expect(plan.hairPlan.surfaceOnly).toBe(true);
    expect(plan.hairPlan.surfaceMaterial).toBe(evidence === "visible-buzz" ? "scalp_shadow" : undefined);
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    outputs.push({ plan, atlas });
    expect(s.gatewayRun).toHaveBeenCalledTimes(1);
    expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
    expect(fetch).not.toHaveBeenCalled();
  }
  const [before, after] = outputs;
  expect(after.plan.facePixelPlan).toEqual(before.plan.facePixelPlan);
  expect(after.plan.outfitPlan).toEqual(before.plan.outfitPlan);
  expect(after.atlas.rgba.slice(16 * 64 * 4)).toEqual(before.atlas.rgba.slice(16 * 64 * 4));
  let changed = 0;
  for (let p = 0; p < 4096; p++) {
    expect(after.atlas.rgba[p * 4 + 3]).toBe(before.atlas.rgba[p * 4 + 3]);
    if ([0, 1, 2].some(c => before.atlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) {
      expect(p % 64).toBeLessThan(32); expect(Math.floor(p / 64)).toBeLessThan(16); changed++;
    }
  }
  expect(changed).toBeGreaterThan(0);
});
it.each([undefined, "fallback"] as const)("renders stored bald/long-sleeve evidence through V3 without cross-field long hair (%s)", async failure => {
  const s = await setup(failure, false, false, false, "008");
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string;
    diagnostics: { geometry: { semanticPass: boolean } };
    analysis: { skinPlan: { hairPlan: { template: string }; facePixelPlan: { source: string } } } };
  expect(body.diagnostics.geometry.semanticPass).toBe(true);
  expect(body.analysis.skinPlan.hairPlan.template).toBe("bald");
  expect(body.analysis.skinPlan.facePixelPlan.source).toBe("identity_geometry");
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it("protects the adapter without adding a public production route", async () => {
  const s = await setup();
  expect((await s.worker.fetch(s.request({ "x-primary-audit-token": "wrong" }), s.env)).status).toBe(403);
  expect((await s.worker.fetch(s.request({ "x-current-default-e2e": "wrong" }), s.env)).status).toBe(400);
  expect((await s.worker.fetch(new Request("https://offline/api/generate", { method: "POST",
    headers: { "x-primary-audit-token": "offline-token" } }), s.env)).status).toBe(404);
  expect(s.gatewayRun).not.toHaveBeenCalled(); expect(s.nativeRun).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains accepted geometry through real handler without mistaking goatee for complexion (%s)", async failure => {
  const s = await setup(failure, false, false, false, true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; diagnostics: { geometry: { semanticPass: boolean } };
    analysis: { skinPlan: { facePixelPlan: { source: string; layout: { geometryUsage: { eyes: boolean; mouth: boolean } } } } } };
  expect(body.diagnostics.geometry.semanticPass).toBe(true);
  expect(body.analysis.skinPlan.facePixelPlan).toMatchObject({ source: "identity_geometry", layout: { geometryUsage: { eyes: true, mouth: true } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains observed plaid tan through real V3 handler and final PNG (%s)", async failure => {
  const s = await setup(failure, false, false, true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { outfitPlan: { upper: { pattern: { color: string } } } } } };
  expect(body.analysis.skinPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  expectReferenceTanBand(atlas);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("reuses actual production handler; optional geometry rejection preserves valid PNG (%s)", async failure => {
  const s = await setup(failure);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: true, generationMode: "procedural_fallback", contract: "primary_compact_v3_legacy_suffix",
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true },
      geometry: { providerShapePass: false, semanticPass: false, acceptedGeometry: null } } });
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(s.kv.get).toHaveBeenCalled(); // Real handler quota path, no injected fake quota inside the adapter.
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64 as string));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  expect((await s.worker.fetch(s.request(), s.env)).status).toBe(409);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  const { skinPngBase64: png, ...metadata } = body;
  expect(png).toBeTruthy();
  expect(JSON.stringify(metadata)).not.toMatch(/offline-token|offline-only|data:image|base64,/);
});
it.each([undefined, "fallback"].flatMap(failure => [
  { status: "VALID", suffix: " | REGION:[0.1,0,0.9,1,0.2,0.03,0.8,0.55,0.28,0.12,0.72,0.48,0.95]" },
  { status: "EXPLICIT_NULL", suffix: " | REGION:null" },
  { status: "MISSING", suffix: "" },
  { status: "MALFORMED", suffix: " | REGION:[1,2]" },
  { status: "INVALID_REGION", suffix: " | REGION:[0.1,0,0.9,1,0.2,0.03,0.8,0.55,0.28,0.12,0.72,0.48,2]" },
].map(example => ({ ...example, failure: failure as "fallback" | undefined }))))(
  "classifies pre-normalization localization without retaining evidence prose ($failure/$status)", async example => {
    const s = await setup(example.failure, false, false, false, false, false);
    // Synthetic wire fixtures, never reconstruction of a historical response.
    s.fixture.sourceSelection.portraitEvidence = `Synthetic primary portrait evidence${example.suffix}`;
    const expected = classifyPortraitLocalization(s.fixture.sourceSelection.portraitEvidence);
    expect(expected.status).toBe(example.status);
    const response = await s.worker.fetch(s.request(), s.env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.diagnostics.localization).toEqual(boundedProjection(expected));
    const region = body.diagnostics.normalizedPrimary.sourceSelection.portraitRegion;
    if (example.status === "VALID") expect(region).not.toBeNull();
    else expect(region).toBeNull();
    expect(body.diagnostics.primaryValidation).toMatchObject({
      providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true,
    });
    expect(s.gatewayRun).toHaveBeenCalledTimes(1);
    expect(s.nativeRun).toHaveBeenCalledTimes((example.failure ? 1 : 0) + (example.status === "VALID" ? 1 : 0));
    expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
    expect(JSON.stringify(body.diagnostics)).not.toMatch(/Synthetic primary portrait evidence|REGION:|offline-token|offline-only|data:image|base64,/);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([undefined, "fallback"] as const)("reports no geometry attempt for unknown crop coverage without inventing rejection (%s)", async failure => {
  const s = await setup(failure, false, false, false, false, false);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { diagnostics: { geometry: unknown }; skinPngBase64: string;
    analysis: { skinPlan: { facePixelPlan: { layout: { geometryUsage: { eyes: boolean } } } } } };
  expect(body.diagnostics.geometry).toBeNull();
  expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.eyes).toBe(false);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  const root = mkdtempSync("evaluation-artifacts/e2e-geometry-skip-offline-20260927-");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  state.runId = "a".repeat(32); // Same synthetic request, not a recovered live run.
  const post = vi.fn(async () => ({ status: response.status, body: body as unknown as Record<string, unknown> }));
  await runCurrentDefaultE2E(state, prepared, post, event => atomicCheckpoint(`${root}/summary.json`, state, event), root);
  expect(post).toHaveBeenCalledTimes(1);
  expect(state.classification).toBe("CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED");
  expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: false,
    actualWireCropSha256: null, matchesActualWire: null,
    replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" },
    diagnostics: { cropMode: "center_fallback" } });
  expect((await readLatestAuditCheckpoint(`${root}/summary.json`))?.snapshot).toEqual(JSON.parse(JSON.stringify(state)));
  const persisted = readFileSync(`${root}/summary.json`, "utf8");
  expect(persisted).not.toMatch(/offline-token|offline-only|data:image|base64,/);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not turn an ineligible primary failure into fallback or geometry", async () => {
  const s = await setup("invalid");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).not.toBe(200);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).not.toHaveBeenCalled();
  expect(log.mock.calls.map(c => String(c[0]).split("|")[2]).filter(s => s?.startsWith("production_")))
    .toEqual(["production_primary_returned", "production_primary_diagnostic_finished"]);
});
it("rejects raw-original-shaped or opt-in injected payload before provider dispatch", async () => {
  const s = await setup();
  expect((await s.worker.fetch(s.request({}, { ...payload, expectedContractVersion: "primary_compact_v4_structured_localization" }), s.env)).status).toBe(400);
  expect(s.gatewayRun).not.toHaveBeenCalled();
});
it("keeps one production handler call and the original preprocessing implementation", () => {
  const adapter = readFileSync("test/audit/currentDefaultE2E.ts", "utf8");
  expect(adapter.match(/productionWorker\.fetch\(/g)).toHaveLength(1);
  expect(adapter).not.toMatch(/runPhotoAnalysis\(|generateSkin\(|SYNCHRONOUS_ENHANCEMENTS_ENABLED\s*:/);
  const browser = readFileSync("test/audit/currentDefaultPreprocess.mjs", "utf8");
  expect(browser).toContain("preparePhotoForUpload(source)");
  expect(browser).not.toMatch(/drawImage\(|Math\.round|resize/);
  expect(boundedProjection({ secret: "hidden", value: "data:image/jpeg;base64,abc", safe: "striped" }))
    .toEqual({ value: "[redacted]", safe: "striped" });
});

it.each([1, 2])("does not POST when authoritative checkpoint %s fails", async failAt => {
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  let writes = 0;
  const post = vi.fn();
  await expect(runCurrentDefaultE2E(state, prepared, post, async () => {
    if (++writes === failAt) throw new Error("checkpoint_unavailable");
  }, "unused")).rejects.toThrow("checkpoint_unavailable");
  expect(post).not.toHaveBeenCalled();
});

it("does not retry an unobserved generation response or invent provider counts", async () => {
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  const post = vi.fn(async () => { throw new Error("transport_unobserved"); });
  await runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused");
  expect(post).toHaveBeenCalledTimes(1);
  expect(state.accounting).toBe("unknown");
  expect(state.result).toBeNull();
  await expect(runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused"))
    .rejects.toThrow("e2e_generation_already_consumed");
  expect(post).toHaveBeenCalledTimes(1);
});
