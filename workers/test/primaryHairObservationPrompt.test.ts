// Offline prompt contract regression, not evidence of improved model compliance.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V2_PROMPT } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { HAIR_OBSERVATION_REINFORCEMENT as instruction, withoutHairObservationReinforcement as historical } from "./primaryHairPromptSupport";
import { withoutGemmaEvidenceReminder } from "./gemmaEvidencePromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const oldPromptHashes = {
  compactV3: "8e0e41996c9d4454da6fcdcd8a0012ea1af82346c720b631225f9f5544a4c1f1",
  gemmaNamed: "6a9c56a793475d427e9e2ed89c8b7e96bbf01fd6fb5003e2a1f27686669bbb02",
};

describe("source-independent primary hair observation reinforcement (offline)", () => {
  let network: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
  afterAll(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

  it("contains exactly one removable shared hair instruction", () => {
    // Runtime deadline changes are independently covered, not a prompt delta.
    // Full historical prompt hashes below detect any other instruction change.
    expect(ANALYSIS_PROMPT.split(instruction)).toHaveLength(2);
    expect(historical(ANALYSIS_PROMPT)).not.toContain(instruction);
  });

  it("inherits the exact instruction once in rich, v2, v3 and named Gemma primary prompts", () => {
    for (const prompt of [ANALYSIS_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
      COMPACT_PHOTO_ANALYSIS_V3_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT]) {
      expect(prompt.split(`${instruction}\n`)).toHaveLength(2);
      expect(prompt.indexOf(instruction)).toBeGreaterThan(prompt.indexOf("fringeOpening records"));
      expect(prompt.indexOf(instruction)).toBeLessThan(prompt.indexOf("hairPart is the visible parting direction"));
    }
    expect(hash(historical(withoutTiedHairObservation(COMPACT_PHOTO_ANALYSIS_V3_PROMPT)))).toBe(oldPromptHashes.compactV3);
    expect(hash(historical(withoutTiedHairObservation(withoutGemmaEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT))))).toBe(oldPromptHashes.gemmaNamed);
  });

  it("separates root part and forehead opening without demanding a centered answer or inventing evidence", () => {
    expect(instruction).toContain("inspect root/scalp direction and exposed forehead skin separately");
    expect(instruction).toContain("do not copy the bangs type, length or density");
    expect(instruction).toContain("describing the supporting observations in observed.hair");
    expect(instruction).toContain("a bang-tip gap, highlight or shadow alone does not prove a root part");
    expect(instruction).toContain("hidden evidence must not be invented");
    expect(instruction).not.toMatch(/center|원본|29002888|blazer|suit|force|always.*(?:part|opening)/i);
    expect(ANALYSIS_PROMPT).toContain("Do not infer a center part merely from a tiny separation between bang tips");
    expect(ANALYSIS_PROMPT).toContain("Prefer the actual dominant gap instead of forcing symmetry.");
    expect(ANALYSIS_PROMPT).toContain("This is independent from hairPart: a bang-tip opening can exist without visible scalp/root parting.");
  });

  it("keeps schemas, required fields and categorical vocabulary unchanged", () => {
    expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)))
      .toBe("935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986");
    expect(Buffer.byteLength(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(4688);
    expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)))
      .toBe("ef271dc3ed81f9cbb9d30144e4abb659ea3ccf601683d9952228dd70a9bdeb0e");
    const hints = PHOTO_ANALYSIS_SCHEMA.properties.renderHints;
    expect(hints.properties.hairPart.enum).toEqual(["none", "center", "left", "right"]);
    expect(hints.properties.fringeOpening.enum).toEqual(["none", "left", "center", "right"]);
    expect(hints.required).toContain("hairPart"); expect(hints.required).toContain("fringeOpening");
  });

  it("writes only new safe hash evidence and does not claim fresh live efficacy", () => {
    const root = mkdtempSync("evaluation-artifacts/primary-hair-observation-prompt-offline-20261007-");
    const report = {
      providerCalls: 0, remoteStartup: 0, liveEfficacy: "unmeasured",
      evidenceScope: "prompt_contract_regression_not_full_source_freeze", addedInstructionCount: 1,
      priorPromptHashes: oldPromptHashes,
      currentPromptHashes: { compactV3: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT), gemmaNamed: hash(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT) },
      schemaHashes: { compactV3: hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)), gemmaNamed: hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)) },
      schemaBytes: 4688, schemaHashesUnchanged: true,
      independentRootAndForeheadObservation: true, sourceSpecificExpectedAnswer: false,
      rawPromptResponseRequestImageOrSecretSaved: false,
    };
    const serialized = JSON.stringify(report, null, 2);
    expect(serialized).not.toContain(instruction);
    expect(serialized).not.toMatch(/data:image|Bearer\s|AIza|cfut_/);
    writeFileSync(`${root}/audit.json`, serialized, { flag: "wx" });
    console.info("PRIMARY_HAIR_OBSERVATION_PROMPT_AUDIT", root);
  });
});
