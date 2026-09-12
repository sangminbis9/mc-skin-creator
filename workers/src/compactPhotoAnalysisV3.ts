/** Inactive candidate. No caller imports or API stages are added by this module. */
import type { ValidationResult } from "./analysis";
import {
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  normalizeCompactPhotoAnalysisV2,
  validateCompactPhotoAnalysisV2,
  type CompactPhotoAnalysisV2,
} from "./compactPhotoAnalysis";

export interface CompactV3Schema {
  type?: string | readonly string[];
  properties?: Record<string, CompactV3Schema>;
  required?: readonly string[];
  items?: CompactV3Schema;
  enum?: readonly unknown[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

// Retain small enums controlling evidence interpretation, not rendering vocabulary.
export const COMPACT_V3_CRITICAL_ENUM_PATHS = [
  "quality", "failReason", "framing", "faceMeasurements[].value", "faceMeasurements[].provenance",
  "identityFeatures[].category", "identityFeatures[].confidence",
] as const;
const critical = new Set<string>(COMPACT_V3_CRITICAL_ENUM_PATHS);

function providerSchema(node: CompactV3Schema, path = ""): CompactV3Schema {
  const copy = structuredClone(node);
  if (!critical.has(path)) delete copy.enum;
  // The original v2 schema remains the runtime contract, including all bounds.
  if (path) delete copy.required;
  delete copy.minItems;
  delete copy.maxItems;
  delete copy.minimum;
  delete copy.maximum;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties)
    .map(([key, value]) => [key, providerSchema(value, path ? `${path}.${key}` : key)]));
  if (copy.items) copy.items = providerSchema(copy.items, `${path}[]`);
  return copy;
}

export const COMPACT_PHOTO_ANALYSIS_V3_SCHEMA = providerSchema(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
export type CompactPhotoAnalysisV3 = CompactPhotoAnalysisV2;

const extraVocabulary: string[] = [];
function vocabulary(node: CompactV3Schema, path = ""): void {
  // v2 already describes every render-hint slot and face-measurement cue.
  if (node.enum && !path.startsWith("renderHints.") && path !== "faceMeasurements[].value") {
    extraVocabulary.push(`${path}: ${node.enum.map((v) => JSON.stringify(v)).join("|")}`);
  }
  Object.entries(node.properties ?? {}).forEach(([key, value]) => vocabulary(value, path ? `${path}.${key}` : key));
  if (node.items) vocabulary(node.items, `${path}[]`);
}
vocabulary(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
export const COMPACT_PHOTO_ANALYSIS_V3_PROMPT = COMPACT_PHOTO_ANALYSIS_V2_PROMPT.replace(
  "COMPACT WIRE CONTRACT v2", "COMPACT WIRE CONTRACT v3",
) + `\nV3 output validation: keep every v2 field, group, slot and meaning above. Provider schema omissions do not make semantic fields optional. Return all nested fields and every faceMeasurements cue as instructed above. Only fallbackFeatures is optional in new output; legacy absence of faceMeasurements remains runtime-compatible. No additional fields. Exact group lengths and slot vocabularies above are checked at runtime. Source indices must refer to supplied images; faceMeasurements belongs only to portraitImageIndex. Additional categorical vocabularies (exact spelling):\n${extraVocabulary.join("\n")}`;

export interface CompactV3SourceContext {
  /** Actual number of images supplied by the caller; never supplied by model output. */
  imageCount: number;
  /** Optional caller-owned portrait selection, if it was already fixed. */
  portraitImageIndex?: number;
}

function validateShape(schema: CompactV3Schema, raw: unknown, strict: boolean): string[] {
  const errors: string[] = [];
  const ancestors = new Set<object>();
  function visit(node: CompactV3Schema, value: unknown, path: string): void {
    const kinds = Array.isArray(node.type) ? node.type : [node.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!kinds.includes(kind) && !(kinds.includes("integer") && Number.isInteger(value))) {
      errors.push(`${path}:type`); return;
    }
    if (node.enum && !node.enum.includes(value)) errors.push(`${path}:enum`);
    if (typeof value === "number" && (!Number.isFinite(value)
      || value < (node.minimum ?? -Infinity) || value > (node.maximum ?? Infinity))) errors.push(`${path}:range`);
    if (typeof value !== "object" || value === null) return;
    if (ancestors.has(value)) { errors.push(`${path}:cycle`); return; }
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? Infinity)) errors.push(`${path}:length`);
      // entries() also visits sparse holes, unlike forEach().
      for (const [index, item] of value.entries()) if (node.items) visit(node.items, item, `${path}[${index}]`);
    } else {
      const obj = value as Record<string, unknown>;
      if (strict && Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) errors.push(`${path}:plainObject`);
      for (const key of node.required ?? []) if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key}:required`);
      for (const [key, item] of Object.entries(obj)) {
        if (node.properties && Object.hasOwn(node.properties, key)) visit(node.properties[key], item, `${path}.${key}`);
        else if (strict || node.additionalProperties === false) errors.push(`${path}.${key}:additionalProperty`);
      }
    }
    ancestors.delete(value);
  }
  visit(schema, raw, "compact");
  return errors;
}

/** Provider shape validation alone is NOT permission to consume the response. */
export function validateCompactPhotoAnalysisV3Provider(raw: unknown): string[] {
  return validateShape(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, raw, false);
}

/** Strict acceptance before legacy normalization can default/discard invalid data. */
export function validateCompactPhotoAnalysisV3(raw: unknown, context: CompactV3SourceContext): string[] {
  const errors = validateShape(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA, raw, true);
  if (errors.length) return errors;
  errors.push(...validateCompactPhotoAnalysisV2(raw));
  if (errors.length) return errors;
  const compact = raw as CompactPhotoAnalysisV3;
  if (!Number.isInteger(context.imageCount) || context.imageCount < 1 || context.imageCount > 5) {
    errors.push("context.imageCount:range");
  }
  for (const key of ["portraitImageIndex", "outfitImageIndex", "generationImageIndex"] as const) {
    if (compact.sourceSelection[key] >= context.imageCount) errors.push(`sourceSelection.${key}:unavailableReference`);
  }
  if (context.portraitImageIndex !== undefined && (!Number.isInteger(context.portraitImageIndex)
    || context.portraitImageIndex < 0 || context.portraitImageIndex >= context.imageCount
    || context.portraitImageIndex !== compact.sourceSelection.portraitImageIndex)) errors.push("sourceSelection.portraitImageIndex:referenceMismatch");
  compact.faceMeasurements?.forEach((cue, index) => {
    const unknown = cue.value === "unknown" && cue.provenance === "unknown" && cue.confidence === 0;
    const observed = cue.value !== "unknown" && cue.provenance !== "unknown"
      && cue.confidence >= 0.75 && compact.visibleRegions.face;
    if (!unknown && !observed) errors.push(`faceMeasurements[${index}]:evidenceContract`);
  });
  if (errors.length) return errors;
  const rich = normalizeCompactPhotoAnalysisV2(raw);
  if (!rich.ok) errors.push(...rich.errors);
  return errors;
}

export function normalizeCompactPhotoAnalysisV3(raw: unknown, context: CompactV3SourceContext): ValidationResult {
  const errors = validateCompactPhotoAnalysisV3(raw, context);
  return errors.length ? { ok: false, errors } : normalizeCompactPhotoAnalysisV2(raw);
}
