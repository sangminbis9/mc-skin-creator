// Exact inverse of the later tuple-schema delta for historical hash assertions.
// Never used on provider output or by the production/audit runner.
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";

export function priorGemmaTupleSchema() {
  const schema = structuredClone(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
  delete schema.properties!.faceMeasurements.items!.anyOf;
  return schema;
}

// The exact partial-branch schema used by C-004 and B-001. Read-only evidence
// reconstruction, never a candidate for repairing returned provider fields.
export function partialGemmaTupleSchema() {
  const schema = structuredClone(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
  const item = schema.properties!.faceMeasurements.items!;
  const branches = item.anyOf!;
  item.anyOf = [
    { properties: {
      value: { enum: branches[0].properties!.value.enum },
      provenance: { enum: branches[0].properties!.provenance.enum },
      confidence: { enum: branches[0].properties!.confidence.enum },
    } },
    { properties: {
      value: { enum: branches[1].properties!.value.enum },
      provenance: { enum: branches[1].properties!.provenance.enum },
      confidence: { minimum: branches[1].properties!.confidence.minimum },
    } },
  ];
  return schema;
}

export function withoutGemmaTupleSourceDelta(file: string, source: string): string {
  if (file !== "src/analysis.ts" && file !== "src/gemmaPhotoAnalysis.ts") return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let value = source.replace(/\r\n/g, "\n");
  if (file === "src/gemmaPhotoAnalysis.ts") {
    const selfContainedDelta = `  // Each generation branch is a complete object contract. Do not depend on a
  // provider combining partial branch properties with sibling required/types.
  // Parent constraints remain intact; this changes no JSON Schema acceptance.
  const { anyOf: partialBranches, ...baseItem } = item;
  item.anyOf = partialBranches.map(branch => ({
    ...structuredClone(baseItem),
    properties: Object.fromEntries(Object.entries(baseItem.properties!).map(([key, field]) => [
      key, { ...structuredClone(field), ...branch.properties![key] },
    ])),
  }));
`;
    if (value.split(selfContainedDelta).length !== 2) throw new Error("unexpected_gemma_complete_branch_delta");
    value = value.replace(selfContainedDelta, "");
  }
  const deltas: Array<[string, string]> = file === "src/analysis.ts" ? [
    ['gemma.validateGemmaNamedPhotoAnalysis(core, "v4")', "gemma.validateGemmaNamedPhotoAnalysis(core)"],
    ['gemma.adaptGemmaNamedPhotoAnalysis(core, "v4")', "gemma.adaptGemmaNamedPhotoAnalysis(core)"],
  ] : file === "src/gemmaPhotoAnalysis.ts" ? [
    ['import { FACE_MEASUREMENT_VALUES } from "./faceMeasurementEvidence";\n', ""],
    ["  anyOf?: readonly Schema[];\n", ""],
    [`const namedCoreSchema = buildNamedSchema();

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
  return schema;
}

`, ""],
    ["GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA = buildV3NamedSchema();", "GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA = buildNamedSchema();"],
    ["  namedCoreSchema,\n", "  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,\n"],
    ["if (node.type !== undefined && !kinds.includes(kind)", "if (!kinds.includes(kind)"],
    ['    if (node.anyOf && !node.anyOf.some(branch => validateSchema(branch, value).length === 0)) {\n      errors.push(`${path}:anyOf`);\n    }\n', ""],
    ['validateGemmaNamedPhotoAnalysis(raw: unknown, contract: "v3" | "v4" = "v3")', 'validateGemmaNamedPhotoAnalysis(raw: unknown)'],
    ['validateSchema(contract === "v4" ? namedCoreSchema : GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, raw)', 'validateSchema(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, raw)'],
    ['adaptGemmaNamedPhotoAnalysis(raw: unknown, contract: "v3" | "v4" = "v3")', 'adaptGemmaNamedPhotoAnalysis(raw: unknown)'],
    ['validateGemmaNamedPhotoAnalysis(raw, contract)', 'validateGemmaNamedPhotoAnalysis(raw)'],
  ] : [];
  for (const [current, previous] of deltas) {
    if (value.split(current).length !== 2) throw new Error("unexpected_gemma_tuple_source_delta");
    value = value.replace(current, previous);
  }
  return value.replace(/\n/g, newline);
}
