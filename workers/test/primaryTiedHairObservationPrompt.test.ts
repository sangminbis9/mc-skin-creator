// Offline instruction/contract evidence only: model compliance needs a fresh live run.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V2_PROMPT } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { makeAnalysis } from "./helpers";
import { TIED_HAIR_OBSERVATION as instruction, withoutTiedHairObservation as previous } from "./primaryTiedHairPromptSupport";
import { withoutGemmaSourceEvidenceReminder } from "./gemmaSourceEvidencePromptSupport";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const prior = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-002/summary.json", "utf8"));
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";

describe("independent tied-hair observation instruction", () => {
  let network: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
  afterAll(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

  it("adds exactly one shared instruction to rich, V2, V3 and Gemma without another prompt delta", () => {
    for (const prompt of [ANALYSIS_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT]) {
      expect(prompt.split(`${instruction}\n`)).toHaveLength(2);
      expect(previous(prompt)).not.toContain(instruction);
      expect(prompt.indexOf(instruction)).toBeGreaterThan(prompt.indexOf("- For observed.hair, explicitly describe root/scalp"));
      expect(prompt.indexOf(instruction)).toBeLessThan(prompt.indexOf("STEP 4 — inferred"));
    }
    expect(hash(previous(COMPACT_PHOTO_ANALYSIS_V3_PROMPT) + suffix)).toBe(prior.currentDefaultE2E.contract.geminiPromptSha256);
    expect(hash(previous(withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)) + suffix)).toBe(prior.currentDefaultE2E.contract.gemmaPromptSha256);
    const source = readFileSync("src/analysis.ts", "utf8");
    expect(hash(previous(source))).toBe(prior.currentDefaultE2E.fixedHashes["src\\analysis.ts"]);
    expect(() => previous(previous(ANALYSIS_PROMPT))).toThrow("expected_exactly_one");
    expect(() => previous(`${ANALYSIS_PROMPT}\n${instruction}\n`)).toThrow("expected_exactly_one");
  });

  it("requests observed structure separately from texture, without prescribing a paired answer", () => {
    expect(instruction).toContain("loose versus tied sections independently from straight/wavy/curly texture");
    expect(instruction).toContain("number and viewer-relative placement");
    expect(instruction).toContain("category hair and confidence supported by the image");
    expect(instruction).toContain("Do not infer a braid from waves, a ribbon, or two loose face-framing locks");
    expect(instruction).toContain("do not invent a hidden matching section or raise confidence");
    expect(instruction).not.toMatch(/reference H|image-16|29002888|twin braids|always|priority 5|confidence high/i);
  });

  it("leaves both provider schemas and vocabulary byte-identical to the consumed live run", () => {
    expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(prior.currentDefaultE2E.contract.geminiSchemaSha256);
    expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA))).toBe(prior.currentDefaultE2E.contract.gemmaSchemaSha256);
    expect(Buffer.byteLength(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(4688);
  });

  it.each([
    ["two long braids with bangs", "twin_braids"],
    ["two ponytails with bangs", "twin_tails"],
    ["long straight hair with two loose face-framing locks and a ribbon", null],
    ["long wavy hair; no braids", null],
    ["one visible braid; the other side is unseen", null],
  ] as const)("existing family selection needs evidence: %s", (hair, expected) => {
    const a = makeAnalysis();
    a.observed.hair = hair; a.identityPrompt = hair;
    a.canonicalIdentity.features = [];
    a.renderHints.overallHairLength = "chest"; a.renderHints.hairTexture = "straight";
    a.fallbackFeatures.hairstyle = "long"; a.visibleRegions.hair = true;
    const before = JSON.stringify(a);
    const paired = buildReferenceStylePlan(a).candidates.hair.filter(c => ["twin_braids", "twin_tails"].includes(c.family));
    expect(paired.map(c => c.family)).toEqual(expected ? [expected] : []);
    expect(JSON.stringify(a)).toBe(before);
  });

  it("records hashes and limitations, never full prompts or claims of live improvement", () => {
    const root = mkdtempSync("evaluation-artifacts/primary-tied-hair-observation-offline-20261010-");
    const report = {
      priorRun: "reference-style-v3-e2e-braided-ribbon-20261010-002",
      change: "one_shared_source_independent_observation_instruction",
      instructionSha256: hash(instruction),
      previousWirePromptHashes: { gemini: hash(previous(COMPACT_PHOTO_ANALYSIS_V3_PROMPT) + suffix), gemma: hash(previous(withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)) + suffix) },
      currentWirePromptHashes: { gemini: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix), gemma: hash(withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT) + suffix) },
      hashScope: "tied_hair_instruction_delta_excludes_later_Gemma_source_evidence_reminder",
      schemasUnchanged: true, schemaBytes: 4688, rendererChanged: false, validatorChanged: false,
      sourceSpecificAnswer: false, inferenceCalls: 0, remoteStartup: 0,
      liveEfficacy: "unmeasured", priorPromptCausality: "not_established",
      primaryOutputRepair: false, historicalArtifactsChanged: false,
    };
    const serialized = JSON.stringify(report, null, 2);
    expect(serialized).not.toContain(instruction);
    expect(serialized).not.toMatch(/data:image|Bearer\s|AIza|cfut_/);
    writeFileSync(`${root}/audit.json`, serialized, { flag: "wx" });
    console.info("TIED_HAIR_OBSERVATION_OFFLINE", root);
  });
});
