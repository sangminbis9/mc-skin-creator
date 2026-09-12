import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA, validatePhotoAnalysis, type PhotoAnalysis, type ValidationResult } from "./analysis";
import { FACE_MEASUREMENT_VALUES, type FaceMeasurementEvidence } from "./faceMeasurementEvidence";

/** Versioned provider boundary; ordered vectors never escape normalization. */
export interface CompactPhotoAnalysis extends Omit<PhotoAnalysis, "renderHints" | "faceMeasurementEvidence" | "canonicalIdentity" | "identityGeometry" | "fallbackFeatures"> {
  renderHints: string[];
  faceMeasurements?: Array<FaceMeasurementEvidence["cues"][keyof FaceMeasurementEvidence["cues"]]>;
  canonicalIdentity: Omit<PhotoAnalysis["canonicalIdentity"], "features">;
  identityFeatures: PhotoAnalysis["canonicalIdentity"]["features"];
  fallbackFeatures?: Partial<PhotoAnalysis["fallbackFeatures"]>;
}

export const COMPACT_HINT_GROUPS = {
  complexion: ["skinUndertone", "faceShape", "jawShape"],
  eyes: ["eyeShape", "eyeSize", "irisLightness", "eyeSpacing", "eyeTilt"],
  browsNose: ["eyebrowShape", "noseShape"],
  mouth: ["mouthShape", "mouthOpening", "lipFullness", "lipColor"],
  fringe: ["bangs", "bangsLength", "bangsDensity", "fringeEdge", "fringeOpening"],
  hairForm: ["hairTexture", "hairVolume", "hairSilhouette", "hairBackShape"],
  hairLength: ["overallHairLength", "sideHairLength"],
  hairSides: ["hairPart", "sideHairShape", "sideHairAsymmetry", "earExposure"],
  hairAccessory: ["hairAccessory", "hairAccessoryScale", "hairAccessorySide"],
  hairAccessoryColor: ["hairAccessoryColor"],
  neckAccessory: ["necklace", "neckAccessory"],
  upperOutfit: ["garmentTexture", "outerLayer", "outerGarment"],
  bottom: ["bottomPattern", "bottomAccent"],
  legwear: ["legwear", "legwearAsymmetry", "thighAccessory", "thighAccessorySide"],
  legwearColor: ["legwearColor"],
} as const satisfies Record<string, readonly (keyof PhotoAnalysis["renderHints"])[]>;

export type CompactHintGroupName = keyof typeof COMPACT_HINT_GROUPS;
export type CompactRenderHintGroups = {
  [Group in CompactHintGroupName]: string[];
};

export interface CompactPhotoAnalysisV2 extends Omit<PhotoAnalysis, "renderHints" | "faceMeasurementEvidence" | "canonicalIdentity" | "identityGeometry" | "fallbackFeatures"> {
  renderHints: CompactRenderHintGroups;
  faceMeasurements?: Array<FaceMeasurementEvidence["cues"][keyof FaceMeasurementEvidence["cues"]]>;
  canonicalIdentity: Omit<PhotoAnalysis["canonicalIdentity"], "features">;
  identityFeatures: PhotoAnalysis["canonicalIdentity"]["features"];
  fallbackFeatures?: Partial<PhotoAnalysis["fallbackFeatures"]>;
}

type Schema = {
  type?: string | readonly string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  enum?: readonly unknown[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  description?: string;
};
const rich = PHOTO_ANALYSIS_SCHEMA as unknown as Schema;
const hintProperties = rich.properties!.renderHints.properties!;
export const COMPACT_HINT_ORDER = Object.keys(hintProperties) as Array<keyof PhotoAnalysis["renderHints"]>;
export const COMPACT_FACE_ORDER = Object.keys(FACE_MEASUREMENT_VALUES) as Array<keyof typeof FACE_MEASUREMENT_VALUES>;
const fallbackKeys = ["skinTone", "hairColor", "hairstyle", "eyeColor", "eyebrowThickness", "facialHair", "glasses", "glassesColor", "earrings", "hat", "hatColor", "expression", "topType", "topColor", "topAccentColor", "sleeveLength", "bottomType", "bottomColor", "shoesColor"] as const;

function withoutDescriptions(node: Schema): Schema {
  const copy = structuredClone(node);
  delete copy.description;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, child]) => [key, withoutDescriptions(child)]));
  if (copy.items) copy.items = withoutDescriptions(copy.items);
  return copy;
}

function buildSchema(): Schema {
  const schema = withoutDescriptions(rich);
  const properties = schema.properties!;
  delete properties.faceMeasurementEvidence;
  properties.renderHints = {
    type: "array", minItems: COMPACT_HINT_ORDER.length, maxItems: COMPACT_HINT_ORDER.length,
    items: { type: "string", enum: [...new Set(COMPACT_HINT_ORDER.flatMap(key => hintProperties[key].enum as string[]))] },
  };
  // Reference ownership is already required in sourceSelection: do not request it twice.
  properties.faceMeasurements = {
    type: "array", minItems: COMPACT_FACE_ORDER.length, maxItems: COMPACT_FACE_ORDER.length,
    items: { type: "object", additionalProperties: false,
      properties: {
        value: { type: "string", enum: [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())] },
        provenance: { type: "string", enum: ["observed_categorical", "inferred", "unknown"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }, required: ["value", "provenance", "confidence"],
    },
  };
  properties.identityFeatures = properties.canonicalIdentity.properties!.features;
  delete properties.canonicalIdentity.properties!.features;
  properties.canonicalIdentity.required = ["overallImpression", "mustPreserve"];
  // A cache override is optional, but cannot be dropped when it carries a unique palette choice.
  properties.fallbackFeatures = { type: "object", additionalProperties: false,
    properties: Object.fromEntries(fallbackKeys.map(key => [key, { type: key === "earrings" ? "boolean" : "string" }])),
  };
  schema.required = [...schema.required!.filter(key => key !== "fallbackFeatures"), "identityFeatures"];
  schema.additionalProperties = false;
  return schema;
}
export const COMPACT_PHOTO_ANALYSIS_SCHEMA = buildSchema();

function buildSchemaV2(): Schema {
  const schema = withoutDescriptions(rich);
  const properties = schema.properties!;
  delete properties.faceMeasurementEvidence;
  properties.renderHints = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, keys]) => [group, {
        type: "array",
        items: {
          type: "string",
          enum: [...new Set(keys.flatMap((key) => hintProperties[key].enum as string[]))],
        },
      }]),
    ),
    required: Object.keys(COMPACT_HINT_GROUPS),
  };
  properties.faceMeasurements = {
    type: "array", minItems: COMPACT_FACE_ORDER.length, maxItems: COMPACT_FACE_ORDER.length,
    items: { type: "object", additionalProperties: false,
      properties: {
        value: { type: "string", enum: [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())] },
        provenance: { type: "string", enum: ["observed_categorical", "inferred", "unknown"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }, required: ["value", "provenance", "confidence"],
    },
  };
  properties.identityFeatures = properties.canonicalIdentity.properties!.features;
  delete properties.canonicalIdentity.properties!.features;
  properties.canonicalIdentity.required = ["overallImpression", "mustPreserve"];
  properties.fallbackFeatures = { type: "object", additionalProperties: false,
    properties: Object.fromEntries(fallbackKeys.map((key) => [key, { type: key === "earrings" ? "boolean" : "string" }])),
  };
  schema.required = [...schema.required!.filter((key) => key !== "fallbackFeatures"), "identityFeatures"];
  schema.additionalProperties = false;
  return schema;
}

export const COMPACT_PHOTO_ANALYSIS_V2_SCHEMA = buildSchemaV2();

/** Preserve every measurement instruction; only the output representation is overridden. */
export const COMPACT_PHOTO_ANALYSIS_PROMPT = `${ANALYSIS_PROMPT}

COMPACT WIRE CONTRACT v1 (overrides only the output JSON shape above):
Keep every observation, inference rationale, prompt, palette override and identity priority with the same meaning.
renderHints is an ordered array of exactly ${COMPACT_HINT_ORDER.length} strings. Use the following zero-based field order and the exact vocabulary for each slot:
${COMPACT_HINT_ORDER.map((key, index) => `${index}: ${key} = ${hintProperties[key].enum!.join(" | ")}`).join("\n")}
${COMPACT_HINT_ORDER.filter(key => hintProperties[key].description).map(key => `${key}: ${hintProperties[key].description}`).join("\n")}
Return faceMeasurements instead of faceMeasurementEvidence: exactly ${COMPACT_FACE_ORDER.length} objects {value, provenance, confidence}, in this zero-based order:
${COMPACT_FACE_ORDER.map((key, index) => `${index}: ${key} = ${FACE_MEASUREMENT_VALUES[key].join(" | ")}`).join("\n")}
These measurements refer ONLY to sourceSelection.portraitImageIndex, so do not return a second reference index. Preserve observed_categorical/inferred/unknown and the measured confidence. Always report every cue; use unknown/unknown/0 for unavailable evidence. Never infer coordinates or invent confidence.
Move canonicalIdentity.features unchanged to the root field identityFeatures. Keep canonicalIdentity.overallImpression and mustPreserve unchanged.
fallbackFeatures is an optional cache: preserve all source-supported palette/category choices that carry information beyond the other fields. Omitted keys use existing server reconstruction; do not discard unique observations.
All other fields retain their original names, contents and meanings. Do not return faceMeasurementEvidence or identityGeometry.`;

export const COMPACT_PHOTO_ANALYSIS_V2_PROMPT = `${ANALYSIS_PROMPT}

COMPACT WIRE CONTRACT v2 (overrides only the output JSON shape above):
Keep every observation, inference rationale, prompt, palette override and identity priority with the same meaning.
renderHints is an object of ordered semantic arrays. Return every group and exactly the listed number of strings in each group. Use this zero-based field order and the exact vocabulary for each slot:
${Object.entries(COMPACT_HINT_GROUPS).map(([group, keys]) => `${group} (${keys.length}):\n${keys.map((key, index) => `  ${index}: ${key} = ${hintProperties[key].enum!.join(" | ")}`).join("\n")}`).join("\n")}
${COMPACT_HINT_ORDER.filter((key) => hintProperties[key].description).map((key) => `${key}: ${hintProperties[key].description}`).join("\n")}
Return faceMeasurements instead of faceMeasurementEvidence: exactly ${COMPACT_FACE_ORDER.length} objects {value, provenance, confidence}, in this zero-based order:
${COMPACT_FACE_ORDER.map((key, index) => `${index}: ${key} = ${FACE_MEASUREMENT_VALUES[key].join(" | ")}`).join("\n")}
These measurements refer ONLY to sourceSelection.portraitImageIndex, so do not return a second reference index. Preserve observed_categorical/inferred/unknown and the measured confidence. Always report every cue; use unknown/unknown/0 for unavailable evidence. Never infer coordinates or invent confidence.
Move canonicalIdentity.features unchanged to the root field identityFeatures. Keep canonicalIdentity.overallImpression and mustPreserve unchanged.
fallbackFeatures is an optional cache: preserve all source-supported palette/category choices that carry information beyond the other fields. Omitted keys use existing server reconstruction; do not discard unique observations.
All other fields retain their original names, contents and meanings. Do not return faceMeasurementEvidence or identityGeometry.`;

function validateSchemaSubset(schema: Schema, raw: unknown): string[] {
  const errors: string[] = [];
  function visit(node: Schema, value: unknown, path: string): void {
    const kinds = Array.isArray(node.type) ? node.type : [node.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!kinds.includes(kind) && !(kinds.includes("integer") && typeof value === "number" && Number.isInteger(value))) {
      errors.push(`${path}:type`); return;
    }
    if (node.enum && !node.enum.includes(value)) errors.push(`${path}:enum`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (node.minimum ?? -Infinity) || value > (node.maximum ?? Infinity))) errors.push(`${path}:range`);
    if (Array.isArray(value)) {
      if (value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? Infinity)) errors.push(`${path}:length`);
      if (node.items) value.forEach((item, index) => visit(node.items!, item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of node.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}:required`);
      for (const [key, item] of Object.entries(obj)) {
        if (node.properties?.[key]) visit(node.properties[key], item, `${path}.${key}`);
        else if (node.additionalProperties === false) errors.push(`${path}:additionalProperty`);
      }
    }
  }
  visit(schema, raw, "compact");
  return errors;
}

/** Small schema-subset validator also enforces per-slot vocabulary before rich validation. */
export function validateCompactPhotoAnalysis(raw: unknown): string[] {
  const errors = validateSchemaSubset(COMPACT_PHOTO_ANALYSIS_SCHEMA, raw);
  if (errors.length) return errors;
  const compact = raw as CompactPhotoAnalysis;
  compact.renderHints.forEach((value, index) => {
    if (!hintProperties[COMPACT_HINT_ORDER[index]].enum!.includes(value)) errors.push(`renderHints[${index}]:fieldVocabulary`);
  });
  compact.faceMeasurements?.forEach((cue, index) => {
    if (!(FACE_MEASUREMENT_VALUES[COMPACT_FACE_ORDER[index]] as readonly string[]).includes(cue.value)) errors.push(`faceMeasurements[${index}]:fieldVocabulary`);
  });
  return errors;
}

export function normalizeCompactPhotoAnalysis(raw: unknown): ValidationResult {
  const errors = validateCompactPhotoAnalysis(raw);
  if (errors.length) return { ok: false, errors };
  const { renderHints, faceMeasurements, identityFeatures, canonicalIdentity, ...rest } = raw as CompactPhotoAnalysis;
  return validatePhotoAnalysis({
    ...rest,
    renderHints: Object.fromEntries(COMPACT_HINT_ORDER.map((key, index) => [key, renderHints[index]])),
    canonicalIdentity: { ...canonicalIdentity, features: identityFeatures },
    ...(faceMeasurements ? { faceMeasurementEvidence: {
      referenceImageIndex: rest.sourceSelection.portraitImageIndex,
      cues: Object.fromEntries(COMPACT_FACE_ORDER.map((key, index) => [key, faceMeasurements[index]])),
    } } : {}),
  });
}

export type CompactRenderHintsV2Result =
  | { ok: true; renderHints: Record<string, string> }
  | { ok: false; errors: string[] };

export function restoreCompactRenderHintsV2(raw: unknown): CompactRenderHintsV2Result {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["renderHints:type"] };
  }
  const source = raw as Record<string, unknown>;
  const errors: string[] = [];
  const expectedGroups = Object.keys(COMPACT_HINT_GROUPS);
  for (const group of Object.keys(source)) {
    if (!expectedGroups.includes(group)) errors.push("renderHints:additionalProperty");
  }
  const entries: Array<[keyof PhotoAnalysis["renderHints"], string]> = [];
  for (const [group, keys] of Object.entries(COMPACT_HINT_GROUPS) as Array<[
    CompactHintGroupName,
    readonly (keyof PhotoAnalysis["renderHints"])[],
  ]>) {
    const values = source[group];
    if (!Array.isArray(values)) {
      errors.push(`renderHints.${group}:type`);
      continue;
    }
    if (values.length !== keys.length) {
      errors.push(`renderHints.${group}:length`);
      continue;
    }
    values.forEach((value, index) => {
      if (typeof value !== "string" || !hintProperties[keys[index]].enum!.includes(value)) {
        errors.push(`renderHints.${group}[${index}]:fieldVocabulary`);
      } else {
        entries.push([keys[index], value]);
      }
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    renderHints: Object.fromEntries(entries),
  };
}

export function validateCompactPhotoAnalysisV2(raw: unknown): string[] {
  const errors = validateSchemaSubset(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA, raw);
  if (errors.length) return errors;
  const compact = raw as CompactPhotoAnalysisV2;
  const restoredHints = restoreCompactRenderHintsV2(compact.renderHints);
  if (!restoredHints.ok) errors.push(...restoredHints.errors);
  compact.faceMeasurements?.forEach((cue, index) => {
    if (!(FACE_MEASUREMENT_VALUES[COMPACT_FACE_ORDER[index]] as readonly string[]).includes(cue.value)) {
      errors.push(`faceMeasurements[${index}]:fieldVocabulary`);
    }
  });
  return errors;
}

export function normalizeCompactPhotoAnalysisV2(raw: unknown): ValidationResult {
  const errors = validateCompactPhotoAnalysisV2(raw);
  if (errors.length) return { ok: false, errors };
  const { renderHints, faceMeasurements, identityFeatures, canonicalIdentity, ...rest } = raw as CompactPhotoAnalysisV2;
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
  });
}
