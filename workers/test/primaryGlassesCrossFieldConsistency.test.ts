import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { resolveFaceMeasurements, type FaceMeasurementEvidence } from "../src/faceMeasurementEvidence";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { makeAnalysis } from "./helpers";

const LIVE = path.resolve("evaluation-artifacts/bound-profile-cli-primary-canary-live-20260921-001/summary.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const OUTPUT = path.resolve("evaluation-artifacts/primary-glasses-cross-field-consistency-20260921-001");
const BUILD = process.env.BUILD_PRIMARY_GLASSES_CONSISTENCY === "approved-offline";

type LiveSummary = {
  selectedCanary: { id: string; expectedSha256: string; expectedBytes: number };
  primary: {
    visibleRegions: PhotoAnalysis["visibleRegions"];
    sourceSelection: Pick<PhotoAnalysis["sourceSelection"], "portraitImageIndex" | "outfitImageIndex" | "generationImageIndex">;
    faceMeasurementEvidence: FaceMeasurementEvidence;
    relevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
    canonicalFaceCues: Array<Record<string, unknown>>;
    measurementTraceSelected: Record<string, string>;
    categoricalOnlyFaceLayoutPlan: Record<string, unknown>;
  };
};

type StoredCase = {
  analysis: PhotoAnalysis;
  sourceAnnotation: { accessories?: string; face?: string; hair?: string };
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const caseFile = (id: string) => path.join(GENERALIZATION, "after", id, "analysis-and-plan.json");
const glassesTokens = ["none", "regular", "round", "sunglasses"] as const;

function minimalIdentity(overallImpression: string, hairEvidence: string, accessoryEvidence: string) {
  return {
    overallImpression,
    mustPreserve: ["long blonde waves", "visible eyes", "open black blazer", accessoryEvidence],
    features: [
      { feature: "long blonde waves", category: "hair" as const, priority: 5 as const, confidence: "high" as const, evidence: hairEvidence, targetRegions: ["head.front", "head.overlay"] },
      { feature: "visible eyes", category: "face" as const, priority: 5 as const, confidence: "high" as const, evidence: "both eyes are unobstructed", targetRegions: ["head.front"] },
      { feature: "open black blazer", category: "outfit" as const, priority: 4 as const, confidence: "high" as const, evidence: "dark lapels surround a beige inner shirt", targetRegions: ["torso.front"] },
      { feature: accessoryEvidence, category: "accessory" as const, priority: 3 as const, confidence: "high" as const, evidence: accessoryEvidence, targetRegions: ["torso.front"] },
    ],
  };
}

function normalizeTextCase(options: {
  hair: string;
  accessories: string;
  identityPrompt: string;
  impression: string;
  fallbackGlasses?: string;
}) {
  const seed = makeAnalysis();
  const result = validatePhotoAnalysis(makeAnalysis({
    observed: {
      ...seed.observed,
      face: "oval face with directly visible eyes and brows",
      hair: options.hair,
      accessories: options.accessories,
      clothing: "open black blazer over a beige inner shirt",
    },
    canonicalIdentity: minimalIdentity(options.impression, options.hair, options.accessories),
    identityPrompt: options.identityPrompt,
    outfitPrompt: "Open black blazer, beige inner shirt, and fine gold necklace.",
    fallbackFeatures: options.fallbackGlasses === undefined
      ? {} as never
      : { glasses: options.fallbackGlasses } as never,
  }));
  expect(result.ok, result.ok ? undefined : result.errors.join("\n")).toBe(true);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.analysis;
}

function liveCounterfactual(summary: LiveSummary, glasses: typeof glassesTokens[number]) {
  const seed = makeAnalysis();
  const analysis = makeAnalysis({
    visibleRegions: { ...seed.visibleRegions, ...summary.primary.visibleRegions },
    sourceSelection: { ...seed.sourceSelection, ...summary.primary.sourceSelection },
    renderHints: { ...seed.renderHints, ...summary.primary.relevantRenderHints },
    fallbackFeatures: { ...seed.fallbackFeatures, glasses, expression: "neutral" },
    faceMeasurementEvidence: structuredClone(summary.primary.faceMeasurementEvidence),
    identityGeometry: undefined,
  });
  const trace = resolveFaceMeasurements(analysis);
  const layout = buildFacePixelPlanVariants(analysis, 1)[0].layout;
  return {
    glasses,
    measurementTrace: Object.fromEntries(Object.entries(trace).map(([cue, decision]) => [cue, {
      selected: decision.selected,
      reason: decision.reason,
      value: decision.value,
      provenance: decision.provenance,
      confidence: decision.confidence,
    }])),
    faceLayoutPlan: {
      eyeSpacing: layout.eyeSpacingTopology,
      eyeFootprint: layout.eyeFootprintTopology,
      eyeOpenness: layout.eyeOpenness,
      browEyeDistance: layout.browDistanceTopology,
      browSlope: layout.browSlopeTopology,
      mouthWidth: layout.mouthWidth,
      mouthOpenness: layout.mouthOpening,
      expression: layout.mouthExpressionTopology,
      glassesMaskPixels: layout.glassesMask.length,
    },
  };
}

function sentinel(id: string, sourceGlasses: "present" | "absent") {
  const stored = readJson<StoredCase>(caseFile(id));
  const analysis = stored.analysis;
  const glasses = analysis.fallbackFeatures.glasses;
  const accessoryFeatures = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "accessory")
    .map(({ feature, evidence, confidence }) => ({ feature, evidence, confidence }));
  return {
    id,
    sourceGlasses,
    fallbackFeaturesGlasses: glasses,
    observedAccessories: analysis.observed.accessories,
    canonicalAccessoryFeatures: accessoryFeatures,
    sourceSelection: analysis.sourceSelection,
    glassesConstrained: glasses !== "none",
    taxonomy: sourceGlasses === "present" && glasses !== "none"
      ? "CONSISTENT_PRESENT"
      : sourceGlasses === "absent" && glasses === "none"
        ? "CONSISTENT_ABSENT"
        : "SOURCE_CONFLICT",
  };
}

function diagnose() {
  const live = readJson<LiveSummary>(LIVE);
  const annotations = readJson<Array<{ id: string; accessories: string; features: Record<string, unknown> }>>(path.join(GENERALIZATION, "annotations.json"));
  const sourceRubric = readJson<{ cases: Array<{ id: string; glassesOrCovering: string; faceVisibility: string; pose: string }> }>(RUBRIC);
  const annotation = annotations.find((item) => item.id === live.selectedCanary.id)!;
  const rubric = sourceRubric.cases.find((item) => item.id === live.selectedCanary.id)!;

  const hairFrames = normalizeTextCase({
    hair: "long blonde hair frames the face on both sides",
    accessories: "fine gold necklace; no visible eyewear",
    identityPrompt: "Long blonde hair frames a bare face with visible eyes.",
    impression: "Long blonde waves and a bare, unobstructed face.",
  });
  const contextualFrames = normalizeTextCase({
    hair: "long blonde waves fall behind both shoulders",
    accessories: "thin frames around both eyes",
    identityPrompt: "Thin frames around both visible eyes.",
    impression: "A face with thin prescription eyewear.",
  });
  const round = normalizeTextCase({
    hair: "dark textured hair",
    accessories: "large round glasses",
    identityPrompt: "Large round glasses dominate the face.",
    impression: "Large round glasses and dark hair.",
  });
  const sunglasses = normalizeTextCase({
    hair: "short brown hair",
    accessories: "dark sunglasses",
    identityPrompt: "Dark sunglasses cover both eyes.",
    impression: "Dark sunglasses and short hair.",
  });
  const explicitStale = normalizeTextCase({
    hair: "long blonde hair falls beside the face",
    accessories: "fine gold necklace; no visible eyewear",
    identityPrompt: "Bare face with visible eyes.",
    impression: "Long blonde waves and a bare face.",
    fallbackGlasses: "regular",
  });
  const invalidUnknown = normalizeTextCase({
    hair: "long blonde hair falls beside the face",
    accessories: "fine gold necklace; no visible eyewear",
    identityPrompt: "Bare face with visible eyes.",
    impression: "Long blonde waves and a bare face.",
    fallbackGlasses: "unknown",
  });

  const sentinels = [
    sentinel("glasses-monochrome", "present"),
    sentinel("short-hair-red-shirt", "absent"),
    sentinel("long-straight-hair", "absent"),
    sentinel("headscarf-color-blocks", "absent"),
  ];
  const counterfactuals = Object.fromEntries(glassesTokens.map((glasses) => [glasses, liveCounterfactual(live, glasses)]));
  return {
    live,
    annotation,
    rubric,
    normalization: {
      hairFramesFace: hairFrames.fallbackFeatures.glasses,
      contextualEyeglassFrames: contextualFrames.fallbackFeatures.glasses,
      roundGlasses: round.fallbackFeatures.glasses,
      sunglasses: sunglasses.fallbackFeatures.glasses,
      explicitValidCacheOverridesContradictoryText: explicitStale.fallbackFeatures.glasses,
      invalidUnknownReconstructedFromNoGlassesEvidence: invalidUnknown.fallbackFeatures.glasses,
    },
    sentinels,
    counterfactuals,
  };
}

it.skipIf(!fs.existsSync(LIVE) || !fs.existsSync(RUBRIC))("audits glasses cross-field consistency without external calls", () => {
  const value = diagnose();
  expect(value.live.primary.sourceSelection.portraitImageIndex).toBe(0);
  expect(value.live.primary.faceMeasurementEvidence.referenceImageIndex).toBe(0);
  expect(value.annotation.accessories).toBe("fine gold necklace");
  expect(value.rubric.glassesOrCovering).toBe("none");
  expect(value.normalization).toMatchObject({
    hairFramesFace: "none",
    contextualEyeglassFrames: "regular",
    roundGlasses: "round",
    sunglasses: "sunglasses",
    explicitValidCacheOverridesContradictoryText: "regular",
    invalidUnknownReconstructedFromNoGlassesEvidence: "none",
  });
  expect(value.sentinels.map((item) => item.taxonomy)).toEqual([
    "CONSISTENT_PRESENT", "CONSISTENT_ABSENT", "CONSISTENT_ABSENT", "CONSISTENT_ABSENT",
  ]);
  for (const cue of ["eyeSpacing", "eyeOpenness", "eyeFootprint"]) {
    expect(value.counterfactuals.none.measurementTrace[cue].selected).toBe("categorical_grammar");
    for (const token of ["regular", "round", "sunglasses"] as const) {
      expect(value.counterfactuals[token].measurementTrace[cue].selected).toBe("legacy_fallback");
    }
  }
});

it.skipIf(!BUILD || !fs.existsSync(LIVE) || !fs.existsSync(RUBRIC))("writes the secret-safe glasses consistency review", () => {
  const value = diagnose();
  fs.mkdirSync(OUTPUT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(OUTPUT, name),
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });

  write("field-inventory.json", {
    compactProviderBoundary: {
      fallbackFeatures: "optional partial cache with string-typed glasses member; provider enum is removed in v3",
      observedAccessories: "observed.accessories",
      canonicalAccessoryEvidence: "identityFeatures[] where category=accessory plus canonicalIdentity.mustPreserve/overallImpression",
      renderHints: "no dedicated glasses-presence field; eye render hints do not prove presence or absence",
      visibleRegions: "face/hair/upperBody/lowerBody/feet only; no glasses flag",
      sourceSelection: "portraitImageIndex owns faceMeasurements; no independent glasses reference index",
    },
    richAnalysis: {
      authoritativeConsumerInput: "fallbackFeatures.glasses",
      allowedValues: ["none", "regular", "round", "sunglasses"],
      supportingTextFields: [
        "observed.face", "observed.hair", "observed.accessories", "observed.clothing",
        "identityPrompt", "outfitPrompt", "canonicalIdentity.overallImpression", "canonicalIdentity.mustPreserve[]",
      ],
      canonicalAccessoryField: "canonicalIdentity.features[].category=accessory",
      renderHintsPresenceField: null,
      geometryPresenceField: "identityGeometry.glasses (optional focused stage; absent in this canary)",
    },
    normalizationChain: [
      "compact fallbackFeatures.glasses (optional)",
      "normalizeCompactPhotoAnalysisV3",
      "normalizeCompactPhotoAnalysisV2",
      "validatePhotoAnalysis fallbackEnum(valid explicit value, otherwise inferredGlasses)",
      "rich fallbackFeatures.glasses",
      "resolveFaceMeasurements: group=eyes && glasses !== none",
      "eye categorical suppression -> legacy_fallback",
    ],
    precedence: {
      explicitValidFallbackCache: "wins over textual reconstruction even when text says no eyewear",
      invalidOrMissingFallbackCache: "reconstructed from sanitized rich text evidence",
      crossFieldConflictDetection: false,
      consumerTreatment: "hard authority, despite compact prompt describing fallbackFeatures as optional cache",
    },
  });

  write("consistency-matrix.json", {
    caseId: value.live.selectedCanary.id,
    exactLiveGlassesToken: "unavailable",
    rows: [
      {
        field: "normalized rich fallbackFeatures.glasses",
        value: "non_none_exact_token_unavailable",
        provenance: "deduced from stored consumer trace; only eye-axis veto capable of producing its three stored legacy_fallback decisions",
        supportsGlasses: true,
        confidence: "presence-class high; exact token unavailable",
        consistencyWithSource: "contradicts_source",
      },
      {
        field: "observed.accessories",
        value: "not_stored_in_live_artifact",
        provenance: "provider output omitted by sanitizer",
        supportsGlasses: "unknown",
        confidence: "unavailable",
        consistencyWithSource: "insufficient_stored_evidence",
      },
      {
        field: "canonicalIdentity accessory features",
        value: "not_stored_in_live_artifact; sanitizer retained face category only",
        provenance: "provider output filtered by audit worker",
        supportsGlasses: "unknown",
        confidence: "unavailable",
        consistencyWithSource: "insufficient_stored_evidence",
      },
      {
        field: "renderHints",
        value: value.live.primary.relevantRenderHints,
        provenance: "stored provider-derived rich analysis",
        supportsGlasses: false,
        confidence: "not applicable",
        consistencyWithSource: "no dedicated presence signal",
      },
      {
        field: "frozen annotation accessories",
        value: value.annotation.accessories,
        provenance: "generalization-20260905 frozen annotation",
        supportsGlasses: false,
        confidence: "source ground-truth reference",
        consistencyWithSource: "ground_truth_reference",
      },
      {
        field: "frozen source rubric glassesOrCovering",
        value: value.rubric.glassesOrCovering,
        provenance: "production-primary-face-measurement-audit source rubric",
        supportsGlasses: false,
        confidence: "source ground-truth reference",
        consistencyWithSource: "ground_truth_reference",
      },
    ],
    taxonomy: {
      normalizedOutputVsFrozenSource: "SOURCE_CONFLICT",
      providerInternalCrossFieldConsistency: "INSUFFICIENT_STORED_EVIDENCE",
      rationale: "the trace proves non-none normalized glasses presence and the frozen source proves absence, but provider observed/accessory fields and the exact compact cache token were intentionally not retained",
    },
  });

  write("sentinel-comparison.json", {
    sentinels: value.sentinels,
    interpretation: "the frozen positive sentinel has aligned structured, observed, and canonical evidence; three no-glasses sentinels retain glasses=none despite other accessories. Wavy is anomalous, not evidence that all legacy cache records are systematically non-none.",
    normalizationParserChecks: value.normalization,
    confirmedBugAndFix: {
      before: "global fallbackEvidence treated bare word 'frames' and negated phrases such as 'no visible eyewear' as positive glasses evidence",
      after: "negated eyewear phrases are removed first and bare 'frames' no longer qualifies; explicit eyewear words or frames around/over eyes remain supported",
      liveCausality: "plausible but unproven because the live artifact omitted observed/accessory/free-text and compact fallbackFeatures",
    },
  });

  write("counterfactual.json", {
    exactLiveToken: "unavailable",
    currentStoredState: {
      measurementTraceSelected: value.live.primary.measurementTraceSelected,
      faceLayoutPlan: value.live.primary.categoricalOnlyFaceLayoutPlan,
      provenConstraintClass: "non_none",
    },
    syntheticStates: value.counterfactuals,
    fieldRemovedOrInvalidUnknown: {
      noGlassesTextResult: value.normalization.invalidUnknownReconstructedFromNoGlassesEvidence,
      rule: "unknown is not coerced to none; invalid/missing cache is reconstructed from evidence, which is none only when no positive eyewear evidence exists",
    },
    assessment: "none restores categorical eye axes; every explicit present class preserves the existing protection. This supports fixing normalization false positives rather than weakening the consumer guard.",
  });

  write("REPORT.md", `# Primary glasses cross-field consistency\n\n` +
    `- HEAD: 0b9d6dec4346076736ad21d92b4125481808efc1; branch main; pre-existing dirty/untracked files preserved.\n` +
    `- External calls: 0 (remote Wrangler, health, whoami, JPEG, Gemini, Gemma, provider, evaluator, package manager).\n` +
    `- Exact live glasses token: unavailable. The stored trace proves only normalized \`fallbackFeatures.glasses !== "none"\`.\n` +
    `- Frozen source: fine gold necklace; no visible glasses; portrait/reference index 0.\n` +
    `- Taxonomy: SOURCE_CONFLICT at normalized-output-vs-source level; INSUFFICIENT_STORED_EVIDENCE for provider-internal cross-field consistency.\n` +
    `- Confirmed systemic normalization defect: bare \`frames\` and negated phrases such as \`no visible eyewear\` were positive matches. Negations are now removed first, and the parser requires eyewear words or eye-contextual frames.\n` +
    `- Positive sentinel: glasses-monochrome is CONSISTENT_PRESENT. No-glasses sentinels short-hair-red-shirt, long-straight-hair, and headscarf-color-blocks are CONSISTENT_ABSENT.\n` +
    `- Precedence remains risky but not changed: an explicit valid fallback cache token still wins and no provider cross-field conflict detector exists. Evidence is insufficient to down-rank it safely.\n` +
    `- Consumer protection remains unchanged: regular, round, and sunglasses preserve legacy eye openings; only explicit/reconstructed none permits categorical eye grammar.\n` +
    `- Next live audit should retain only the exact glasses cache token plus observed.accessories and canonical accessory cues, then proceed with the remaining six cases.\n`);
});
