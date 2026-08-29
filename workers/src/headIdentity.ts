import type { PhotoAnalysis } from "./analysis";
import { generateGeminiStructuredJson, isGeminiQuotaError } from "./gemini";
import type { RawImage } from "./png";
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

export const HEAD_CANDIDATE_REPLACEMENT_CONFIDENCE = 0.7;

export type HeadPairwiseResult =
  | { ok: true; review: HeadPairwiseReview; neuronsSpent: number }
  | { ok: false; quotaExceeded: boolean; detail: string; neuronsSpent: number };

const dimensionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    better: { type: "string", enum: ["A", "B", "tie", "not_evaluable"] },
    structuralPresenceA: { type: "string", enum: ["present", "absent", "not_applicable"] },
    structuralPresenceB: { type: "string", enum: ["present", "absent", "not_applicable"] },
    visualReadabilityA: { type: "string", enum: ["strong", "weak", "absent", "not_evaluable"] },
    visualReadabilityB: { type: "string", enum: ["strong", "weak", "absent", "not_evaluable"] },
    reason: { type: "string" },
  },
  required: ["better", "structuralPresenceA", "structuralPresenceB", "visualReadabilityA", "visualReadabilityB", "reason"],
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

export function parseHeadPairwiseReview(raw: Record<string, unknown>): HeadPairwiseReview | null {
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
      !["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceA)) ||
      !["present", "absent", "not_applicable"].includes(String(candidate.structuralPresenceB)) ||
      !["strong", "weak", "absent", "not_evaluable"].includes(String(candidate.visualReadabilityA)) ||
      !["strong", "weak", "absent", "not_evaluable"].includes(String(candidate.visualReadabilityB)) ||
      typeof candidate.reason !== "string"
    ) return null;
    identityDimensions[name] = {
      better: candidate.better as IdentityDimensionReview["better"],
      structuralPresenceA: candidate.structuralPresenceA as IdentityDimensionReview["structuralPresenceA"],
      structuralPresenceB: candidate.structuralPresenceB as IdentityDimensionReview["structuralPresenceB"],
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
  // A tie is not evidence that a generated face should be replaced. Preserve
  // the richer source-derived candidate while the absolute gate still judges it.
  return candidateA.kind === "generated" ? candidateA : candidateB.kind === "generated" ? candidateB : candidateA;
}

function identityDimensionsSupportWinner(review: HeadPairwiseReview, winner: "A" | "B"): boolean {
  const dimensions = Object.values(review.identityDimensions);
  const aVotes = dimensions.filter((dimension) => dimension.better === "A").length;
  const bVotes = dimensions.filter((dimension) => dimension.better === "B").length;
  const allUnavailable = dimensions.every((dimension) => dimension.better === "not_evaluable");
  // Keep old stored reviews readable, but do not let an overall winner override
  // contradictory structured evidence or six dimension-level ties.
  if (allUnavailable) return true;
  return winner === "B" ? bVotes > 0 && bVotes >= aVotes : aVotes > 0 && aVotes >= bVotes;
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
): Promise<HeadPairwiseResult> {
  const prompt = `You are choosing between two Minecraft heads for SAME-PERSON identity preservation. Image 0 is a tight source FACE crop.${sourceHeadCropDataUrl ? " Image 1 is a wider source HEAD crop." : ""} The final two images are Candidate A and Candidate B. Each candidate strip is ordered front, front-left 3/4, front-right 3/4 and uses identical Minecraft geometry. Ignore outfit quality and background. This is ${purpose === "correction_guard" ? "a before(A) versus after(B) correction guard; choose B only if it is genuinely more like the source" : "a bounded candidate selection"}.

Judge in this priority order: hair silhouette; fringe/hairline footprint; exposed forehead; visible face width; eye vertical position; eye spacing; eyebrow position; glasses footprint; mouth height and width; skin/hair contrast; distinctive P5 features; overall first-impression resemblance. Do not reward conventional attractiveness, beautification, extra shading, or generic polish. Preserve visible asymmetry and unusual proportions. A structurally valid Minecraft face can still be the wrong person.

Canonical identity: ${analysis.canonicalIdentity.overallImpression}
P5 features: ${analysis.canonicalIdentity.features.filter((feature) => feature.priority === 5).map((feature) => feature.feature).join("; ") || "none labelled"}
Must preserve: ${analysis.canonicalIdentity.mustPreserve.join("; ")}

For every identityDimensions entry, separately report structural pixel presence, visual readability, and which candidate is closer to the source. A present but weakly readable frame is not "missing". Use not_evaluable when the crop cannot support a judgment. Mark p5RegressionInB, structuralRegressionInB, or craftRegressionInB true whenever B loses one of those invariants. Return winner A, B, or tie. Use tie when the evidence is genuinely indistinguishable at 8x8 resolution. confidence is 0..1. reasons must cite visible comparative evidence. failedIdentityFeatures and correctionTargets describe only remaining identity losses, using compact targets such as head.front.eye_row, head.front.mouth, head.overlay.fringe, head.left.hair, head.right.glasses.`;
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
          purpose === "correction_guard" ? "Candidate A (before correction):" : "Candidate A:",
          purpose === "correction_guard" ? "Candidate B (after correction):" : "Candidate B:",
        ],
        prompt,
        responseSchema: HEAD_PAIRWISE_SCHEMA,
        maxOutputTokens: 1600,
      });
      neuronsSpent += visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
      const payload = extractPayload(result);
      const review = payload ? parseHeadPairwiseReview(payload) : null;
      if (!review) {
        lastError = new Error(`${model}: invalid pairwise response`);
        continue;
      }
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
