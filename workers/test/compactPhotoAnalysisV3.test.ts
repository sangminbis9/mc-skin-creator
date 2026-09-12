import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA, validatePhotoAnalysis } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_HINT_GROUPS, COMPACT_PHOTO_ANALYSIS_PROMPT, COMPACT_PHOTO_ANALYSIS_SCHEMA,
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA, normalizeCompactPhotoAnalysisV2,
  restoreCompactRenderHintsV2, validateCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  normalizeCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3Provider,
  type CompactV3Schema as Schema } from "../src/compactPhotoAnalysisV3";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex,
  normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { validateAtlasCraft } from "../src/skinPost";
import { analysisFromAnnotation, type AnnotatedCase } from "./generalizationSupport";
import { semanticFixture, semanticNames, wireFixture, codeSchema, transcode, enumPaths } from "./compactV3Support";

const ROOT = "evaluation-artifacts/compact-v3-offline-20260910";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const context = { imageCount: 1 };
const providerValidate = new Ajv({ allErrors: true }).compile(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
const v2 = COMPACT_PHOTO_ANALYSIS_V2_SCHEMA;

function metrics(schema: Schema, prompt?: string) {
  let arrays = 0, objects = 0, nullableUnions = 0, additionalPropertiesFalse = 0, additionalPropertiesUnspecified = 0;
  const enums = enumPaths(schema);
  function visit(node: Schema) {
    if (node.type === "array") arrays++;
    if (node.type === "object" || node.type?.includes("object")) {
      objects++;
      if (node.additionalProperties === false) additionalPropertiesFalse++;
      if (node.additionalProperties === undefined) additionalPropertiesUnspecified++;
    }
    if (Array.isArray(node.type) && node.type.includes("null")) nullableUnions++;
    Object.values(node.properties ?? {}).forEach(visit);
    if (node.items) visit(node.items);
  }
  visit(schema);
  return { ...inspectGeminiResponseSchema(schema), enumDeclarations: enums.length,
    largestEnum: Math.max(0, ...enums.map(e => e.values.length)), arrays, objects, nullableUnions,
    additionalPropertiesFalse, additionalPropertiesUnspecified,
    ...(prompt === undefined ? {} : { promptBytes: Buffer.byteLength(prompt), promptHash: hash(prompt) }) };
}
function noEnums(node: Schema): Schema {
  const copy = structuredClone(node);
  delete copy.enum;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, item]) => [key, noEnums(item)]));
  if (copy.items) copy.items = noEnums(copy.items);
  return copy;
}

const candidateA = noEnums(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
function relaxStructure(node: Schema, root = true): Schema {
  const copy = structuredClone(node);
  if (!root) delete copy.required;
  delete copy.minItems; delete copy.maxItems; delete copy.minimum; delete copy.maximum;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, value]) => [key, relaxStructure(value, false)]));
  if (copy.items) copy.items = relaxStructure(copy.items, false);
  return copy;
}
const candidateB = codeSchema(relaxStructure(v2));
const promptB = `${COMPACT_PHOTO_ANALYSIS_V2_PROMPT}\nCODED OUTPUT ONLY: convert categorical values below to field-local codes after observation; codes never replace free text. Each array item uses the codebook at its [] path.\n${enumPaths(v2).map(e => `${e.path}: ${e.values.map((v, i) => `c${i.toString(36)}=${JSON.stringify(v)}`).join("|")}`).join("\n")}`;
async function artifact(name: string, value: unknown) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(`${ROOT}/${name}.json`, JSON.stringify(value, null, 2));
}
function render(analysis: Parameters<typeof normalizeAnalysisForRendering>[0]) {
  const normalized = normalizeAnalysisForRendering(analysis);
  const plan = buildSkinPlan(normalized);
  const colors = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  const style = buildFaceStyle(normalized, colors);
  const atlas = buildProceduralFallbackAtlas(colors, style, plan);
  if (!atlas) throw new Error("missing_fixture_atlas");
  return { plan, atlas,
    craft: validateAtlasCraft(atlas, style, undefined, undefined, plan),
    explicitPlanCraft: validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan),
  };
}
function compare(before: ReturnType<typeof render>, after: ReturnType<typeof render>) {
  for (const key of ["facePixelPlan", "hairPlan", "headIdentityPlan", "outfitPlan"] as const) expect(after.plan[key]).toEqual(before.plan[key]);
  expect(after.plan).toEqual(before.plan);
  expect(after.atlas).toEqual(before.atlas);
  return { planHash: hash(after.plan), atlasHash: hash(after.atlas.rgba), craft: after.craft.ok };
}

describe("Compact v3 offline contract", () => {
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); }); });
  afterAll(() => { expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard.mockRestore(); });

  it("audits all subtrees and compares three reversible representations", async () => {
    const subtrees: unknown[] = [];
    const audit = (node: Schema, path: string) => {
      const root = path.split(/[.[]/)[0];
      const semanticImportance = ["quality", "failReason", "framing", "sourceSelection", "faceMeasurements", "canonicalIdentity", "identityFeatures"].includes(root)
        ? "identity/evidence interpretation" : root === "fallbackFeatures" ? "optional palette/cache overrides; preserve unique choices" : "source observation/rendering/completion; retain losslessly";
      subtrees.push({ path, ...metrics(node), semanticImportance,
        movableConstraints: [node.enum && "categorical vocabulary", node.required && "required fields", (node.minItems !== undefined || node.maxItems !== undefined) && "array bounds", (node.minimum !== undefined || node.maximum !== undefined) && "number bounds"].filter(Boolean) });
      Object.entries(node.properties ?? {}).forEach(([key, item]) => audit(item, path ? `${path}.${key}` : key));
      if (node.items) audit(node.items, `${path}[]`);
    };
    Object.entries(v2.properties!).forEach(([key, item]) => audit(item, key));
    const candidates = {
      A: { ...metrics(candidateA, COMPACT_PHOTO_ANALYSIS_V3_PROMPT), newCodeMappings: 0 },
      B: { ...metrics(candidateB, promptB), newCodeMappings: enumPaths(v2).reduce((n, e) => n + e.values.length, 0) },
      C: { ...metrics(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, COMPACT_PHOTO_ANALYSIS_V3_PROMPT), newCodeMappings: 0 },
    };
    const generations = {
      rich: metrics(PHOTO_ANALYSIS_SCHEMA, ANALYSIS_PROMPT), v1: metrics(COMPACT_PHOTO_ANALYSIS_SCHEMA, COMPACT_PHOTO_ANALYSIS_PROMPT),
      v2: metrics(v2, COMPACT_PHOTO_ANALYSIS_V2_PROMPT), v3: metrics(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
    };
    for (const candidate of Object.values(candidates)) expect(candidate.valid).toBe(true);
    expect(generations.v3.serializedBytes!).toBeLessThanOrEqual(5120);
    expect(generations.v3.enumValueCount).toBeLessThan(45);
    expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT.split("COMPACT WIRE CONTRACT")[0]).toBe(ANALYSIS_PROMPT + "\n\n");
    expect(generations.v3.promptBytes! / generations.v2.promptBytes!).toBeLessThan(1.1);
    for (const e of enumPaths(v2)) expect(new Set(e.values.map((_, i) => `c${i.toString(36)}`)).size).toBe(e.values.length);
    await artifact("complexity", { generations, candidates, selected: "C", subtrees, liveCalls: 0,
      risks: { A: "no provider vocabulary protection even for provenance/quality", B: "250 code mappings, enum declaration count unchanged, added prompt/codebook ambiguity", C: "provider union blocks out-of-contract measurement tokens; per-cue runtime rejection remains authoritative" },
      estimatedProviderLimit: null });
  });

  it("uses the canonical measurement union only at the provider faceMeasurements value boundary", () => {
    const canonicalUnion = [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())];
    const valueSchema = COMPACT_PHOTO_ANALYSIS_V3_SCHEMA.properties!.faceMeasurements
      .items!.properties!.value;
    expect(canonicalUnion).toHaveLength(16);
    expect(valueSchema.enum).toEqual(canonicalUnion);
    for (const values of Object.values(FACE_MEASUREMENT_VALUES)) {
      expect(values.every((value) => canonicalUnion.includes(value))).toBe(true);
    }

    const previousProviderSchema = structuredClone(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
    delete previousProviderSchema.properties!.faceMeasurements.items!.properties!.value.enum;
    const before = metrics(previousProviderSchema);
    const after = metrics(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
    expect(before).toMatchObject({ serializedBytes: 4539, propertyCount: 98, requiredCount: 13,
      depth: 5, enumDeclarations: 6, enumValueCount: 23, largestEnum: 6 });
    expect(after).toMatchObject({ propertyCount: before.propertyCount, requiredCount: before.requiredCount,
      depth: before.depth, enumDeclarations: before.enumDeclarations + 1,
      enumValueCount: before.enumValueCount + canonicalUnion.length, largestEnum: canonicalUnion.length });

    const base = wireFixture(semanticFixture("plain"));
    base.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    const invalid = structuredClone(base);
    invalid.faceMeasurements[0] = { value: "average", provenance: "observed_categorical", confidence: 0.95 };
    expect(providerValidate(invalid)).toBe(false);
    expect(validateCompactPhotoAnalysisV3Provider(invalid)).toContain("compact.faceMeasurements[0].value:enum");

    for (const value of canonicalUnion) {
      const providerCandidate = structuredClone(base);
      providerCandidate.faceMeasurements[0] = value === "unknown"
        ? { value, provenance: "unknown", confidence: 0 }
        : { value, provenance: "observed_categorical", confidence: 0.9 };
      expect(providerValidate(providerCandidate), value).toBe(true);
    }

    const wrongCue = structuredClone(base);
    wrongCue.faceMeasurements[0] = { value: "normal", provenance: "observed_categorical", confidence: 0.9 };
    expect(providerValidate(wrongCue)).toBe(true);
    expect(validateCompactPhotoAnalysisV3(wrongCue, context)).toContain("faceMeasurements[0]:fieldVocabulary");

    const validCue = structuredClone(base);
    validCue.faceMeasurements[0] = { value: "medium", provenance: "observed_categorical", confidence: 0.9 };
    expect(providerValidate(validCue)).toBe(true);
    expect(validateCompactPhotoAnalysisV3(validCue, context)).toEqual([]);
  });

  it("preserves all eight semantic fixtures through full v3 normalization and all plans/atlases", async () => {
    const results = [];
    for (const name of semanticNames) {
      const input = semanticFixture(name), wire = wireFixture(input);
      const encoded = transcode(v2, wire, false);
      expect(new Ajv().compile(candidateB)(encoded)).toBe(true);
      const decoded = transcode(v2, encoded, true);
      expect(decoded).toEqual(wire);
      expect(normalizeCompactPhotoAnalysisV3(decoded, context)).toEqual(normalizeCompactPhotoAnalysisV3(wire, context));
      expect(new Ajv().compile(candidateA)(wire)).toBe(true);
      expect(providerValidate(wire), name).toBe(true);
      expect(validateCompactPhotoAnalysisV3Provider(wire), name).toEqual([]);
      expect(validateCompactPhotoAnalysisV3(wire, context), name).toEqual([]);
      const rich = validatePhotoAnalysis({ ...input, inferred: wire.inferred });
      const v2Result = normalizeCompactPhotoAnalysisV2(wire);
      const v3Result = normalizeCompactPhotoAnalysisV3(wire, context);
      expect(v3Result, name).toEqual(v2Result);
      expect(v3Result, name).toEqual(rich);
      if (!rich.ok || !v3Result.ok) throw new Error("normalization_failed");
      results.push({ name, semanticHash: hash(v3Result.analysis), ...compare(render(rich.analysis), render(v3Result.analysis)) });
    }
    await artifact("semantic-equivalence", { fixtures: 8, candidatesRoundtrip: ["A", "B", "C"], sourceSemanticLoss: 0, planDiffs: 0, atlasDiffs: 0, results });
  }, 30_000);

  it("enforces vocabulary, field presence, bounds, provenance and caller-owned references at runtime", async () => {
    const base = wireFixture(semanticFixture("plain"));
    base.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    expect(validateCompactPhotoAnalysisV3(base, context)).toEqual([]);
    type Mutable = {
      renderHints: Record<string, unknown[]>; observed: Record<string, unknown>;
      faceMeasurements: Array<Record<string, unknown>>; sourceSelection: Record<string, unknown>;
      visibleRegions: Record<string, unknown>; inferred?: Record<string, unknown>; identityFeatures: unknown[];
    };
    const mutations: Array<[string, (wire: Mutable) => void]> = [
      ["unknown token", w => { w.renderHints.complexion[0] = "invented"; }],
      ["wrong slot valid group token", w => { w.renderHints.complexion[0] = "round"; }],
      ["short group", w => { w.renderHints.eyes.pop(); }],
      ["extra group", w => { w.renderHints.extra = []; }],
      ["missing group", w => { delete w.renderHints.eyes; }],
      ["missing nested semantic", w => { delete w.observed.face; }],
      ["missing root semantic", w => { delete w.inferred; }],
      ["unexpected nested field", w => { w.observed.extra = "x"; }],
      ["bad provenance", w => { w.faceMeasurements[0].provenance = "calibrated_geometry"; }],
      ["range", w => { w.faceMeasurements[0].confidence = 1.1; }],
      ["nonfinite", w => { w.faceMeasurements[0].confidence = NaN; }],
      ["infinity", w => { w.faceMeasurements[0].confidence = Infinity; }],
      ["unknown positive confidence", w => { w.faceMeasurements[0].confidence = 0.9; }],
      ["uncertain observed", w => { w.faceMeasurements[0] = { value: "wide", provenance: "observed_categorical", confidence: 0.7 }; }],
      ["hidden observed", w => { w.visibleRegions.face = false; w.faceMeasurements[0] = { value: "wide", provenance: "observed_categorical", confidence: 0.9 }; }],
      ["wrong measurement slot", w => { w.faceMeasurements[0] = { value: "teeth", provenance: "observed_categorical", confidence: 0.9 }; }],
      ["wrong source reference", w => { w.sourceSelection.portraitImageIndex = 1; }],
      ["extra reference owner", w => { w.faceMeasurements[0].referenceImageIndex = 1; }],
      ["malformed category", w => { w.renderHints.eyes[0] = {}; }],
      ["bad inferred enum", w => { w.inferred!.lowerBodyDesign = { bottomType: "invented" }; }],
      ["missing measurement", w => { w.faceMeasurements.pop(); }],
      ["missing cue value", w => { delete w.faceMeasurements[0].value; }],
      ["sparse array", w => { delete w.renderHints.eyes[0]; }],
      ["short feature list", w => { w.identityFeatures.pop(); }],
    ];
    const results = mutations.map(([name, mutate]) => {
      const wire: Mutable = JSON.parse(JSON.stringify(base)); mutate(wire);
      const errors = validateCompactPhotoAnalysisV3(wire, context);
      expect(errors.length, name).toBeGreaterThan(0);
      expect(normalizeCompactPhotoAnalysisV3(wire, context).ok, name).toBe(false);
      return { name, providerAccepted: providerValidate(wire), runtimeRejected: true };
    });
    expect(results.some(r => r.providerAccepted)).toBe(true);
    expect(validateCompactPhotoAnalysisV3(base, { imageCount: 1, portraitImageIndex: 1 }).length).toBeGreaterThan(0);
    expect(validateCompactPhotoAnalysisV3(base, { imageCount: 0 }).length).toBeGreaterThan(0);
    const multi = structuredClone(base); multi.sourceSelection.portraitImageIndex = 1;
    multi.faceMeasurements![0] = { value: "wide", provenance: "observed_categorical", confidence: 0.9 };
    const result = normalizeCompactPhotoAnalysisV3(multi, { imageCount: 2, portraitImageIndex: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.faceMeasurementEvidence!.referenceImageIndex).toBe(1);
    // Every allowed rich render-hint token survives, in its proper slot.
    let positiveTokens = 0;
    for (const [group, keys] of Object.entries(COMPACT_HINT_GROUPS)) keys.forEach((key, index) => {
      for (const token of PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[key].enum) {
        const wire = structuredClone(base);
        wire.renderHints[group as keyof typeof wire.renderHints][index] = token;
        expect(validateCompactPhotoAnalysisV3(wire, context)).toEqual([]); positiveTokens++;
      }
    });
    await artifact("negative-validation", { rejected: results.length, results, positiveTokens, liveCalls: 0 });
  });

  it("rejects every vocabulary and required-field mutation before rich defaults can hide it", async () => {
    const base = wireFixture(semanticFixture("plain"));
    base.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    base.inferred.lowerBodyDesign = {
      bottomType: "pants", bottomPattern: "plain", bottomAccent: "none", legwear: "none",
      legwearAsymmetry: "none", thighAccessory: "none", thighAccessorySide: "none", shoeStyle: "sneakers",
      rationale: "minimum unobserved completion consistent with the visible outfit",
    };
    expect(validateCompactPhotoAnalysisV3(base, context)).toEqual([]);
    const paths: Array<{ kind: string; path: Array<string | number> }> = [];
    function visit(node: Schema, value: unknown, path: Array<string | number>): void {
      if (node.enum) paths.push({ kind: "vocabulary", path });
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value) && node.items) value.forEach((item, index) => visit(node.items!, item, [...path, index]));
      else {
        for (const key of node.required ?? []) paths.push({ kind: "required", path: [...path, key] });
        for (const [key, item] of Object.entries(value)) if (node.properties?.[key]) visit(node.properties[key], item, [...path, key]);
      }
    }
    visit(v2, base, []);
    for (const { kind, path } of paths) {
      const raw = structuredClone(base);
      let parent: unknown = raw;
      for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
      const container = parent as Record<string | number, unknown>;
      if (kind === "required") delete container[path.at(-1)!];
      else container[path.at(-1)!] = "__invalid_vocabulary__";
      expect(validateCompactPhotoAnalysisV3(raw, context).length, `${kind}:${path.join(".")}`).toBeGreaterThan(0);
    }
    const coded = transcode(v2, base, false) as Record<string, unknown>;
    coded.quality = "c_unknown";
    expect(() => transcode(v2, coded, true)).toThrow("invalid_field_local_code");
    const before = hash(base);
    expect(normalizeCompactPhotoAnalysisV3(base, context).ok).toBe(true);
    expect(hash(base)).toBe(before);
    await artifact("systematic-validation", { mutationsRejected: paths.length, requiredMutations: paths.filter(p => p.kind === "required").length,
      vocabularyMutations: paths.filter(p => p.kind === "vocabulary").length, inputMutation: false, codeUnknownRejected: true });
  });

  it("replays frozen twelve without modifying source or silently accepting invalid legacy inputs", async () => {
    const annotations = JSON.parse(await readFile("evaluation-artifacts/generalization-20260905/annotations.json", "utf8")) as AnnotatedCase[];
    const frozen = JSON.parse(await readFile("evaluation-artifacts/compact-primary-v2-20260909/frozen-regression.json", "utf8"));
    const results = [];
    for (const fixture of annotations) {
      const analysis = analysisFromAnnotation(fixture);
      if (fixture.existing) {
        const stored = JSON.parse(await readFile(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8"));
        analysis.identityGeometry = parseIdentityGeometry(stored.sourceGeometryAfter)!;
        expect(analysis.identityGeometry).toBeTruthy();
      }
      const wire = wireFixture(analysis);
      const before = render(analysis);
      const v2Errors = validateCompactPhotoAnalysisV2(wire);
      const v3Errors = validateCompactPhotoAnalysisV3(wire, context);
      // Frozen manual adapter is not necessarily a valid provider response. Never pad observations.
      const restored = restoreCompactRenderHintsV2(wire.renderHints);
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error("hint_restore_failed");
      const replay = render({ ...analysis, renderHints: { ...analysis.renderHints, ...restored.renderHints } });
      const hashes = compare(before, replay);
      const previous = frozen.results.find((r: { id: string }) => r.id === fixture.id);
      expect(hashes.planHash, fixture.id).toBe(previous.planHash);
      expect(hashes.atlasHash, fixture.id).toBe(previous.atlasHash);
      const v3Result = normalizeCompactPhotoAnalysisV3(wire, context);
      const v2Result = normalizeCompactPhotoAnalysisV2(wire);
      if (v3Result.ok && v2Result.ok) {
        expect(v3Result.analysis).toEqual(v2Result.analysis);
        compare(render({ ...v2Result.analysis, identityGeometry: analysis.identityGeometry }), render({ ...v3Result.analysis, identityGeometry: analysis.identityGeometry }));
      } else expect(v3Result.ok).toBe(false);
      results.push({ id: fixture.id, calibrated: Boolean(fixture.existing), ...hashes, craftProblems: replay.craft.problems,
        explicitPlanCraft: replay.explicitPlanCraft, fullBoundaryAccepted: v3Result.ok, v2Errors, v3Errors });
    }
    expect(results).toHaveLength(12);
    expect(results.filter(r => r.calibrated)).toHaveLength(5);
    await artifact("frozen-regression", { cases: 12, craftApproved: results.filter(r => r.craft).length, calibrated: 5, planDiffs: 0, atlasDiffs: 0,
      fullBoundaryAccepted: results.filter(r => r.fullBoundaryAccepted).length, results });
    expect(results.filter(r => r.craft)).toHaveLength(12);
  }, 30_000);

  it("keeps renderer/quantizer/validator and compact contract bytes unchanged during activation", async () => {
    const frozen: Record<string, string> = {
      "skinPack.ts": "583264b7818b8d30853e03901a8e5005c407e28c61406fec4feeee4d5e0b18cd",
      "skinPost.ts": "1e045eddb4ce3b39e197a7a3eeaef3637b642224249f328c6f718db35646d535",
      "skinPlan.ts": "54bbde6408608feb6b3458a42a1042988f09204af269fd028e19b5cda97989bc",
      "identityQuantization.ts": "ec238f24edefb3ff022eed54e829a00ebac64fec8aea293d8c7b3f92c708174c",
      "identityPlans.ts": "c1df36857e886042d56c1b460e167440d85e3153b4ccbf56070b7033e093bd1c",
      "compactPhotoAnalysis.ts": "4c5c13947b0196c0a6a718ed8b9d57cac484a9bd59ccabebd5b59f6523743d89",
      "compactPhotoAnalysisV3.ts": "99d8ca426f96410aad424a459b91f6da3e796979010d8443cebf653487b8a702",
    };
    for (const [file, expected] of Object.entries(frozen)) {
      expect(createHash("sha256").update(await readFile(`src/${file}`)).digest("hex"), file).toBe(expected);
    }
  });
});
