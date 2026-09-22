import { runPhotoAnalysis, type PhotoAnalysis, type PortraitRegion } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { FACE_GEOMETRY_MODEL, runFaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { resolveFaceMeasurements } from "../src/faceMeasurementEvidence";
import { createIdentityCrops } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import type { Env } from "../src/types";
import { GEMMA_VISION_MODEL } from "../src/gemmaPhotoAnalysis";
import { createAuditState, markAuditStage, validRunId, wrapAuditAI, type AuditRunState } from "./primaryAuditLifecycle";

type AuditEnv = Env & { PRIMARY_AUDIT_TOKEN?: string };
// Isolate-local, best-effort observability, not a durable inference ledger.
const runs = new Map<string, AuditRunState>();
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

function attemptsOf(attempts: NonNullable<Awaited<ReturnType<typeof runPhotoAnalysis>>["providerAttempts"]>) {
  return attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    outcome: attempt.outcome,
    responseFormatMode: attempt.responseFormatMode ?? null,
    providerSchemaValidation: attempt.providerSchemaValidation ?? null,
    strictValidation: attempt.strictValidation ?? null,
    httpStatus: attempt.status ?? null,
    providerStatus: attempt.providerStatus ?? null,
    fallbackEligible: attempt.fallbackEligible ?? null,
    fallbackReason: attempt.fallbackReason ?? null,
    dailyQuotaExhausted: attempt.dailyQuotaExhausted ?? false,
  }));
}

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
    if (request.method === "GET" && url.pathname === "/primary-audit-status") {
      const runId = url.searchParams.get("runId");
      if (!validRunId(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
      const state = runs.get(runId);
      return Response.json(state ? { found: true, ...state } : { found: false, runId });
    }
    if (request.method === "POST" && url.pathname === "/face-geometry-audit") {
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
        if (typeof body.imageDataUrl !== "string" || !body.imageDataUrl.startsWith("data:image/jpeg;base64,")
          || !body.portraitRegion || typeof body.portraitRegion !== "object") {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "invalid_geometry_audit_input" }, { status: 400 });
        }
        if (!env.AI || typeof env.AI.run !== "function") {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "missing_audit_binding" }, { status: 400 });
        }
        const crops = await createIdentityCrops(body.imageDataUrl, body.portraitRegion, body.cropContext ?? {});
        if (!crops || !crops.diagnostics.quality.usableForFaceGeometry) {
          state.finalOk = false;
          return Response.json({ runtime, auditState: state, error: "production_face_crop_unusable",
            crop: crops?.diagnostics ?? null }, { status: 422 });
        }
        markAuditStage(state, "geometry_started");
        const result = await runFaceIdentityGeometryAnalysis({
          ...env,
          AI: wrapAuditAI(env.AI, state, FACE_GEOMETRY_MODEL),
        }, crops.faceDataUrl);
        markAuditStage(state, "geometry_completed");
        state.finalOk = result.ok;
        markAuditStage(state, "response_ready");
        return Response.json({
          runtime,
          ok: result.ok,
          elapsedMs: result.elapsedMs,
          auditState: state,
          crop: crops.diagnostics,
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
    if (request.method !== "POST" || url.pathname !== "/primary-audit") return new Response("not found", { status: 404 });
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
      if (typeof body.imageDataUrl !== "string" || !body.imageDataUrl.startsWith("data:image/jpeg;base64,")) {
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
      }, body.imageDataUrl);
      markAuditStage(state, "photo_analysis_completed");
      state.finalOk = result.ok;
      markAuditStage(state, "response_ready");
      const common = {
        runtime,
        elapsedMs: Date.now() - started,
        ok: result.ok,
        attempts: result.attempts,
        providerSequence: attemptsOf(result.providerAttempts ?? []),
        auditState: state,
      };
      return Response.json(result.ok
        ? { ...common, validation: { compactProviderSchema: "passed", compactStrictRuntime: "passed", richPhotoAnalysis: "passed" }, analysis: analysisOf(result.analysis) }
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
