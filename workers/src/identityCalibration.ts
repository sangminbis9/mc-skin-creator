import {
  HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE,
  type CandidateAdmissibility,
  type HeadCandidateAdmissibilityEvidence,
  type PairwiseDecision,
  type HeadPairwiseReview,
  type IdentityDimension,
  type PairwiseActionableVerdict,
} from "./headIdentity";
import type { FacePixelPlan, HairPlan } from "./identityPlans";
import type { RawImage } from "./png";
import type { SkinCritique } from "./skinCritique";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type Rect } from "./uvLayout";

export type IdentityCalibrationLevel = "A_identical" | "B_minor" | "C_degraded" | "D_generic" | "E_improved";

export interface IdentityCalibrationAtlas {
  level: Exclude<IdentityCalibrationLevel, "E_improved">;
  atlas: RawImage;
  changedPixels: number;
  changedIdentityDimensions: string[];
}

export interface NearPeerCalibrationDefinition {
  id: "hairline-near-peer" | "eye-layout-near-peer" | "head-silhouette-near-peer";
  primaryDimension: IdentityDimension;
  candidateA: HeadCandidateAdmissibilityEvidence;
  candidateB: HeadCandidateAdmissibilityEvidence;
  deterministicDifference: {
    hairlineDistance: number;
    eyeLayoutDistance: number;
    silhouetteDistance: number;
    expressionTopologyDifference: number;
    accessoryFootprintDistance: number;
  };
  sourceFidelityPrinciple: string;
}

const ADMISSIBLE_NEAR_PEER: HeadCandidateAdmissibilityEvidence = {
  p5Valid: true,
  craftValid: true,
  renderContractValid: true,
  criticalDefects: [],
  calibrationConflicts: [],
};

/** Offline semantic fixtures; deterministic differences are never sent to the VLM. */
export const NEAR_PEER_CALIBRATION_DATASET: readonly NearPeerCalibrationDefinition[] = [
  {
    id: "hairline-near-peer",
    primaryDimension: "hairline",
    candidateA: ADMISSIBLE_NEAR_PEER,
    candidateB: ADMISSIBLE_NEAR_PEER,
    deterministicDifference: { hairlineDistance: 0.125, eyeLayoutDistance: 0, silhouetteDistance: 0, expressionTopologyDifference: 0, accessoryFootprintDistance: 0 },
    sourceFidelityPrinciple: "source-matching part and forehead opening outrank a plausible generic hairline",
  },
  {
    id: "eye-layout-near-peer",
    primaryDimension: "eyeLayout",
    candidateA: ADMISSIBLE_NEAR_PEER,
    candidateB: ADMISSIBLE_NEAR_PEER,
    deterministicDifference: { hairlineDistance: 0, eyeLayoutDistance: 0.125, silhouetteDistance: 0, expressionTopologyDifference: 0.125, accessoryFootprintDistance: 0 },
    sourceFidelityPrinciple: "source-specific spacing and openness outrank cleaner generic symmetry",
  },
  {
    id: "head-silhouette-near-peer",
    primaryDimension: "headSilhouette",
    candidateA: ADMISSIBLE_NEAR_PEER,
    candidateB: ADMISSIBLE_NEAR_PEER,
    deterministicDifference: { hairlineDistance: 0, eyeLayoutDistance: 0, silhouetteDistance: 0.125, expressionTopologyDifference: 0, accessoryFootprintDistance: 0 },
    sourceFidelityPrinciple: "source crown and side contour outrank a plausible generic contour in the same hair category",
  },
] as const;

function cloneAtlas(atlas: RawImage): RawImage {
  return { width: atlas.width, height: atlas.height, rgba: new Uint8Array(atlas.rgba) };
}

function pixelOffset(rect: Rect, x: number, y: number): number {
  return ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
}

function copyColor(atlas: RawImage, rect: Rect, x: number, y: number): [number, number, number, number] {
  const offset = pixelOffset(rect, x, y);
  return [atlas.rgba[offset], atlas.rgba[offset + 1], atlas.rgba[offset + 2], atlas.rgba[offset + 3]];
}

function putColor(atlas: RawImage, rect: Rect, x: number, y: number, color: readonly number[]): void {
  atlas.rgba.set(color, pixelOffset(rect, x, y));
}

/**
 * Build blind A-D calibration stimuli from the current atlas. The mutations are
 * plan-driven and generic: no source identity, expected winner, or score is
 * embedded in the image or returned metadata.
 */
export function buildIdentityCalibrationAtlases(
  current: RawImage,
  facePlan: FacePixelPlan,
  hairPlan: HairPlan,
): IdentityCalibrationAtlas[] {
  const baseFront = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay;
  const identical = cloneAtlas(current);

  const minor = cloneAtlas(current);
  const protectedBase = new Set(facePlan.pixels.map((pixel) => `${pixel.x},${pixel.y}`));
  const cheek = [[1, 5], [6, 5], [1, 6], [6, 6]].find(([x, y]) => !protectedBase.has(`${x},${y}`)) ?? [1, 6];
  const cheekOffset = pixelOffset(baseFront, cheek[0], cheek[1]);
  for (let channel = 0; channel < 3; channel++) {
    minor.rgba[cheekOffset + channel] = Math.max(0, Math.min(255, minor.rgba[cheekOffset + channel] + (channel === 0 ? 4 : 2)));
  }

  const degraded = cloneAtlas(current);
  let degradedPixels = 0;
  const degradedDimensions: string[] = [];
  const erase = (rect: Rect, x: number, y: number) => {
    const offset = pixelOffset(rect, x, y);
    if (degraded.rgba[offset + 3] !== 0) degradedPixels++;
    degraded.rgba[offset + 3] = 0;
  };
  const glassesPixels = [...facePlan.glassesPlan.framePixels, ...facePlan.glassesPlan.sideArms];
  if (glassesPixels.length > 0) {
    for (const point of glassesPixels) erase(overlay[point.face], point.x, point.y);
    degradedDimensions.push("glasses_readability");
  } else if (facePlan.pixels.some((pixel) => pixel.cluster === "fringe")) {
    const skin = copyColor(current, baseFront, 4, 4);
    for (const pixel of facePlan.pixels.filter((item) => item.cluster === "fringe")) {
      putColor(degraded, baseFront, pixel.x, pixel.y, skin);
      degradedPixels++;
    }
    degradedDimensions.push("fringe_profile");
  } else {
    for (const face of ["left", "right"] as const) {
      const points = hairPlan.headMask.faces[face];
      const maximumY = Math.max(0, ...points.map((point) => point.y));
      for (const point of points.filter((item) => item.y >= maximumY - 1)) erase(overlay[face], point.x, point.y);
    }
    degradedDimensions.push("side_silhouette");
  }

  const generic = cloneAtlas(current);
  const skin = copyColor(current, baseFront, 4, 4);
  const hairPixel = facePlan.pixels.find((pixel) => pixel.cluster === "fringe");
  const hair = hairPixel ? copyColor(current, baseFront, hairPixel.x, hairPixel.y) : copyColor(current, baseFront, 0, 0);
  const eyePixel = facePlan.pixels.find((pixel) => pixel.cluster === "left_eye");
  const eye = eyePixel ? copyColor(current, baseFront, eyePixel.x, eyePixel.y) : [32, 28, 26, 255] as const;
  const mouthPixel = facePlan.pixels.find((pixel) => pixel.cluster === "mouth");
  const mouth = mouthPixel ? copyColor(current, baseFront, mouthPixel.x, mouthPixel.y) : [92, 46, 48, 255] as const;
  let genericPixels = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const next = y === 0 ? hair : skin;
    const previous = copyColor(generic, baseFront, x, y);
    if (previous.some((value, index) => value !== next[index])) genericPixels++;
    putColor(generic, baseFront, x, y, next);
  }
  for (const x of [2, 5]) putColor(generic, baseFront, x, 3, eye);
  for (const x of [3, 4]) putColor(generic, baseFront, x, 5, mouth);
  for (const face of ["front", "left", "right"] as const) {
    const rect = overlay[face];
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const offset = pixelOffset(rect, x, y);
      if (generic.rgba[offset + 3] !== 0) genericPixels++;
      generic.rgba[offset + 3] = 0;
    }
  }

  return [
    { level: "A_identical", atlas: identical, changedPixels: 0, changedIdentityDimensions: [] },
    { level: "B_minor", atlas: minor, changedPixels: 1, changedIdentityDimensions: [] },
    { level: "C_degraded", atlas: degraded, changedPixels: degradedPixels, changedIdentityDimensions: degradedDimensions },
    { level: "D_generic", atlas: generic, changedPixels: genericPixels, changedIdentityDimensions: ["hairline", "eye_layout", "mouth_expression", "face_width", "accessories"] },
  ];
}

export interface IdentityScoreSample {
  id: string;
  level?: IdentityCalibrationLevel;
  identityScore: number;
  faceHairScore: number;
}

export interface ScoreHistogram {
  count: number;
  bins: Record<number, number>;
  mode: number | null;
  modeCount: number;
  modeShare: number;
  distinctScores: number;
}

export function buildScoreHistogram(values: number[]): ScoreHistogram {
  const bins: Record<number, number> = {};
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 100) continue;
    bins[value] = (bins[value] ?? 0) + 1;
  }
  const entries = Object.entries(bins).map(([score, count]) => [Number(score), count] as const);
  entries.sort((first, second) => second[1] - first[1] || first[0] - second[0]);
  const mode = entries[0]?.[0] ?? null;
  const modeCount = entries[0]?.[1] ?? 0;
  const count = entries.reduce((sum, entry) => sum + entry[1], 0);
  return {
    count,
    bins,
    mode,
    modeCount,
    modeShare: count === 0 ? 0 : modeCount / count,
    distinctScores: entries.length,
  };
}

export function summarizeIdentityScores(samples: IdentityScoreSample[]): {
  identity: ScoreHistogram;
  faceHair: ScoreHistogram;
  suspiciousIdentityPlateau: boolean;
} {
  const identity = buildScoreHistogram(samples.map((sample) => sample.identityScore));
  const faceHair = buildScoreHistogram(samples.map((sample) => sample.faceHairScore));
  // A mode occupying at least two thirds of a non-trivial sample while the
  // adjacent face/hair dimension has more resolution is calibration evidence,
  // not a score adjustment or release-gate override.
  const suspiciousIdentityPlateau =
    identity.count >= 10 &&
    identity.modeShare >= 2 / 3 &&
    (faceHair.distinctScores > identity.distinctScores ||
      faceHair.modeShare + 0.15 < identity.modeShare);
  return { identity, faceHair, suspiciousIdentityPlateau };
}

export interface IdentitySensitivityPoint {
  id: string;
  retainedIdentity: number;
  critique: Pick<SkinCritique, "identityScore" | "faceHairScore">;
}

export interface IdentitySensitivityAssessment {
  monotonic: boolean;
  strictDrops: number;
  plateauSteps: number;
  inversions: Array<{ from: string; to: string; delta: number }>;
  totalIdentityDrop: number;
}

export function assessIdentitySensitivity(
  points: IdentitySensitivityPoint[],
): IdentitySensitivityAssessment {
  const ordered = [...points].sort((first, second) => second.retainedIdentity - first.retainedIdentity);
  let strictDrops = 0;
  let plateauSteps = 0;
  const inversions: IdentitySensitivityAssessment["inversions"] = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const delta = current.critique.identityScore - previous.critique.identityScore;
    if (delta < 0) strictDrops++;
    else if (delta === 0) plateauSteps++;
    else inversions.push({ from: previous.id, to: current.id, delta });
  }
  return {
    monotonic: inversions.length === 0,
    strictDrops,
    plateauSteps,
    inversions,
    totalIdentityDrop: ordered.length < 2
      ? 0
      : ordered[0].critique.identityScore - ordered.at(-1)!.critique.identityScore,
  };
}

export interface CalibrationBenchmarkObservation {
  level: IdentityCalibrationLevel;
  absolute?: Pick<SkinCritique, "identityScore" | "faceHairScore">;
  candidateAdmissibility?: CandidateAdmissibility;
  pairwise?: Pick<HeadPairwiseReview, "winner" | "confidence"> & {
    actionableVerdict?: PairwiseActionableVerdict;
  };
}

export type CalibrationPairwiseRole = "production_near_peer" | "stress_test_only" | "not_executed";

export function classifyCalibrationPairwiseRole(
  observation: CalibrationBenchmarkObservation,
): CalibrationPairwiseRole {
  if (!observation.pairwise) return "not_executed";
  return observation.candidateAdmissibility?.admissible === false
    ? "stress_test_only"
    : "production_near_peer";
}

export interface PairwiseStabilityDirectionInput {
  candidateOrder: readonly [string, string];
  decision: PairwiseDecision;
}

export type NormalizedActionableOutcome =
  | { kind: "select_candidate"; candidateId: string }
  | { kind: "abstain"; reason: Exclude<PairwiseActionableVerdict, "A" | "B"> };

export type NormalizedProductionDecision =
  | { kind: "retain_incumbent"; selectedCandidateId: string }
  | { kind: "replace_incumbent"; selectedCandidateId: string };

export interface PairwiseStabilityDirection {
  candidateOrder: readonly [string, string];
  normalizedRawPreference: string | "tie";
  confidence: number;
  actionableVerdict: PairwiseActionableVerdict;
  normalizedActionableOutcome: NormalizedActionableOutcome;
  productionDecision: NormalizedProductionDecision;
}

export interface PairwiseStability {
  incumbentCandidateId: string;
  rawPreferenceStable: boolean | null;
  actionableVerdictStable: boolean | null;
  productionDecisionStable: boolean | null;
  safeAbstention: boolean | null;
  forward: PairwiseStabilityDirection | null;
  reverse: PairwiseStabilityDirection | null;
}

function normalizePairwiseDirection(
  incumbentCandidateId: string,
  input: PairwiseStabilityDirectionInput,
): PairwiseStabilityDirection {
  if (!input.candidateOrder.includes(incumbentCandidateId)) {
    throw new Error(`incumbent candidate ${incumbentCandidateId} is absent from the comparison order`);
  }
  const candidateIdForLabel = (label: "A" | "B"): string =>
    input.candidateOrder[label === "A" ? 0 : 1];
  const normalizedRawPreference = input.decision.rawPreference === "tie"
    ? "tie"
    : candidateIdForLabel(input.decision.rawPreference);
  const normalizedActionableOutcome: NormalizedActionableOutcome =
    input.decision.actionableVerdict === "A" || input.decision.actionableVerdict === "B"
      ? { kind: "select_candidate", candidateId: candidateIdForLabel(input.decision.actionableVerdict) }
      : { kind: "abstain", reason: input.decision.actionableVerdict };
  const selectedCandidateId = normalizedActionableOutcome.kind === "select_candidate"
    ? normalizedActionableOutcome.candidateId
    : incumbentCandidateId;
  return {
    candidateOrder: input.candidateOrder,
    normalizedRawPreference,
    confidence: input.decision.confidence,
    actionableVerdict: input.decision.actionableVerdict,
    normalizedActionableOutcome,
    productionDecision: selectedCandidateId === incumbentCandidateId
      ? { kind: "retain_incumbent", selectedCandidateId }
      : { kind: "replace_incumbent", selectedCandidateId },
  };
}

function actionableOutcomeStable(
  forward: NormalizedActionableOutcome,
  reverse: NormalizedActionableOutcome,
): boolean {
  if (forward.kind === "abstain" && reverse.kind === "abstain") return true;
  return forward.kind === "select_candidate" &&
    reverse.kind === "select_candidate" &&
    forward.candidateId === reverse.candidateId;
}

/**
 * Calibration-only normalization. Exact raw/verdict values remain available,
 * while stability is compared using real candidate identities and a fixed
 * incumbent rather than arbitrary A/B positions.
 */
export function assessPairwiseStability(input: {
  incumbentCandidateId: string;
  forward?: PairwiseStabilityDirectionInput;
  reverse?: PairwiseStabilityDirectionInput;
}): PairwiseStability {
  const forward = input.forward
    ? normalizePairwiseDirection(input.incumbentCandidateId, input.forward)
    : null;
  const reverse = input.reverse
    ? normalizePairwiseDirection(input.incumbentCandidateId, input.reverse)
    : null;
  if (!forward || !reverse) {
    return {
      incumbentCandidateId: input.incumbentCandidateId,
      rawPreferenceStable: null,
      actionableVerdictStable: null,
      productionDecisionStable: null,
      safeAbstention: null,
      forward,
      reverse,
    };
  }
  const productionDecisionStable =
    forward.productionDecision.selectedCandidateId === reverse.productionDecision.selectedCandidateId;
  return {
    incumbentCandidateId: input.incumbentCandidateId,
    rawPreferenceStable: forward.normalizedRawPreference === reverse.normalizedRawPreference,
    actionableVerdictStable: actionableOutcomeStable(
      forward.normalizedActionableOutcome,
      reverse.normalizedActionableOutcome,
    ),
    productionDecisionStable,
    safeAbstention: productionDecisionStable &&
      forward.normalizedActionableOutcome.kind === "abstain" &&
      reverse.normalizedActionableOutcome.kind === "abstain",
    forward,
    reverse,
  };
}

export type MeaningfulImprovementSensitivity = "supported" | "not_supported" | "not_measured";

export function assessMeaningfulImprovementSensitivity(
  stability: PairwiseStability,
  expectedImprovedCandidateId: string | null,
): MeaningfulImprovementSensitivity {
  if (!expectedImprovedCandidateId || !stability.forward || !stability.reverse) return "not_measured";
  const selectedExpectedCandidate = (direction: PairwiseStabilityDirection): boolean =>
    direction.normalizedActionableOutcome.kind === "select_candidate" &&
    direction.normalizedActionableOutcome.candidateId === expectedImprovedCandidateId;
  return stability.productionDecisionStable === true &&
    selectedExpectedCandidate(stability.forward) &&
    selectedExpectedCandidate(stability.reverse)
    ? "supported"
    : "not_supported";
}

function benchmarkPairwiseVerdict(
  pairwise: NonNullable<CalibrationBenchmarkObservation["pairwise"]>,
): PairwiseActionableVerdict {
  if (pairwise.actionableVerdict) return pairwise.actionableVerdict;
  if (pairwise.winner !== "tie" && pairwise.confidence < HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE) {
    return "insufficient_confidence";
  }
  return pairwise.winner;
}

export function validateCalibrationBenchmark(
  observations: CalibrationBenchmarkObservation[],
): string[] {
  const failures: string[] = [];
  const byLevel = new Map(observations.map((observation) => [observation.level, observation]));
  const identical = byLevel.get("A_identical")?.pairwise;
  if (identical && benchmarkPairwiseVerdict(identical) !== "tie") failures.push("identical candidate comparison did not tie");
  const minor = byLevel.get("B_minor")?.absolute;
  const current = byLevel.get("A_identical")?.absolute;
  if (minor && current && Math.abs(minor.identityScore - current.identityScore) > 3) {
    failures.push("minor non-identity change moved identity by more than three points");
  }
  const degraded = byLevel.get("C_degraded");
  if (degraded?.pairwise && classifyCalibrationPairwiseRole(degraded) === "production_near_peer") {
    const verdict = benchmarkPairwiseVerdict(degraded.pairwise);
    if (verdict === "B") failures.push("degraded candidate was an actionable winner");
    else if (verdict !== "A") failures.push("degraded comparison did not produce an actionable current-candidate win");
  }
  if (degraded?.absolute && current && degraded.absolute.identityScore >= current.identityScore) failures.push("degraded identity did not reduce absolute identity");
  const generic = byLevel.get("D_generic")?.absolute;
  if (generic && degraded?.absolute && generic.identityScore > degraded.absolute.identityScore) failures.push("generic face scored above the targeted degradation");
  const genericPairwise = byLevel.get("D_generic")?.pairwise;
  const genericObservation = byLevel.get("D_generic");
  if (genericPairwise && genericObservation && classifyCalibrationPairwiseRole(genericObservation) === "production_near_peer") {
    const verdict = benchmarkPairwiseVerdict(genericPairwise);
    if (verdict === "B") failures.push("generic candidate was an actionable winner");
    else if (verdict !== "A") failures.push("generic comparison did not produce an actionable current-candidate win");
  }
  const improved = byLevel.get("E_improved")?.pairwise;
  if (improved && benchmarkPairwiseVerdict(improved) !== "B") failures.push("source-informed improvement did not win actionably");
  return failures;
}

export type EvaluatorHealthStatus = "healthy" | "degraded" | "unknown";

export interface EvaluatorHealthInput {
  observations: CalibrationBenchmarkObservation[];
  diagnosisConflictCount: number;
  completedPairwiseComparisons: number;
  requiredPairwiseComparisons: number;
  liveCallFailures: number;
  orderBiasDetected: boolean;
}

export interface EvaluatorHealth {
  status: EvaluatorHealthStatus;
  reasons: string[];
  benchmarkFailures: string[];
}

export type PairwiseRoleHealthStatus = "healthy" | "safe_but_uncertain" | "improving" | "degraded" | "unknown";

export interface PairwiseEvaluatorRoleHealthInput {
  inadmissibleCandidatesRejected: number;
  inadmissiblePairwiseCalls: number;
  stability: PairwiseStability | null;
  expectedMeaningfullyImprovedCandidateId: string | null;
  sourceFidelityConflictCount: number;
}

export interface PairwiseEvaluatorRoleHealth {
  catastrophicCandidateSafety: PairwiseRoleHealthStatus;
  nearPeerSafety: PairwiseRoleHealthStatus;
  nearPeerDiscrimination: PairwiseRoleHealthStatus;
  rawOrderStability: PairwiseRoleHealthStatus;
  decisionOrderStability: PairwiseRoleHealthStatus;
  meaningfulImprovementSensitivity: PairwiseRoleHealthStatus;
  sourceFidelityCalibration: PairwiseRoleHealthStatus;
}

/** Diagnostic only; these role-specific statuses never alter strict gates. */
export function assessPairwiseEvaluatorRoleHealth(
  input: PairwiseEvaluatorRoleHealthInput,
): PairwiseEvaluatorRoleHealth {
  const catastrophicCandidateSafety = input.inadmissiblePairwiseCalls > 0
    ? "degraded"
    : input.inadmissibleCandidatesRejected > 0
      ? "healthy"
      : "unknown";
  const nearPeerSafety = input.stability?.productionDecisionStable === true
    ? "healthy"
    : input.stability?.productionDecisionStable === false
      ? "degraded"
      : "unknown";
  const rawOrderStability = input.stability?.rawPreferenceStable === true
    ? "healthy"
    : input.stability?.rawPreferenceStable === false
      ? "degraded"
      : "unknown";
  const decisionOrderStability = input.stability?.productionDecisionStable === true
    ? "healthy"
    : input.stability?.productionDecisionStable === false
      ? "degraded"
      : "unknown";
  const sensitivity = input.stability
    ? assessMeaningfulImprovementSensitivity(input.stability, input.expectedMeaningfullyImprovedCandidateId)
    : "not_measured";
  const meaningfulImprovementSensitivity = sensitivity === "supported"
    ? "healthy"
    : sensitivity === "not_supported"
      ? input.stability?.safeAbstention ? "safe_but_uncertain" : "degraded"
      : "unknown";
  const nearPeerDiscrimination = sensitivity === "supported"
    ? "healthy"
    : input.stability?.safeAbstention
      ? "safe_but_uncertain"
      : sensitivity === "not_supported"
        ? "degraded"
        : "unknown";
  const sourceFidelityCalibration = input.sourceFidelityConflictCount === 0
    ? input.stability?.forward ? "healthy" : "unknown"
    : "improving";
  return {
    catastrophicCandidateSafety,
    nearPeerSafety,
    nearPeerDiscrimination,
    rawOrderStability,
    decisionOrderStability,
    meaningfulImprovementSensitivity,
    sourceFidelityCalibration,
  };
}

/** Diagnostic only. This result must never bypass or relax the release gate. */
export function assessEvaluatorHealth(input: EvaluatorHealthInput): EvaluatorHealth {
  const absoluteLevels = new Set(
    input.observations
      .filter((observation) => observation.absolute)
      .map((observation) => observation.level),
  );
  const benchmarkFailures = validateCalibrationBenchmark(input.observations);
  const incomplete =
    !(["A_identical", "B_minor", "C_degraded", "D_generic"] as const)
      .every((level) => absoluteLevels.has(level)) ||
    input.completedPairwiseComparisons < input.requiredPairwiseComparisons;
  if (incomplete) {
    return {
      status: "unknown",
      reasons: ["required controlled calibration observations are incomplete"],
      benchmarkFailures,
    };
  }

  const reasons = [
    ...benchmarkFailures,
    ...(input.diagnosisConflictCount > 0
      ? [`${input.diagnosisConflictCount} score/diagnosis conflict(s)`]
      : []),
    ...(input.liveCallFailures > 0
      ? [`${input.liveCallFailures} live evaluator call(s) failed`]
      : []),
    ...(input.orderBiasDetected ? ["pairwise order bias detected"] : []),
  ];
  return {
    status: reasons.length === 0 ? "healthy" : "degraded",
    reasons,
    benchmarkFailures,
  };
}
