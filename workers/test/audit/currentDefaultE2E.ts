// Protected audit adapter only. Production handler, inputs and settings are not replaced.
import productionWorker from "../../src/index";
import type { Env } from "../../src/types";
import { extractAnalysisPayload, classifyPortraitLocalization, validatePhotoAnalysis } from "../../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, normalizeCompactPhotoAnalysisV3,
  validateCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3Provider } from "../../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, adaptGemmaNamedPhotoAnalysis,
  validateGemmaNamedPhotoAnalysis } from "../../src/gemmaPhotoAnalysis";
import { FACE_IDENTITY_GEOMETRY_SCHEMA, parseFaceIdentityGeometry,
  validateFaceGeometryProviderShape } from "../../src/faceIdentityGeometry";
import { base64ToBytes, decodeImage } from "../../src/png";
import { createE2EGateTrace, e2eGateResponse, failE2EGate, type E2EGateTrace } from "./currentDefaultE2EGateTrace";

export const E2E_MARKER = "current-default-v3-e2e-baseline-20260926-001";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : {};
const fields = (value: unknown, names: string[]) => Object.fromEntries(names.filter(name => Object.hasOwn(object(value), name))
  .map(name => [name, object(value)[name]]));
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
// Bounded normalized projection, not a generic raw-provider-response sanitizer.
export function boundedProjection(value: unknown, depth = 0): unknown {
  if (depth > 18) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return /data:|base64|AIza|cfut_|Bearer |https?:\/\/|[A-Za-z0-9+/]{160,}/i.test(value)
    ? "[redacted]" : [...value].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("").slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 512).map(item => boundedProjection(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128)
    .filter(([key]) => !/prompt|portraitEvidence|raw|secret|token|header|base64|dataUrl/i.test(key))
    .map(([key, item]) => [key, boundedProjection(item, depth + 1)]));
  return null;
}
export function analysisProjection(value: unknown) {
  return boundedProjection(fields(value, ["quality", "framing", "visibleRegions", "sourceSelection", "observed",
    "canonicalIdentity", "renderHints", "faceMeasurementEvidence", "fallbackFeatures", "skinPlan"]));
}
export async function imageIdentity(url: string) {
  if (!/^data:image\/(jpeg|png);base64,/.test(url) || url.length > 1_500_000) throw new Error("e2e_image_contract");
  const bytes = base64ToBytes(url.slice(url.indexOf(",") + 1));
  const decoded = await decodeImage(bytes);
  return { bytes: bytes.length, sha256: await digest(bytes), rgbaSha256: await digest(decoded.rgba),
    width: decoded.width, height: decoded.height, dataUrlChars: url.length };
}
function proxy<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy({} as T, { get(_target, key) {
    if (typeof key === "string" && Object.hasOwn(overrides, key)) return overrides[key];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
type Stage = "geminiPrimary" | "gemmaPrimary" | "faceGeometry";
type BindingAttempt = { stage: Stage; started: true; completion: "pending" | "returned" | "threw";
  elapsedMs: number | null; httpStatus: number | null; deadlineMs: number; schemaSha256: string };
const sequenceFields = ["provider", "model", "outcome", "status", "providerStatus", "origin", "elapsedMs",
  "configuredDeadlineMs", "deadlineTimerFired", "providerAttemptKind", "attemptOrdinal", "fallbackEligible",
  "fallbackReason", "providerSchemaValidation", "strictValidation", "responseFormatMode"];

export async function currentDefaultE2E(request: Request, env: Env, trace: E2EGateTrace = createE2EGateTrace()): Promise<Response> {
  const started = Date.now();
  if (request.headers.get("x-current-default-e2e") !== E2E_MARKER) {
    failE2EGate(trace, "marker", "e2e_marker_required");
    return e2eGateResponse(trace, { error: "e2e_marker_required" }, 403);
  }
  // Same left-to-right short circuit as the original OR; record only the first fixed predicate.
  const contextFailure = !env.GEMINI_API_KEY ? "gemini_api_key_missing" : !env.AI ? "ai_binding_missing"
    : typeof env.AI.gateway !== "function" ? "ai_gateway_not_function"
    : env.VISION_MODEL !== "gemini-3.8-flash" ? "vision_model_mismatch"
    : env.WORKERS_VISION_MODEL !== "@cf/google/gemma-4-26b-a4b-it" ? "workers_vision_model_mismatch"
    : env.FACE_GEOMETRY_ENRICHMENT_ENABLED !== "true" ? "face_geometry_flag_mismatch" : null;
  if (contextFailure) {
    failE2EGate(trace, "context", contextFailure);
    return e2eGateResponse(trace, { error: "e2e_production_context_mismatch" }, 409);
  }
  trace.contextValidated = true; trace.sequence++;
  const input = await request.json() as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "analysisImage,image" || typeof input.image !== "string"
    || typeof input.analysisImage !== "string" || !input.image.startsWith("data:image/jpeg;base64,")
    || !input.analysisImage.startsWith("data:image/jpeg;base64,")) {
    failE2EGate(trace, "payload", "e2e_payload_shape");
    return e2eGateResponse(trace, { error: "e2e_payload_shape" }, 400);
  }
  trace.payloadValidated = true; trace.sequence++;
  const analysisInput = await imageIdentity(input.analysisImage);
  const generationInput = await imageIdentity(input.image);
  if (analysisInput.width !== 597 || analysisInput.height !== 896 || generationInput.width !== 299 || generationInput.height !== 448
    || request.headers.get("x-e2e-analysis-sha") !== analysisInput.sha256
    || request.headers.get("x-e2e-generation-sha") !== generationInput.sha256) {
    failE2EGate(trace, "preprocessing", "e2e_preprocessed_input_mismatch");
    return e2eGateResponse(trace, { error: "e2e_preprocessed_input_mismatch" }, 400);
  }
  trace.preprocessingValidated = true; trace.sequence++;

  const attempts: BindingAttempt[] = [];
  const jobs: Promise<void>[] = [];
  const diagnostics: Record<string, unknown> = { primaryValidation: null, normalizedPrimary: null,
    localization: null, primaryDiagnostic: null, geometry: null, primaryElapsedMs: null };
  let firstPrimaryAt: number | null = null;
  const inspect = (stage: Stage, result: unknown) => {
    try {
      const raw = extractAnalysisPayload(result);
      if (stage === "faceGeometry") {
        const shape = validateFaceGeometryProviderShape(raw);
        const errors: string[] = [];
        const geometry = shape.length ? null : parseFaceIdentityGeometry(raw, errors);
        diagnostics.geometry = { providerShapePass: !shape.length, semanticPass: Boolean(geometry),
          errors: [...shape, ...errors].slice(0, 32), acceptedGeometry: geometry ? boundedProjection(geometry) : null };
        return;
      }
      const providerErrors = stage === "gemmaPrimary" ? validateGemmaNamedPhotoAnalysis(raw)
        : validateCompactPhotoAnalysisV3Provider(raw);
      const adapted = stage === "gemmaPrimary" && !providerErrors.length ? adaptGemmaNamedPhotoAnalysis(raw) : null;
      const compact = adapted?.ok ? adapted.compact : raw;
      const strictErrors = providerErrors.length ? [] : validateCompactPhotoAnalysisV3(compact, { imageCount: 1 });
      const normalized = providerErrors.length || strictErrors.length ? null
        : normalizeCompactPhotoAnalysisV3(compact, { imageCount: 1 });
      const rich = normalized?.ok ? validatePhotoAnalysis(normalized.analysis) : null;
      diagnostics.primaryValidation = { providerShapePass: !providerErrors.length, providerErrors,
        strictRuntimePass: !providerErrors.length && !strictErrors.length, strictErrors,
        normalizationPass: normalized?.ok ?? false, richValidationPass: rich?.ok ?? false };
      if (normalized?.ok) {
        diagnostics.normalizedPrimary = analysisProjection(normalized.analysis);
        diagnostics.localization = boundedProjection(classifyPortraitLocalization(normalized.analysis.sourceSelection.portraitEvidence));
      }
    } catch { diagnostics[stage === "faceGeometry" ? "geometry" : "primaryValidation"] = { diagnostic: "inspection_unavailable" }; }
  };
  const dispatch = async (stage: Stage, target: object, fn: unknown, args: unknown[], schema: unknown) => {
    if (typeof fn !== "function") {
      failE2EGate(trace, "provider_guard", "e2e_binding_method_unavailable");
      throw new Error("e2e_binding_method_unavailable");
    }
    if (attempts.some(item => item.stage === stage)) {
      failE2EGate(trace, "provider_guard", "e2e_provider_budget_exceeded");
      throw new Error("e2e_provider_budget_exceeded");
    }
    trace.providerAttemptIntent++; trace.sequence++;
    trace.firstProviderIntentSequence ||= trace.sequence;
    const at = Date.now();
    if (stage !== "faceGeometry") firstPrimaryAt ??= at;
    const entry: BindingAttempt = { stage, started: true, completion: "pending", elapsedMs: null,
      httpStatus: null, deadlineMs: stage === "faceGeometry" ? 25_000 : 45_000,
      schemaSha256: await digest(new TextEncoder().encode(JSON.stringify(schema))) };
    attempts.push(entry);
    try {
      // Callback invocation observation, not proof of remote HTTP completion/acceptance.
      trace.providerAttemptStarted++; trace.providerDispatchObserved = true; trace.sequence++;
      trace.firstProviderStartedSequence ||= trace.sequence;
      const result: unknown = await Reflect.apply(fn, target, args);
      entry.completion = "returned"; entry.elapsedMs = Date.now() - at;
      if (result instanceof Response) {
        entry.httpStatus = result.status;
        if (result.ok) {
          jobs.push(result.clone().json().then((body: unknown) => {
            const candidates = object(body).candidates;
            const candidate = Array.isArray(candidates) ? object(candidates[0]) : {};
            const parts = object(candidate.content).parts;
            const text = Array.isArray(parts) ? parts.map(part => object(part).text ?? "").join("") : "";
            inspect(stage, { response: text });
          }).catch(() => {}));
        }
      } else inspect(stage, result);
      return result;
    } catch (error) { entry.completion = "threw"; entry.elapsedMs = Date.now() - at; throw error; }
  };
  const ai = env.AI!; // The unchanged context guard above already returned if this binding was absent.
  const instrumentedAI = proxy(ai, {
    gateway: (...args: Parameters<typeof ai.gateway>) => {
      const gateway = ai.gateway(...args);
      return proxy(gateway, { run: (...runArgs: unknown[]) => {
        const requestBody = object(runArgs[0]);
        const schema = object(object(requestBody.query).generationConfig).responseJsonSchema;
        if (requestBody.endpoint !== "v1beta/models/gemini-3.8-flash:generateContent"
          || JSON.stringify(schema) !== JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)) {
          failE2EGate(trace, "provider_guard", "e2e_non_v3_gateway_blocked");
          throw new Error("e2e_non_v3_gateway_blocked");
        }
        return dispatch("geminiPrimary", gateway, gateway.run, runArgs, schema);
      } });
    },
    run: async (...args: unknown[]) => {
      const schema = object(object(object(args[1]).response_format).json_schema).schema;
      const geometry = JSON.stringify(schema) === JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA);
      if (args[0] !== env.WORKERS_VISION_MODEL || (!geometry
        && JSON.stringify(schema) !== JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA))) {
        failE2EGate(trace, "provider_guard", "e2e_non_v3_native_blocked");
        throw new Error("e2e_non_v3_native_blocked");
      }
      if (geometry) {
        const messages = object(args[1]).messages;
        const content = Array.isArray(messages) ? object(messages[0]).content : null;
        const image = Array.isArray(content) ? content.find(part => object(part).type === "image_url") : null;
        const url = object(object(image).image_url).url;
        if (typeof url !== "string") {
          failE2EGate(trace, "provider_guard", "e2e_geometry_image_missing");
          throw new Error("e2e_geometry_image_missing");
        }
        diagnostics.geometryInput = await imageIdentity(url);
      }
      return dispatch(geometry ? "faceGeometry" : "gemmaPrimary", ai, ai.run, args, schema);
    },
  });
  const kv = env.MCSKIN_KV;
  const instrumentedKV = proxy(kv, { put: (...args: Parameters<typeof kv.put>) => {
    if (args[0] === "diagnostic:last-primary-analysis" && typeof args[1] === "string") {
      try {
        const value = object(JSON.parse(args[1]));
        diagnostics.primaryDiagnostic = { ok: value.ok, attempts: value.attempts, reason: value.reason ?? null,
          providerAttempts: Array.isArray(value.providerAttempts)
            ? value.providerAttempts.map(item => boundedProjection(fields(item, sequenceFields))) : [] };
        diagnostics.primaryElapsedMs = firstPrimaryAt === null ? null : Date.now() - firstPrimaryAt;
      } catch { /* Passive observation must not alter production KV behavior. */ }
    }
    return kv.put(...args);
  } });
  const productionRequest = new Request("https://internal.invalid/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  trace.handlerInvocationStarted = true; trace.handlerStartSequence = ++trace.sequence;
  const response = await productionWorker.fetch(productionRequest, { ...env, AI: instrumentedAI, MCSKIN_KV: instrumentedKV });
  trace.handlerInvocationReturned = true; trace.sequence++;
  if (response.status >= 400) failE2EGate(trace, "handler_response", "production_handler_http_error");
  const body = object(await response.json());
  await Promise.all(jobs);
  return e2eGateResponse(trace, { marker: E2E_MARKER, productionStatus: response.status, elapsedMs: Date.now() - started,
    contract: "primary_compact_v3_legacy_suffix", inputs: { analysis: analysisInput, generation: generationInput },
    bindingAttempts: attempts, diagnostics: boundedProjection(diagnostics), ok: body.ok === true, errorCode: boundedProjection(body.errorCode),
    quality: boundedProjection(body.quality), generationMode: boundedProjection(body.generationMode),
    features: boundedProjection(body.features), analysis: analysisProjection(body.analysis),
    // Only final generated PNG is intentionally transported; caller removes it before JSON persistence.
    skinPngBase64: typeof body.skinPngBase64 === "string" ? body.skinPngBase64 : null,
  }, response.status, "production_handler");
}
