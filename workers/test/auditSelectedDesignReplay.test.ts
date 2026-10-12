import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { makeAnalysis } from "./helpers";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import * as selection from "../src/referenceStyleSelection";
import * as composition from "../src/referenceStyleRenderer";
import * as generation from "../src/generate";
import * as plans from "../src/skinPlan";
import { encodePng, bytesToBase64, base64ToBytes, decodePng } from "../src/png";
import { captureCurrentDefaultPropagation } from "./audit/currentDefaultPropagation";
import { boundedProjection, digest } from "./audit/currentDefaultE2E";
import { freshAuditOutput } from "./freshAuditOutput";
import type { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { PROPAGATION_STAGES } from "./audit/e2eStageObservation";

afterEach(() => vi.restoreAllMocks());
async function fixture(primary = makeAnalysis()) {
  const a = normalizeAnalysisForRendering(primary), plan = buildSkinPlan(a);
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, features, plan.hairPlan), baseline = buildProceduralSourceAtlas(features, style, plan)!;
  const production = renderReferencePrimaryAtlas(baseline, plan, a, style);
  if (!production.ok) throw new Error("authored_production_render_failed");
  const body = { ok: true, features, analysis: { ...a, skinPlan: plan, referenceStyle: production.summary },
    skinPngBase64: bytesToBase64(await encodePng(production.atlas)) };
  return { primary, geometry: null, providerStage: "authored_offline", body, runId: "a".repeat(32),
    inputs: { analysisSha256: "b".repeat(64), generationSha256: "c".repeat(64) }, verifyReplay: true };
}

it("transports response-derived parameters without rebuilding a plan or claiming replay verification", async () => {
  const input = await fixture(), immutable = JSON.stringify(input);
  const plan = vi.spyOn(plans, "buildSkinPlan"), atlas = vi.spyOn(generation, "buildProceduralSourceAtlas");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const trace = await captureCurrentDefaultPropagation({ ...input, replayMode: "response_parameters" }, boundedProjection, digest);
  expect(plan).not.toHaveBeenCalled(); expect(atlas).not.toHaveBeenCalled();
  expect(trace.parameterEvidence).toBe("derived_from_same_run_response_plan");
  expect(trace.replay).toMatchObject({ scope: "response_plan_derived_parameters", sourcePlanMatch: null,
    finalAtlasMatch: null, selectedDesignMatch: null, rankingRecomputed: false });
  expect(trace.skinPlan).toEqual(boundedProjection({ skinPlan: input.body.analysis.skinPlan }));
  expect(JSON.stringify(input)).toBe(immutable);
  const full = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(full.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(full.finalPng).toEqual(trace.finalPng);
  const saved = trace.injectedParameters as { features: unknown; faceStyle: unknown };
  expect(full.injectedParameters).toMatchObject({ features: saved.features, faceStyle: saved.faceStyle });
  expect(network).not.toHaveBeenCalled();
});

it("captures exact plan/features parameters without a second remote pixel render or atlas claim", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const input = await fixture(), immutable = JSON.stringify(input);
  const baseline = vi.spyOn(generation, "buildProceduralSourceAtlas");
  const rerank = vi.spyOn(selection, "selectReferenceStyleAtlas");
  const compose = vi.spyOn(composition, "composeReferenceStyleAtlas");
  const trace = await captureCurrentDefaultPropagation({ ...input, replayMode: "parameters_only" }, boundedProjection, digest);
  expect(trace.parameterEvidence).toBe("verified_same_run_plan_features");
  expect(trace.replay).toMatchObject({ scope: "plan_features_only", atlasReplay: "deferred_local",
    renderAnalysisMatch: true, sourcePlanMatch: true, featuresMatch: true,
    selectedDesignMatch: null, finalAtlasMatch: null, rankingRecomputed: false });
  expect(trace.injectedParameters).toMatchObject({ features: input.body.features, familyDesign: null });
  expect(baseline).not.toHaveBeenCalled(); expect(compose).not.toHaveBeenCalled(); expect(rerank).not.toHaveBeenCalled();
  expect(JSON.stringify(input)).toBe(immutable);
  // The heavier proof remains separately executable offline, with no new model
  // observation. Only it may attest to the resulting pixels/design.
  const full = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(full.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(full.finalPng).toEqual(trace.finalPng);
  const savedParameters = trace.injectedParameters as { features: unknown; faceStyle: unknown };
  expect(full.injectedParameters).toMatchObject({ features: savedParameters.features, faceStyle: savedParameters.faceStyle });
  expect(network).not.toHaveBeenCalled();
});

it("reports fixed parameter-projection boundaries without altering evidence, including a throwing observer", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const input = { ...await fixture(), replayMode: "parameters_only" as const };
  const expected = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  const stages: string[] = [];
  const actual = await captureCurrentDefaultPropagation({ ...input, onStage: stage => { stages.push(stage); } }, boundedProjection, digest);
  expect(stages).toEqual(PROPAGATION_STAGES);
  expect(actual).toEqual(expected);
  for (const onStage of [() => { throw Error("synthetic observer failure"); }, async () => { throw Error("synthetic async observer failure"); }]) {
    expect(await captureCurrentDefaultPropagation({ ...input, onStage }, boundedProjection, digest)).toEqual(expected);
  }
  const noPngStages: string[] = [];
  await captureCurrentDefaultPropagation({ ...input, body: { ok: false }, onStage: stage => { noPngStages.push(stage); } }, boundedProjection, digest);
  expect(noPngStages).toEqual(PROPAGATION_STAGES.slice(0, 2));
  expect(network).not.toHaveBeenCalled();
});

it.each(["plan", "features", "analysis"] as const)("parameter-only mode rejects mismatched %s instead of inventing evidence", async field => {
  const input = await fixture();
  if (field === "plan") input.body.analysis.skinPlan.hairPlan.template = "medium_bob";
  if (field === "features") input.body.features.hairColor = "#012345";
  if (field === "analysis") input.body.analysis = { ...input.body.analysis,
    observed: { ...input.body.analysis.observed, hair: "different actual observation" } };
  const trace = await captureCurrentDefaultPropagation({ ...input, replayMode: "parameters_only" }, boundedProjection, digest);
  expect(trace.parameterEvidence).toBe("unverified"); expect(trace.injectedParameters).toBeNull();
});

it("does not certify pixels merely because parameters match", async () => {
  const input = await fixture(), atlas = await decodePng(base64ToBytes(input.body.skinPngBase64));
  atlas.rgba[(8 * 64 + 8) * 4] ^= 1;
  input.body.skinPngBase64 = bytesToBase64(await encodePng(atlas));
  const trace = await captureCurrentDefaultPropagation({ ...input, replayMode: "parameters_only" }, boundedProjection, digest);
  expect(trace.parameterEvidence).toBe("verified_same_run_plan_features");
  expect(trace.replay).toMatchObject({ finalAtlasMatch: null, selectedDesignMatch: null });
  const full = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(full.parameterEvidence).toBe("unverified");
  expect(full.replay).toMatchObject({ finalAtlasMatch: false });
});

it.each(["ordinary", "headwear", "pixel-pattern"] as const)(
  "can verify the exact final atlas locally using only sanitized captured parameters/plan/design (%s)", async variant => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
    const primary = makeAnalysis();
    if (variant === "headwear") {
      primary.fallbackFeatures.hat = "cap";
      primary.observed.accessories = "light-blue cap";
    }
    if (variant === "pixel-pattern") {
      primary.observed.clothing = "a hoodie featuring a pixelated, blocky pattern in pastel shades of pink, lavender, and light blue";
      primary.renderHints.garmentTexture = "knit";
    }
    const input = await fixture(primary);
    const trace = await captureCurrentDefaultPropagation({ ...input, replayMode: "parameters_only" }, boundedProjection, digest);
    expect(trace.parameterEvidence).toBe("verified_same_run_plan_features");
    // Simulate persisted JSON. No raw primary/prompt or image input is available
    // to the local atlas verifier, and missing fields are never supplemented.
    const saved = JSON.parse(JSON.stringify(trace)) as {
      injectedParameters: { features: Parameters<typeof buildProceduralSourceAtlas>[0]; faceStyle: ReturnType<typeof buildFaceStyle> };
      skinPlan: { skinPlan: ReturnType<typeof buildSkinPlan> };
      referenceStyle: { design: ReturnType<typeof buildReferenceStylePlan> };
      finalPng: { sha256: string; rgbaSha256: string };
    };
    const source = buildProceduralSourceAtlas(saved.injectedParameters.features,
      saved.injectedParameters.faceStyle, saved.skinPlan.skinPlan)!;
    expect(source).not.toBeNull();
    const local = composition.composeReferenceStyleAtlas(source, saved.skinPlan.skinPlan,
      saved.referenceStyle.design, saved.injectedParameters.faceStyle);
    const actual = await decodePng(base64ToBytes(input.body.skinPngBase64));
    expect(local.atlas.rgba).toEqual(actual.rgba);
    const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    expect(sha(local.atlas.rgba)).toBe(saved.finalPng.rgbaSha256);
    expect(sha(base64ToBytes(input.body.skinPngBase64))).toBe(saved.finalPng.sha256);
    const out = freshAuditOutput("evaluation-artifacts/deferred-parameter-atlas-replay-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "authored_offline_deferred_atlas_verification",
      variant, remoteAtlasClaim: null, localAtlasMatch: true, finalPngSha256: saved.finalPng.sha256,
      rgbaSha256: saved.finalPng.rgbaSha256, liveEvidence: false, providerCalls: 0,
      rawPrimaryAvailableToLocalVerifier: false, missingFieldsSupplemented: false,
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
  }, 60_000,
);

it("proves the selected atlas plus independent head foundations without a second candidate search", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const input = await fixture(), immutable = JSON.stringify(input);
  expect(input.body.analysis.referenceStyle.renderAttempts).toBeGreaterThan(1);
  const rerank = vi.spyOn(selection, "selectReferenceStyleAtlas"), compose = vi.spyOn(composition, "composeReferenceStyleAtlas");
  const trace = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ scope: "observed_design_atlas", rankingRecomputed: false,
    acceptedCandidateCountRecomputed: false, renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  // Current head-proportion validation independently rebuilds its foundation
  // for quality and craft. These are not alternate candidates or reranking.
  expect(compose.mock.calls.map(call => call[2].headProportionPolicy))
    .toEqual(["reference_low_eyes_v1", undefined, undefined]);
  for (const call of compose.mock.calls) for (const axis of ["face", "hair", "outfit"] as const)
    expect(call[2][axis]).toEqual(input.body.analysis.referenceStyle.design![axis]);
  expect(rerank).not.toHaveBeenCalled();
  expect(trace.injectedParameters).toMatchObject({ features: input.body.features });
  expect(trace.referenceStyle).toEqual(boundedProjection(input.body.analysis.referenceStyle));
  expect(JSON.stringify(input)).toBe(immutable); expect(network).not.toHaveBeenCalled();
});

it.each(["plan", "features", "candidate", "drape", "metrics", "constraints", "png"] as const)(
  "does not invent verified parameters when the actual response %s differs", async field => {
    const input = await fixture();
    const design = input.body.analysis.referenceStyle.design!;
    if (field === "plan") input.body.analysis.skinPlan.hairPlan.template = "medium_bob";
    if (field === "features") input.body.features.hairColor = "#012345";
    if (field === "candidate") design.hair.cost += 1;
    if (field === "drape") design.drape.eligible = !design.drape.eligible;
    if (field === "metrics") input.body.analysis.referenceStyle.metrics!.eyeContrast += 1;
    if (field === "constraints") delete input.body.analysis.referenceStyle.constraints;
    if (field === "png") {
      const atlas = await decodePng(base64ToBytes(input.body.skinPngBase64));
      atlas.rgba[(8 * 64 + 8) * 4] ^= 1;
      input.body.skinPngBase64 = bytesToBase64(await encodePng(atlas));
    }
    const trace = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
    expect(trace.parameterEvidence).toBe("unverified"); expect(trace.injectedParameters).toBeNull();
    expect(trace.replay).toMatchObject({ context: "unmatched", finalAtlasMatch: false });
  },
);

it("explicitly treats accepted-candidate totals as observed rather than newly recomputed", async () => {
  const input = await fixture();
  // Within-bounds count alteration is intentionally not ranking verification.
  input.body.analysis.referenceStyle.acceptedCandidates = 1;
  const trace = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(trace.replay).toMatchObject({ finalAtlasMatch: true, acceptedCandidateCountRecomputed: false });
  expect(trace.referenceStyle).toMatchObject({ acceptedCandidates: 1 });
  input.body.analysis.referenceStyle.acceptedCandidates = 0;
  expect((await captureCurrentDefaultPropagation(input, boundedProjection, digest)).injectedParameters).toBeNull();
});

it("retains the actual unresolved source grammar without inventing a selected family", async () => {
  const primary = makeAnalysis();
  primary.renderHints.hairAccessory = "clip";
  const input = await fixture(primary);
  expect(input.body.analysis.skinPlan.headIdentityPlan.ownership?.execution).toBe("preserve_existing_grammar");
  expect(input.body.analysis.referenceStyle.status).toBe("source_grammar_preserved");
  const rerank = vi.spyOn(selection, "selectReferenceStyleAtlas"), compose = vi.spyOn(composition, "composeReferenceStyleAtlas");
  const trace = await captureCurrentDefaultPropagation(input, boundedProjection, digest);
  expect(trace.parameterEvidence).toBe("verified_exact_same_run_replay");
  expect(trace.replay).toMatchObject({ scope: "preserved_source_atlas", finalAtlasMatch: true });
  expect(trace.selectedFamilies).toBeNull();
  expect(trace.injectedParameters).toMatchObject({ familyDesign: null });
  expect(rerank).not.toHaveBeenCalled(); expect(compose).not.toHaveBeenCalled();
});
