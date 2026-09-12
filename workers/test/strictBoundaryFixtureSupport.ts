import type { IdentityFeaturePriority, PhotoAnalysis } from "../src/analysis";
import { analysisFromAnnotation, type AnnotatedCase } from "./generalizationSupport";

export type ManualEvidenceClass = "A" | "B" | "C" | "D";

export interface StrictBoundaryFixtureAudit {
  classification: "source_supported_recovery" | "already_valid" | "legitimate_fixture_evidence_insufficient";
  beforeFeatures: IdentityFeaturePriority[];
  recoveredFeatures: IdentityFeaturePriority[];
  finalFeatures: IdentityFeaturePriority[];
  netAdded: number;
  evidenceClasses: Record<ManualEvidenceClass, number>;
  sourceFields: string[];
  compatibilitySourceFields: string[];
}

function explicitString(record: object, key: string): string | null {
  if (!Object.hasOwn(record, key)) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() && !/^(?:none|unknown|not visible)$/i.test(value)
    ? value.trim()
    : null;
}

function regularHairEvidence(c: AnnotatedCase): {
  feature: IdentityFeaturePriority;
  sourceFields: string[];
} | null {
  const hairColor = explicitString(c.features, "hairColor");
  if (!hairColor) return null;
  return {
    feature: {
      feature: `${hairColor} hair color`,
      category: "hair",
      priority: 4,
      confidence: "medium",
      evidence: "frozen manual annotation field: features.hairColor",
      targetRegions: ["head.front", "head.side", "head.back"],
    },
    sourceFields: ["features.hairColor"],
  };
}

function coveringEvidence(c: AnnotatedCase): {
  feature: IdentityFeaturePriority;
  sourceFields: string[];
} | null {
  const covering = explicitString(c.features, "hat");
  const color = explicitString(c.features, "hatColor");
  if (!covering || !color) return null;
  const sourceFields = ["features.hat", "features.hatColor", "observed.accessories"];
  return {
    feature: {
      feature: `${color} ${covering} coverage silhouette`,
      category: "silhouette",
      priority: 4,
      confidence: "medium",
      evidence: "frozen manual annotation fields: features.hat, features.hatColor, observed.accessories",
      targetRegions: ["head.front", "head.side", "head.back", "head.overlay"],
    },
    sourceFields,
  };
}

function preserveSourceSupportedLegacySemantics(c: AnnotatedCase, historical: PhotoAnalysis): {
  analysis: PhotoAnalysis;
  sourceFields: string[];
} {
  let analysis = historical;
  const sourceFields: string[] = [];
  if (explicitString(c.features, "topAccentColor") === "cream") {
    analysis = {
      ...analysis,
      fallbackFeatures: { ...analysis.fallbackFeatures, topAccentColor: "#ded2b6" },
    };
    sourceFields.push("features.topAccentColor (cream -> existing renderer #ded2b6)");
  }
  const sleeveLength = explicitString(c.features, "sleeveLength");
  const topType = explicitString(c.features, "topType");
  if (sleeveLength === "sleeveless" && topType === "tank"
    && /bare shoulders/i.test(c.clothing)
    && !/sleeveless|tank top/i.test(c.clothing)) {
    const evidence = `${historical.observed.clothing}; sleeveless tank top (frozen manual annotation)`;
    analysis = {
      ...analysis,
      observed: { ...analysis.observed, clothing: evidence },
      outfitPrompt: evidence,
    };
    sourceFields.push("features.sleeveLength", "features.topType", "observed.clothing");
  }
  return { analysis, sourceFields };
}

/**
 * Test-only bridge for historical manual annotations. It atomizes an existing
 * composite hair/covering cue by promoting its explicitly annotated colour;
 * it never invents a fourth cue, reads fixture IDs, or changes the production
 * normalizer.
 */
export function strictBoundaryAnalysisFromAnnotation(c: AnnotatedCase): {
  analysis: PhotoAnalysis;
  audit: StrictBoundaryFixtureAudit;
} {
  const historical = analysisFromAnnotation(c);
  const beforeFeatures = structuredClone(historical.canonicalIdentity.features);
  const compatible = preserveSourceSupportedLegacySemantics(c, historical);
  if (beforeFeatures.length >= 4) {
    return {
      analysis: compatible.analysis,
      audit: {
        classification: "already_valid",
        beforeFeatures,
        recoveredFeatures: [],
        finalFeatures: beforeFeatures,
        netAdded: 0,
        evidenceClasses: { A: beforeFeatures.length, B: 0, C: 0, D: 0 },
        sourceFields: [],
        compatibilitySourceFields: compatible.sourceFields,
      },
    };
  }

  const recovered = coveringEvidence(c) ?? regularHairEvidence(c);
  if (!recovered) {
    return {
      analysis: historical,
      audit: {
        classification: "legitimate_fixture_evidence_insufficient",
        beforeFeatures,
        recoveredFeatures: [],
        finalFeatures: beforeFeatures,
        netAdded: 0,
        evidenceClasses: { A: beforeFeatures.length, B: 0, C: 0, D: 1 },
        sourceFields: [],
        compatibilitySourceFields: [],
      },
    };
  }

  const finalFeatures = [...beforeFeatures, recovered.feature];
  finalFeatures.sort((first, second) => second.priority - first.priority);
  if (finalFeatures.length < 4 || finalFeatures.length > 12) {
    return {
      analysis: historical,
      audit: {
        classification: "legitimate_fixture_evidence_insufficient",
        beforeFeatures,
        recoveredFeatures: [recovered.feature],
        finalFeatures: beforeFeatures,
        netAdded: 0,
        evidenceClasses: { A: beforeFeatures.length, B: 1, C: 0, D: 1 },
        sourceFields: recovered.sourceFields,
        compatibilitySourceFields: [],
      },
    };
  }

  const recoveredAnalysis: PhotoAnalysis = {
      ...compatible.analysis,
      canonicalIdentity: { ...compatible.analysis.canonicalIdentity, features: finalFeatures },
  };

  return {
    analysis: recoveredAnalysis,
    audit: {
      classification: "source_supported_recovery",
      beforeFeatures,
      recoveredFeatures: [recovered.feature],
      finalFeatures,
      netAdded: finalFeatures.length - beforeFeatures.length,
      evidenceClasses: { A: beforeFeatures.length, B: 1, C: 0, D: 0 },
      sourceFields: recovered.sourceFields,
      compatibilitySourceFields: compatible.sourceFields,
    },
  };
}
