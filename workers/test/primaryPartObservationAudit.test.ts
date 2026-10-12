// Offline contract proof, not reconstruction of unavailable provider output.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA } from "../src/analysis";
import { COMPACT_HINT_GROUPS, COMPACT_PHOTO_ANALYSIS_V2_PROMPT } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { adaptGemmaNamedPhotoAnalysis, GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { normalizeAnalysisForRendering } from "../src/generate";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { withoutHairObservationReinforcement } from "./primaryHairPromptSupport";
import { withoutGemmaEvidenceReminder, withoutGemmaEvidenceSourceDelta } from "./gemmaEvidencePromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const livePath = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json";
const enumPart = PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties.hairPart.enum;
const enumOpening = PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties.fringeOpening.enum;

describe("primary part observation boundary — no provider", () => {
  it("keeps independent part/opening semantics and exact vocabularies in both provider prompts", () => {
    expect(COMPACT_HINT_GROUPS.hairSides[0]).toBe("hairPart");
    expect(COMPACT_HINT_GROUPS.fringe[4]).toBe("fringeOpening");
    const partClause = "hairPart is the visible parting direction from the viewer's perspective: center, left, right, or none.";
    const openingClause = "fringeOpening records the largest visible forehead gap between front-hair clusters from the viewer's perspective: left, center, right, or none.";
    const independentClause = "This is independent from hairPart: a bang-tip opening can exist without visible scalp/root parting.";
    for (const prompt of [ANALYSIS_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
      COMPACT_PHOTO_ANALYSIS_V3_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT]) {
      expect(prompt).toContain(partClause);
      expect(prompt).toContain(openingClause);
      expect(prompt).toContain(independentClause);
    }
    expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).toContain(`0: hairPart = ${enumPart.join(" | ")}`);
    expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).toContain(`4: fringeOpening = ${enumOpening.join(" | ")}`);
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain(`hairPart: ${enumPart.join(" | ")}`);
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain(`fringeOpening: ${enumOpening.join(" | ")}`);
    const hints = GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA.properties!.renderHints.properties!;
    expect(hints.hairSides.properties!.hairPart.enum).toEqual(enumPart);
    expect(hints.fringe.properties!.fringeOpening.enum).toEqual(enumOpening);
  });

  it("preserves all sixteen named part/opening combinations through strict and render normalization", () => {
    for (const hairPart of enumPart) for (const fringeOpening of enumOpening) {
      // Authored semantic unit. Do not call this a recovered real response.
      const source = semanticFixture("plain");
      source.observed.hair = "short straight brown hair";
      source.identityPrompt = "short straight brown hair";
      source.inferred.hairBack = { value: "short hair", rationale: "authored unit" };
      Object.assign(source.renderHints, { hairPart, fringeOpening });
      const named = namedGemmaFixture(wireFixture(source)), immutable = JSON.stringify(named);
      const adapted = adaptGemmaNamedPhotoAnalysis(named);
      expect(adapted.ok).toBe(true);
      if (!adapted.ok) throw new Error(adapted.errors.join(";"));
      expect(adapted.compact.renderHints.hairSides[0]).toBe(hairPart);
      expect(adapted.compact.renderHints.fringe[4]).toBe(fringeOpening);
      const rich = normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 });
      expect(rich.ok).toBe(true);
      if (!rich.ok) throw new Error(rich.errors.join(";"));
      const render = normalizeAnalysisForRendering(rich.analysis);
      expect(render.renderHints.hairPart).toBe(hairPart);
      expect(render.renderHints.fringeOpening).toBe(fringeOpening);
      expect(JSON.stringify(named)).toBe(immutable);
    }
  });

  it("rejects missing named cues instead of silently converting absence to none", () => {
    for (const [group, field] of [["hairSides", "hairPart"], ["fringe", "fringeOpening"]]) {
      const named = namedGemmaFixture(wireFixture(semanticFixture("plain")));
      delete named.renderHints[group][field];
      const result = adaptGemmaNamedPhotoAnalysis(named);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContain(`gemma.renderHints.${group}.${field}:required`);
    }
  });

  it("records the real validated-primary miss without attributing omitted prose or inventing raw evidence", () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const bytes = readFileSync(livePath);
      expect(sha(bytes)).toBe("c47ee4e58111e816a5cd1c27150028b229724e5b9f2ecce7e0e120796a706561");
      const saved = JSON.parse(bytes.toString()).currentDefaultE2E;
      const trace = saved.result.propagationTrace;
      const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
      // The approved new observation instruction must not rewrite the old run's contract.
      expect(sha(withoutHairObservationReinforcement(withoutTiedHairObservation(COMPACT_PHOTO_ANALYSIS_V3_PROMPT)) + referenceSuffix)).toBe(saved.contract.geminiPromptSha256);
      expect(sha(withoutHairObservationReinforcement(withoutTiedHairObservation(withoutGemmaEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT))) + referenceSuffix)).toBe(saved.contract.gemmaPromptSha256);
      expect(sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA))).toBe(saved.contract.gemmaSchemaSha256);
      // Prompt hashes above pin the actual wire. Independently authorized
      // runtime deadline code does not change this historical observation.
      for (const file of ["compactPhotoAnalysis.ts", "compactPhotoAnalysisV3.ts", "gemmaPhotoAnalysis.ts"]) {
        const source = readFileSync(`src/${file}`, "utf8");
        expect(sha(file === "gemmaPhotoAnalysis.ts" ? withoutGemmaEvidenceSourceDelta(source) : source), file)
          .toBe(saved.fixedHashes[`src\\${file}`]);
      }
      expect(trace.providerStage).toBe("gemmaPrimary");
      expect(trace.primary.renderHints.hairPart).toBe("none");
      expect(trace.primary.renderHints.fringeOpening).toBe("none");
      expect(trace.renderAnalysis.renderHints.hairPart).toBe("none");
      expect(trace.renderAnalysis.renderHints.fringeOpening).toBe("none");
      expect(trace.injectedParameters.faceStyle.hairPart).toBe("none");
      expect(trace.injectedParameters.faceStyle.fringeOpening).toBe("none");
      expect(trace.skinPlan.skinPlan.hairPlan.part).toBe("none");
      expect(trace.primary.observed.hair).toContain("dense, blunt fringe covering the forehead");
      expect(trace.projectionChanges).not.toContain("primary.observed.hair");
      expect(trace.projectionChanges).not.toContain("primary.renderHints.hairPart");
      expect(trace.projectionChanges).not.toContain("primary.renderHints.fringeOpening");
      expect(trace.replay.finalAtlasMatch).toBe(true);
      const root = mkdtempSync("evaluation-artifacts/primary-part-observation-audit-20261007-");
      writeFileSync(`${root}/audit.json`, JSON.stringify({ providerCalls: 0, productionChanges: 0,
        sourceSummarySha256: sha(bytes), runId: trace.runId, providerStage: trace.providerStage,
        evidenceBoundary: "validated_primary_not_raw_provider_payload",
        rawResponseAvailable: false, omittedIdentityPromptNotReconstructed: true,
        sourceReview: { provenance: "manual_source_review", hairPart: "center", fringeOpening: "center" },
        primary: { hairPart: "none", fringeOpening: "none", description: "dense_blunt_forehead_covering" },
        downstream: { normalizedPart: "none", normalizedOpening: "none", injectedPart: "none",
          injectedOpening: "none", plannedPart: "none", exactSameRunReplay: true },
        earliestLoss: "PRIMARY_MISSED", adapterVocabularyDrift: 0, independentCombinationsPreserved: 16,
        missingCueRejectedNotDefaulted: true, reasonForModelObservationError: "unobserved",
        promptHashes: { compactV3: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT), gemmaNamed: sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT) },
        historicalPromptAndSourceRecoveredByRemovingOnlyApprovedInstruction: true,
        historicalSchemaHashEquality: true, currentPromptIntentionallyChanged: true,
        currentPromptLiveEfficacy: "unmeasured",
        promptSemantics: { partDefined: true, openingDefined: true, independenceDefined: true },
        doNotInferCenterPartFromRendererOrSourceAtRuntime: true }, null, 2), { flag: "wx" });
      // Full-file byte identity is pinned by digest; deep-comparing 777k
      // Buffer entries is unrelated to this contract and wastes test CPU.
      expect(sha(readFileSync(livePath))).toBe(sha(bytes));
      expect(network).not.toHaveBeenCalled();
      console.info("PRIMARY_PART_OBSERVATION_AUDIT", root);
    } finally { network.mockRestore(); }
  });
});
