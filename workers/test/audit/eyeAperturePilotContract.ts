/** Protected audit only. The production entry point never imports this module. */
import { extractAnalysisPayload } from "../../src/analysis";
import { validateV4Shape } from "../../src/compactPhotoAnalysisV4";
import { generateWorkersAiStructuredJson, geminiProviderErrorDiagnostic, workersAiStructuredInput, type GeminiStructuredRequest } from "../../src/gemini";
import type { Env } from "../../src/types";
import { buildEyeAperturePrototypeRequest, EYE_APERTURE_SCHEMA, validateEyeApertureObservation } from "./eyeAperturePrototype";

export const APERTURE_INPUTS = [
  { widthPx: 185, heightPx: 192, bytes: 92486, sha256: "26be2fb184d5497fa19ec5be826df248c53807db399408f5fa559f836adffab1" },
  { widthPx: 320, heightPx: 344, bytes: 250052, sha256: "e67afbb8d0a9fa9b1eca6741a82f56f94e976492bab5a29b34bea939923a95a2" },
] as const;
export const APERTURE_OPTIONS = {
  model: "@cf/google/gemma-4-26b-a4b-it", maxOutputTokens: 4096, configuredDeadlineMs: 25000,
  reasoning: false, temperature: "omitted", seed: "omitted", retry: 0, fallback: false,
  cacheOptions: "omitted_native_binding", cacheHit: null,
} as const;

export function aperturePilotRequest(imageDataUrl: string, input: 0 | 1): GeminiStructuredRequest {
  const dimensions = APERTURE_INPUTS[input];
  const built = buildEyeAperturePrototypeRequest(imageDataUrl, dimensions.widthPx, dimensions.heightPx);
  if (built.model !== APERTURE_OPTIONS.model) throw new Error("aperture_model_drift");
  return { model: built.model, prompt: built.prompt, responseSchema: built.responseSchema,
    imageDataUrls: built.imageDataUrls, maxOutputTokens: APERTURE_OPTIONS.maxOutputTokens,
    timeoutCapMs: APERTURE_OPTIONS.configuredDeadlineMs, allowWorkersAiFallback: false };
}

export function apertureShapeErrors(raw: unknown): string[] {
  return validateV4Shape(EYE_APERTURE_SCHEMA, raw, true)
    .map(error => error.replace(/^compact/, "eyeAperture"))
    .map(error => /^eyeAperture(?:\.[A-Za-z0-9_]+)*:[A-Za-z0-9_]+$/.test(error) ? error : "eyeAperture:invalid_shape_path");
}

export async function apertureRequestIdentity(imageDataUrl: string, input: 0 | 1) {
  const request = aperturePilotRequest(imageDataUrl, input);
  const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map(v => v.toString(16).padStart(2, "0")).join("");
  return { promptSha256: await hash(request.prompt), schemaSha256: await hash(JSON.stringify(request.responseSchema)),
    wireSha256: await hash(JSON.stringify(workersAiStructuredInput(request, APERTURE_OPTIONS.model))) };
}

/** Check exact input bytes in the protected endpoint; no decoding or transformation. */
export async function apertureImageIdentity(dataUrl: unknown, input: 0 | 1): Promise<boolean> {
  if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return false;
  try {
    const raw = atob(dataUrl.slice("data:image/png;base64,".length));
    const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    const expected = APERTURE_INPUTS[input];
    if (bytes.length !== expected.bytes || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return false;
    const header = new DataView(bytes.buffer);
    if (header.getUint32(16) !== expected.widthPx || header.getUint32(20) !== expected.heightPx) return false;
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
    return digest === expected.sha256;
  } catch { return false; }
}

export async function runExperimentalAperture(env: Env, imageDataUrl: string, input: 0 | 1) {
  const started = Date.now();
  const requestIdentity = await apertureRequestIdentity(imageDataUrl, input);
  try {
    const response = await generateWorkersAiStructuredJson({ ...env, WORKERS_VISION_MODEL: APERTURE_OPTIONS.model }, aperturePilotRequest(imageDataUrl, input));
    const raw = extractAnalysisPayload(response);
    const shapeErrors = apertureShapeErrors(raw);
    const semantic = shapeErrors.length ? null : validateEyeApertureObservation(raw, APERTURE_INPUTS[input]);
    return { requestIdentity, providerOutcome: "returned" as const, providerHttpStatus: null, providerStatus: "binding_returned",
      elapsedMs: Date.now() - started, requestRejected: false,
      providerShapeValid: shapeErrors.length === 0, shapeErrors,
      semanticValid: semantic?.ok === true, semanticErrors: semantic?.errors ?? [],
      accepted: semantic?.ok ? structuredClone(semantic.value) : null,
      cacheHit: null, independentInferenceConfirmed: false };
  } catch (error) {
    const diagnostic = geminiProviderErrorDiagnostic(error);
    const knownStatus = diagnostic.providerStatus && /^[A-Z0-9_]{1,64}$/.test(diagnostic.providerStatus)
      ? diagnostic.providerStatus : null;
    const requestRejected = diagnostic.httpStatus === 400 || knownStatus === "INVALID_ARGUMENT"
      || /(?:unsupported|not supported|invalid).{0,30}(?:schema|response.format)|(?:schema|response.format).{0,30}(?:unsupported|not supported|invalid)/i.test(diagnostic.message ?? "");
    return { requestIdentity, providerOutcome: "failed" as const, providerHttpStatus: diagnostic.httpStatus,
      providerStatus: knownStatus, elapsedMs: Date.now() - started, requestRejected,
      providerShapeValid: null, shapeErrors: [] as string[], semanticValid: null, semanticErrors: [] as string[],
      accepted: null, cacheHit: null, independentInferenceConfirmed: false };
  }
}
