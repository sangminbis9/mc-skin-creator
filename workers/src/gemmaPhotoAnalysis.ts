import {
  PHOTO_ANALYSIS_SCHEMA,
} from "./analysis";
import {
  COMPACT_HINT_GROUPS,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  type CompactPhotoAnalysisV2,
} from "./compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT } from "./compactPhotoAnalysisV3";
import { COMPACT_PHOTO_ANALYSIS_V4_PROMPT, withStructuredPortraitRegion } from "./compactPhotoAnalysisV4";
import { FACE_MEASUREMENT_VALUES } from "./faceMeasurementEvidence";

export const GEMMA_VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";

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
  anyOf?: readonly Schema[];
};

export type GemmaNamedRenderHints = {
  [Group in keyof typeof COMPACT_HINT_GROUPS]: {
    [Field in (typeof COMPACT_HINT_GROUPS)[Group][number]]: string;
  };
};

export type GemmaNamedPhotoAnalysis = Omit<CompactPhotoAnalysisV2, "renderHints"> & {
  renderHints: GemmaNamedRenderHints;
};

export type GemmaNamedAdapterResult =
  | { ok: true; compact: CompactPhotoAnalysisV2 }
  | { ok: false; errors: string[] };

const richRenderHintProperties = (
  PHOTO_ANALYSIS_SCHEMA as unknown as Schema
).properties!.renderHints.properties!;

function buildNamedSchema(): Schema {
  const schema = structuredClone(
    COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  ) as Schema;
  schema.properties!.renderHints = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => [
        group,
        {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            fields.map((field) => [
              field,
              structuredClone(richRenderHintProperties[field]),
            ]),
          ),
          required: [...fields],
        },
      ]),
    ),
    required: Object.keys(COMPACT_HINT_GROUPS),
  };
  return schema;
}

const namedCoreSchema = buildNamedSchema();

function buildV3NamedSchema(): Schema {
  const schema = structuredClone(namedCoreSchema);
  const item = schema.properties!.faceMeasurements.items!;
  // Mirror the existing runtime evidence tuple, never repair provider output.
  // Cue-specific vocabulary and face visibility still require strict validation.
  item.anyOf = [
    { properties: {
      value: { enum: ["unknown"] },
      provenance: { enum: ["unknown"] },
      confidence: { enum: [0] },
    } },
    { properties: {
      value: { enum: [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())].filter(v => v !== "unknown") },
      provenance: { enum: item.properties!.provenance.enum!.filter(v => v !== "unknown") },
      confidence: { minimum: 0.75 },
    } },
  ];
  // Each generation branch is a complete object contract. Do not depend on a
  // provider combining partial branch properties with sibling required/types.
  // Parent constraints remain intact; this changes no JSON Schema acceptance.
  const { anyOf: partialBranches, ...baseItem } = item;
  item.anyOf = partialBranches.map(branch => ({
    ...structuredClone(baseItem),
    properties: Object.fromEntries(Object.entries(baseItem.properties!).map(([key, field]) => [
      key, { ...structuredClone(field), ...branch.properties![key] },
    ])),
  }));
  return schema;
}

/** Gemma-only provider DTO. The existing Compact v3/runtime schema is unchanged. */
export const GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA = buildV3NamedSchema();

const namedHintContract = Object.entries(COMPACT_HINT_GROUPS)
  .map(([group, fields]) => `${group}: { ${fields
    .map((field) => `${field}: ${(richRenderHintProperties[field].enum ?? []).join(" | ")}`)
    .join(", ")} }`)
  .join("\n");

/** Preserve the production analysis semantics and override only Gemma's renderHints wire shape. */
const namedV3Prompt = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}

GEMMA NAMED RENDERHINTS WIRE OVERRIDE:
For this provider response, renderHints groups are named objects, not positional arrays.
Return every group, every field below, and no additional fields. Each field must use its own exact vocabulary:
${namedHintContract}
This override changes representation only. Keep every other Compact v3 field and meaning exactly as instructed above.`;

/** Re-emphasize the existing V3 evidence contract, without coercing returned data. */
export const GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT = `${namedV3Prompt}

SOURCE SELECTION EVIDENCE COMPLETENESS:
Even with one image and all image indices set to 0, provide descriptive evidence in sourceSelection.portraitEvidence, outfitEvidence, and generationEvidence explaining the visible view or its limitations for each choice.
Each evidence string must contain at least 3 characters after trimming. For portraitEvidence, this minimum applies to the descriptive prose before the REGION suffix; append the required REGION suffix without replacing the prose.
Use only visible source support, describe limitations honestly, and do not invent details or pad evidence to meet the minimum.

FACE MEASUREMENT EVIDENCE CONSISTENCY:
For every faceMeasurements entry, confidence measures support for the chosen non-unknown cue value, not certainty that the cue is unavailable.
Unavailable evidence must be exactly {"value":"unknown","provenance":"unknown","confidence":0}, even when you are certain it cannot be measured.
A non-unknown cue requires visible face evidence, non-unknown provenance, and confidence >=0.75. Do not raise confidence or invent a cue to satisfy this rule; use the unavailable tuple when evidence is insufficient.
Before returning, check value/provenance/confidence together for every entry.`;

export const GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA = withStructuredPortraitRegion(
  namedCoreSchema,
);
if (namedV3Prompt.split(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).length !== 2) {
  throw new Error("v4 Gemma prompt derivation no longer matches frozen v3 contract");
}
// This V3-only reminder does not silently change the internal opt-in V4 contract.
export const GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT = namedV3Prompt
  .replace(COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V4_PROMPT)
  .replace("Keep every other Compact v3 field", "Keep every other Compact v4 field");

function validateSchema(schema: Schema, raw: unknown): string[] {
  const errors: string[] = [];
  function visit(node: Schema, value: unknown, path: string): void {
    const kinds = Array.isArray(node.type) ? node.type : [node.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (node.type !== undefined && !kinds.includes(kind) && !(
      kinds.includes("integer") && typeof value === "number" && Number.isInteger(value)
    )) {
      errors.push(`${path}:type`);
      return;
    }
    if (node.enum && !node.enum.includes(value)) errors.push(`${path}:enum`);
    if (node.anyOf && !node.anyOf.some(branch => validateSchema(branch, value).length === 0)) {
      errors.push(`${path}:anyOf`);
    }
    if (typeof value === "number" && (
      !Number.isFinite(value)
      || value < (node.minimum ?? -Infinity)
      || value > (node.maximum ?? Infinity)
    )) errors.push(`${path}:range`);
    if (Array.isArray(value)) {
      if (value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? Infinity)) {
        errors.push(`${path}:length`);
      }
      if (node.items) value.forEach((item, index) => visit(node.items!, item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(object, key)) errors.push(`${path}.${key}:required`);
    }
    for (const [key, item] of Object.entries(object)) {
      if (node.properties && Object.hasOwn(node.properties, key)) {
        visit(node.properties[key], item, `${path}.${key}`);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}.${key}:additionalProperty`);
      }
    }
  }
  visit(schema, raw, "gemma");
  return errors;
}

export function validateGemmaNamedPhotoAnalysis(raw: unknown, contract: "v3" | "v4" = "v3"): string[] {
  return validateSchema(contract === "v4" ? namedCoreSchema : GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, raw);
}

/** Field-name mapping only: no values are inferred, defaulted, coerced, or dropped. */
export function adaptGemmaNamedPhotoAnalysis(raw: unknown, contract: "v3" | "v4" = "v3"): GemmaNamedAdapterResult {
  const errors = validateGemmaNamedPhotoAnalysis(raw, contract);
  if (errors.length) return { ok: false, errors };
  const named = raw as GemmaNamedPhotoAnalysis;
  const renderHints = Object.fromEntries(
    Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => {
      const namedGroup = named.renderHints[
        group as keyof GemmaNamedRenderHints
      ] as Record<string, string>;
      return [group, fields.map((field) => namedGroup[field])];
    }),
  ) as CompactPhotoAnalysisV2["renderHints"];
  return {
    ok: true,
    compact: {
      ...named,
      renderHints,
    },
  };
}
