import type { PhotoAnalysis } from "./analysis";
import { generateGeminiStructuredJson, isGeminiQuotaError } from "./gemini";
import type { RawImage } from "./png";
import type { FacePixelPlan, HairPlan } from "./identityPlans";
import { measureFaceRenderContract, measureHairRenderContract, type ContractStatus } from "./identityRenderContract";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type Rect } from "./uvLayout";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";
import type { Env } from "./types";

export type HeadCandidateKind = "generated" | "deterministic" | "deterministic_variant" | "corrected";

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
}

export interface HeadPairwiseReview {
  winner: "A" | "B" | "tie";
  confidence: number;
  identityDimensions: Record<IdentityDimension, IdentityDimensionReview>;
  p5RegressionInB: boolean;
  structuralRegressionInB: boolean;
  craftRegressionInB: boolean;
  calibrationConflicts: string[];
  reasons: string[];
  failedIdentityFeatures: string[];
  correctionTargets: string[];
  dimensionWeights?: Record<IdentityDimension, number>;
}

export type IdentityDimension = "hairSilhouette" | "hairline" | "eyeLayout" | "glassesReadability" | "mouthExpression" | "faceWidth";
export interface IdentityDimensionReview {
  better: "A" | "B" | "tie" | "not_evaluable";
  structuralPresenceA: "present" | "absent" | "not_applicable";
  structuralPresenceB: "present" | "absent" | "not_applicable";
  visualReadabilityA: "strong" | "weak" | "absent" | "not_evaluable";
  visualReadabilityB: "strong" | "weak" | "absent" | "not_evaluable";
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
export const HEAD_PAIRWISE_BLIND_RULES = "Neither A nor B communicates chronology, candidate cost, contract status, structural pass/fail state, or an expected winner.";

export type HeadPairwiseResult =
  | { ok: true; review: HeadPairwiseReview; neuronsSpent: number }
  | { ok: false; quotaExceeded: boolean; detail: string; neuronsSpent: number };

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
    reason: { type: "string" },
  },
  required: ["better", "visualReadabilityA", "visualReadabilityB", "reason"],
} as const;

export const HEAD_PAIRWISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    identityDimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        hairSilhouette: dimensionSchema,
        hairline: dimensionSchema,
        eyeLayout: dimensionSchema,
        glassesReadability: dimensionSchema,
        mouthExpression: dimensionSchema,
        faceWidth: dimensionSchema,
      },
      required: ["hairSilhouette", "hairline", "eyeLayout", "glassesReadability", "mouthExpression", "faceWidth"],
    },
    p5RegressionInB: { type: "boolean" },
    structuralRegressionInB: { type: "boolean" },
    craftRegressionInB: { type: "boolean" },
    reasons: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
    failedIdentityFeatures: { type: "array", maxItems: 8, items: { type: "string" } },
    correctionTargets: { type: "array", maxItems: 8, items: { type: "string" } },
  },
  required: ["winner", "confidence", "identityDimensions", "p5RegressionInB", "structuralRegressionInB", "craftRegressionInB", "reasons", "failedIdentityFeatures", "correctionTargets"],
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
  const dimensionNames: IdentityDimension[] = ["hairSilhouette", "hairline", "eyeLayout", "glassesReadability", "mouthExpression", "faceWidth"];
  const rawDimensions = typeof raw.identityDimensions === "object" && raw.identityDimensions !== null
    ? raw.identityDimensions as Record<string, unknown>
    : {};
  const fallbackDimension: IdentityDimensionReview = {
    better: "not_evaluable", structuralPresenceA: "not_applicable", structuralPresenceB: "not_applicable",
    visualReadabilityA: "not_evaluable", visualReadabilityB: "not_evaluable", reason: "dimension not returned",
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
      typeof candidate.reason !== "string"
    ) return null;
    identityDimensions[name] = {
      better: candidate.better as IdentityDimensionReview["better"],
      structuralPresenceA: structuralA?.dimensions[name] ?? (["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceA)) ? candidate.structuralPresenceA as IdentityDimensionReview["structuralPresenceA"] : "not_applicable"),
      structuralPresenceB: structuralB?.dimensions[name] ?? (["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceB)) ? candidate.structuralPresenceB as IdentityDimensionReview["structuralPresenceB"] : "not_applicable"),
      visualReadabilityA: candidate.visualReadabilityA as IdentityDimensionReview["visualReadabilityA"],
      visualReadabilityB: candidate.visualReadabilityB as IdentityDimensionReview["visualReadabilityB"],
      reason: candidate.reason,
    };
  }
  const conflictText = [...reasons, ...failedIdentityFeatures].join(" ").toLowerCase();
  const calibrationConflicts: string[] = [];
  const glasses = identityDimensions.glassesReadability;
  if (/\b(?:missing|absent|no)\b.{0,24}\b(?:glasses|frames|spectacles)\b/.test(conflictText) &&
      (glasses.structuralPresenceA === "present" || glasses.structuralPresenceB === "present")) {
    calibrationConflicts.push("glasses described as missing despite reported structural presence; treat as readability uncertainty");
  }
  return {
    winner: raw.winner as HeadPairwiseReview["winner"],
    confidence: raw.confidence,
    identityDimensions,
    p5RegressionInB: raw.p5RegressionInB === true,
    structuralRegressionInB: raw.structuralRegressionInB === true,
    craftRegressionInB: raw.craftRegressionInB === true,
    calibrationConflicts,
    reasons,
    failedIdentityFeatures,
    correctionTargets,
  };
}

export function selectHeadCandidate(
  candidateA: HeadCandidate,
  candidateB: HeadCandidate,
  review: HeadPairwiseReview,
): HeadCandidate {
  const dimensionSupport = identityDimensionsSupportWinner(review, "B");
  const safeReplacement =
    candidateB.structuralValidity &&
    review.winner === "B" &&
    review.confidence >= HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE &&
    !review.p5RegressionInB &&
    !review.structuralRegressionInB &&
    !review.craftRegressionInB &&
    (review.calibrationConflicts?.length ?? 0) === 0 &&
    dimensionSupport;
  if (safeReplacement) return candidateB;
  if (review.confidence >= HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE && review.winner === "A") return candidateA;
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
  const entries = Object.entries(review.identityDimensions) as Array<[IdentityDimension, IdentityDimensionReview]>;
  const weight = (name: IdentityDimension) => review.dimensionWeights?.[name] ?? 1;
  const aVotes = entries.filter(([, dimension]) => dimension.better === "A").reduce((sum, [name]) => sum + weight(name), 0);
  const bVotes = entries.filter(([, dimension]) => dimension.better === "B").reduce((sum, [name]) => sum + weight(name), 0);
  const allUnavailable = dimensions.every((dimension) => dimension.better === "not_evaluable");
  // Keep old stored reviews readable, but do not let an overall winner override
  // contradictory structured evidence or six dimension-level ties.
  if (allUnavailable) return true;
  return winner === "B" ? bVotes > 0 && bVotes >= aVotes : aVotes > 0 && aVotes >= bVotes;
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
    hairSilhouette: "not_applicable", hairline: "not_applicable", eyeLayout: "not_applicable",
    glassesReadability: "not_applicable", mouthExpression: "not_applicable", faceWidth: "not_applicable",
  };
  const contractSatisfaction: HeadStructuralEvidence["contractSatisfaction"] = {
    hairSilhouette: "not_applicable", hairline: "not_applicable", eyeLayout: "not_applicable",
    glassesReadability: "not_applicable", mouthExpression: "not_applicable", faceWidth: "not_applicable",
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
    dimensions.faceWidth = "present";
    dimensions.glassesReadability = presence(facePlan.layout.glassesMask, CLASSIC_LAYOUT.head.overlay.front);
    const faceContract = measureFaceRenderContract(atlas, facePlan);
    contractSatisfaction.eyeLayout = faceContract.eyesPresent ? "satisfied" : "violated";
    contractSatisfaction.mouthExpression = faceContract.violations.some((problem) => /mouth|teeth|smile/.test(problem)) ? "violated" : "satisfied";
    contractSatisfaction.glassesReadability = faceContract.glassesPresent === null ? "not_applicable" : faceContract.glassesPresent ? "satisfied" : "violated";
    contractSatisfaction.faceWidth = "satisfied";
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
    dimensions.hairSilhouette = checks.length === 0 ? "not_applicable" : count >= Math.ceil(checks.length * 0.65) ? "present" : "absent";
    const hairContract = measureHairRenderContract(atlas, hairPlan);
    contractSatisfaction.hairSilhouette = hairContract.status;
    if (contractSatisfaction.hairline === "not_applicable" && hairPlan.headMask.faces.front.length > 0) contractSatisfaction.hairline = hairContract.status;
    contractViolations.push(...hairContract.violations);
  }
  return { dimensions, contractSatisfaction, contractViolations, expectedPixels, presentPixels };
}

export function buildIdentityDimensionWeights(analysis: PhotoAnalysis): Record<IdentityDimension, number> {
  const weights: Record<IdentityDimension, number> = { hairSilhouette: 1, hairline: 1, eyeLayout: 1, glassesReadability: 1, mouthExpression: 1, faceWidth: 1 };
  const mapFeature = (text: string): IdentityDimension[] => [
    ...(/silhouette|overall hair|crown|volume/.test(text) ? ["hairSilhouette" as const] : []),
    ...(/hairline|fringe|bang|forehead|part/.test(text) ? ["hairline" as const] : []),
    ...(/\beye|brow|inter-eye/.test(text) ? ["eyeLayout" as const] : []),
    ...(/glass|frame|spectacle/.test(text) ? ["glassesReadability" as const] : []),
    ...(/mouth|smile|teeth|lip/.test(text) ? ["mouthExpression" as const] : []),
    ...(/face width|jaw|round face|narrow face/.test(text) ? ["faceWidth" as const] : []),
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
    weights.hairSilhouette *= 0.7 + geometry.headSilhouette * 0.3;
    weights.mouthExpression *= 0.7 + geometry.mouth * 0.3;
    weights.faceWidth *= 0.7 + geometry.faceBounds * 0.3;
    weights.glassesReadability *= 0.7 + geometry.glasses * 0.3;
  }
  return weights;
}

export function shouldAcceptIdentityCorrection(review: HeadPairwiseReview): boolean {
  return review.winner === "B" &&
    review.confidence >= HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE &&
    !review.p5RegressionInB &&
    !review.structuralRegressionInB &&
    !review.craftRegressionInB &&
    (review.calibrationConflicts?.length ?? 0) === 0 &&
    identityDimensionsSupportWinner(review, "B");
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
  const prompt = `You are choosing between two Minecraft heads for SAME-PERSON identity preservation. Image 0 is a tight source FACE crop.${sourceHeadCropDataUrl ? " Image 1 is a wider source HEAD crop." : ""} The final two images are Candidate A and Candidate B. Each candidate evidence panel has a nearest-neighbour enlarged front view on top and an ordered front, front-left 3/4, front-right 3/4 strip below; all use identical Minecraft geometry. Ignore outfit quality and background. This is a blind ${purpose === "correction_guard" ? "identity correction guard" : "bounded candidate selection"}. ${HEAD_PAIRWISE_BLIND_RULES}

Judge in this priority order: hair silhouette; fringe/hairline footprint; exposed forehead; visible face width; eye vertical position; eye spacing; eyebrow position; glasses footprint; mouth height and width; skin/hair contrast; distinctive P5 features; overall first-impression resemblance. Do not reward conventional attractiveness, beautification, extra shading, or generic polish. Preserve visible asymmetry and unusual proportions. A structurally valid Minecraft face can still be the wrong person.

Canonical identity: ${analysis.canonicalIdentity.overallImpression}
P5 features: ${analysis.canonicalIdentity.features.filter((feature) => feature.priority === 5).map((feature) => feature.feature).join("; ") || "none labelled"}
Must preserve: ${analysis.canonicalIdentity.mustPreserve.join("; ")}

Do not infer correctness from the labels and do not assume either candidate is newer. You are not given candidate costs, contract results, structural pass/fail state, or an expected winner. For every identityDimensions entry, report only visual readability and which candidate is closer to the source. A present but weakly readable frame is not "missing". Use not_evaluable when the crop cannot support a judgment. Mark p5RegressionInB, structuralRegressionInB, or craftRegressionInB true only from visible evidence that Candidate B loses one of those invariants. Return winner A, B, or tie. Use tie when the evidence is genuinely indistinguishable at 8x8 resolution. confidence is 0..1. reasons must cite visible comparative evidence. failedIdentityFeatures and correctionTargets describe only remaining identity losses, using compact targets such as head.front.eye_row, head.front.mouth, head.overlay.fringe, head.left.hair, head.right.glasses.`;
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
        maxOutputTokens: 1600,
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
  return {
    ok: false,
    quotaExceeded: isGeminiQuotaError(lastError),
    detail: lastError instanceof Error ? lastError.message : String(lastError),
    neuronsSpent,
  };
}
