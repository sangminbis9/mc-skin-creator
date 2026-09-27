import {
  ANALYSIS_PROMPT,
  ANALYSIS_PROMPT_V4,
  validatePhotoAnalysis,
  validatePortraitRegionWithDiagnostics,
  type PhotoAnalysisLocalizationAuthority,
  type PortraitRegion,
  type PortraitRegionValidationReason,
  type PortraitRelationshipFailure,
  type ValidationResult,
} from "./analysis";
import { COMPACT_FACE_ORDER, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  restoreCompactRenderHintsV2, type CompactPhotoAnalysisV2 } from "./compactPhotoAnalysis";
import {
  COMPACT_PHOTO_ANALYSIS_V3_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  type CompactV3Schema,
  type CompactV3SourceContext,
} from "./compactPhotoAnalysisV3";
import { validateCompactPhotoAnalysisV3 } from "./compactPhotoAnalysisV3";

export const PRIMARY_COMPACT_V3_LEGACY_SUFFIX = "primary_compact_v3_legacy_suffix" as const;
export const PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION = "primary_compact_v4_structured_localization" as const;
export type PrimaryContractVersion = typeof PRIMARY_COMPACT_V3_LEGACY_SUFFIX
  | typeof PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION;

const boxSchema: CompactV3Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    left: { type: "number" }, top: { type: "number" },
    right: { type: "number" }, bottom: { type: "number" },
  },
  required: ["left", "top", "right", "bottom"],
};

/** Nullable named wire field. Number range and geometry relations remain runtime checks. */
export const STRUCTURED_PORTRAIT_REGION_SCHEMA: CompactV3Schema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    subjectBox: structuredClone(boxSchema),
    headBox: structuredClone(boxSchema),
    faceBox: structuredClone(boxSchema),
    confidence: { type: "number" },
  },
  required: ["subjectBox", "headBox", "faceBox", "confidence"],
};

/** Returns a new schema; frozen v2/v3 exports are never mutated. */
export function withStructuredPortraitRegion<T extends CompactV3Schema>(source: T): T {
  const schema = structuredClone(source);
  const selection = schema.properties?.sourceSelection;
  const legacySelection = (COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as CompactV3Schema).properties?.sourceSelection;
  if (!selection?.properties || !legacySelection?.required) {
    throw new Error("sourceSelection schema is unavailable for v4 localization");
  }
  selection.properties.portraitRegion = structuredClone(STRUCTURED_PORTRAIT_REGION_SCHEMA);
  selection.required = [...new Set([...legacySelection.required, "portraitRegion"])];
  return schema;
}

export const COMPACT_PHOTO_ANALYSIS_V4_RUNTIME_SCHEMA = withStructuredPortraitRegion(
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as CompactV3Schema,
);
export const COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA = withStructuredPortraitRegion(
  COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
);

if (COMPACT_PHOTO_ANALYSIS_V3_PROMPT.split(ANALYSIS_PROMPT).length !== 2
  || COMPACT_PHOTO_ANALYSIS_V3_PROMPT.split("COMPACT WIRE CONTRACT v3").length !== 2) {
  throw new Error("v4 Compact prompt derivation no longer matches frozen v3 contract");
}
export const COMPACT_PHOTO_ANALYSIS_V4_PROMPT = COMPACT_PHOTO_ANALYSIS_V3_PROMPT
  .replace(ANALYSIS_PROMPT, ANALYSIS_PROMPT_V4)
  .replace("COMPACT WIRE CONTRACT v3", "COMPACT WIRE CONTRACT v4");

/** V4-local wire checker: the frozen V3 contract module remains byte-identical. */
export function validateV4Shape(schema: CompactV3Schema, raw: unknown, strict: boolean): string[] {
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

/** Explicit authority reaches the rich validator without modifying the frozen V2/V3 modules. */
export function normalizeCompactPhotoAnalysisV4Core(
  core: unknown,
  context: CompactV3SourceContext,
  authority: PhotoAnalysisLocalizationAuthority,
): ValidationResult {
  const errors = validateCompactPhotoAnalysisV3(core, context);
  if (errors.length) return { ok: false, errors };
  const { renderHints, faceMeasurements, identityFeatures, canonicalIdentity, ...rest } = core as CompactPhotoAnalysisV2;
  const restoredHints = restoreCompactRenderHintsV2(renderHints);
  if (!restoredHints.ok) return restoredHints;
  return validatePhotoAnalysis({
    ...rest,
    renderHints: restoredHints.renderHints,
    canonicalIdentity: { ...canonicalIdentity, features: identityFeatures },
    ...(faceMeasurements ? { faceMeasurementEvidence: {
      referenceImageIndex: rest.sourceSelection.portraitImageIndex,
      cues: Object.fromEntries(COMPACT_FACE_ORDER.map((key, index) => [key, faceMeasurements[index]])),
    } } : {}),
  }, authority);
}

export interface StructuredLocalizationTrace {
  version: 2;
  contractVersion: typeof PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION;
  carrier: "structured_region";
  status: "VALID" | "EXPLICIT_NULL" | "MISSING" | "MALFORMED" | "INVALID_REGION";
  fieldPresent: boolean;
  shapeValidation: "passed" | "failed" | "not_applicable";
  regionValidation: "passed" | "failed" | "not_applicable";
  validationReason: PortraitRegionValidationReason | null;
  /** Fixed predicate only; rejected coordinates never enter the trace. */
  relationshipFailure?: PortraitRelationshipFailure;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function captureStructuredLocalization(raw: unknown): {
  core: unknown;
  fieldPresent: boolean;
  fieldValue: unknown;
} {
  if (!plainRecord(raw) || !plainRecord(raw.sourceSelection)) {
    return { core: raw, fieldPresent: false, fieldValue: undefined };
  }
  const selection = raw.sourceSelection;
  const { portraitRegion, ...coreSelection } = selection;
  return {
    core: { ...raw, sourceSelection: coreSelection },
    fieldPresent: Object.hasOwn(selection, "portraitRegion"),
    fieldValue: portraitRegion,
  };
}

export function validateStructuredLocalization(fieldPresent: boolean, fieldValue: unknown): {
  trace: StructuredLocalizationTrace;
  region: PortraitRegion | null;
  localizationValid: boolean;
} {
  const base = {
    version: 2 as const,
    contractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
    carrier: "structured_region" as const,
    fieldPresent,
    validationReason: null,
  };
  if (!fieldPresent) return { trace: { ...base, status: "MISSING", shapeValidation: "not_applicable",
    regionValidation: "not_applicable" }, region: null, localizationValid: false };
  if (fieldValue === null) return { trace: { ...base, status: "EXPLICIT_NULL", shapeValidation: "passed",
    regionValidation: "not_applicable" }, region: null, localizationValid: false };
  const shapeErrors = validateV4Shape(STRUCTURED_PORTRAIT_REGION_SCHEMA, fieldValue, true);
  if (shapeErrors.length) return { trace: { ...base, status: "MALFORMED", shapeValidation: "failed",
    regionValidation: "not_applicable" }, region: null, localizationValid: false };
  const { validation: semantic, relationshipFailure } = validatePortraitRegionWithDiagnostics(fieldValue);
  if (!semantic.ok) return { trace: { ...base, status: "INVALID_REGION", shapeValidation: "passed",
    regionValidation: "failed", validationReason: semantic.reason,
    ...(relationshipFailure ? { relationshipFailure } : {}) }, region: null, localizationValid: false };
  return { trace: { ...base, status: "VALID", shapeValidation: "passed",
    regionValidation: "passed" }, region: semantic.region, localizationValid: true };
}
