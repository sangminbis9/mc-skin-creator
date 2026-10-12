// Offline schema representation equivalence. No provider/runtime coercion.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";
import { expect, it, vi } from "vitest";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, validateGemmaNamedPhotoAnalysis,
  GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { partialGemmaTupleSchema } from "./historicalGemmaTuple";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

it("keeps full-schema acceptance identical while every standalone branch rejects absent evidence", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const before = partialGemmaTupleSchema(), after = GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA;
    const previousItem = before.properties!.faceMeasurements.items!, currentItem = after.properties!.faceMeasurements.items!;
    const oldFull = new Ajv({ allErrors: true }).compile(before), newFull = new Ajv({ allErrors: true }).compile(after);
    const oldItem = new Ajv().compile(previousItem), newItem = new Ajv().compile(currentItem);
    const branches = currentItem.anyOf!.map(b => new Ajv().compile(b));
    const withoutBranches = structuredClone(after);
    withoutBranches.properties!.faceMeasurements.items!.anyOf = previousItem.anyOf;
    expect(withoutBranches).toEqual(before);
    expect(sha(JSON.stringify(before))).toBe("6003f93e1d9134ef6675d61f8615b52154eea7a423fae6adab46e5c14dd8dde3");
    expect(sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe("b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3");
    for (const branch of currentItem.anyOf!) {
      expect(branch.type).toBe("object"); expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toEqual(["value", "provenance", "confidence"]);
      expect(Object.keys(branch.properties!)).toEqual(["value", "provenance", "confidence"]);
      expect(branch.properties!.value.type).toBe("string");
      expect(branch.properties!.provenance.type).toBe("string");
      expect(branch.properties!.confidence).toMatchObject({ type: "number", maximum: 1 });
    }
    const base = namedGemmaFixture(wireFixture(semanticFixture("plain")));
    base.faceMeasurements = Array.from({ length: 8 }, () => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    expect(oldFull(base)).toBe(true); expect(newFull(base)).toBe(true);
    const cases: unknown[] = [null, [], "unknown", 0, false];
    const values = [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat()), "invented", 0, null];
    const provenance = ["unknown", "observed_categorical", "inferred", "invented", null];
    for (const value of values) for (const p of provenance) for (const confidence of [-1, 0, 0.5, 0.749999, 0.75, 0.9, 1, 1.01, "0", null]) {
      const tuple = { value, provenance: p, confidence };
      cases.push(tuple, { ...tuple, extra: true });
      for (let mask = 0; mask < 7; mask++) cases.push(Object.fromEntries(Object.entries(tuple).filter((_, bit) => mask & (1 << bit))));
    }
    let accepted = 0, rejected = 0;
    for (const raw of cases) {
      const frozen = JSON.stringify(raw);
      const expected = oldItem(raw);
      expect(newItem(raw)).toBe(expected);
      // Even when siblings were ignored, a complete branch admits precisely the
      // same item set. This models a boundary, not a claim about provider internals.
      expect(branches.some(validate => validate(raw))).toBe(expected);
      const full = { ...base, faceMeasurements: [raw, ...base.faceMeasurements!.slice(1)] };
      expect(newFull(full)).toBe(oldFull(full));
      expect(validateGemmaNamedPhotoAnalysis(full).length === 0).toBe(newFull(full));
      expect(JSON.stringify(raw)).toBe(frozen);
      if (expected) accepted++; else rejected++;
    }
    expect(accepted).toBeGreaterThan(0); expect(rejected).toBeGreaterThan(accepted);
    const livePath = "evaluation-artifacts/reference-style-v3-e2e-short-black-sweatshirt-20261010-001/summary.json";
    const liveBytes = readFileSync(livePath, "utf8"), live = JSON.parse(liveBytes);
    expect(sha(liveBytes)).toBe("49866e567b408bf6933de6c20a9809de06d96abfef9d599e10a473dc38866f10");
    expect(live.currentDefaultE2E.result.diagnostics.primaryValidation.providerErrors).toHaveLength(16);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/gemma-complete-tuple-branches-offline-20261010-");
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_representation_equivalence_not_live_acceptance",
      oldHash: sha(JSON.stringify(before)), newHash: sha(JSON.stringify(after)), oldBytes: Buffer.byteLength(JSON.stringify(before)),
      newBytes: Buffer.byteLength(JSON.stringify(after)), cases: cases.length, accepted, rejected,
      fullSchemaParity: true, standaloneBranchParity: true, runtimeValidatorParity: true,
      v4Unchanged: true, productionDefault: "v3", sourceDataCoercion: false, providerCalls: 0,
      liveRoot: livePath, actualMissingPaths: 16, actualReturnedValues: "not_reconstructed",
      providerCompilerCause: "unproven", liveCompatibility: "unverified", deployed: false }, null, 2), { flag: "wx" });
    console.info("COMPLETE_TUPLE_BRANCHES", output);
  } finally { network.mockRestore(); }
}, 60_000);
