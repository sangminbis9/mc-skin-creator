import { PHOTO_ANALYSIS_SCHEMA, type PhotoAnalysis } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_HINT_GROUPS, type CompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import type { CompactV3Schema as Schema } from "../src/compactPhotoAnalysisV3";
import { makeAnalysis } from "./helpers";

export function wireFixture(input: PhotoAnalysis): CompactPhotoAnalysisV2 {
  const raw = Object.fromEntries(Object.keys(PHOTO_ANALYSIS_SCHEMA.properties)
    .filter(key => key in input).map(key => [key, input[key as keyof PhotoAnalysis]]));
  delete raw.faceMeasurementEvidence;
  return {
    ...raw,
    inferred: { ...input.inferred, lowerBodyDesign: input.inferred.lowerBodyDesign ?? null },
    renderHints: Object.fromEntries(Object.entries(COMPACT_HINT_GROUPS)
      .map(([group, keys]) => [group, keys.map(key => input.renderHints[key])])),
    canonicalIdentity: { overallImpression: input.canonicalIdentity.overallImpression, mustPreserve: input.canonicalIdentity.mustPreserve },
    identityFeatures: input.canonicalIdentity.features,
    ...(input.faceMeasurementEvidence ? { faceMeasurements: COMPACT_FACE_ORDER.map(key => input.faceMeasurementEvidence!.cues[key]) } : {}),
  } as CompactPhotoAnalysisV2;
}

export function namedGemmaFixture(
  compact: CompactPhotoAnalysisV2,
): Omit<CompactPhotoAnalysisV2, "renderHints"> & { renderHints: Record<string, Record<string, string>> } {
  return {
    ...compact,
    renderHints: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => [
        group,
        Object.fromEntries(fields.map((field, index) => [
          field,
          compact.renderHints[group as keyof typeof compact.renderHints][index],
        ])),
      ]),
    ),
  };
}

export const semanticNames = ["face", "glasses", "covering", "curly", "bun", "layered", "plain", "full-body"];
export function semanticFixture(name: string): PhotoAnalysis {
  const input = makeAnalysis();
  if (name === "face") {
    input.framing = "face"; input.visibleRegions.upperBody = false;
    input.inferred.upperBody = { value: "neutral gray shirt", rationale: "no garment observable" };
  }
  if (name === "glasses") { input.fallbackFeatures.glasses = "round"; input.observed.accessories = "round silver glasses"; }
  if (name === "covering") {
    input.fallbackFeatures.hat = "headscarf"; input.observed.accessories = "opaque blue headscarf covering all hair";
    input.visibleRegions.hair = false;
  }
  if (name === "curly") { input.renderHints.hairTexture = "curly"; input.observed.hair = "curly black hair with high crown and full sides"; }
  if (name === "bun") { input.renderHints.hairBackShape = "tied"; input.observed.hair = "black hair tied in a high centered bun"; }
  if (name === "layered") {
    input.renderHints.outerGarment = "open_jacket"; input.renderHints.outerLayer = "heavy";
    input.observed.clothing = "open brown jacket over a white collared shirt";
  }
  if (name === "plain") { input.renderHints.garmentTexture = "plain"; input.observed.clothing = "plain blue t-shirt"; }
  if (name === "full-body") {
    input.framing = "full_body"; input.visibleRegions.lowerBody = true; input.visibleRegions.feet = true;
    input.inferred.lowerBody = null; input.inferred.shoes = null;
    input.observed.clothing = "blue t-shirt, gray pants and white sneakers";
  }
  return input;
}

/** Candidate comparison prototype only; field-local codebooks follow enum order. */
export function codeSchema(node: Schema): Schema {
  const copy = structuredClone(node);
  if (copy.enum) { copy.type = "string"; copy.enum = copy.enum.map((_, index) => `c${index.toString(36)}`); }
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, value]) => [key, codeSchema(value)]));
  if (copy.items) copy.items = codeSchema(copy.items);
  return copy;
}

export function transcode(node: Schema, raw: unknown, decode: boolean): unknown {
  if (node.enum) {
    const index = decode ? node.enum.findIndex((_, i) => `c${i.toString(36)}` === raw) : node.enum.indexOf(raw);
    if (index < 0) throw new Error("invalid_field_local_code");
    return decode ? node.enum[index] : `c${index.toString(36)}`;
  }
  if (raw === null) return null;
  if (Array.isArray(raw) && node.items) return raw.map(item => transcode(node.items!, item, decode));
  if (typeof raw === "object" && raw !== null && node.properties) return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, node.properties![key] ? transcode(node.properties![key], value, decode) : value]),
  );
  return raw;
}

export function enumPaths(node: Schema, path = ""): Array<{ path: string; values: readonly unknown[] }> {
  return [
    ...(node.enum ? [{ path, values: node.enum }] : []),
    ...Object.entries(node.properties ?? {}).flatMap(([key, child]) => enumPaths(child, path ? `${path}.${key}` : key)),
    ...(node.items ? enumPaths(node.items, `${path}[]`) : []),
  ];
}
