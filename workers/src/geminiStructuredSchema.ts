export interface GeminiSchemaPreflight {
  valid: boolean;
  jsonSerializable: boolean;
  serializedBytes: number | null;
  depth: number;
  propertyCount: number;
  requiredCount: number;
  enumValueCount: number;
  descriptionChars: number;
  unsupportedConstructs: string[];
  undefinedPaths: string[];
  nonFiniteNumberPaths: string[];
  missingRequiredProperties: string[];
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$id", "$defs", "$ref", "$anchor",
  "type", "format", "title", "description", "enum",
  "items", "prefixItems", "minItems", "maxItems",
  "minimum", "maximum", "anyOf", "oneOf",
  "properties", "additionalProperties", "required", "propertyOrdering",
]);

const SCHEMA_CHILD_KEYS = new Set(["items", "additionalProperties"]);
const SCHEMA_ARRAY_KEYS = new Set(["prefixItems", "anyOf", "oneOf"]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Deterministic, API-free validation for the JSON Schema subset accepted by
 * Gemini structured output. It records only shape metadata, never prompts,
 * images, API keys, or schema contents.
 */
export function inspectGeminiResponseSchema(schema: unknown): GeminiSchemaPreflight {
  const unsupported = new Set<string>();
  const undefinedPaths: string[] = [];
  const nonFiniteNumberPaths: string[] = [];
  const missingRequiredProperties: string[] = [];
  const seen = new Set<object>();
  const scanned = new Set<object>();
  let depth = 0;
  let propertyCount = 0;
  let requiredCount = 0;
  let enumValueCount = 0;
  let descriptionChars = 0;
  let circular = false;

  const scanValue = (value: unknown, path: string): void => {
    if (value === undefined) {
      undefinedPaths.push(path);
      return;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      nonFiniteNumberPaths.push(path);
      return;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      unsupported.add(`${path}:non_json_value`);
      return;
    }
    if (typeof value === "object" && value !== null) {
      if (scanned.has(value)) {
        circular = true;
        return;
      }
      scanned.add(value);
      if (Array.isArray(value)) value.forEach((item, index) => scanValue(item, `${path}[${index}]`));
      else Object.entries(value).forEach(([key, item]) => scanValue(item, `${path}.${key}`));
      scanned.delete(value);
    }
  };

  const visitSchema = (value: unknown, path: string, currentDepth: number): void => {
    const node = objectRecord(value);
    if (!node) {
      unsupported.add(`${path}:schema_not_object`);
      return;
    }
    if (seen.has(node)) {
      circular = true;
      unsupported.add(`${path}:circular_reference`);
      return;
    }
    seen.add(node);
    depth = Math.max(depth, currentDepth);
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) unsupported.add(key);
    }

    const properties = objectRecord(node.properties);
    if (node.properties !== undefined && !properties) unsupported.add(`${path}.properties:not_object`);
    if (properties) {
      propertyCount += Object.keys(properties).length;
      for (const [name, child] of Object.entries(properties)) visitSchema(child, `${path}.properties.${name}`, currentDepth + 1);
    }

    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== "string")) {
        unsupported.add(`${path}.required:not_string_array`);
      } else {
        requiredCount += node.required.length;
        for (const name of node.required) {
          if (!properties || !(name as string in properties)) missingRequiredProperties.push(`${path}.${String(name)}`);
        }
      }
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) unsupported.add(`${path}.enum:not_array`);
      else enumValueCount += node.enum.length;
    }
    if (typeof node.description === "string") descriptionChars += node.description.length;
    for (const key of SCHEMA_CHILD_KEYS) {
      const child = node[key];
      if (child !== undefined && typeof child !== "boolean") visitSchema(child, `${path}.${key}`, currentDepth + 1);
    }
    for (const key of SCHEMA_ARRAY_KEYS) {
      const children = node[key];
      if (children === undefined) continue;
      if (!Array.isArray(children)) unsupported.add(`${path}.${key}:not_array`);
      else children.forEach((child, index) => visitSchema(child, `${path}.${key}[${index}]`, currentDepth + 1));
    }
    const definitions = objectRecord(node.$defs);
    if (node.$defs !== undefined && !definitions) unsupported.add(`${path}.$defs:not_object`);
    if (definitions) for (const [name, child] of Object.entries(definitions)) visitSchema(child, `${path}.$defs.${name}`, currentDepth + 1);
    seen.delete(node);
  };

  scanValue(schema, "$schema");
  visitSchema(schema, "$schema", 1);
  let serializedBytes: number | null = null;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  } catch {
    circular = true;
  }
  const unsupportedConstructs = [...unsupported].sort();
  const jsonSerializable = !circular && undefinedPaths.length === 0 && nonFiniteNumberPaths.length === 0 && !unsupportedConstructs.some((item) => item.includes("non_json_value"));
  return {
    valid: jsonSerializable && unsupportedConstructs.length === 0 && missingRequiredProperties.length === 0,
    jsonSerializable,
    serializedBytes,
    depth,
    propertyCount,
    requiredCount,
    enumValueCount,
    descriptionChars,
    unsupportedConstructs,
    undefinedPaths,
    nonFiniteNumberPaths,
    missingRequiredProperties,
  };
}
