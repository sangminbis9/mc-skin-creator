import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  PHOTO_ANALYSIS_SCHEMA,
  validatePhotoAnalysis,
  type PhotoAnalysis,
} from "../src/analysis";
import {
  COMPACT_FACE_ORDER,
  COMPACT_HINT_GROUPS,
  COMPACT_HINT_ORDER,
  COMPACT_PHOTO_ANALYSIS_SCHEMA,
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  normalizeCompactPhotoAnalysisV2,
  restoreCompactRenderHintsV2,
  validateCompactPhotoAnalysisV2,
  type CompactHintGroupName,
  type CompactPhotoAnalysisV2,
} from "../src/compactPhotoAnalysis";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import {
  buildFaceStyle,
  buildProceduralFallbackAtlas,
  fallbackFeaturesToHex,
  normalizeAnalysisForRendering,
  refineFeatureColorsFromAnalysis,
} from "../src/generate";
import { makeAnalysis } from "./helpers";
import { analysisFromAnnotation, type AnnotatedCase } from "./generalizationSupport";

const ROOT = process.env.COMPACT_V2_OUTPUT_ROOT ?? "evaluation-artifacts/compact-primary-v2-20260909";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ajv = new Ajv({ allErrors: true });
const schemaValidate = ajv.compile(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);

type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: readonly unknown[];
};

function largestEnum(node: Schema): number {
  return Math.max(
    node.enum?.length ?? 0,
    node.items ? largestEnum(node.items) : 0,
    ...Object.values(node.properties ?? {}).map(largestEnum),
  );
}

export function compactV2Fixture(input: PhotoAnalysis): CompactPhotoAnalysisV2 {
  const raw = Object.fromEntries(
    Object.keys(PHOTO_ANALYSIS_SCHEMA.properties)
      .filter((key) => key in input)
      .map((key) => [key, input[key as keyof PhotoAnalysis]]),
  );
  delete raw.faceMeasurementEvidence;
  return {
    ...raw,
    inferred: { ...input.inferred, lowerBodyDesign: input.inferred.lowerBodyDesign ?? null },
    renderHints: Object.fromEntries(
      (Object.entries(COMPACT_HINT_GROUPS) as Array<[
        CompactHintGroupName,
        readonly (keyof PhotoAnalysis["renderHints"])[],
      ]>).map(([group, keys]) => [group, keys.map((key) => input.renderHints[key])]),
    ) as CompactPhotoAnalysisV2["renderHints"],
    canonicalIdentity: {
      overallImpression: input.canonicalIdentity.overallImpression,
      mustPreserve: input.canonicalIdentity.mustPreserve,
    },
    identityFeatures: input.canonicalIdentity.features,
    ...(input.faceMeasurementEvidence
      ? { faceMeasurements: COMPACT_FACE_ORDER.map((key) => input.faceMeasurementEvidence!.cues[key]) }
      : {}),
  } as CompactPhotoAnalysisV2;
}

function atlas(analysis: PhotoAnalysis) {
  const colors = refineFeatureColorsFromAnalysis(
    analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone),
  );
  return buildProceduralFallbackAtlas(colors, buildFaceStyle(analysis, colors), buildSkinPlan(analysis));
}

function semanticFixture(name: string): PhotoAnalysis {
  const input = makeAnalysis();
  if (name === "face") {
    input.framing = "face";
    input.visibleRegions.upperBody = false;
    input.inferred.upperBody = { value: "neutral gray shirt", rationale: "no garment observable" };
  }
  if (name === "glasses") {
    input.fallbackFeatures.glasses = "round";
    input.observed.accessories = "round silver glasses";
  }
  if (name === "covering") {
    input.fallbackFeatures.hat = "headscarf";
    input.observed.accessories = "opaque blue headscarf covering all hair";
    input.visibleRegions.hair = false;
  }
  if (name === "curly") {
    input.renderHints.hairTexture = "curly";
    input.observed.hair = "curly black hair with high crown and full sides";
  }
  if (name === "bun") {
    input.renderHints.hairBackShape = "tied";
    input.observed.hair = "black hair tied in a high centered bun";
  }
  if (name === "layered") {
    input.renderHints.outerGarment = "open_jacket";
    input.renderHints.outerLayer = "heavy";
    input.observed.clothing = "open brown jacket over a white collared shirt";
  }
  if (name === "plain") {
    input.renderHints.garmentTexture = "plain";
    input.observed.clothing = "plain blue t-shirt";
  }
  if (name === "full-body") {
    input.framing = "full_body";
    input.visibleRegions.lowerBody = true;
    input.visibleRegions.feet = true;
    input.inferred.lowerBody = null;
    input.inferred.shoes = null;
    input.observed.clothing = "blue t-shirt, gray pants and white sneakers";
  }
  return input;
}

describe("compact primary PhotoAnalysis v2 grouped render hints", () => {
  it("partitions all 45 hints into small semantic enum groups", async () => {
    const groupedKeys = Object.values(COMPACT_HINT_GROUPS).flat();
    expect(groupedKeys).toHaveLength(45);
    expect(new Set(groupedKeys).size).toBe(45);
    expect(new Set(groupedKeys)).toEqual(new Set(COMPACT_HINT_ORDER));

    const renderSchema = (COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema).properties!.renderHints;
    for (const [group, keys] of Object.entries(COMPACT_HINT_GROUPS)) {
      const expected = [...new Set(keys.flatMap((key) => PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[key].enum))];
      expect(renderSchema.properties![group].items!.enum).toEqual(expected);
      expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT).toContain(`${group} (${keys.length}):`);
      keys.forEach((key) => {
        expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT).toContain(
          `${key} = ${PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[key].enum.join(" | ")}`,
        );
      });
    }

    const rich = inspectGeminiResponseSchema(PHOTO_ANALYSIS_SCHEMA);
    const compactV1 = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_SCHEMA);
    const compactV2 = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
    expect(compactV2.valid).toBe(true);
    expect(compactV2.descriptionChars).toBe(0);
    expect(largestEnum(COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema)).toBe(121);
    expect(largestEnum(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema)).toBeLessThan(20);
    await mkdir(ROOT, { recursive: true });
    await writeFile(`${ROOT}/offline.json`, JSON.stringify({
      groups: COMPACT_HINT_GROUPS,
      groupCount: Object.keys(COMPACT_HINT_GROUPS).length,
      rich: { ...rich, largestSingleEnum: largestEnum(PHOTO_ANALYSIS_SCHEMA as Schema) },
      compactV1: { ...compactV1, largestSingleEnum: largestEnum(COMPACT_PHOTO_ANALYSIS_SCHEMA as Schema) },
      compactV2: { ...compactV2, largestSingleEnum: largestEnum(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA as Schema) },
      schemaHash: hash(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA),
      promptHash: hash(COMPACT_PHOTO_ANALYSIS_V2_PROMPT),
    }, null, 2));
  });

  it("losslessly restores all hints, plans and atlases for eight semantic fixtures", async () => {
    const results = [];
    for (const name of ["face", "glasses", "covering", "curly", "bun", "layered", "plain", "full-body"]) {
      const input = semanticFixture(name);
      const wire = compactV2Fixture(input);
      expect(schemaValidate(wire), `${name}: ${JSON.stringify(schemaValidate.errors)}`).toBe(true);
      expect(validateCompactPhotoAnalysisV2(wire), name).toEqual([]);
      const rich = validatePhotoAnalysis({ ...input, inferred: wire.inferred });
      const normalized = normalizeCompactPhotoAnalysisV2(wire);
      expect(normalized, name).toEqual(rich);
      expect(normalized.ok, name).toBe(true);
      if (!rich.ok || !normalized.ok) continue;
      expect(normalized.analysis.renderHints, name).toEqual(rich.analysis.renderHints);
      const before = normalizeAnalysisForRendering(rich.analysis);
      const after = normalizeAnalysisForRendering(normalized.analysis);
      const beforePlan = buildSkinPlan(before);
      const afterPlan = buildSkinPlan(after);
      expect(afterPlan.facePixelPlan, name).toEqual(beforePlan.facePixelPlan);
      expect(afterPlan.hairPlan, name).toEqual(beforePlan.hairPlan);
      expect(afterPlan.headIdentityPlan, name).toEqual(beforePlan.headIdentityPlan);
      expect(afterPlan.outfitPlan, name).toEqual(beforePlan.outfitPlan);
      expect(afterPlan, name).toEqual(beforePlan);
      const beforeAtlas = atlas(before);
      const afterAtlas = atlas(after);
      expect(beforeAtlas, name).not.toBeNull();
      expect(afterAtlas, name).toEqual(beforeAtlas);
      results.push({
        name,
        hintsHash: hash(normalized.analysis.renderHints),
        facePixelPlanHash: hash(afterPlan.facePixelPlan),
        hairPlanHash: hash(afterPlan.hairPlan),
        headIdentityPlanHash: hash(afterPlan.headIdentityPlan),
        outfitPlanHash: hash(afterPlan.outfitPlan),
        atlasHash: hash(afterAtlas?.rgba ?? []),
      });
    }
    expect(results).toHaveLength(8);
    await mkdir(ROOT, { recursive: true });
    await writeFile(`${ROOT}/semantic-equivalence.json`, JSON.stringify({
      passed: true,
      fixtureCount: results.length,
      sourceSemanticLoss: 0,
      planDiffs: 0,
      atlasDiffs: 0,
      results,
    }, null, 2));
  }, 15_000);

  it("rejects cross-group, wrong-slot, missing and extra group values", () => {
    const wire = compactV2Fixture(makeAnalysis());
    const crossGroup = structuredClone(wire);
    crossGroup.renderHints.complexion[0] = "open_jacket";
    expect(schemaValidate(crossGroup)).toBe(false);
    expect(validateCompactPhotoAnalysisV2(crossGroup)).toContain("compact.renderHints.complexion[0]:enum");

    const wrongSlot = structuredClone(wire);
    wrongSlot.renderHints.complexion[0] = "round";
    expect(schemaValidate(wrongSlot)).toBe(true);
    expect(validateCompactPhotoAnalysisV2(wrongSlot)).toContain("renderHints.complexion[0]:fieldVocabulary");

    const missing = structuredClone(wire);
    missing.renderHints.fringe.pop();
    expect(validateCompactPhotoAnalysisV2(missing)).toContain("renderHints.fringe:length");
    const extra = structuredClone(wire);
    extra.renderHints.eyes.push("round");
    expect(validateCompactPhotoAnalysisV2(extra)).toContain("renderHints.eyes:length");
  });

  it("retains every rich enum in its exact grouped slot vocabulary", () => {
    const wire = compactV2Fixture(makeAnalysis());
    for (const [group, keys] of Object.entries(COMPACT_HINT_GROUPS) as Array<[
      CompactHintGroupName,
      readonly (keyof PhotoAnalysis["renderHints"])[],
    ]>) {
      keys.forEach((key, index) => {
        for (const value of PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[key].enum) {
          const candidate = structuredClone(wire);
          candidate.renderHints[group][index] = value;
          expect(validateCompactPhotoAnalysisV2(candidate), `${group}[${index}]=${value}`).toEqual([]);
        }
      });
    }
  });

  it("preserves unknown categorical evidence without fabricating geometry or confidence", () => {
    const wire = compactV2Fixture(makeAnalysis());
    wire.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({
      value: "unknown",
      provenance: "unknown",
      confidence: 0,
    }));
    const result = normalizeCompactPhotoAnalysisV2(wire);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.values(result.analysis.faceMeasurementEvidence!.cues)).toEqual(
      COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 })),
    );
    expect(result.analysis.identityGeometry).toBeUndefined();
  });

  it("keeps all frozen atlases byte-identical, including the five calibrated cases", async () => {
    const annotations = JSON.parse(
      await readFile(resolve("evaluation-artifacts/generalization-20260905/annotations.json"), "utf8"),
    ) as AnnotatedCase[];
    const results = [];
    for (const fixture of annotations) {
      const analysis = analysisFromAnnotation(fixture);
      if (fixture.existing) {
        const stored = JSON.parse(await readFile(
          resolve(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`),
          "utf8",
        ));
        const geometry = parseIdentityGeometry(stored.sourceGeometryAfter);
        expect(geometry, fixture.id).not.toBeNull();
        analysis.identityGeometry = geometry!;
      }
      const wire = compactV2Fixture(analysis);
      const restored = restoreCompactRenderHintsV2(wire.renderHints);
      expect(restored.ok, fixture.id).toBe(true);
      if (!restored.ok) continue;
      const before = normalizeAnalysisForRendering(analysis);
      // Stored geometry is joined after the provider boundary; it is never a
      // compact primary response field and must not be fabricated by it.
      const after = normalizeAnalysisForRendering({
        ...analysis,
        renderHints: { ...analysis.renderHints, ...restored.renderHints },
      });
      const beforePlan = buildSkinPlan(before);
      const afterPlan = buildSkinPlan(after);
      const beforeAtlas = atlas(before);
      const afterAtlas = atlas(after);
      expect(afterPlan, fixture.id).toEqual(beforePlan);
      expect(afterAtlas, fixture.id).toEqual(beforeAtlas);
      results.push({
        id: fixture.id,
        calibrated: Boolean(fixture.existing),
        planHash: hash(afterPlan),
        atlasHash: hash(afterAtlas?.rgba ?? []),
      });
    }
    expect(results).toHaveLength(12);
    expect(results.filter((result) => result.calibrated)).toHaveLength(5);
    await writeFile(`${ROOT}/frozen-regression.json`, JSON.stringify({
      passed: true,
      cases: results.length,
      calibratedCases: results.filter((result) => result.calibrated).length,
      planDiffs: 0,
      atlasDiffs: 0,
      unrelatedDiffs: 0,
      results,
    }, null, 2));
  }, 15_000);
});
