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
  reasons: string[];
  failedIdentityFeatures: string[];
  correctionTargets: string[];
}

export type HeadPairwiseResult =
  | { ok: true; review: HeadPairwiseReview; neuronsSpent: number }
  | { ok: false; quotaExceeded: boolean; detail: string; neuronsSpent: number };

export const HEAD_PAIRWISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
    failedIdentityFeatures: { type: "array", maxItems: 8, items: { type: "string" } },
    correctionTargets: { type: "array", maxItems: 8, items: { type: "string" } },
  },
  required: ["winner", "confidence", "reasons", "failedIdentityFeatures", "correctionTargets"],
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
  return {
    winner: raw.winner as HeadPairwiseReview["winner"],
    confidence: raw.confidence,
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
  if (review.confidence >= 0.5 && review.winner === "B") return candidateB;
  if (review.confidence >= 0.5 && review.winner === "A") return candidateA;
  // A tie is not evidence that a generated face should be replaced. Preserve
  // the richer source-derived candidate while the absolute gate still judges it.
  return candidateA.kind === "generated" ? candidateA : candidateB.kind === "generated" ? candidateB : candidateA;
}

export function shouldAcceptIdentityCorrection(review: HeadPairwiseReview): boolean {
  return review.winner === "B" && review.confidence >= 0.5;
}

export async function runHeadPairwiseComparison(
  env: Env,
  analysis: PhotoAnalysis,
  sourceFaceCropDataUrl: string,
  candidateADataUrl: string,
  candidateBDataUrl: string,
  purpose: "candidate_selection" | "correction_guard" = "candidate_selection",
): Promise<HeadPairwiseResult> {
  const prompt = `You are choosing between two Minecraft heads for SAME-PERSON identity preservation. Image 0 is a focused source face/head crop. Image 1 is Candidate A and image 2 is Candidate B. Each candidate strip is ordered front, front-left 3/4, front-right 3/4 and uses identical Minecraft geometry. Ignore outfit quality and background. This is ${purpose === "correction_guard" ? "a before(A) versus after(B) correction guard; choose B only if it is genuinely more like the source" : "a bounded candidate selection"}.

Judge in this priority order: hair silhouette; fringe/hairline footprint; exposed forehead; visible face width; eye vertical position; eye spacing; eyebrow position; glasses footprint; mouth height and width; skin/hair contrast; distinctive P5 features; overall first-impression resemblance. Do not reward conventional attractiveness, beautification, extra shading, or generic polish. Preserve visible asymmetry and unusual proportions. A structurally valid Minecraft face can still be the wrong person.

Canonical identity: ${analysis.canonicalIdentity.overallImpression}
P5 features: ${analysis.canonicalIdentity.features.filter((feature) => feature.priority === 5).map((feature) => feature.feature).join("; ") || "none labelled"}
Must preserve: ${analysis.canonicalIdentity.mustPreserve.join("; ")}

Return winner A, B, or tie. Use tie when the evidence is genuinely indistinguishable at 8x8 resolution. confidence is 0..1. reasons must cite visible comparative evidence. failedIdentityFeatures and correctionTargets describe only remaining identity losses, using compact targets such as head.front.eye_row, head.front.mouth, head.overlay.fringe, head.left.hair, head.right.glasses.`;
  const models = [env.VISION_MODEL?.trim() || "gemini-3.6-flash", env.VISION_FALLBACK_MODEL?.trim()]
    .filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index);
  let lastError: unknown;
  let neuronsSpent = 0;
  for (const model of models) {
    try {
      const result = await generateGeminiStructuredJson(env, {
        model,
        imageDataUrls: [sourceFaceCropDataUrl, candidateADataUrl, candidateBDataUrl],
        imageLabels: [
          "Focused source face/head crop (identity truth):",
          purpose === "correction_guard" ? "Candidate A (before correction):" : "Candidate A:",
          purpose === "correction_guard" ? "Candidate B (after correction):" : "Candidate B:",
        ],
        prompt,
        responseSchema: HEAD_PAIRWISE_SCHEMA,
        maxOutputTokens: 700,
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
