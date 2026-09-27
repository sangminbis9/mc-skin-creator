// Audit-only fixed observations. No environment values, messages, input or provider bodies.
export const E2E_GATE_CODES = ["none", "invalid_e2e_marker_or_run_id", "e2e_already_consumed", "e2e_marker_required",
  "gemini_api_key_missing", "ai_binding_missing", "ai_gateway_not_function", "vision_model_mismatch",
  "workers_vision_model_mismatch", "face_geometry_flag_mismatch", "e2e_payload_shape", "e2e_preprocessed_input_mismatch",
  "e2e_binding_method_unavailable", "e2e_provider_budget_exceeded", "e2e_non_v3_gateway_blocked",
  "e2e_non_v3_native_blocked", "e2e_geometry_image_missing", "e2e_adapter_exception", "production_handler_http_error"] as const;
const stages = ["none", "selector", "consumed", "marker", "context", "payload", "preprocessing",
  "handler", "provider_guard", "handler_response", "response_mapping"] as const;
export type E2EGateTrace = {
  traceVersion: 1; routeEntered: boolean; selectorValidated: boolean; contextValidated: boolean;
  payloadValidated: boolean; preprocessingValidated: boolean; handlerInvocationStarted: boolean;
  handlerInvocationReturned: boolean; providerDispatchObserved: boolean; responseFinalized: boolean;
  failureStage: typeof stages[number]; failureCode: typeof E2E_GATE_CODES[number];
  responseOrigin: "unobserved" | "audit_gate" | "production_handler" | "audit_exception";
  responseStatus: number | null; providerAttemptIntent: number; providerAttemptStarted: number;
  handlerStartSequence: number; firstProviderIntentSequence: number; firstProviderStartedSequence: number;
  sequence: number;
};
export function createE2EGateTrace(): E2EGateTrace {
  return { traceVersion: 1, routeEntered: true, selectorValidated: false, contextValidated: false,
    payloadValidated: false, preprocessingValidated: false, handlerInvocationStarted: false,
    handlerInvocationReturned: false, providerDispatchObserved: false, responseFinalized: false,
    failureStage: "none", failureCode: "none", responseOrigin: "unobserved", responseStatus: null,
    providerAttemptIntent: 0, providerAttemptStarted: 0, handlerStartSequence: 0,
    firstProviderIntentSequence: 0, firstProviderStartedSequence: 0, sequence: 1 };
}
export function failE2EGate(trace: E2EGateTrace, stage: E2EGateTrace["failureStage"], code: E2EGateTrace["failureCode"]) {
  if (trace.failureCode === "none") { trace.failureStage = stage; trace.failureCode = code; }
}
export function e2eGateResponse(trace: E2EGateTrace, body: Record<string, unknown>, status: number,
  origin: E2EGateTrace["responseOrigin"] = "audit_gate") {
  trace.responseOrigin = origin; trace.responseStatus = status; trace.responseFinalized = true; trace.sequence++;
  return Response.json({ ...body, e2eGateTrace: { ...trace } }, { status });
}
// Project only known primitive fields. Reject malformed or inconsistent evidence rather than inventing zero.
export function projectE2EGateTrace(value: unknown, httpStatus: number): E2EGateTrace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result = createE2EGateTrace();
  for (const key of Object.keys(result) as (keyof E2EGateTrace)[]) {
    const v = input[key];
    if (key === "responseStatus") { if (v !== httpStatus) return null; }
    else if (typeof result[key] === "boolean") { if (typeof v !== "boolean") return null; }
    else if (typeof result[key] === "number") { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 64) return null; }
    else if (typeof v !== "string") return null;
  }
  if (input.traceVersion !== 1 || !E2E_GATE_CODES.includes(input.failureCode as E2EGateTrace["failureCode"])
    || !stages.includes(input.failureStage as E2EGateTrace["failureStage"])
    || !["audit_gate", "production_handler", "audit_exception"].includes(String(input.responseOrigin))) return null;
  Object.assign(result, Object.fromEntries(Object.keys(result).map(key => [key, input[key]])));
  if (!result.routeEntered || !result.responseFinalized || result.providerAttemptStarted > result.providerAttemptIntent
    || result.providerAttemptIntent > 3 || result.providerDispatchObserved !== (result.providerAttemptStarted > 0)
    || (result.handlerInvocationReturned && !result.handlerInvocationStarted)
    || (result.providerAttemptIntent > 0 && !result.handlerInvocationStarted)
    || (result.handlerInvocationStarted && (!result.selectorValidated || !result.contextValidated
      || !result.payloadValidated || !result.preprocessingValidated))) return null;
  if (result.handlerInvocationStarted !== (result.handlerStartSequence > 0)
    || (result.providerAttemptIntent > 0) !== (result.firstProviderIntentSequence > 0)
    || (result.providerAttemptStarted > 0) !== (result.firstProviderStartedSequence > 0)
    || result.handlerStartSequence >= result.sequence || result.firstProviderIntentSequence >= result.sequence
    || result.firstProviderStartedSequence >= result.sequence
    || (result.providerAttemptIntent > 0 && result.firstProviderIntentSequence <= result.handlerStartSequence)
    || (result.providerAttemptStarted > 0 && result.firstProviderStartedSequence <= result.firstProviderIntentSequence)) return null;
  return result;
}
export function classifyE2E409(trace: E2EGateTrace | null): string {
  if (!trace || trace.responseStatus !== 409) return "UNKNOWN_409_BOUNDARY";
  if (trace.providerAttemptStarted > 0) return "POST_DISPATCH_E2E_GATE_FAILURE";
  if (trace.providerAttemptIntent > 0) return "UNKNOWN_409_BOUNDARY";
  return "PRE_PROVIDER_E2E_GATE_FAILURE";
}
