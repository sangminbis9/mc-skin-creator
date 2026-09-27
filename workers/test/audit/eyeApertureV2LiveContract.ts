/** Protected audit adapter only; not imported by production. V2 prototype stays immutable. */
import { extractAnalysisPayload } from "../../src/analysis";
import { generateWorkersAiStructuredJson, geminiProviderErrorDiagnostic, workersAiStructuredInput,
  type GeminiStructuredRequest, type StructuredProviderAttempt } from "../../src/gemini";
import type { Env } from "../../src/types";
import { APERTURE_INPUTS, APERTURE_OPTIONS } from "./eyeAperturePilotContract";
import { buildEyeApertureV2Request, EYE_APERTURE_V2_SCHEMA, EYE_APERTURE_V2_VERSION,
  eyeApertureV2ShapeErrors, validateEyeApertureV2, type EyeApertureV2Observation, type AcceptedEyeApertureV2 } from "./eyeApertureV2Prototype";

export const APERTURE_V2_OPTIONS = { ...APERTURE_OPTIONS, postWatchdogMs: 60000 } as const;
export function apertureV2Request(imageDataUrl: string, input: 0 | 1): GeminiStructuredRequest {
  const built = buildEyeApertureV2Request(imageDataUrl, APERTURE_INPUTS[input]);
  if (built.model !== APERTURE_V2_OPTIONS.model) throw new Error("aperture_v2_model_drift");
  return { model: built.model, prompt: built.prompt, responseSchema: built.responseSchema, imageDataUrls: built.imageDataUrls,
    maxOutputTokens: APERTURE_V2_OPTIONS.maxOutputTokens, timeoutCapMs: APERTURE_V2_OPTIONS.configuredDeadlineMs,
    allowWorkersAiFallback: false };
}
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map(v => v.toString(16).padStart(2, "0")).join("");
export async function apertureV2RequestIdentity(imageDataUrl: string, input: 0 | 1) {
  const r = apertureV2Request(imageDataUrl, input);
  return { promptSha256: await sha(r.prompt), schemaSha256: await sha(JSON.stringify(r.responseSchema)),
    wireSha256: await sha(JSON.stringify(workersAiStructuredInput(r, APERTURE_V2_OPTIONS.model))) };
}
// Only schema-defined paths and fixed validator reasons may leave the endpoint.
const allowedPaths = new Set<string>();
function collect(schema: typeof EYE_APERTURE_V2_SCHEMA, path: string) {
  allowedPaths.add(path);
  for (const [key, child] of Object.entries(schema.properties ?? {})) collect(child, `${path}.${key}`);
}
collect(EYE_APERTURE_V2_SCHEMA, "eyeApertureV2");
allowedPaths.add("eyeApertureV2.crop");
const reasons = new Set(["type", "range", "enum", "required", "additional", "invalid_caller_dimensions", "request_mismatch",
  "corner_order", "viewer_left_right_order", "unknown_requires_null_and_zero_confidence", "observed_requires_landmarks",
  "incomplete_or_nonfinite", "corner_range", "invalid_chord_width", "lid_outside_image", "nonpositive_or_nonfinite_gap", "invalid_ratio"]);
export function safeV2Errors(errors: unknown): string[] {
  return Array.isArray(errors) ? errors.map(error => {
    if (typeof error !== "string") return "eyeApertureV2:unclassified_validation_error";
    const [p, reason, extra] = error.split(":");
    return !extra && allowedPaths.has(p) && reasons.has(reason) ? error : "eyeApertureV2:unclassified_validation_error";
  }) : [];
}
/** Reuse actual validator; copy only accepted observation fields, not synthetic provenance tags. */
export function acceptedV2Observation(raw: unknown, input: 0 | 1): EyeApertureV2Observation | null {
  const checked = validateEyeApertureV2(raw, APERTURE_INPUTS[input]);
  if (!checked.ok) return null;
  const a = checked.accepted;
  const eye = (side: "left" | "right") => {
    const e = a[side];
    return { visibility: e.visibility, outerCorner: { ...e.outerCorner }, innerCorner: { ...e.innerCorner },
      upperLidOffsetPx: e.upperLidOffsetPx, lowerLidOffsetPx: e.lowerLidOffsetPx, confidence: e.confidence };
  };
  return { version: EYE_APERTURE_V2_VERSION, cropWidthPx: a.cropWidthPx, cropHeightPx: a.cropHeightPx,
    pose: a.pose, left: eye("left"), right: eye("right") };
}
export function v2Measurements(raw: EyeApertureV2Observation, input: 0 | 1) {
  const checked = validateEyeApertureV2(raw, APERTURE_INPUTS[input]);
  if (!checked.ok) throw new Error("aperture_v2_accepted_revalidation_failed");
  // Origin is attached by the execution owner, not fabricated by the pure prototype.
  const { providerOrigin: _origin, executionMode: _mode, ...numeric } = checked.accepted;
  void _origin; void _mode;
  return numeric;
}
export type V2Measurements = Omit<AcceptedEyeApertureV2, "providerOrigin" | "executionMode">;
export function safeV2Trace(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  return { outcome: ["started", "completed", "failed"].includes(String(a.outcome)) ? String(a.outcome) : "unknown",
    origin: ["LOCAL_DEADLINE", "BINDING_REJECTION", "OUTER_ABORT", "UNKNOWN"].includes(String(a.origin)) ? String(a.origin) : null,
    elapsedMs: typeof a.elapsedMs === "number" && Number.isFinite(a.elapsedMs) ? a.elapsedMs : null,
    configuredDeadlineMs: typeof a.configuredDeadlineMs === "number" && Number.isFinite(a.configuredDeadlineMs) ? a.configuredDeadlineMs : null,
    deadlineTimerFired: typeof a.deadlineTimerFired === "boolean" ? a.deadlineTimerFired : null };
}

export async function runExperimentalApertureV2(env: Env, image: string, input: 0 | 1) {
  const started = Date.now(), requestIdentity = await apertureV2RequestIdentity(image, input);
  let trace: Pick<StructuredProviderAttempt, "outcome" | "origin" | "elapsedMs" | "configuredDeadlineMs" | "deadlineTimerFired"> | null = null;
  const request = apertureV2Request(image, input);
  request.onProviderAttempt = a => { trace = { outcome: a.outcome, origin: a.origin,
    elapsedMs: a.elapsedMs, configuredDeadlineMs: a.configuredDeadlineMs, deadlineTimerFired: a.deadlineTimerFired }; };
  let response: unknown;
  try {
    response = await generateWorkersAiStructuredJson({ ...env, WORKERS_VISION_MODEL: APERTURE_V2_OPTIONS.model }, request);
  } catch (error) {
    const d = geminiProviderErrorDiagnostic(error);
    return { requestIdentity, providerOutcome: "failed" as const, providerHttpStatus: null,
      diagnosticStatus: d.httpStatus, providerStatus: d.providerStatus && /^[A-Z0-9_]{1,64}$/.test(d.providerStatus) ? d.providerStatus : null,
      elapsedMs: Date.now() - started, trace: safeV2Trace(trace), shapeValid: null, semanticContractValid: null,
      shapeErrors: [] as string[], semanticErrors: [] as string[], accepted: null as EyeApertureV2Observation | null };
  }
  let raw: unknown;
  try { raw = extractAnalysisPayload(response); }
  catch { raw = null; }
  const shapeErrors = safeV2Errors(eyeApertureV2ShapeErrors(raw));
  const semantic = shapeErrors.length ? null : validateEyeApertureV2(raw, APERTURE_INPUTS[input]);
  return { requestIdentity, providerOutcome: "returned" as const, providerHttpStatus: null, diagnosticStatus: null,
    providerStatus: "binding_returned", elapsedMs: Date.now() - started, trace: safeV2Trace(trace),
    shapeValid: shapeErrors.length === 0, semanticContractValid: semantic?.ok === true,
    shapeErrors, semanticErrors: safeV2Errors(semantic?.errors ?? []),
    accepted: semantic?.ok ? acceptedV2Observation(raw, input) : null };
}
