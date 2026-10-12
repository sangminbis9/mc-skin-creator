/** Passive audit only. Never reconstruct a historical primary from its PNG.
 * Parameters below are a same-request deterministic replay, not observed raw
 * provider data. They are retained only if plans, features, the observed design
 * and final atlas match the response before sanitization. Candidate ranking is
 * observed from production, not rerun in this advisory verification.
 */
import type { PhotoAnalysis } from "../../src/analysis";
import type { FaceIdentityGeometryAnalysis } from "../../src/faceIdentityGeometry";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../../src/generate";
import { buildSkinPlan, type SkinPlan } from "../../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../../src/referencePrimaryRenderer";
import { FACE_STYLE_TEMPLATES, HAIR_STYLE_TEMPLATES, OUTFIT_STYLE_TEMPLATES, buildReferenceStylePlan } from "../../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../../src/referenceCraftPlan";
import { base64ToBytes, decodePng } from "../../src/png";
import { validateFinalAtlas, validateAtlasCraftFoundation } from "../../src/skinPost";
import type { PropagationStage } from "./e2eStageObservation";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const summaryFields = ["framing", "visibleRegions", "sourceSelection", "observed", "inferred",
  "canonicalIdentity", "renderHints", "identityGeometry", "faceMeasurementEvidence"] as const;

export async function captureCurrentDefaultPropagation(input: {
  primary: PhotoAnalysis | null; geometry: FaceIdentityGeometryAnalysis | null; providerStage: string | null;
  body: ObjectValue; runId: string | null; inputs: { analysisSha256: string; generationSha256: string };
  verifyReplay?: boolean;
  replayMode?: "atlas" | "parameters_only" | "response_parameters";
  onStage?: (stage: PropagationStage) => void;
}, project: (value: unknown) => unknown, digest: (bytes: Uint8Array) => Promise<string>) {
  const mark = (stage: PropagationStage) => {
    try {
      const result: unknown = input.onStage?.(stage);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch { /* Observability must not change the captured evidence or control flow. */ }
  };
  mark("propagation_projection_started");
  const summary = object(input.body.analysis), reference = object(summary.referenceStyle);
  const design = object(reference.design);
  const trace = {
    version: "primary_png_propagation_v1",
    runId: input.runId && /^[a-f0-9]{32}$/.test(input.runId) ? input.runId : null,
    inputs: input.inputs, providerStage: input.providerStage,
    evidenceScope: "this_request_only_not_historical_recovery",
    primary: input.primary ? project({ quality: input.primary.quality, framing: input.primary.framing,
      visibleRegions: input.primary.visibleRegions, sourceSelection: input.primary.sourceSelection,
      observed: input.primary.observed, inferred: input.primary.inferred, canonicalIdentity: input.primary.canonicalIdentity,
      renderHints: input.primary.renderHints, fallbackFeatures: input.primary.fallbackFeatures,
      ...(input.primary.faceMeasurementEvidence ? { faceMeasurementEvidence: input.primary.faceMeasurementEvidence } : {}) }) : null,
    // These are observed response fields, not the selector's first/ranked guess.
    renderAnalysis: project(Object.fromEntries(summaryFields.filter(k => Object.hasOwn(summary, k)).map(k => [k, summary[k]]))),
    selectedFamilies: reference.status === "reference_style_accepted" ? project({
      face: object(design.face).family, hair: object(design.hair).family, outfit: object(design.outfit).family,
    }) : null,
    referenceStyle: project(reference), sourceParameters: project(input.body.features),
    skinPlan: project({ skinPlan: summary.skinPlan }),
    injectedParameters: null as unknown,
    parameterEvidence: "unverified",
    replay: null as unknown,
    finalPng: null as unknown,
    // boundedProjection deliberately omits generated descriptions/portrait prose.
    // Record losses so shortened/redacted text cannot be called cue loss in production.
    projectionChanges: [] as string[],
  };
  const findChanges = (before: unknown, after: unknown, path: string): void => {
    if (typeof before === "string" && before !== after) trace.projectionChanges.push(path);
    else if (Array.isArray(before)) {
      const values = Array.isArray(after) ? after : [];
      if (before.length !== values.length) trace.projectionChanges.push(`${path}:array_length`);
      before.forEach((v, i) => findChanges(v, values[i], `${path}[${i}]`));
    } else if (before && typeof before === "object") {
      const afterObject = object(after);
      Object.entries(before).forEach(([key, v]) => {
        if (!Object.hasOwn(afterObject, key)) trace.projectionChanges.push(`${path}.${key}:omitted`);
        else findChanges(v, afterObject[key], `${path}.${key}`);
      });
    }
  };
  if (input.primary) findChanges(input.primary, trace.primary, "primary");
  findChanges(summary.skinPlan, object(trace.skinPlan).skinPlan, "skinPlan");
  mark("propagation_projection_finished");
  try {
    if (typeof input.body.skinPngBase64 !== "string") return trace;
    mark("propagation_png_started");
    const bytes = base64ToBytes(input.body.skinPngBase64), atlas = await decodePng(bytes);
    trace.finalPng = { sha256: await digest(bytes), rgbaSha256: await digest(atlas.rgba),
      width: atlas.width, height: atlas.height, validation: validateFinalAtlas(atlas) };
    mark("propagation_png_finished");
    if (!input.primary || input.body.ok !== true || input.verifyReplay !== true) return trace;
    // Geometry may have been accepted yet not used if its render was rejected.
    // Compare both legitimate in-memory contexts; never salvage rejected geometry.
    const contexts = input.geometry
      ? [{ analysis: { ...input.primary, faceIdentityGeometry: input.geometry }, kind: "accepted_geometry" },
        { analysis: input.primary, kind: "primary_only" }]
      : [{ analysis: input.primary, kind: "primary_only" }];
    for (const candidate of contexts) {
      mark("propagation_normalization_started");
      const a = normalizeAnalysisForRendering(candidate.analysis);
      mark("propagation_normalization_finished");
      if (input.replayMode === "response_parameters") {
        // This mode transports the actual response plan. It deliberately does
        // NOT certify plan reconstruction or pixel equality on the Worker.
        // Verify those from the durable response in an offline consumer.
        const observedPlan = summary.skinPlan as SkinPlan | undefined;
        const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
        if (!observedPlan?.hairPlan || !summaryFields.every(k => same(a[k], summary[k])) || !same(features, input.body.features)) continue;
        const parameters = { features, faceStyle: buildFaceStyle(a, features, observedPlan.hairPlan), familyDesign: null };
        trace.injectedParameters = project(parameters);
        findChanges(parameters, trace.injectedParameters, "injectedParameters");
        trace.parameterEvidence = "derived_from_same_run_response_plan";
        trace.replay = { context: candidate.kind, renderAnalysisMatch: true, sourcePlanMatch: null,
          featuresMatch: true, selectedDesignMatch: null, finalAtlasMatch: null,
          scope: "response_plan_derived_parameters", atlasReplay: "deferred_local",
          rankingRecomputed: false, acceptedCandidateCountRecomputed: false };
        mark("propagation_parameters_finished");
        return trace;
      }
      mark("propagation_plan_started");
      const plan = buildSkinPlan(a);
      mark("propagation_plan_finished");
      const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      mark("propagation_features_finished");
      if (!summaryFields.every(k => same(a[k], summary[k])) || !same(plan, summary.skinPlan) || !same(features, input.body.features)) continue;
      const style = buildFaceStyle(a, features, plan.hairPlan);
      if (input.replayMode === "parameters_only") {
        // Audit-only bounded verification: exact observed normalization, plan
        // and features license these derived parameters, NOT an atlas claim.
        // Leave the expensive second pixel render to an offline consumer.
        const parameters = { features, faceStyle: style, familyDesign: null };
        trace.injectedParameters = project(parameters);
        findChanges(parameters, trace.injectedParameters, "injectedParameters");
        trace.parameterEvidence = "verified_same_run_plan_features";
        trace.replay = { context: candidate.kind, renderAnalysisMatch: true, sourcePlanMatch: true,
          featuresMatch: true, selectedDesignMatch: null, finalAtlasMatch: null,
          scope: "plan_features_only", atlasReplay: "deferred_local",
          rankingRecomputed: false, acceptedCandidateCountRecomputed: false,
          planSha256: await digest(new TextEncoder().encode(JSON.stringify(plan))) };
        mark("propagation_parameters_finished");
        return trace;
      }
      const source = buildProceduralSourceAtlas(features, style, plan);
      if (!source) continue;
      let chosen: ReturnType<typeof buildReferenceStylePlan> | undefined;
      let reproduced = source;
      let scope: "observed_design_atlas" | "preserved_source_atlas";
      if (plan.headIdentityPlan.ownership?.execution !== "resolved") {
        // This production branch has no candidate search. Preserve its entire
        // source-grammar contract, including the complete legacy craft check.
        const styled = renderReferencePrimaryAtlas(source, plan, a, style);
        if (!styled.ok || !same(styled.summary, reference)) continue;
        reproduced = styled.atlas; scope = "preserved_source_atlas";
      } else {
        const eligible = buildReferenceStylePlan(a);
        const face = eligible.candidates.face.find(c => same(c, design.face));
        const hair = eligible.candidates.hair.find(c => same(c, design.hair));
        const outfit = eligible.candidates.outfit.find(c => same(c, design.outfit));
        if (!face || !hair || !outfit) continue;
        chosen = { ...eligible, face, hair, outfit };
        if (!same(chosen, design) || reference.version !== "reference_primary_v1"
          || reference.status !== "reference_style_accepted" || reference.provenance !== "template_design"
          || reference.craftValidation !== "pass" || reference.sourceGeometryPreserved !== true) continue;
        // Prove the actual selected candidate, not that a fresh ranking would
        // choose it. acceptedCandidates remains an observed production field.
        const count = eligible.candidates.face.length * eligible.candidates.hair.length * eligible.candidates.outfit.length;
        if (reference.renderAttempts !== count || !Number.isInteger(reference.acceptedCandidates)
          || Number(reference.acceptedCandidates) < 1 || Number(reference.acceptedCandidates) > count) continue;
        if (!validateFinalAtlas(source).ok || !validateAtlasCraftFoundation(source, style).ok) continue;
        const composition = composeReferenceStyleAtlas(source, plan, chosen, style);
        const quality = measureReferenceRenderedQuality(composition, source, plan, chosen, style);
        if (!quality.constructionValid || !validateAtlasCraftFoundation(composition.atlas, style).ok
          || !same(quality.metrics, reference.metrics) || !same(composition.diagnostic.constraints, reference.constraints)
          || !validateReferenceAtlasCraft(composition.atlas, source, plan, style,
            buildReferenceCraftPlan(plan, chosen, composition)).ok) continue;
        reproduced = composition.atlas; scope = "observed_design_atlas";
      }
      if (reproduced.width !== atlas.width || reproduced.height !== atlas.height
        || reproduced.rgba.length !== atlas.rgba.length || !reproduced.rgba.every((v, i) => v === atlas.rgba[i])) continue;
      const parameters = { features, faceStyle: style,
        familyDesign: chosen ? { face: FACE_STYLE_TEMPLATES[chosen.face.family],
          hair: chosen.hair.family === "preserve_existing" ? null : HAIR_STYLE_TEMPLATES[chosen.hair.family],
          outfit: chosen.outfit.family === "preserve_existing" ? null : OUTFIT_STYLE_TEMPLATES[chosen.outfit.family] } : null };
      trace.injectedParameters = project(parameters);
      findChanges(parameters, trace.injectedParameters, "injectedParameters");
      trace.parameterEvidence = "verified_exact_same_run_replay";
      trace.replay = { context: candidate.kind, renderAnalysisMatch: true, sourcePlanMatch: true,
        featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true,
        scope, rankingRecomputed: false, acceptedCandidateCountRecomputed: false,
        planSha256: await digest(new TextEncoder().encode(JSON.stringify(plan))) };
      return trace;
    }
    trace.replay = { context: "unmatched", reason: "actual_response_not_reproduced", finalAtlasMatch: false };
  } catch {
    // Advisory diagnosis cannot replace a successful production response or
    // cause a provider retry. Never persist an exception with untrusted prose.
    trace.replay = { context: "unavailable", reason: "diagnostic_replay_unavailable" };
  }
  return trace;
}
