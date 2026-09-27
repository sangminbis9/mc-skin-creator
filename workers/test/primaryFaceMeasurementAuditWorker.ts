import { runPhotoAnalysis, type PhotoAnalysis, type PortraitLocalizationTrace, type PortraitRegion } from "../src/analysis";
import type { StructuredLocalizationTrace } from "../src/compactPhotoAnalysisV4";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { projectProtectedValidatedLocalization } from "./audit/validatedLocalizationEvidence";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { FACE_GEOMETRY_MODEL, runFaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { createIdentityCrops } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import type { Env } from "../src/types";
import { GEMMA_VISION_MODEL } from "../src/gemmaPhotoAnalysis";
import { createAuditState, markAuditStage, validRunId, wrapAuditAI, type AuditRunState } from "./primaryAuditLifecycle";
import { APERTURE_OPTIONS, apertureImageIdentity, runExperimentalAperture } from "./audit/eyeAperturePilotContract";
import { runExperimentalApertureV2 } from "./audit/eyeApertureV2LiveContract";
import { currentDefaultE2E, E2E_MARKER } from "./audit/currentDefaultE2E";
import { createE2EGateTrace, e2eGateResponse, failE2EGate } from "./audit/currentDefaultE2EGateTrace";

type AuditEnv = Env & { PRIMARY_AUDIT_TOKEN?: string };
// Isolate-local, best-effort observability, not a durable inference ledger.
const runs = new Map<string, AuditRunState>();
const aperturePilotSlots = new Map<string, Set<number>>();
const apertureV2NextSlot = new Map<string, number>(); // -1 means consumed/failed/in flight.
let currentDefaultE2EConsumed = false;
const AUDIT_TEXT_LIMIT = 256;

function boundedAuditText(value: unknown): string {
  if (typeof value !== "string") return "";
  const printable = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, AUDIT_TEXT_LIMIT);
}

function isAuditImageDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && (value.startsWith("data:image/jpeg;base64,") || value.startsWith("data:image/png;base64,"));
}

export function attemptsOf(attempts: NonNullable<Awaited<ReturnType<typeof runPhotoAnalysis>>["providerAttempts"]>) {
  return attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    modelId: attempt.model,
    outcome: attempt.outcome,
    traceVersion: attempt.traceVersion ?? null,
    providerAttemptKind: attempt.providerAttemptKind ?? null,
    attemptOrdinal: attempt.attemptOrdinal ?? null,
    origin: attempt.origin ?? null,
    elapsedMs: attempt.elapsedMs ?? null,
    configuredDeadlineMs: attempt.configuredDeadlineMs ?? null,
    deadlineTimerFired: attempt.deadlineTimerFired ?? null,
    responseFormatMode: attempt.responseFormatMode ?? null,
    providerSchemaValidation: attempt.providerSchemaValidation ?? null,
    strictValidation: attempt.strictValidation ?? null,
    httpStatus: attempt.status ?? null,
    status: attempt.status ?? null,
    providerStatus: attempt.providerStatus ?? null,
    code: attempt.providerStatus ?? null,
    fallbackEligible: attempt.fallbackEligible ?? null,
    fallbackReason: attempt.fallbackReason ?? null,
    dailyQuotaExhausted: attempt.dailyQuotaExhausted ?? false,
  }));
}

/** Explicit allowlist: never forward portraitEvidence or model prose. */
export function auditLocalizationTrace(trace: PortraitLocalizationTrace | StructuredLocalizationTrace | undefined) {
  if (!trace) return null;
  if (trace.version === 2) {
    const { version, contractVersion, carrier, status, fieldPresent,
      shapeValidation, regionValidation, validationReason, relationshipFailure } = trace;
    return { traceVersion: version, contractVersion, carrier, status, fieldPresent,
      shapeValidation, regionValidation, validationReason,
      ...(status === "INVALID_REGION" && validationReason === "face_head_relationship_invalid"
        && (relationshipFailure === "head_width_ratio" || relationshipFailure === "head_height_ratio"
          || relationshipFailure === "both_ratios") ? { relationshipFailure } : {}) };
  }
  const { version, status, markerPresent, terminalTokenPresent, numericCount,
    numericParse, regionValidation, validationReason, relationshipFailure } = trace;
  return { traceVersion: version, status, markerPresent, terminalTokenPresent,
    numericCount, numericParse, regionValidation, validationReason,
    ...(validationReason === "face_head_relationship_invalid"
      && (relationshipFailure === "head_width_ratio" || relationshipFailure === "head_height_ratio"
        || relationshipFailure === "both_ratios") ? { relationshipFailure } : {}) };
}

/** The protected response's allowlisted trace, after JSON serialization. */
export type ProtectedAuditLocalizationTrace = NonNullable<ReturnType<typeof auditLocalizationTrace>>;

function analysisOf(analysis: PhotoAnalysis) {
  const hintNames = [
    "eyeSpacing", "eyeSize", "eyeShape", "eyeTilt", "eyebrowShape",
    "mouthShape", "mouthOpening", "lipFullness", "faceShape", "noseShape",
  ] as const;
  let consumerTrace: {
    measurementTrace: ReturnType<typeof resolveFaceMeasurements>;
    faceLayoutPlan: Record<string, unknown>;
  } | null = null;
  try {
    const measurementTrace = resolveFaceMeasurements(analysis);
    const layout = buildSkinPlan(analysis).facePixelPlan.layout;
    consumerTrace = {
      measurementTrace,
      faceLayoutPlan: {
        eyeSpacing: layout.eyeSpacingTopology,
        eyeFootprint: layout.eyeFootprintTopology,
        eyeOpenness: layout.eyeOpenness,
        browEyeDistance: layout.browDistanceTopology,
        browSlope: layout.browSlopeTopology,
        mouthWidth: layout.mouthWidth,
        mouthOpenness: layout.mouthOpening,
        expression: layout.mouthExpressionTopology,
      },
    };
  } catch { /* Optional deterministic consumer trace must not mask primary acquisition. */ }
  return {
    quality: analysis.quality,
    visibleRegions: analysis.visibleRegions,
    sourceSelection: {
      portraitImageIndex: analysis.sourceSelection.portraitImageIndex,
      outfitImageIndex: analysis.sourceSelection.outfitImageIndex,
      generationImageIndex: analysis.sourceSelection.generationImageIndex,
      portraitRegion: analysis.sourceSelection.portraitRegion ?? null,
    },
    identityCropContext: {
      hairVolume: analysis.renderHints.hairVolume,
      hairTexture: analysis.renderHints.hairTexture,
      overallHairLength: analysis.renderHints.overallHairLength,
      sideHairAsymmetry: analysis.renderHints.sideHairAsymmetry,
      headCovering: analysis.fallbackFeatures.hat === "headscarf",
    } satisfies AdaptiveHeadCropContext,
    faceMeasurementEvidence: analysis.faceMeasurementEvidence ?? null,
    relevantRenderHints: Object.fromEntries(hintNames.map((name) => [name, analysis.renderHints[name]])),
    canonicalFaceCues: analysis.canonicalIdentity.features
      .filter((feature) => feature.category === "face")
      .map(({ feature, priority, confidence, targetRegions }) => ({ feature, priority, confidence, targetRegions })),
    fallbackFeaturesGlasses: analysis.fallbackFeatures.glasses,
    observedAccessories: boundedAuditText(analysis.observed.accessories),
    canonicalAccessoryCues: analysis.canonicalIdentity.features
      .filter((feature) => feature.category === "accessory")
      .map(({ feature, evidence, confidence, priority, targetRegions }) => ({
        feature: boundedAuditText(feature),
        evidence: boundedAuditText(evidence),
        confidence,
        priority,
        targetRegions: targetRegions.map(boundedAuditText),
      })),
    consumerTrace,
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!env.PRIMARY_AUDIT_TOKEN || request.headers.get("x-primary-audit-token") !== env.PRIMARY_AUDIT_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    const runtime = {
      marker: "cloudflare_remote_worker",
      aiBinding: Boolean(env.AI),
      aiRunType: typeof env.AI?.run,
      aiGatewayType: typeof env.AI?.gateway,
    };
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/primary-audit-health") {
      return Response.json({ ok: true, runtime, providerCalls: 0 });
    }
    if (request.method === "POST" && url.pathname === "/current-default-e2e-audit") {
      const trace = createE2EGateTrace();
      if (!validRunId(request.headers.get("x-primary-audit-run-id"))
        || request.headers.get("x-current-default-e2e") !== E2E_MARKER) {
        failE2EGate(trace, "selector", "invalid_e2e_marker_or_run_id");
        return e2eGateResponse(trace, { error: "invalid_e2e_marker_or_run_id" }, 400);
      }
      trace.selectorValidated = true; trace.sequence++;
      if (currentDefaultE2EConsumed) {
        failE2EGate(trace, "consumed", "e2e_already_consumed");
        return e2eGateResponse(trace, { error: "e2e_already_consumed" }, 409);
      }
      currentDefaultE2EConsumed = true;
      try { return await currentDefaultE2E(request, env, trace); }
      catch {
        const stage = !trace.contextValidated ? "context" : !trace.payloadValidated ? "payload"
          : !trace.preprocessingValidated ? "preprocessing" : !trace.handlerInvocationReturned ? "handler" : "response_mapping";
        failE2EGate(trace, stage, "e2e_adapter_exception");
        return e2eGateResponse(trace, { error: "e2e_adapter_exception", accounting: "unknown" }, 500, "audit_exception");
      }
    }
    if (request.method === "POST" && url.pathname === "/experimental-eye-aperture-v2-audit") {
      const runId = request.headers.get("x-primary-audit-run-id");
      if (!validRunId(runId) || runs.has(runId) || runs.size >= 32)
        return Response.json({ error: "invalid_or_duplicate_run_id" }, { status: 409 });
      const state = createAuditState(runId); runs.set(runId, state); markAuditStage(state, "request_entered");
      try {
        const body = await request.json<{ imageDataUrl?: unknown; batchRunId?: unknown; slot?: unknown }>();
        if (typeof body.batchRunId !== "string" || !validRunId(body.batchRunId) || (body.slot !== 0 && body.slot !== 1))
          return Response.json({ error: "invalid_v2_identity", auditState: state }, { status: 400 });
        const slot = body.slot;
        if ((apertureV2NextSlot.get(body.batchRunId) ?? 0) !== slot || !await apertureImageIdentity(body.imageDataUrl, slot))
          return Response.json({ error: "v2_order_or_input_mismatch", auditState: state }, { status: 400 });
        // Reserve before await: no parallel duplicate or second crop before successful first output.
        if ((apertureV2NextSlot.get(body.batchRunId) ?? 0) !== slot)
          return Response.json({ error: "v2_slot_consumed", auditState: state }, { status: 409 });
        apertureV2NextSlot.set(body.batchRunId, -1);
        if (!env.AI || typeof env.AI.run !== "function")
          return Response.json({ error: "missing_audit_binding", auditState: state }, { status: 400 });
        const result = await runExperimentalApertureV2({ ...env, AI: wrapAuditAI(env.AI, state, APERTURE_OPTIONS.model) }, body.imageDataUrl as string, slot);
        state.finalOk = result.shapeValid === true && result.semanticContractValid === true && result.accepted !== null;
        if (slot === 0 && state.finalOk) apertureV2NextSlot.set(body.batchRunId, 1);
        markAuditStage(state, "response_ready");
        return Response.json({ runtime, slot, runId, batchRunId: body.batchRunId, auditState: state, ...result });
      } catch {
        state.finalOk = false; markAuditStage(state, "response_ready");
        return Response.json({ error: "v2_audit_execution_error", auditState: state }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/experimental-eye-aperture-audit") {
      const runId = request.headers.get("x-primary-audit-run-id");
      if (!validRunId(runId) || runs.has(runId) || runs.size >= 32)
        return Response.json({ error: "invalid_or_duplicate_run_id" }, { status: 409 });
      const state = createAuditState(runId); runs.set(runId, state); markAuditStage(state, "request_entered");
      try {
        const body = await request.json<{ imageDataUrl?: unknown; pilotRunId?: unknown; slot?: unknown }>();
        if (typeof body.pilotRunId !== "string" || !validRunId(body.pilotRunId)
          || !Number.isInteger(body.slot) || (body.slot as number) < 0 || (body.slot as number) > 3)
          return Response.json({ error: "invalid_aperture_identity", auditState: state }, { status: 400 });
        const slot = body.slot as number, input = (slot % 2) as 0 | 1;
        const consumed = aperturePilotSlots.get(body.pilotRunId) ?? new Set<number>();
        if (consumed.size !== slot || consumed.has(slot) || !await apertureImageIdentity(body.imageDataUrl, input))
          return Response.json({ error: "aperture_order_or_input_mismatch", auditState: state }, { status: 400 });
        consumed.add(slot); aperturePilotSlots.set(body.pilotRunId, consumed);
        if (!env.AI || typeof env.AI.run !== "function")
          return Response.json({ error: "missing_audit_binding", auditState: state }, { status: 400 });
        const result = await runExperimentalAperture({ ...env, AI: wrapAuditAI(env.AI, state, APERTURE_OPTIONS.model) }, body.imageDataUrl as string, input);
        state.finalOk = result.accepted !== null; markAuditStage(state, "response_ready");
        return Response.json({ runtime, slot, runId, pilotRunId: body.pilotRunId, auditState: state, ...result });
      } catch {
        state.finalOk = false; markAuditStage(state, "response_ready");
        return Response.json({ error: "aperture_audit_execution_error", auditState: state }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/primary-audit-status") {
      const runId = url.searchParams.get("runId");
      if (!validRunId(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
      const state = runs.get(runId);
      return Response.json(state ? { found: true, ...state } : { found: false, runId });
    }
    if (request.method === "POST" && (url.pathname === "/face-geometry-audit"
      || url.pathname === "/face-geometry-direct-audit")) {
      const directInput = url.pathname === "/face-geometry-direct-audit";
      const runId = request.headers.get("x-primary-audit-run-id");
      if (!validRunId(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
      if (runs.has(runId)) return Response.json({ error: "duplicate_run_id" }, { status: 409 });
      if (runs.size >= 32) return Response.json({ error: "audit_capacity" }, { status: 409 });
      const state = createAuditState(runId);
      runs.set(runId, state);
      markAuditStage(state, "request_entered");
      try {
        const body = await request.json<{
          imageDataUrl?: unknown;
          portraitRegion?: PortraitRegion | null;
          cropContext?: AdaptiveHeadCropContext;
        }>();
        if (!isAuditImageDataUrl(body.imageDataUrl)
          || (!directInput && (!body.portraitRegion || typeof body.portraitRegion !== "object"))) {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "invalid_geometry_audit_input" }, { status: 400 });
        }
        if (!env.AI || typeof env.AI.run !== "function") {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "missing_audit_binding" }, { status: 400 });
        }
        const crops = directInput ? null
          : await createIdentityCrops(body.imageDataUrl, body.portraitRegion!, body.cropContext ?? {});
        if (!directInput && (!crops || !crops.diagnostics.quality.usableForFaceGeometry)) {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "production_face_crop_unusable",
            crop: crops?.diagnostics ?? null }, { status: 422 });
        }
        markAuditStage(state, "geometry_started");
        const result = await runFaceIdentityGeometryAnalysis({
          ...env,
          AI: wrapAuditAI(env.AI, state, FACE_GEOMETRY_MODEL),
        }, directInput ? body.imageDataUrl : crops!.faceDataUrl);
        markAuditStage(state, "geometry_completed");
        state.finalOk = result.ok;
        markAuditStage(state, "response_ready");
        return Response.json({
          runtime,
          ok: result.ok,
          elapsedMs: result.elapsedMs,
          auditState: state,
          inputMode: directInput ? "direct_frozen_face_crop" : "production_face_crop",
          crop: crops?.diagnostics ?? null,
          providerShapeValid: result.providerShapeValid,
          errors: result.errors,
          measurements: result.measurements,
          geometry: result.geometry,
          httpStatus: result.httpStatus,
          providerStatus: result.providerStatus,
        });
      } catch (error) {
        state.finalOk = false;
        return Response.json({
          runtime,
          ok: false,
          auditState: state,
          boundaryException: { kind: error instanceof SyntaxError ? "input_json_error" : "geometry_audit_execution_error" },
        }, { status: 500 });
      }
    }
    const structuredV4Audit = url.pathname === "/primary-audit-v4-structured-localization";
    if (request.method !== "POST" || (!structuredV4Audit && url.pathname !== "/primary-audit")) {
      return new Response("not found", { status: 404 });
    }
    const runId = request.headers.get("x-primary-audit-run-id");
    if (!validRunId(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
    if (runs.has(runId)) return Response.json({ error: "duplicate_run_id" }, { status: 409 });
    // Fail closed at capacity rather than silently evicting active evidence.
    if (runs.size >= 32) return Response.json({ error: "audit_capacity" }, { status: 409 });
    const state = createAuditState(runId);
    runs.set(runId, state);
    markAuditStage(state, "request_entered");
    try {
      const body = await request.json<{ imageDataUrl?: unknown }>();
      if (!isAuditImageDataUrl(body.imageDataUrl)) {
        state.finalOk = false;
        return Response.json({ runtime, auditState: state, error: "invalid_audit_input" }, { status: 400 });
      }
      if (!env.AI || typeof env.AI.gateway !== "function" || typeof env.AI.run !== "function") {
        state.finalOk = false;
        return Response.json({ runtime, auditState: state, error: "missing_audit_binding" }, { status: 400 });
      }
      const started = Date.now();
      markAuditStage(state, "primary_started");
      const result = await runPhotoAnalysis({
        ...env,
        AI: wrapAuditAI(env.AI, state, GEMMA_VISION_MODEL),
        FACE_GEOMETRY_ENRICHMENT_ENABLED: "false",
        IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: "false",
        SYNCHRONOUS_ENHANCEMENTS_ENABLED: "false",
      }, body.imageDataUrl, structuredV4Audit
        ? { expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } : undefined);
      markAuditStage(state, "photo_analysis_completed");
      state.finalOk = result.ok;
      markAuditStage(state, "response_ready");
      const common = {
        runtime,
        elapsedMs: Date.now() - started,
        primaryElapsedMs: result.primaryElapsedMs ?? null,
        geminiElapsedMs: [...(result.providerAttempts ?? [])].reverse()
          .find((attempt) => attempt.provider === "gemini" && attempt.outcome !== "started")?.elapsedMs ?? null,
        gemmaElapsedMs: [...(result.providerAttempts ?? [])].reverse()
          .find((attempt) => attempt.provider === "workers_ai" && attempt.model === GEMMA_VISION_MODEL
            && attempt.outcome !== "started")?.elapsedMs ?? null,
        ok: result.ok,
        attempts: result.attempts,
        providerSequence: attemptsOf(result.providerAttempts ?? []),
        auditState: state,
      };
      if (structuredV4Audit) {
        const validation = result.contractValidation ?? null;
        const validatedLocalization = projectProtectedValidatedLocalization({
          primaryOk: result.ok,
          primaryCoreValid: validation?.primaryCoreValid,
          localizationValid: validation?.localizationValid,
          portraitImageIndex: result.ok ? result.analysis.sourceSelection.portraitImageIndex : null,
          portraitRegion: result.ok ? result.analysis.sourceSelection.portraitRegion : null,
          imageCount: 1,
        });
        return Response.json({ ...common,
          expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
          contractValidation: validation,
          localizationTrace: auditLocalizationTrace(result.ok ? result.localizationTrace : undefined),
          validatedLocalization,
          validation: { compactProviderSchema: validation?.providerWireSchemaValid === true ? "passed"
            : validation?.providerWireSchemaValid === false ? "failed" : "unobserved",
          compactStrictRuntime: validation?.primaryCoreValid === true ? "passed"
            : validation?.primaryCoreValid === false ? "failed" : "unobserved",
          richPhotoAnalysis: result.ok ? "passed" : "unobserved" },
          analysis: result.ok ? { quality: result.analysis.quality,
            visibleRegions: { face: result.analysis.visibleRegions.face },
            sourceSelection: { portraitImageIndex: result.analysis.sourceSelection.portraitImageIndex,
              portraitRegion: result.analysis.sourceSelection.portraitRegion ?? null },
            identityCropContext: {
              hairVolume: result.analysis.renderHints.hairVolume,
              hairTexture: result.analysis.renderHints.hairTexture,
              overallHairLength: result.analysis.renderHints.overallHairLength,
              sideHairAsymmetry: result.analysis.renderHints.sideHairAsymmetry,
              headCovering: result.analysis.fallbackFeatures.hat === "headscarf",
            } satisfies AdaptiveHeadCropContext,
            fallbackFeaturesGlasses: result.analysis.fallbackFeatures.glasses,
            faceMeasurementEyeOpenness: result.analysis.faceMeasurementEvidence?.cues.eyeOpenness ?? null } : null,
          failure: result.ok ? null : { reason: result.reason },
        });
      }
      return Response.json(result.ok
        ? { ...common, validation: { compactProviderSchema: "passed", compactStrictRuntime: "passed", richPhotoAnalysis: "passed" },
          localizationTrace: auditLocalizationTrace(result.localizationTrace), analysis: analysisOf(result.analysis) }
        : { ...common, failure: { reason: result.reason } });
    } catch (error) {
      state.finalOk = false;
      return Response.json({
        runtime,
        ok: false,
        auditState: state,
        boundaryException: {
          kind: error instanceof SyntaxError ? "input_json_error" : "audit_execution_error",
        },
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
