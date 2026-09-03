import type { PhotoAnalysis } from "./analysis";
import { classifyEvaluatorQuotaFailure, type EvaluatorQuotaFailure } from "./evaluatorQuota";
import { generateGeminiStructuredJson, isGeminiQuotaError } from "./gemini";
import type { RawImage } from "./png";
import type { FacePixelPlan, HairPlan } from "./identityPlans";
import { measureFaceRenderContract, measureHairRenderContract, type ContractStatus } from "./identityRenderContract";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type Rect } from "./uvLayout";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";
import type { Env } from "./types";

export type HeadCandidateKind = "generated" | "deterministic" | "deterministic_variant" | "corrected";

export type CandidateInadmissibilityReason =
  | "p5_regression"
  | "structural_regression"
  | "craft_invalid"
  | "render_contract_violation"
  | "critical_defect"
  | "calibration_conflict"
  | "other";

export interface HeadCandidateAdmissibilityEvidence {
  p5Valid: boolean;
  craftValid: boolean;
  renderContractValid: boolean;
  criticalDefects: string[];
  calibrationConflicts: string[];
}

export interface CandidateAdmissibility {
  admissible: boolean;
  reasons: CandidateInadmissibilityReason[];
  details: string[];
}

export interface HeadCandidate {
  id: string;
  kind: HeadCandidateKind;
  atlas: RawImage;
  headMontageDataUrl: string;
  structuralValidity: boolean;
  facePlanVariant?: string;
  facePlan?: FacePixelPlan;
  hairPlan?: HairPlan;
  structuralEvidence?: HeadStructuralEvidence;
  admissibilityEvidence: HeadCandidateAdmissibilityEvidence;
}

export interface HeadPairwiseReview {
  winner: "A" | "B" | "tie";
  confidence: number;
  sourceSalientCues: SourceSalientCue[];
  identityDimensions: Record<IdentityDimension, IdentityDimensionReview>;
  globalIdentityJudgment: GlobalIdentityJudgment;
  p5RegressionInB: boolean;
  structuralRegressionInB: boolean;
  craftRegressionInB: boolean;
  calibrationConflicts: string[];
  reasons: string[];
  failedIdentityFeatures: string[];
  correctionTargets: string[];
  dimensionWeights?: Record<IdentityDimension, number>;
}

export type IdentityDimension = "headSilhouette" | "hairline" | "eyeLayout" | "mouthExpression" | "distinctiveAccessories" | "faceProportions";
export type SourceFidelity = "high" | "medium" | "low" | "absent" | "not_evaluable";
export interface SourceSalientCue {
  cue: string;
  importance: "high" | "medium" | "low";
  dimension: IdentityDimension;
}
export interface IdentityDimensionReview {
  better: "A" | "B" | "tie" | "not_evaluable";
  structuralPresenceA: "present" | "absent" | "not_applicable";
  structuralPresenceB: "present" | "absent" | "not_applicable";
  visualReadabilityA: "strong" | "weak" | "absent" | "not_evaluable";
  visualReadabilityB: "strong" | "weak" | "absent" | "not_evaluable";
  sourceFidelityA: SourceFidelity;
  sourceFidelityB: SourceFidelity;
  reason: string;
}

export interface GlobalIdentityJudgment {
  better: "A" | "B" | "tie" | "not_evaluable";
  replacementValue: "meaningful" | "trivial" | "unclear";
  reason: string;
}

export interface HeadStructuralEvidence {
  dimensions: Record<IdentityDimension, IdentityDimensionReview["structuralPresenceA"]>;
  contractSatisfaction: Record<IdentityDimension, ContractStatus>;
  contractViolations: string[];
  expectedPixels: number;
  presentPixels: number;
}

export const HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE = 0.7;
export const HEAD_PAIRWISE_BLIND_RULES = "Candidate labels are arbitrary and communicate no hidden metadata or preference. Judge only the source pixels and candidate pixels.";

export type PairwiseActionableVerdict =
  | "A"
  | "B"
  | "tie"
  | "insufficient_confidence"
  | "unsafe_regression"
  | "calibration_conflict"
  | "dimension_conflict"
  | "insufficient_identity_gain";

export interface PairwiseDecision {
  rawPreference: HeadPairwiseReview["winner"];
  confidence: number;
  actionableVerdict: PairwiseActionableVerdict;
  replacementSafe: boolean;
}

export interface HeadPairwiseEligibility {
  eligible: boolean;
  candidateA: CandidateAdmissibility;
  candidateB: CandidateAdmissibility;
}

export type HeadPairwiseGateResult =
  | {
      pairwiseExecuted: false;
      eligibility: HeadPairwiseEligibility;
      result: null;
      neuronsSpent: 0;
      stageOutcome: "rejected_before_pairwise";
    }
  | {
      pairwiseExecuted: true;
      eligibility: HeadPairwiseEligibility;
      result: HeadPairwiseResult;
      neuronsSpent: number;
      stageOutcome: "pairwise_completed" | "pairwise_failed";
    };

export type HeadPairwiseResult =
  | { ok: true; review: HeadPairwiseReview; neuronsSpent: number }
  | { ok: false; quotaExceeded: boolean; quotaFailure?: EvaluatorQuotaFailure; detail: string; neuronsSpent: number };

export interface PairwiseOrderBiasAssessment {
  forwardWinner: "first" | "second" | "tie";
  reversedWinner: "first" | "second" | "tie";
  consistent: boolean;
  biasedTowardLabel: "A" | "B" | null;
}

export function assessPairwiseOrderBias(
  forward: Pick<HeadPairwiseReview, "winner">,
  reversed: Pick<HeadPairwiseReview, "winner">,
): PairwiseOrderBiasAssessment {
  const forwardWinner = forward.winner === "A" ? "first" : forward.winner === "B" ? "second" : "tie";
  const reversedWinner = reversed.winner === "A" ? "second" : reversed.winner === "B" ? "first" : "tie";
  const biasedTowardLabel = forward.winner === reversed.winner && forward.winner !== "tie"
    ? forward.winner
    : null;
  return {
    forwardWinner,
    reversedWinner,
    consistent: forwardWinner === reversedWinner,
    biasedTowardLabel,
  };
}

const dimensionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    better: { type: "string", enum: ["A", "B", "tie", "not_evaluable"] },
    visualReadabilityA: { type: "string", enum: ["strong", "weak", "absent", "not_evaluable"] },
    visualReadabilityB: { type: "string", enum: ["strong", "weak", "absent", "not_evaluable"] },
    sourceFidelityA: { type: "string", enum: ["high", "medium", "low", "absent", "not_evaluable"] },
    sourceFidelityB: { type: "string", enum: ["high", "medium", "low", "absent", "not_evaluable"] },
    reason: { type: "string" },
  },
  required: ["better", "visualReadabilityA", "visualReadabilityB", "sourceFidelityA", "sourceFidelityB", "reason"],
} as const;

export const HEAD_PAIRWISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    sourceSalientCues: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          cue: { type: "string" },
          importance: { type: "string", enum: ["high", "medium", "low"] },
          dimension: { type: "string", enum: ["headSilhouette", "hairline", "eyeLayout", "mouthExpression", "distinctiveAccessories", "faceProportions"] },
        },
        required: ["cue", "importance", "dimension"],
      },
    },
    identityDimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        headSilhouette: dimensionSchema,
        hairline: dimensionSchema,
        eyeLayout: dimensionSchema,
        mouthExpression: dimensionSchema,
        distinctiveAccessories: dimensionSchema,
        faceProportions: dimensionSchema,
      },
      required: ["headSilhouette", "hairline", "eyeLayout", "mouthExpression", "distinctiveAccessories", "faceProportions"],
    },
    globalIdentityJudgment: {
      type: "object",
      additionalProperties: false,
      properties: {
        better: { type: "string", enum: ["A", "B", "tie", "not_evaluable"] },
        replacementValue: { type: "string", enum: ["meaningful", "trivial", "unclear"] },
        reason: { type: "string" },
      },
      required: ["better", "replacementValue", "reason"],
    },
    p5RegressionInB: { type: "boolean" },
    structuralRegressionInB: { type: "boolean" },
    craftRegressionInB: { type: "boolean" },
    reasons: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
    failedIdentityFeatures: { type: "array", maxItems: 8, items: { type: "string" } },
    correctionTargets: { type: "array", maxItems: 8, items: { type: "string" } },
  },
  required: ["winner", "confidence", "sourceSalientCues", "identityDimensions", "globalIdentityJudgment", "p5RegressionInB", "structuralRegressionInB", "craftRegressionInB", "reasons", "failedIdentityFeatures", "correctionTargets"],
} as const;

function extractPayload(result: unknown): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null) return null;
  const response = (result as { response?: unknown }).response;
  if (typeof response === "object" && response !== null) return response as Record<string, unknown>;
  if (typeof response !== "string") return null;
  try {
    const parsed = JSON.parse(response);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseHeadPairwiseReview(
  raw: Record<string, unknown>,
  structuralA?: HeadStructuralEvidence,
  structuralB?: HeadStructuralEvidence,
): HeadPairwiseReview | null {
  if (
    !["A", "B", "tie"].includes(String(raw.winner)) ||
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1 ||
    !Array.isArray(raw.sourceSalientCues) ||
    raw.sourceSalientCues.length === 0 ||
    !Array.isArray(raw.reasons) ||
    raw.reasons.length === 0 ||
    !Array.isArray(raw.failedIdentityFeatures) ||
    !Array.isArray(raw.correctionTargets)
  ) return null;
  const strings = (values: unknown[], maximum: number): string[] | null => {
    const selected = values.slice(0, maximum);
    return selected.every((value) => typeof value === "string") ? selected as string[] : null;
  };
  const reasons = strings(raw.reasons, 6);
  const failedIdentityFeatures = strings(raw.failedIdentityFeatures, 8);
  const correctionTargets = strings(raw.correctionTargets, 8);
  if (!reasons || !failedIdentityFeatures || !correctionTargets) return null;
  const dimensionNames: IdentityDimension[] = ["headSilhouette", "hairline", "eyeLayout", "mouthExpression", "distinctiveAccessories", "faceProportions"];
  const sourceSalientCues = raw.sourceSalientCues.slice(0, 8).flatMap((value): SourceSalientCue[] => {
    if (typeof value !== "object" || value === null) return [];
    const cue = value as Record<string, unknown>;
    if (
      typeof cue.cue !== "string" ||
      !["high", "medium", "low"].includes(String(cue.importance)) ||
      !dimensionNames.includes(cue.dimension as IdentityDimension)
    ) return [];
    return [{
      cue: cue.cue,
      importance: cue.importance as SourceSalientCue["importance"],
      dimension: cue.dimension as IdentityDimension,
    }];
  });
  if (sourceSalientCues.length !== Math.min(raw.sourceSalientCues.length, 8)) return null;
  const rawDimensions = typeof raw.identityDimensions === "object" && raw.identityDimensions !== null
    ? raw.identityDimensions as Record<string, unknown>
    : {};
  const fallbackDimension: IdentityDimensionReview = {
    better: "not_evaluable", structuralPresenceA: "not_applicable", structuralPresenceB: "not_applicable",
    visualReadabilityA: "not_evaluable", visualReadabilityB: "not_evaluable",
    sourceFidelityA: "not_evaluable", sourceFidelityB: "not_evaluable", reason: "dimension not returned",
  };
  const identityDimensions = {} as Record<IdentityDimension, IdentityDimensionReview>;
  for (const name of dimensionNames) {
    const candidate = typeof rawDimensions[name] === "object" && rawDimensions[name] !== null
      ? rawDimensions[name] as Record<string, unknown>
      : null;
    if (!candidate) { identityDimensions[name] = fallbackDimension; continue; }
    if (
      !["A", "B", "tie", "not_evaluable"].includes(String(candidate.better)) ||
      !["strong", "weak", "absent", "not_evaluable"].includes(String(candidate.visualReadabilityA)) ||
      !["strong", "weak", "absent", "not_evaluable"].includes(String(candidate.visualReadabilityB)) ||
      !["high", "medium", "low", "absent", "not_evaluable"].includes(String(candidate.sourceFidelityA)) ||
      !["high", "medium", "low", "absent", "not_evaluable"].includes(String(candidate.sourceFidelityB)) ||
      typeof candidate.reason !== "string"
    ) return null;
    identityDimensions[name] = {
      better: candidate.better as IdentityDimensionReview["better"],
      structuralPresenceA: structuralA?.dimensions[name] ?? (["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceA)) ? candidate.structuralPresenceA as IdentityDimensionReview["structuralPresenceA"] : "not_applicable"),
      structuralPresenceB: structuralB?.dimensions[name] ?? (["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceB)) ? candidate.structuralPresenceB as IdentityDimensionReview["structuralPresenceB"] : "not_applicable"),
      visualReadabilityA: candidate.visualReadabilityA as IdentityDimensionReview["visualReadabilityA"],
      visualReadabilityB: candidate.visualReadabilityB as IdentityDimensionReview["visualReadabilityB"],
      sourceFidelityA: candidate.sourceFidelityA as SourceFidelity,
      sourceFidelityB: candidate.sourceFidelityB as SourceFidelity,
      reason: candidate.reason,
    };
  }
  const rawGlobal = typeof raw.globalIdentityJudgment === "object" && raw.globalIdentityJudgment !== null
    ? raw.globalIdentityJudgment as Record<string, unknown>
    : null;
  if (
    !rawGlobal ||
    !["A", "B", "tie", "not_evaluable"].includes(String(rawGlobal.better)) ||
    !["meaningful", "trivial", "unclear"].includes(String(rawGlobal.replacementValue)) ||
    typeof rawGlobal.reason !== "string"
  ) return null;
  const globalIdentityJudgment: GlobalIdentityJudgment = {
    better: rawGlobal.better as GlobalIdentityJudgment["better"],
    replacementValue: rawGlobal.replacementValue as GlobalIdentityJudgment["replacementValue"],
    reason: rawGlobal.reason,
  };
  const conflictText = [...reasons, ...failedIdentityFeatures].join(" ").toLowerCase();
  const calibrationConflicts: string[] = [];
  const glasses = identityDimensions.distinctiveAccessories;
  if (/\b(?:missing|absent|no)\b.{0,24}\b(?:glasses|frames|spectacles)\b/.test(conflictText) &&
      (glasses.structuralPresenceA === "present" || glasses.structuralPresenceB === "present")) {
      calibrationConflicts.push("glasses described as missing despite reported structural presence; treat as readability uncertainty");
  }
  const fidelityRank: Record<SourceFidelity, number> = {
    high: 3, medium: 2, low: 1, absent: 0, not_evaluable: -1,
  };
  const readabilityRank: Record<IdentityDimensionReview["visualReadabilityA"], number> = {
    strong: 2, weak: 1, absent: 0, not_evaluable: -1,
  };
  for (const [name, dimension] of Object.entries(identityDimensions) as Array<[IdentityDimension, IdentityDimensionReview]>) {
    const aFidelity = fidelityRank[dimension.sourceFidelityA];
    const bFidelity = fidelityRank[dimension.sourceFidelityB];
    if (dimension.better === "A" && aFidelity >= 0 && bFidelity >= 0 && aFidelity <= bFidelity) {
      calibrationConflicts.push(`${name} favored A without greater source fidelity`);
    }
    if (dimension.better === "B" && aFidelity >= 0 && bFidelity >= 0 && bFidelity <= aFidelity) {
      calibrationConflicts.push(`${name} favored B without greater source fidelity`);
    }
    const aReadability = readabilityRank[dimension.visualReadabilityA];
    const bReadability = readabilityRank[dimension.visualReadabilityB];
    if (dimension.better === "A" && aReadability > bReadability && aFidelity < bFidelity) {
      calibrationConflicts.push(`${name} readability overrode source fidelity for A`);
    }
    if (dimension.better === "B" && bReadability > aReadability && bFidelity < aFidelity) {
      calibrationConflicts.push(`${name} readability overrode source fidelity for B`);
    }
  }
  if (
    raw.winner !== "tie" &&
    globalIdentityJudgment.better !== "not_evaluable" &&
    globalIdentityJudgment.better !== raw.winner
  ) {
    calibrationConflicts.push("overall winner conflicts with global same-person judgment");
  }
  if (raw.winner === "tie" && ["A", "B"].includes(globalIdentityJudgment.better)) {
    calibrationConflicts.push("overall tie conflicts with global same-person judgment");
  }
  return {
    winner: raw.winner as HeadPairwiseReview["winner"],
    confidence: raw.confidence,
    sourceSalientCues,
    identityDimensions,
    globalIdentityJudgment,
    p5RegressionInB: raw.p5RegressionInB === true,
    structuralRegressionInB: raw.structuralRegressionInB === true,
    craftRegressionInB: raw.craftRegressionInB === true,
    calibrationConflicts,
    reasons,
    failedIdentityFeatures,
    correctionTargets,
  };
}

export function assessCandidateAdmissibility(candidate: HeadCandidate): CandidateAdmissibility {
  const reasons: CandidateInadmissibilityReason[] = [];
  const details: string[] = [];
  const add = (reason: CandidateInadmissibilityReason, detail: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    details.push(detail);
  };
  const evidence = candidate.admissibilityEvidence;
  if (!evidence) {
    add("other", "deterministic admissibility evidence is missing");
  } else {
    if (!evidence.p5Valid) add("p5_regression", "candidate does not satisfy its deterministic P5 contract");
    if (!evidence.craftValid) add("craft_invalid", "candidate failed deterministic craft validation");
    if (!evidence.renderContractValid) add("render_contract_violation", "candidate failed deterministic render-contract validation");
    if (evidence.criticalDefects.length > 0) add("critical_defect", evidence.criticalDefects.join("; "));
    if (evidence.calibrationConflicts.length > 0) add("calibration_conflict", evidence.calibrationConflicts.join("; "));
  }
  if (!candidate.structuralValidity) add("structural_regression", "candidate is not structurally valid");
  if ((candidate.facePlan?.candidateCost.p5ContractViolations ?? 0) > 0) {
    add("p5_regression", "FacePixelPlan reports a P5 contract violation");
  }
  if ((candidate.facePlan?.candidateCost.violations.length ?? 0) > 0) {
    add("render_contract_violation", candidate.facePlan!.candidateCost.violations.join("; "));
  }
  if ((candidate.structuralEvidence?.contractViolations.length ?? 0) > 0) {
    add("render_contract_violation", candidate.structuralEvidence!.contractViolations.join("; "));
  }
  return { admissible: reasons.length === 0, reasons, details };
}

export function assessHeadPairwiseEligibility(
  candidateA: HeadCandidate,
  candidateB: HeadCandidate,
): HeadPairwiseEligibility {
  const candidateAAdmissibility = assessCandidateAdmissibility(candidateA);
  const candidateBAdmissibility = assessCandidateAdmissibility(candidateB);
  return {
    eligible: candidateAAdmissibility.admissible && candidateBAdmissibility.admissible,
    candidateA: candidateAAdmissibility,
    candidateB: candidateBAdmissibility,
  };
}

/**
 * Production boundary for pairwise evaluation. Calibration stress tests may
 * call the raw evaluator directly, but production comparison must use this
 * gate so an inadmissible pair consumes no model capacity.
 */
export async function runHeadPairwiseIfAdmissible(
  candidateA: HeadCandidate,
  candidateB: HeadCandidate,
  invokePairwise: () => Promise<HeadPairwiseResult>,
): Promise<HeadPairwiseGateResult> {
  const eligibility = assessHeadPairwiseEligibility(candidateA, candidateB);
  if (!eligibility.eligible) {
    return {
      pairwiseExecuted: false,
      eligibility,
      result: null,
      neuronsSpent: 0,
      stageOutcome: "rejected_before_pairwise",
    };
  }
  const result = await invokePairwise();
  return {
    pairwiseExecuted: true,
    eligibility,
    result,
    neuronsSpent: result.neuronsSpent,
    stageOutcome: result.ok ? "pairwise_completed" : "pairwise_failed",
  };
}

export function selectHeadCandidate(
  candidateA: HeadCandidate,
  candidateB: HeadCandidate,
  review: HeadPairwiseReview,
): HeadCandidate {
  const decision = assessPairwiseDecision(review);
  if (decision.actionableVerdict === "B" && candidateB.structuralValidity) return candidateB;
  if (decision.actionableVerdict === "A") return candidateA;
  if (decision.actionableVerdict !== "tie") return candidateA;
  const deterministicTieWinner = selectDeterministicTieWinner(candidateA, candidateB, review);
  if (deterministicTieWinner) return deterministicTieWinner;
  // A tie is not evidence that a generated face should be replaced. Preserve
  // the richer source-derived candidate while the absolute gate still judges it.
  return candidateA.kind === "generated" ? candidateA : candidateB.kind === "generated" ? candidateB : candidateA;
}

function selectDeterministicTieWinner(
  candidateA: HeadCandidate,
  candidateB: HeadCandidate,
  review: HeadPairwiseReview,
): HeadCandidate | null {
  if (review.winner !== "tie" || review.p5RegressionInB || review.structuralRegressionInB || review.craftRegressionInB || review.calibrationConflicts.length > 0) return null;
  const planA = candidateA.facePlan;
  const planB = candidateB.facePlan;
  if (!candidateA.structuralValidity || !candidateB.structuralValidity || !planA || !planB) return null;
  if (planA.source !== "identity_geometry" || planB.source !== "identity_geometry") return null;
  if (planA.candidateCost.p5ContractViolations !== 0 || planB.candidateCost.p5ContractViolations !== 0) return null;
  if (planA.candidateCost.violations.length > 0 || planB.candidateCost.violations.length > 0) return null;
  if ((candidateA.structuralEvidence?.contractViolations.length ?? 0) > 0 || (candidateB.structuralEvidence?.contractViolations.length ?? 0) > 0) return null;
  const signature = (plan: FacePixelPlan) => JSON.stringify({
    eyeRows: [plan.layout.leftEyeRow, plan.layout.rightEyeRow],
    eyeXs: [plan.layout.leftEyeXs, plan.layout.rightEyeXs],
    mouth: [plan.layout.mouthRow, plan.layout.mouthWidth, plan.layout.mouthTopology],
    hairline: plan.layout.hairlineDepthByColumn,
    glasses: plan.glassesPlan.topology,
  });
  if (signature(planA) === signature(planB)) return null;
  const margin = Math.max(planA.candidateCost.meaningfulMargin, planB.candidateCost.meaningfulMargin);
  const difference = Math.abs(planA.candidateCost.totalCost - planB.candidateCost.totalCost);
  if (difference < margin) return null;
  return planA.candidateCost.totalCost < planB.candidateCost.totalCost ? candidateA : candidateB;
}

function identityDimensionsSupportWinner(review: HeadPairwiseReview, winner: "A" | "B"): boolean {
  const dimensions = Object.values(review.identityDimensions);
  const allUnavailable = dimensions.every((dimension) => dimension.better === "not_evaluable");
  // Do not turn the dimensions into a majority vote. They are evidence for a
  // global same-person judgment, with high-salience contradictions acting as
  // a veto rather than six interchangeable votes.
  if (allUnavailable) return true;
  const opponent = winner === "A" ? "B" : "A";
  const highSalienceOpposition = review.sourceSalientCues.some((cue) =>
    cue.importance === "high" && review.identityDimensions[cue.dimension].better === opponent
  );
  if (highSalienceOpposition) return false;
  const global = review.globalIdentityJudgment.better;
  if (global !== "not_evaluable" && global !== winner) return false;
  return dimensions.some((dimension) => dimension.better === winner);
}

export function assessPairwiseDecision(review: HeadPairwiseReview): PairwiseDecision {
  let actionableVerdict: PairwiseActionableVerdict;
  if (review.winner === "tie") actionableVerdict = "tie";
  else if (review.confidence < HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE) actionableVerdict = "insufficient_confidence";
  else if (review.calibrationConflicts.length > 0) actionableVerdict = "calibration_conflict";
  else if (review.winner === "B" && (review.p5RegressionInB || review.structuralRegressionInB || review.craftRegressionInB)) {
    actionableVerdict = "unsafe_regression";
  } else if (!identityDimensionsSupportWinner(review, review.winner)) actionableVerdict = "dimension_conflict";
  else if (review.winner === "B" && review.globalIdentityJudgment.replacementValue !== "meaningful") {
    actionableVerdict = "insufficient_identity_gain";
  }
  else actionableVerdict = review.winner;
  return {
    rawPreference: review.winner,
    confidence: review.confidence,
    actionableVerdict,
    replacementSafe: actionableVerdict === "B",
  };
}

function opaque(atlas: RawImage, rect: Rect, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return false;
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3] > 0;
}

function locallyDistinct(atlas: RawImage, rect: Rect, x: number, y: number): boolean {
  const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= rect.w || ny >= rect.h) return false;
    const adjacent = ((rect.y + ny) * ATLAS_SIZE + rect.x + nx) * 4;
    return Math.abs(atlas.rgba[offset] - atlas.rgba[adjacent]) +
      Math.abs(atlas.rgba[offset + 1] - atlas.rgba[adjacent + 1]) +
      Math.abs(atlas.rgba[offset + 2] - atlas.rgba[adjacent + 2]) >= 36;
  });
}

export function measureHeadCandidateStructure(
  atlas: RawImage,
  facePlan?: FacePixelPlan,
  hairPlan?: HairPlan,
): HeadStructuralEvidence {
  const dimensions: HeadStructuralEvidence["dimensions"] = {
    headSilhouette: "not_applicable", hairline: "not_applicable", eyeLayout: "not_applicable",
    mouthExpression: "not_applicable", distinctiveAccessories: "not_applicable", faceProportions: "not_applicable",
  };
  const contractSatisfaction: HeadStructuralEvidence["contractSatisfaction"] = {
    headSilhouette: "not_applicable", hairline: "not_applicable", eyeLayout: "not_applicable",
    mouthExpression: "not_applicable", distinctiveAccessories: "not_applicable", faceProportions: "not_applicable",
  };
  const contractViolations: string[] = [];
  let expectedPixels = 0;
  let presentPixels = 0;
  const presence = (points: Array<{ x: number; y: number }>, rect: Rect, requireContrast = false, ratio = 0.65) => {
    expectedPixels += points.length;
    const count = points.filter((point) => opaque(atlas, rect, point.x, point.y) && (!requireContrast || locallyDistinct(atlas, rect, point.x, point.y))).length;
    presentPixels += count;
    return points.length === 0 ? "not_applicable" as const : count >= Math.max(1, Math.ceil(points.length * ratio)) ? "present" as const : "absent" as const;
  };
  if (facePlan) {
    const face = CLASSIC_LAYOUT.head.base.front;
    const points = (cluster: "left_eye" | "right_eye" | "mouth" | "fringe") => facePlan.pixels.filter((pixel) => pixel.cluster === cluster);
    const leftEye = presence(points("left_eye"), face, true, 0.35);
    const rightEye = presence(points("right_eye"), face, true, 0.35);
    dimensions.eyeLayout = leftEye === "present" && rightEye === "present" ? "present" : "absent";
    dimensions.mouthExpression = presence(points("mouth"), face, true, 0.35);
    dimensions.hairline = presence(points("fringe"), face, true, 0.2);
    dimensions.faceProportions = "present";
    dimensions.distinctiveAccessories = presence(facePlan.layout.glassesMask, CLASSIC_LAYOUT.head.overlay.front);
    const faceContract = measureFaceRenderContract(atlas, facePlan);
    contractSatisfaction.eyeLayout = faceContract.eyesPresent ? "satisfied" : "violated";
    contractSatisfaction.mouthExpression = faceContract.violations.some((problem) => /mouth|teeth|smile/.test(problem)) ? "violated" : "satisfied";
    contractSatisfaction.distinctiveAccessories = faceContract.glassesPresent === null ? "not_applicable" : faceContract.glassesPresent ? "satisfied" : "violated";
    contractSatisfaction.faceProportions = "satisfied";
    if (facePlan.renderContract.hairline) contractSatisfaction.hairline = dimensions.hairline === "present" ? "satisfied" : "violated";
    contractViolations.push(...faceContract.violations);
  }
  if (hairPlan) {
    const mask = hairPlan.headMask;
    const checks = (["front", "top", "left", "right", "back"] as const).flatMap((face) =>
      mask.faces[face].map((point) => ({ face, point })),
    );
    expectedPixels += checks.length;
    const count = checks.filter(({ face, point }) => opaque(atlas, CLASSIC_LAYOUT.head.overlay[face], point.x, point.y)).length;
    presentPixels += count;
    dimensions.headSilhouette = checks.length === 0 ? "not_applicable" : count >= Math.ceil(checks.length * 0.65) ? "present" : "absent";
    const hairContract = measureHairRenderContract(atlas, hairPlan);
    contractSatisfaction.headSilhouette = hairContract.status;
    if (contractSatisfaction.hairline === "not_applicable" && hairPlan.headMask.faces.front.length > 0) contractSatisfaction.hairline = hairContract.status;
    contractViolations.push(...hairContract.violations);
  }
  return { dimensions, contractSatisfaction, contractViolations, expectedPixels, presentPixels };
}

export function buildIdentityDimensionWeights(analysis: PhotoAnalysis): Record<IdentityDimension, number> {
  const weights: Record<IdentityDimension, number> = { headSilhouette: 1, hairline: 1, eyeLayout: 1, mouthExpression: 1, distinctiveAccessories: 1, faceProportions: 1 };
  const mapFeature = (text: string): IdentityDimension[] => [
    ...(/silhouette|overall hair|crown|volume/.test(text) ? ["headSilhouette" as const] : []),
    ...(/hairline|fringe|bang|forehead|part/.test(text) ? ["hairline" as const] : []),
    ...(/\beye|brow|inter-eye/.test(text) ? ["eyeLayout" as const] : []),
    ...(/glass|frame|spectacle|earring|headscarf|accessor/.test(text) ? ["distinctiveAccessories" as const] : []),
    ...(/mouth|smile|teeth|lip/.test(text) ? ["mouthExpression" as const] : []),
    ...(/face width|jaw|round face|narrow face|face proportion/.test(text) ? ["faceProportions" as const] : []),
  ];
  for (const feature of analysis.canonicalIdentity.features) {
    const confidence = feature.confidence === "high" ? 1 : feature.confidence === "medium" ? 0.65 : 0.35;
    const priority = 0.15 * feature.priority + (feature.priority === 5 ? 0.75 : 0);
    for (const dimension of mapFeature(`${feature.feature} ${feature.evidence}`.toLowerCase())) weights[dimension] += priority * confidence;
  }
  const geometry = analysis.identityGeometry?.confidence;
  if (geometry) {
    weights.eyeLayout *= 0.7 + geometry.eyes * 0.3;
    weights.hairline *= 0.7 + geometry.hairline * 0.3;
    weights.headSilhouette *= 0.7 + geometry.headSilhouette * 0.3;
    weights.mouthExpression *= 0.7 + geometry.mouth * 0.3;
    weights.faceProportions *= 0.7 + geometry.faceBounds * 0.3;
    weights.distinctiveAccessories *= 0.7 + geometry.glasses * 0.3;
  }
  return weights;
}

export function shouldAcceptIdentityCorrection(review: HeadPairwiseReview): boolean {
  return assessPairwiseDecision(review).actionableVerdict === "B";
}

export function buildHeadPairwisePrompt(
  purpose: "candidate_selection" | "correction_guard",
  hasSourceHeadCrop: boolean,
): string {
  return `Your single objective is: Which candidate more faithfully preserves the identity of the person in the source photo when represented as a Minecraft skin?

Image 0 is a tight source FACE crop.${hasSourceHeadCrop ? " Image 1 is a wider source HEAD crop." : ""} The final two images are Candidate A and Candidate B. Each candidate evidence panel has a nearest-neighbour enlarged front view on top and an ordered front, front-left 3/4, front-right 3/4 strip below. Both panels use identical geometry, scale, interpolation, padding, background, and lighting. This is a blind ${purpose === "correction_guard" ? "identity correction guard" : "bounded candidate selection"}. ${HEAD_PAIRWISE_BLIND_RULES}

Use this structured evaluation sequence without returning private chain-of-thought:
1. Identify the source-visible identity cues and record them in sourceSalientCues with high, medium, or low importance.
2. For every dimension, separately record candidate visibility/readability and source fidelity.
3. Compare the same source cue in A and B. The dimension's better field means greater fidelity to the source, never greater pixel clarity by itself.
4. Consider only traits representable on a standard 8x8 Minecraft head.
5. In globalIdentityJudgment, ignore pixel polish and generic visual quality and decide which candidate would make a human viewer more likely to identify the person in the source. Record whether the advantage is meaningful enough to justify replacement, trivial, or unclear.
6. Return the overall raw preference and confidence that the winner is meaningfully more faithful to the source. The overall winner must agree with the global same-person judgment; otherwise use tie or report the uncertainty.

Source-conditioned dimension meanings:
- headSilhouette: fidelity of crown volume, hair length, side/back mass, asymmetry, and overall head outline to the source.
- hairline: fidelity of fringe/part, exposed forehead, depth, and placement to the source.
- eyeLayout: fidelity of relative eye height, spacing, openness, asymmetry, and relation to eyewear in the source.
- mouthExpression: fidelity of mouth height, width, openness, and expression to the source.
- distinctiveAccessories: fidelity of source-visible glasses, earrings, head coverings, and other identity-defining head accessories. For glasses consider frame shape, scale, placement, thickness, lens footprint, and relation to the eyes. visualReadability only says whether pixels are visible; a clearer or thicker feature is worse when it mismatches the source.
- faceProportions: fidelity of visible face-window width, jaw impression, relative feature placement, and hair/face balance to the source.

Candidate-internal prettiness is not identity evidence. Do not prefer sharper contrast, cleaner pixels, more detailed hair, thicker glasses, more visible eyes, prettier shading, or a more elaborate outer layer unless that specific property more closely matches the source. A subtle source-matching feature must beat a dramatic but incorrect one. Source-high-salience fidelity loss must outweigh small improvements in low-salience clarity; do not use unweighted dimension majority voting.

Use tie normally when the identity difference is immaterial, source evidence is insufficient, trade-offs are unresolved, or one candidate is clearer while the other appears more source-faithful. A slight lean may be reported as A or B with confidence below ${HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE.toFixed(2)}, but that is not an actionable replacement. confidence means confidence in meaningful source-identity superiority, not confidence that some visible difference exists. Do not force A or B.

Mark p5RegressionInB only when Candidate B visibly loses a high-salience source identity cue; mark structuralRegressionInB or craftRegressionInB only from visible candidate evidence. These VLM diagnostics never replace the deterministic pre-pairwise admissibility gate. reasons must cite source-conditioned comparisons. failedIdentityFeatures and correctionTargets describe remaining source-identity losses using compact Minecraft regions.`;
}

export async function runHeadPairwiseComparison(
  env: Env,
  analysis: PhotoAnalysis,
  sourceFaceCropDataUrl: string,
  candidateADataUrl: string,
  candidateBDataUrl: string,
  purpose: "candidate_selection" | "correction_guard" = "candidate_selection",
  sourceHeadCropDataUrl?: string,
  structuralA?: HeadStructuralEvidence,
  structuralB?: HeadStructuralEvidence,
): Promise<HeadPairwiseResult> {
  const prompt = buildHeadPairwisePrompt(purpose, Boolean(sourceHeadCropDataUrl));
  const models = [env.VISION_MODEL?.trim() || "gemini-3.6-flash", env.VISION_FALLBACK_MODEL?.trim()]
    .filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index);
  let lastError: unknown;
  let neuronsSpent = 0;
  for (const model of models) {
    try {
      const result = await generateGeminiStructuredJson(env, {
        model,
        imageDataUrls: [sourceFaceCropDataUrl, ...(sourceHeadCropDataUrl ? [sourceHeadCropDataUrl] : []), candidateADataUrl, candidateBDataUrl],
        imageLabels: [
          "Tight source face crop (facial geometry truth):",
          ...(sourceHeadCropDataUrl ? ["Wider source head crop (hair silhouette/hairline truth):"] : []),
          "Candidate A (blind label):",
          "Candidate B (blind label):",
        ],
        prompt,
        responseSchema: HEAD_PAIRWISE_SCHEMA,
        maxOutputTokens: 2400,
      });
      neuronsSpent += visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
      const payload = extractPayload(result);
      const review = payload ? parseHeadPairwiseReview(payload, structuralA, structuralB) : null;
      if (!review) {
        lastError = new Error(`${model}: invalid pairwise response`);
        continue;
      }
      review.dimensionWeights = buildIdentityDimensionWeights(analysis);
      return { ok: true, review, neuronsSpent };
    } catch (error) {
      lastError = error;
      neuronsSpent += NEURONS_VISION_DETAIL_ESTIMATE;
    }
  }
  const quotaFailure = classifyEvaluatorQuotaFailure(lastError);
  return {
    ok: false,
    quotaExceeded: isGeminiQuotaError(lastError),
    ...(quotaFailure ? { quotaFailure } : {}),
    detail: lastError instanceof Error ? lastError.message : String(lastError),
    neuronsSpent,
  };
}
