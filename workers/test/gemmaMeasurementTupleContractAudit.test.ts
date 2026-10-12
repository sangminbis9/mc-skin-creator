// Offline proof of the production Gemma V3 tuple constraint; no live imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";
import { expect, it, vi } from "vitest";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA,
  GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT,
  adaptGemmaNamedPhotoAnalysis, validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

// Reconstruct only the previously frozen schema by reversing the exact delta.
const schema = structuredClone(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
delete schema.properties!.faceMeasurements.items!.anyOf;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const knownValues = [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())].filter(v => v !== "unknown");
const item = schema.properties!.faceMeasurements.items!;
// The root shape/order/required fields and every other subtree are identical.
// Union vocabulary remains positional: cue-specific legality and face visibility
// remain strict-runtime responsibilities, not claims of this candidate.
const partialCandidate = {
  ...structuredClone(schema),
  properties: {
    ...structuredClone(schema.properties!),
    faceMeasurements: {
      ...structuredClone(schema.properties!.faceMeasurements),
      items: { ...structuredClone(item), anyOf: [
        { properties: { value: { enum: ["unknown"] }, provenance: { enum: ["unknown"] }, confidence: { enum: [0] } } },
        { properties: { value: { enum: knownValues }, provenance: { enum: item.properties!.provenance.enum!.filter(v => v !== "unknown") }, confidence: { minimum: 0.75 } } },
      ] },
    },
  },
};
const completeBranches = partialCandidate.properties.faceMeasurements.items.anyOf.map(branch => ({
  ...structuredClone(item),
  properties: Object.fromEntries(Object.entries(item.properties!).map(([key, field]) => [key, {
    ...structuredClone(field), ...branch.properties[key as keyof typeof branch.properties],
  }])),
}));
const candidate = { ...structuredClone(partialCandidate), properties: {
  ...structuredClone(partialCandidate.properties),
  faceMeasurements: { ...structuredClone(partialCandidate.properties.faceMeasurements),
    items: { ...structuredClone(item), anyOf: completeBranches } },
} };

it("enforces the independently specified tuple constraint without coercion or changing V4", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const productionBefore = JSON.stringify(schema);
  const validateOld = new Ajv({ allErrors: true }).compile(schema);
  const validateCandidate = new Ajv({ allErrors: true }).compile(candidate);
  const base = wireFixture(semanticFixture("plain"));
  base.visibleRegions.face = true;
  base.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  expect(validateCompactPhotoAnalysisV3(base, { imageCount: 1 })).toEqual([]);
  let valid = 0, invalid = 0;
  try {
    expect(sha(productionBefore)).toBe("ef271dc3ed81f9cbb9d30144e4abb659ea3ccf601683d9952228dd70a9bdeb0e");
    expect(candidate).toEqual(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
    expect(sha(JSON.stringify(partialCandidate))).toBe("6003f93e1d9134ef6675d61f8615b52154eea7a423fae6adab46e5c14dd8dde3");
    expect(sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe("b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3");
    expect(sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)).toBe("b7591bd73dd7436bb44fb26a80c7cd4ab039c355f52130c293e7917708913bb6");
    expect(sha(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT)).toBe("f3e6181c17740736b4f60b1cd1e8d0dbcd1915baec7169f41de533ede9c3a750");
    const removed = structuredClone(candidate);
    const { anyOf: _branches, ...originalItem } = removed.properties.faceMeasurements.items;
    void _branches;
    expect(originalItem).toEqual(item);
    expect({ ...removed, properties: { ...removed.properties, faceMeasurements: schema.properties!.faceMeasurements } }).toEqual(schema);
    for (const [index, cue] of COMPACT_FACE_ORDER.entries()) {
      for (const value of FACE_MEASUREMENT_VALUES[cue]) for (const provenance of ["unknown", "inferred", "observed_categorical"] as const)
        for (const confidence of [0, 0.5, 0.749999, 0.75, 0.9, 1]) {
          const wire = structuredClone(base);
          wire.faceMeasurements![index] = { value, provenance, confidence };
          const named = namedGemmaFixture(wire), before = JSON.stringify(named);
          const expected = value === "unknown" && provenance === "unknown" && confidence === 0
            || value !== "unknown" && provenance !== "unknown" && confidence >= 0.75;
          expect(validateOld(named)).toBe(true);
          expect(validateCandidate(named), `${cue}:${value}:${provenance}:${confidence}`).toBe(expected);
          expect(validateGemmaNamedPhotoAnalysis(named).length === 0).toBe(expected);
          expect(adaptGemmaNamedPhotoAnalysis(named).ok).toBe(expected);
          expect(validateGemmaNamedPhotoAnalysis(named, "v4")).toEqual([]);
          expect(adaptGemmaNamedPhotoAnalysis(named, "v4").ok).toBe(true);
          expect(validateCompactPhotoAnalysisV3(wire, { imageCount: 1 }).length === 0).toBe(expected);
          expect(JSON.stringify(named)).toBe(before);
          if (expected) valid++; else invalid++;
        }
    }
    const live = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-003/summary.json", "utf8"));
    const failed = live.currentDefaultE2E.result.diagnostics.failedFaceMeasurement;
    const wire = structuredClone(base);
    wire.faceMeasurements![failed.index] = { value: failed.value, provenance: failed.provenance, confidence: failed.confidence };
    // Surrounding fields are an authored valid fixture, NOT reconstructed live output.
    const modeled = namedGemmaFixture(wire);
    expect(validateOld(modeled)).toBe(true); expect(validateCandidate(modeled)).toBe(false);
    expect(validateCompactPhotoAnalysisV3(wire, { imageCount: 1 })).toContain("faceMeasurements[3]:evidenceContract");

    // This remains intentionally narrower than all runtime validation.
    const wrongCue = structuredClone(base);
    wrongCue.faceMeasurements![0] = { value: "normal", provenance: "observed_categorical", confidence: 0.9 };
    expect(validateCandidate(namedGemmaFixture(wrongCue))).toBe(true);
    expect(validateCompactPhotoAnalysisV3(wrongCue, { imageCount: 1 }).length).toBeGreaterThan(0);
    const hidden = structuredClone(base); hidden.visibleRegions.face = false;
    hidden.faceMeasurements![0] = { value: "medium", provenance: "observed_categorical", confidence: 0.9 };
    expect(validateCandidate(namedGemmaFixture(hidden))).toBe(true);
    expect(validateCompactPhotoAnalysisV3(hidden, { imageCount: 1 })).toContain("faceMeasurements[0]:evidenceContract");

    const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
    const rows = annotations.map(fixture => {
      const { analysis } = strictBoundaryAnalysisFromAnnotation(fixture);
      const compact = wireFixture(analysis), named = namedGemmaFixture(compact), before = JSON.stringify(named);
      expect(validateCandidate(named), fixture.id).toBe(true);
      const adapted = adaptGemmaNamedPhotoAnalysis(named);
      expect(adapted.ok).toBe(true); if (!adapted.ok) throw new Error("adapter_failed");
      const normalized = normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 });
      expect(normalized.ok, fixture.id).toBe(true);
      expect(normalized).toEqual(normalizeCompactPhotoAnalysisV3(compact, { imageCount: 1 }));
      expect(JSON.stringify(named)).toBe(before);
      return { id: fixture.id, candidatePass: true, normalizationIdentical: true };
    });
    expect(rows).toHaveLength(12);
    expect(JSON.stringify(schema)).toBe(productionBefore);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/gemma-measurement-tuple-implementation-offline-20261010-");
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_production_implementation_not_deployed",
      previousSchemaHash: sha(productionBefore), currentSchemaHash: sha(JSON.stringify(candidate)),
      previousBytes: Buffer.byteLength(productionBefore), currentBytes: Buffer.byteLength(JSON.stringify(candidate)),
      exactDelta: "properties.faceMeasurements.items.anyOf added as complete object branches; everything else identical",
      validCombinationsPreserved: valid, contradictoryCombinationsRejected: invalid,
      modeledLiveTupleRejected: true, surroundingLiveResponseReconstructed: false,
      residualRuntimeResponsibilities: ["cue-specific vocabulary", "face visibility", "caller source references"],
      frozenRows: rows, inputMutation: false, providerCalls: 0, providerCompatibility: "unverified",
      v4Unchanged: true, promptsUnchanged: true, deployed: false }, null, 2), { flag: "wx" });
    console.info("GEMMA_TUPLE_OFFLINE", output);
  } finally { network.mockRestore(); }
}, 60000);

it("agrees with AJV on malformed item shapes, ranges and both valid branches without mutation", () => {
  const ajv = new Ajv({ allErrors: true }).compile(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
  for (const measurement of [null, [], "unknown", {},
    { value: "unknown", provenance: "unknown" },
    { value: "unknown", provenance: "unknown", confidence: "0" },
    { value: "unknown", provenance: "unknown", confidence: 0, extra: true },
    { value: "medium", provenance: "inferred", confidence: -1 },
    { value: "medium", provenance: "inferred", confidence: 1.01 },
    { value: "invented", provenance: "inferred", confidence: 0.9 },
    { value: "unknown", provenance: "unknown", confidence: 0 },
    { value: "medium", provenance: "inferred", confidence: 0.75 },
  ]) {
    const compact = wireFixture(semanticFixture("plain"));
    compact.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    const named = namedGemmaFixture(compact);
    const raw = { ...named, faceMeasurements: [measurement, ...named.faceMeasurements!.slice(1)] };
    const before = JSON.stringify(raw);
    expect(validateGemmaNamedPhotoAnalysis(raw).length === 0).toBe(ajv(raw));
    expect(adaptGemmaNamedPhotoAnalysis(raw).ok).toBe(ajv(raw));
    expect(JSON.stringify(raw)).toBe(before);
  }
});
