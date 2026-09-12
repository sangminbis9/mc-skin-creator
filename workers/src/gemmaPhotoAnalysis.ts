import {
  PHOTO_ANALYSIS_SCHEMA,
} from "./analysis";
import {
  COMPACT_HINT_GROUPS,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  type CompactPhotoAnalysisV2,
} from "./compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT } from "./compactPhotoAnalysisV3";

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

/** Gemma-only provider DTO. The existing Compact v3/runtime schema is unchanged. */
export const GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA = buildNamedSchema();

const namedHintContract = Object.entries(COMPACT_HINT_GROUPS)
  .map(([group, fields]) => `${group}: { ${fields
    .map((field) => `${field}: ${(richRenderHintProperties[field].enum ?? []).join(" | ")}`)
    .join(", ")} }`)
  .join("\n");

/** Preserve the production analysis semantics and override only Gemma's renderHints wire shape. */
export const GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}

GEMMA NAMED RENDERHINTS WIRE OVERRIDE:
For this provider response, renderHints groups are named objects, not positional arrays.
Return every group, every field below, and no additional fields. Each field must use its own exact vocabulary:
${namedHintContract}
This override changes representation only. Keep every other Compact v3 field and meaning exactly as instructed above.`;

function validateSchema(schema: Schema, raw: unknown): string[] {
  const errors: string[] = [];
  function visit(node: Schema, value: unknown, path: string): void {
    const kinds = Array.isArray(node.type) ? node.type : [node.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!kinds.includes(kind) && !(
      kinds.includes("integer") && typeof value === "number" && Number.isInteger(value)
    )) {
      errors.push(`${path}:type`);
      return;
    }
    if (node.enum && !node.enum.includes(value)) errors.push(`${path}:enum`);
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

export function validateGemmaNamedPhotoAnalysis(raw: unknown): string[] {
  return validateSchema(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, raw);
}

/** Field-name mapping only: no values are inferred, defaulted, coerced, or dropped. */
export function adaptGemmaNamedPhotoAnalysis(raw: unknown): GemmaNamedAdapterResult {
  const errors = validateGemmaNamedPhotoAnalysis(raw);
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
