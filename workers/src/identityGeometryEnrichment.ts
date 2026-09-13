import { extractAnalysisPayload } from "./analysis";
import type { CompactV3Schema } from "./compactPhotoAnalysisV3";
import { DIRECT_LOWER_FACE_SCHEMA, DIRECT_CONTOUR_FIELDS, directBoundaryUsable, parseDirectLowerFaceContour, type DirectLowerFaceContour } from "./directFaceContour";
import { generateWorkersAiStructuredJson, geminiProviderErrorDiagnostic, type GeminiStructuredRequest } from "./gemini";
import { IDENTITY_GEOMETRY_WIRE_SCHEMA, IDENTITY_GEOMETRY_PROMPT, normalizeIdentityGeometryWireResponse, parseIdentityGeometry, applyCropVisibility, type GeometryCropVisibility, type IdentityGeometryAnalysis } from "./identityGeometry";
import type { Env } from "./types";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";

export const GEOMETRY_ENRICHMENT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
// Conservative upper budget until measured latency supports activation. Never
// changes the primary provider's deadlines (90s combined primary + <=25s here).
export const GEOMETRY_ENRICHMENT_TIMEOUT_MS = 25_000;
export const GEMMA_IDENTITY_GEOMETRY_SCHEMA = {
  ...IDENTITY_GEOMETRY_WIRE_SCHEMA,
  properties: { ...IDENTITY_GEOMETRY_WIRE_SCHEMA.properties, directLowerFaceContour: DIRECT_LOWER_FACE_SCHEMA },
  required: [...IDENTITY_GEOMETRY_WIRE_SCHEMA.required, "directLowerFaceContour"],
} as const;
export const GEMMA_IDENTITY_GEOMETRY_PROMPT = IDENTITY_GEOMETRY_PROMPT + `
DIRECT LOWER FACE: directLowerFaceContour uses ONLY the TIGHT FACE crop specified in the coordinate contract above (left=0, top=0, right=1, bottom=1). Measure paired visible skin boundaries independently, not semantic face-shape labels.
cheek: outer cheek boundaries on the clearly visible lower-mid-face row.
jaw: mandibular side boundaries on a lower row, below the cheek row.
chin: visible lower-face boundaries near the chin tip, below the jaw row.
Each returns left/right/y/evidence/confidence. Width is derived by code, never predict a width or fixed jaw/cheek ratio. Boundaries must lie inside face.visibleLeft/visibleRight and face.foreheadY/chinY. Do not invent a hidden side by symmetry, hair silhouette, demographic guesses or faceShape labels. If evidence is unknown, left/right/y must be null and confidence must be exactly 0. Inferred is only a locally visible but uncertain edge, not a reconstructed hidden contour. Clipped/occluded chin is unknown; visible cheek/jaw remain independent. Because cheek, jaw and chin are different rows, do not force their widths to decrease monotonically: equal or slightly wider lower rows are valid only when both visible boundaries directly support them. If an outward step contradicts the locally visible outline, report unknown instead of forcing it. Preserve genuine observed asymmetry. Return every schema field; no prose.`;

/** This exact subset is the full grammar used by this schema. Diagnostics have paths only. */
export function validateGeometryProviderShape(raw: unknown): string[] {
  const errors: string[] = [];
  function visit(schema: CompactV3Schema, value: unknown, path: string) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(kind)) { errors.push(`${path}:type`); return; }
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) errors.push(`${path}:range`);
    if (Array.isArray(value)) {
      if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${path}:length`);
      if (schema.items) value.forEach((item, i) => visit(schema.items!, item, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}:required`);
      for (const [key, item] of Object.entries(obj)) {
        if (schema.properties?.[key]) visit(schema.properties[key], item, `${path}.${key}`);
        else if (schema.additionalProperties === false) errors.push(`${path}:additionalProperty`);
      }
    }
  }
  visit(GEMMA_IDENTITY_GEOMETRY_SCHEMA, raw, "geometry");
  return errors;
}

export function geometryEnrichmentRequest(faceDataUrl: string, headDataUrl: string): GeminiStructuredRequest {
  return { model: GEOMETRY_ENRICHMENT_MODEL, imageDataUrls: [faceDataUrl, headDataUrl],
    prompt: GEMMA_IDENTITY_GEOMETRY_PROMPT, responseSchema: GEMMA_IDENTITY_GEOMETRY_SCHEMA,
    maxOutputTokens: 4096, timeoutCapMs: GEOMETRY_ENRICHMENT_TIMEOUT_MS, allowWorkersAiFallback: false };
}
export type GeometryEnrichmentResult = { ok: boolean; geometry?: IdentityGeometryAnalysis; measuredContour?: DirectLowerFaceContour; elapsedMs: number; neuronsSpent: number; errors: string[]; providerStatus?: string | null; httpStatus?: number | null };

/** Exactly one native Workers AI call. All failure paths leave primary intact. */
export async function runIdentityGeometryEnrichment(env: Env, faceDataUrl: string, headDataUrl: string, crop?: GeometryCropVisibility): Promise<GeometryEnrichmentResult> {
  const started = Date.now();
  let neuronsSpent = 0;
  try {
    neuronsSpent = NEURONS_VISION_DETAIL_ESTIMATE;
    const result = await generateWorkersAiStructuredJson({ ...env, WORKERS_VISION_MODEL: GEOMETRY_ENRICHMENT_MODEL }, geometryEnrichmentRequest(faceDataUrl, headDataUrl));
    neuronsSpent = visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
    const raw = extractAnalysisPayload(result);
    const errors = validateGeometryProviderShape(raw);
    if (errors.length || !raw) return { ok: false, elapsedMs: Date.now() - started, neuronsSpent, errors };
    // Safe numeric/enum-only diagnostic, validated against the exact schema
    // above; not a usable geometry until semantic/crop validation below passes.
    const measuredContour = raw.directLowerFaceContour as DirectLowerFaceContour;
    if (!parseDirectLowerFaceContour(measuredContour, raw.face as IdentityGeometryAnalysis["face"], errors)) {
      return { ok: false, measuredContour, elapsedMs: Date.now() - started, neuronsSpent, errors };
    }
    const normalized = normalizeIdentityGeometryWireResponse(raw, crop);
    const parsed = normalized && parseIdentityGeometry(normalized);
    const geometry = parsed && applyCropVisibility(parsed, crop);
    if (!geometry) return { ok: false, measuredContour, elapsedMs: Date.now() - started, neuronsSpent, errors: ["geometry:semantic_validation"] };
    if (!geometry.directLowerFaceContour || !DIRECT_CONTOUR_FIELDS.some(field => directBoundaryUsable(geometry.directLowerFaceContour?.[field]))) {
      return { ok: false, measuredContour, elapsedMs: Date.now() - started, neuronsSpent, errors: ["geometry.directLowerFaceContour:no_usable_boundary"] };
    }
    return { ok: true, geometry, measuredContour, elapsedMs: Date.now() - started, neuronsSpent, errors: [] };
  } catch (error) {
    const diagnostic = geminiProviderErrorDiagnostic(error);
    return { ok: false, elapsedMs: Date.now() - started, neuronsSpent, errors: ["geometry:provider_failure"], httpStatus: diagnostic.httpStatus, providerStatus: diagnostic.providerStatus };
  }
}
