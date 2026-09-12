import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { PHOTO_ANALYSIS_SCHEMA, validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_SCHEMA, COMPACT_PHOTO_ANALYSIS_PROMPT, COMPACT_HINT_ORDER, COMPACT_FACE_ORDER, normalizeCompactPhotoAnalysis, validateCompactPhotoAnalysis } from "../src/compactPhotoAnalysis";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";

/** Test-only encoding of synthetic inputs; never supplies annotations to production. */
export function compactFixture(input: PhotoAnalysis) {
  const raw = Object.fromEntries(Object.keys(PHOTO_ANALYSIS_SCHEMA.properties).filter(key => key in input).map(key => [key, input[key as keyof PhotoAnalysis]]));
  delete raw.faceMeasurementEvidence;
  return {
    ...raw, inferred: { ...input.inferred, lowerBodyDesign: input.inferred.lowerBodyDesign ?? null },
    renderHints: COMPACT_HINT_ORDER.map(key => input.renderHints[key]),
    canonicalIdentity: { overallImpression: input.canonicalIdentity.overallImpression, mustPreserve: input.canonicalIdentity.mustPreserve },
    identityFeatures: input.canonicalIdentity.features,
    ...(input.faceMeasurementEvidence ? { faceMeasurements: COMPACT_FACE_ORDER.map(key => input.faceMeasurementEvidence!.cues[key]) } : {}),
  };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ajv = new Ajv({ allErrors: true });
const schemaValidate = ajv.compile(COMPACT_PHOTO_ANALYSIS_SCHEMA);

describe("compact primary PhotoAnalysis boundary", () => {
  it("keeps supported schema below the acceptance budget without losing vocabulary", async () => {
    const compact = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_SCHEMA);
    expect(compact.valid).toBe(true);
    expect(compact.serializedBytes).toBeLessThanOrEqual(7000);
    expect(compact.propertyCount).toBeLessThanOrEqual(100);
    expect(compact.depth).toBeLessThanOrEqual(5);
    expect(compact.descriptionChars).toBe(0);
    expect(COMPACT_HINT_ORDER).toHaveLength(45);
    expect(COMPACT_FACE_ORDER).toHaveLength(8);
    for (const [key, field] of Object.entries(PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties)) {
      expect(COMPACT_PHOTO_ANALYSIS_PROMPT).toContain(`${key} = ${field.enum.join(" | ")}`);
    }
    await mkdir("evaluation-artifacts/compact-primary-20260909", { recursive: true });
    await writeFile("evaluation-artifacts/compact-primary-20260909/offline.json", JSON.stringify({
      rich: inspectGeminiResponseSchema(PHOTO_ANALYSIS_SCHEMA), compact,
      schemaHash: hash(COMPACT_PHOTO_ANALYSIS_SCHEMA), promptHash: hash(COMPACT_PHOTO_ANALYSIS_PROMPT),
    }, null, 2));
  });

  it.each(["face", "glasses", "covering", "curly", "bun", "layered", "plain", "full-body"])("preserves %s rich analysis, complete plans and final atlas", name => {
    const input = makeAnalysis();
    if (name === "face") { input.framing = "face"; input.visibleRegions.upperBody = false; input.inferred.upperBody = { value: "neutral gray shirt", rationale: "no garment observable" }; }
    if (name === "glasses") { input.fallbackFeatures.glasses = "round"; input.observed.accessories = "round silver glasses"; }
    if (name === "covering") { input.fallbackFeatures.hat = "headscarf"; input.observed.accessories = "opaque blue headscarf covering all hair"; input.visibleRegions.hair = false; }
    if (name === "curly") { input.renderHints.hairTexture = "curly"; input.observed.hair = "curly black hair with high crown and full sides"; }
    if (name === "bun") { input.renderHints.hairBackShape = "tied"; input.observed.hair = "black hair tied in a high centered bun"; }
    if (name === "layered") { input.renderHints.outerGarment = "open_jacket"; input.renderHints.outerLayer = "heavy"; input.observed.clothing = "open brown jacket over a white collared shirt"; }
    if (name === "plain") { input.renderHints.garmentTexture = "plain"; input.observed.clothing = "plain blue t-shirt"; }
    if (name === "full-body") { input.framing = "full_body"; input.visibleRegions.lowerBody = true; input.visibleRegions.feet = true; input.inferred.lowerBody = null; input.inferred.shoes = null; input.observed.clothing = "blue t-shirt, gray pants and white sneakers"; }
    const wire = compactFixture(input);
    expect(schemaValidate(wire), JSON.stringify(schemaValidate.errors)).toBe(true);
    const rich = validatePhotoAnalysis({ ...input, inferred: wire.inferred });
    const normalized = normalizeCompactPhotoAnalysis(wire);
    expect(normalized).toEqual(rich);
    expect(normalized.ok).toBe(true);
    if (!rich.ok || !normalized.ok) return;
    const before = normalizeAnalysisForRendering(rich.analysis);
    const after = normalizeAnalysisForRendering(normalized.analysis);
    expect(buildSkinPlan(after)).toEqual(buildSkinPlan(before));
    expect(buildFacePixelPlanVariants(after, 3)).toEqual(buildFacePixelPlanVariants(before, 3));
    const atlas = (analysis: PhotoAnalysis) => {
      const colors = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      return buildProceduralFallbackAtlas(colors, buildFaceStyle(analysis, colors), buildSkinPlan(analysis));
    };
    const beforeAtlas = atlas(before);
    const afterAtlas = atlas(after);
    expect(beforeAtlas).not.toBeNull();
    expect(afterAtlas).toEqual(beforeAtlas);
  });

  it("preserves observations, confidence and inferred/unknown provenance without coordinates", () => {
    const wire = { ...compactFixture(makeAnalysis()), faceMeasurements: COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 })) };
    wire.faceMeasurements[0] = { value: "wide", provenance: "observed_categorical", confidence: 0.91 };
    wire.faceMeasurements[1] = { value: "normal", provenance: "inferred", confidence: 0.83 };
    wire.faceMeasurements[3] = { value: "close", provenance: "observed_categorical", confidence: 0.6 };
    const result = normalizeCompactPhotoAnalysis(wire);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.faceMeasurementEvidence?.cues.eyeSpacing).toEqual(wire.faceMeasurements[0]);
    expect(result.analysis.faceMeasurementEvidence?.cues.eyeOpenness).toEqual(wire.faceMeasurements[1]);
    expect(result.analysis.faceMeasurementEvidence?.cues.browEyeDistance).toEqual({ value: "unknown", provenance: "unknown", confidence: 0 });
    expect(result.analysis.identityGeometry).toBeUndefined();
    expect(result.analysis).not.toHaveProperty("faceMeasurements");
    expect(result.analysis).not.toHaveProperty("identityFeatures");
  });

  it("rejects truncated/reordered invalid slots, non-finite confidence and unknown fields", () => {
    const wire = compactFixture(makeAnalysis());
    expect(validateCompactPhotoAnalysis({ ...wire, renderHints: wire.renderHints.slice(1) })).not.toEqual([]);
    expect(validateCompactPhotoAnalysis({ ...wire, renderHints: ["coily", ...wire.renderHints.slice(1)] })).toContain("renderHints[0]:fieldVocabulary");
    expect(validateCompactPhotoAnalysis({ ...wire, faceMeasurements: COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: NaN })) })).not.toEqual([]);
    expect(validateCompactPhotoAnalysis({ ...wire, identityGeometry: {} })).not.toEqual([]);
    expect(validateCompactPhotoAnalysis({ ...wire, quality: undefined })).not.toEqual([]);
  });

  it("retains every render enum in its own positional vocabulary", () => {
    const wire = compactFixture(makeAnalysis());
    COMPACT_HINT_ORDER.forEach((key, index) => {
      for (const value of PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[key].enum) {
        const vector = [...wire.renderHints];
        vector[index] = value;
        expect(validateCompactPhotoAnalysis({ ...wire, renderHints: vector })).toEqual([]);
      }
    });
  });

  it("uses existing reconstruction only for omitted cache keys and leaves absent measurement absent", () => {
    const input = makeAnalysis();
    const wire = compactFixture(input);
    delete wire.fallbackFeatures;
    const result = normalizeCompactPhotoAnalysis(wire);
    const legacy = validatePhotoAnalysis({ ...input, inferred: wire.inferred, fallbackFeatures: undefined });
    expect(result).toEqual(legacy);
    if (result.ok) expect(result.analysis.faceMeasurementEvidence).toBeUndefined();
  });
});
