import type { PhotoAnalysis } from "./analysis";
import { classifyEvaluatorQuotaFailure, type EvaluatorQuotaFailure } from "./evaluatorQuota";
import { generateGeminiStructuredJson, isGeminiQuotaError } from "./gemini";
import type { RawImage } from "./png";
import {
  NEURONS_VISION_DETAIL_ESTIMATE,
  visionNeuronsFromUsage,
} from "./quota";
import type { Env } from "./types";
import { CLASSIC_LAYOUT, type BoxUV, type Rect } from "./uvLayout";
import {
  buildSkinPlan,
  formatSkinPlanForPrompt,
  type SkinPlan,
} from "./skinPlan";

export type CritiqueCategory =
  "identity" | "face_hair" | "outfit" | "continuity" | "overlay" | "artifact";

export interface SkinCritiqueDefect {
  category: CritiqueCategory;
  severity: "minor" | "major" | "critical";
  feature: string;
  evidence: string;
  targetRegions: string[];
  correction: string;
}

export interface IdentityDiagnosis {
  samePersonReadability: "clear" | "probable" | "ambiguous" | "weak";
  strongestPreservedCues: string[];
  strongestLostCues: string[];
  genericization: "none" | "minor" | "moderate" | "severe";
  confidence: number;
}

export interface SkinCritique {
  identityScore: number;
  faceHairScore: number;
  outfitScore: number;
  consistencyScore: number;
  layerScore: number;
  identityDiagnosis: IdentityDiagnosis;
  p5IdentityChecks: Array<{
    feature: string;
    status: "present" | "weak" | "missing" | "wrong";
    evidence: string;
    targetRegions: string[];
  }>;
  defects: SkinCritiqueDefect[];
}

export const SKIN_RELEASE_THRESHOLDS = {
  identityScore: 88,
  faceHairScore: 85,
  outfitScore: 78,
  consistencyScore: 82,
  layerScore: 70,
} as const;

export type SkinCritiqueResult =
  | {
      ok: true;
      critique: SkinCritique;
      approved: boolean;
      correctionPrompt: string;
      calibrationConflicts: string[];
      neuronsSpent: number;
    }
  | {
      ok: false;
      quotaExceeded: boolean;
      quotaFailure?: EvaluatorQuotaFailure;
      detail: string;
      neuronsSpent: number;
    };

export const SKIN_CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    identityScore: { type: "integer", minimum: 0, maximum: 100 },
    faceHairScore: { type: "integer", minimum: 0, maximum: 100 },
    outfitScore: { type: "integer", minimum: 0, maximum: 100 },
    consistencyScore: { type: "integer", minimum: 0, maximum: 100 },
    layerScore: { type: "integer", minimum: 0, maximum: 100 },
    identityDiagnosis: {
      type: "object",
      additionalProperties: false,
      properties: {
        samePersonReadability: {
          type: "string",
          enum: ["clear", "probable", "ambiguous", "weak"],
        },
        strongestPreservedCues: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
        },
        strongestLostCues: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
        },
        genericization: {
          type: "string",
          enum: ["none", "minor", "moderate", "severe"],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: [
        "samePersonReadability",
        "strongestPreservedCues",
        "strongestLostCues",
        "genericization",
        "confidence",
      ],
    },
    p5IdentityChecks: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          feature: { type: "string" },
          status: { type: "string", enum: ["present", "weak", "missing", "wrong"] },
          evidence: { type: "string" },
          targetRegions: { type: "array", items: { type: "string" } },
        },
        required: ["feature", "status", "evidence", "targetRegions"],
      },
    },
    defects: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: [
              "identity",
              "face_hair",
              "outfit",
              "continuity",
              "overlay",
              "artifact",
            ],
          },
          severity: {
            type: "string",
            enum: ["minor", "major", "critical"],
          },
          feature: { type: "string" },
          evidence: { type: "string" },
          targetRegions: { type: "array", items: { type: "string" } },
          correction: { type: "string" },
        },
        required: [
          "category",
          "severity",
          "feature",
          "evidence",
          "targetRegions",
          "correction",
        ],
      },
    },
  },
  required: [
    "identityScore",
    "faceHairScore",
    "outfitScore",
    "consistencyScore",
    "layerScore",
    "identityDiagnosis",
    "p5IdentityChecks",
    "defects",
  ],
} as const;

function extractPayload(result: unknown): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null) return null;
  const response = (result as { response?: unknown }).response;
  if (typeof response === "object" && response !== null) {
    return response as Record<string, unknown>;
  }
  if (typeof response !== "string") return null;
  try {
    const parsed = JSON.parse(response);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseSkinCritique(raw: Record<string, unknown>): SkinCritique | null {
  const score = (key: keyof SkinCritique): number | null => {
    const value = raw[key];
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
      ? Number(value)
      : null;
  };
  const scores = {
    identityScore: score("identityScore"),
    faceHairScore: score("faceHairScore"),
    outfitScore: score("outfitScore"),
    consistencyScore: score("consistencyScore"),
    layerScore: score("layerScore"),
  };
  if (Object.values(scores).some((value) => value === null)) return null;
  if (
    typeof raw.identityDiagnosis !== "object" ||
    raw.identityDiagnosis === null ||
    Array.isArray(raw.identityDiagnosis)
  ) return null;
  const diagnosis = raw.identityDiagnosis as Record<string, unknown>;
  if (
    !["clear", "probable", "ambiguous", "weak"].includes(
      String(diagnosis.samePersonReadability),
    ) ||
    !Array.isArray(diagnosis.strongestPreservedCues) ||
    !Array.isArray(diagnosis.strongestLostCues) ||
    !["none", "minor", "moderate", "severe"].includes(
      String(diagnosis.genericization),
    ) ||
    typeof diagnosis.confidence !== "number" ||
    !Number.isFinite(diagnosis.confidence) ||
    diagnosis.confidence < 0 ||
    diagnosis.confidence > 1
  ) return null;
  const identityDiagnosis: IdentityDiagnosis = {
    samePersonReadability:
      diagnosis.samePersonReadability as IdentityDiagnosis["samePersonReadability"],
    strongestPreservedCues: diagnosis.strongestPreservedCues
      .filter((cue): cue is string => typeof cue === "string")
      .slice(0, 8),
    strongestLostCues: diagnosis.strongestLostCues
      .filter((cue): cue is string => typeof cue === "string")
      .slice(0, 8),
    genericization: diagnosis.genericization as IdentityDiagnosis["genericization"],
    confidence: diagnosis.confidence,
  };
  if (!Array.isArray(raw.p5IdentityChecks)) return null;
  const p5IdentityChecks: SkinCritique["p5IdentityChecks"] = [];
  for (const value of raw.p5IdentityChecks.slice(0, 8)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.feature !== "string" ||
      !["present", "weak", "missing", "wrong"].includes(String(item.status)) ||
      typeof item.evidence !== "string" ||
      !Array.isArray(item.targetRegions)
    ) return null;
    p5IdentityChecks.push({
      feature: item.feature,
      status: item.status as SkinCritique["p5IdentityChecks"][number]["status"],
      evidence: item.evidence,
      targetRegions: item.targetRegions.filter((region): region is string => typeof region === "string"),
    });
  }
  if (!Array.isArray(raw.defects)) return null;
  const defects: SkinCritiqueDefect[] = [];
  for (const value of raw.defects.slice(0, 8)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const item = value as Record<string, unknown>;
    if (
      ![
        "identity",
        "face_hair",
        "outfit",
        "continuity",
        "overlay",
        "artifact",
      ].includes(String(item.category)) ||
      !["minor", "major", "critical"].includes(String(item.severity)) ||
      typeof item.feature !== "string" ||
      typeof item.evidence !== "string" ||
      typeof item.correction !== "string" ||
      !Array.isArray(item.targetRegions)
    )
      return null;
    defects.push({
      category: item.category as CritiqueCategory,
      severity: item.severity as SkinCritiqueDefect["severity"],
      feature: item.feature,
      evidence: item.evidence,
      correction: item.correction,
      targetRegions: item.targetRegions.filter(
        (region): region is string => typeof region === "string",
      ),
    });
  }
  // Some fallback vision models follow an implicit 0-10 convention even
  // though the response schema says 0-100. Treat an all-<=10 score set as a
  // coherent 10-point answer and normalize it before applying the quality
  // gate. Without this, a reasonable 7/10 face/hair result is logged as 7%
  // and minor, actionable defects are discarded as if the review were
  // internally contradictory.
  const scale = Object.values(scores).every((value) => (value ?? 100) <= 10)
    ? 10
    : 1;
  return {
    identityScore: scores.identityScore! * scale,
    faceHairScore: scores.faceHairScore! * scale,
    outfitScore: scores.outfitScore! * scale,
    consistencyScore: scores.consistencyScore! * scale,
    layerScore: scores.layerScore! * scale,
    identityDiagnosis,
    p5IdentityChecks,
    defects,
  };
}

/**
 * Finds evidence/score contradictions without changing a score or bypassing
 * the strict release gate. These diagnostics make evaluator failure distinct
 * from renderer failure.
 */
export function findIdentityDiagnosisConflicts(
  analysis: PhotoAnalysis,
  critique: SkinCritique,
): string[] {
  const conflicts: string[] = [];
  const diagnosis = critique.identityDiagnosis;
  const failedP5 = findCriticalIdentityMisses(analysis, critique);
  const p5Features = analysis.canonicalIdentity.features.filter(
    (feature) => feature.priority === 5,
  );
  const allP5Present =
    p5Features.length > 0 &&
    failedP5.length === 0 &&
    critique.p5IdentityChecks
      .filter((check) =>
        p5Features.some(
          (feature) => normalizeIdentityText(feature.feature) === normalizeIdentityText(check.feature),
        ),
      )
      .every((check) => check.status === "present");

  if (
    diagnosis.samePersonReadability === "clear" &&
    diagnosis.genericization === "none" &&
    allP5Present &&
    critique.identityScore < SKIN_RELEASE_THRESHOLDS.identityScore
  ) {
    conflicts.push("clear same-person diagnosis with no genericization and all P5 cues present scored below 88");
  }
  if (
    (diagnosis.samePersonReadability === "ambiguous" ||
      diagnosis.samePersonReadability === "weak") &&
    critique.identityScore >= SKIN_RELEASE_THRESHOLDS.identityScore
  ) {
    conflicts.push("ambiguous or weak same-person diagnosis scored at or above 88");
  }
  if (
    (diagnosis.genericization === "moderate" || diagnosis.genericization === "severe") &&
    critique.identityScore >= SKIN_RELEASE_THRESHOLDS.identityScore
  ) {
    conflicts.push("moderate or severe genericization scored at or above 88");
  }
  if (
    diagnosis.samePersonReadability === "clear" &&
    (diagnosis.genericization === "moderate" || diagnosis.genericization === "severe")
  ) {
    conflicts.push("clear same-person readability contradicts moderate or severe genericization");
  }
  return conflicts;
}

function normalizeIdentityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function evaluateSkinReleaseGate(
  analysis: PhotoAnalysis,
  critique: SkinCritique,
): { approved: boolean; critical: boolean; failedP5: ReturnType<typeof findCriticalIdentityMisses> } {
  const critical = critique.defects.some((defect) => defect.severity === "critical");
  const failedP5 = findCriticalIdentityMisses(analysis, critique);
  return {
    approved:
      !critical &&
      failedP5.length === 0 &&
      critique.identityScore >= SKIN_RELEASE_THRESHOLDS.identityScore &&
      critique.faceHairScore >= SKIN_RELEASE_THRESHOLDS.faceHairScore &&
      critique.outfitScore >= SKIN_RELEASE_THRESHOLDS.outfitScore &&
      critique.consistencyScore >= SKIN_RELEASE_THRESHOLDS.consistencyScore &&
      critique.layerScore >= SKIN_RELEASE_THRESHOLDS.layerScore,
    critical,
    failedP5,
  };
}

export function isActionableCritiqueDefect(
  critique: SkinCritique,
  defect: SkinCritiqueDefect,
): boolean {
  if (defect.severity !== "minor") return true;
  if (
    defect.category === "identity" ||
    defect.category === "face_hair"
  ) {
    return critique.identityScore < 88 || critique.faceHairScore < 85;
  }
  if (defect.category === "outfit") return critique.outfitScore < 78;
  if (defect.category === "overlay") return critique.layerScore < 70;
  return critique.consistencyScore < 82;
}

export function findCriticalIdentityMisses(
  analysis: PhotoAnalysis,
  critique: SkinCritique,
): Array<{ feature: string; status: "missing" | "wrong" }> {
  return analysis.canonicalIdentity.features
    .filter((feature) => feature.priority === 5)
    .flatMap((feature) => {
      const check = critique.p5IdentityChecks.find(
        (item) => normalizeIdentityText(item.feature) === normalizeIdentityText(feature.feature),
      );
      if (!check) return [{ feature: feature.feature, status: "missing" as const }];
      return check.status === "missing" || check.status === "wrong"
        ? [{ feature: feature.feature, status: check.status }]
        : [];
    });
}

function atlasRegionStats(atlas: RawImage, rects: Rect[]): string {
  let opaque = 0;
  let total = 0;
  const colors = new Set<string>();
  for (const rect of rects) {
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        total++;
        const offset = ((rect.y + y) * atlas.width + rect.x + x) * 4;
        if (atlas.rgba[offset + 3] < 128) continue;
        opaque++;
        colors.add(
          `${atlas.rgba[offset]},${atlas.rgba[offset + 1]},${atlas.rgba[offset + 2]}`,
        );
      }
    }
  }
  return `${opaque}/${total} opaque texels, ${colors.size} opaque RGB colors`;
}

function boxFaces(box: BoxUV): Rect[] {
  return [box.top, box.bottom, box.right, box.front, box.left, box.back];
}

export function formatAtlasStructuralEvidence(atlas: RawImage): string {
  return [
    `head base: ${atlasRegionStats(atlas, boxFaces(CLASSIC_LAYOUT.head.base))}`,
    `head outer layer: ${atlasRegionStats(atlas, boxFaces(CLASSIC_LAYOUT.head.overlay))}`,
    `torso base: ${atlasRegionStats(atlas, boxFaces(CLASSIC_LAYOUT.body.base))}`,
    `torso outer layer: ${atlasRegionStats(atlas, boxFaces(CLASSIC_LAYOUT.body.overlay))}`,
  ].join("; ");
}

export async function runSkinCritique(
  env: Env,
  analysis: PhotoAnalysis,
  referenceImageDataUrls: string[],
  renderedMontageDataUrl: string,
  suppliedPlan?: SkinPlan,
  structuralAtlas?: RawImage,
  sourceFaceCropDataUrl?: string,
): Promise<SkinCritiqueResult> {
  const skinPlan = suppliedPlan ?? buildSkinPlan(analysis);
  // Preserve the full UI contract: primary photo plus up to four alternate
  // same-person views. The rendered montage is a separate sixth input.
  const references = referenceImageDataUrls.slice(0, sourceFaceCropDataUrl ? 4 : 5);
  const sourceCount = references.length + (sourceFaceCropDataUrl ? 1 : 0);
  const prompt = `You are a strict Minecraft skin likeness reviewer. The first ${sourceCount} image(s) are source evidence for the SAME person. When present, the explicitly labelled focused face/head crop is the direct facial-identity reference and must be compared against the candidate's front and 3/4 head close-ups. The final image is a deterministic render of one exact 64x64 Java skin. Its top two rows contain the six full-body views in this order: front, back, left, right, front-left 3/4, front-right 3/4. The third row contains enlarged head close-ups in this order: front, front-left 3/4, front-right 3/4. The fourth row contains enlarged upper-body close-ups in this order: front, back, front-left 3/4. Use the head close-ups to judge glasses, eyes, fringe, earrings, and hair texture; use the upper-body close-ups for collars, ties, knit, jackets, and shoulder hair; use the full-body views for overall outfit and cross-view consistency.

Canonical identity: ${analysis.canonicalIdentity.overallImpression}
Must preserve: ${analysis.canonicalIdentity.mustPreserve.join("; ")}
Ranked cues: ${analysis.canonicalIdentity.features.map((feature) => `P${feature.priority} ${feature.feature}`).join("; ")}
Expected outfit: ${analysis.outfitPrompt}
Minecraft surface/layer plan: ${formatSkinPlanForPrompt(skinPlan)}
${
  structuralAtlas
    ? `Machine-measured atlas facts (exact 64x64 alpha/RGB, supporting rather than replacing visual likeness judgement): ${formatAtlasStructuralEvidence(structuralAtlas)}. Do not claim a layer is unused or a region is one solid color when these exact counts contradict that claim; still judge whether its placement and perceptual readability are effective in the rendered views.`
    : ""
}

Minecraft constraint calibration:
- The source set is intended to show one person. If one alternate source visibly conflicts with the primary and the remaining sources on several stable identity traits, treat that image as an accidental outlier rather than penalizing the candidate for following the canonical identity. Do not call normal lighting, expression, makeup, hairstyle, outfit or time differences an identity conflict.
- This must remain a standard cubic Minecraft player. A 64x64 skin cannot create arbitrary voxels, rounded geometry, loose strands, or protrusions beyond the standard expanded outer cube. Never penalize a valid head merely because its physical boundary is cubic.
- Judge curly, tousled, or spiky hair by the evidence actually available in a skin: transparent/non-transparent outer-layer steps, irregular clusters, a coherent 3-6 shade ramp, asymmetric strand placement, a readable face window, and continuous front/side/back flow. Call hair flat only when those cues are visibly absent, not merely because it is pixel art.
- The overlay is expanded by only 0.35 Minecraft texture pixels in these renders. Use the enlarged head and upper-body rows to distinguish it from the base before claiming that the second layer is unused.
- At an 8x12 torso, cable knit is represented by repeating alternating light/dark ribs or zigzags on base and overlay. Judge whether that readable construction exists; do not require photoreal woven cables.

Score the five dimensions independently. identityScore is ONLY same-person first-impression resemblance from the head: silhouette, hairline/fringe, exposed face proportions, eye layout, mouth expression, and identity-defining accessories. faceHairScore is the fidelity and craft of the face/hair construction itself. Outfit, body, continuity, and outer-layer issues belong only in their named scores; do not subtract them from identityScore a second time.

Identity calibration anchors for a standard 8x8 Minecraft head:
- 95-100: exceptionally faithful Minecraft abstraction; nearly every expressible identity cue is specific and immediately readable.
- 88-94: clearly the same person at first glance; distinctive expressible cues outweigh minor pixel-art omissions.
- 80-87: major traits are present, but the head remains generic or ambiguous as that person.
- below 80: important identity cues are lost, wrong, or substantially genericized.
These are calibration anchors, not a request to pass the candidate. P5 presence is necessary but never sufficient for a high identity score. Do not penalize photographic micro-detail that no standard 8x8 head can encode. Use any integer justified by the evidence; do not snap scores to multiples of five.

Score identity and face/hair against the photos, outfit fidelity, cross-view physical consistency, and meaningful second-layer depth. Every score MUST be an integer on a 0-100 scale, never a 0-10 scale. For EVERY P5 cue, emit one p5IdentityChecks entry using the exact feature text and classify it present, weak, missing, or wrong. Missing or wrong P5 cues are hard failures regardless of aggregate score. Separately emit identityDiagnosis as an explanation of the visual evidence: samePersonReadability, the strongest preserved and lost cues, genericization, and confidence from 0 to 1. The diagnosis explains the score but is not a formula for calculating it. Penalize generic faces, wrong fringe/part/silhouette, missing accessories, incorrect color blocks, repeated or mirrored views, disconnected seams, hollow shells, random noise and blank surfaces. Report only visible, actionable defects that are achievable within the standard Minecraft skin format. targetRegions must use Minecraft regions such as head.front, head.overlay, torso.front, torso.back, arm.left, arm.right, leg.left or leg.right. Keep corrections narrow and preserve already-correct features.`;
  const models = [
    env.VISION_MODEL?.trim() || "gemini-3.6-flash",
    env.VISION_FALLBACK_MODEL?.trim(),
  ].filter(
    (model, index, all): model is string =>
      Boolean(model) && all.indexOf(model) === index,
  );
  let lastError: unknown;
  let neuronsSpent = 0;
  for (const model of models) {
    try {
      const result = await generateGeminiStructuredJson(env, {
        model,
        imageDataUrls: [
          ...(references[0] ? [references[0]] : []),
          ...(sourceFaceCropDataUrl ? [sourceFaceCropDataUrl] : []),
          ...references.slice(1),
          renderedMontageDataUrl,
        ],
        imageLabels: [
          ...(references[0]
            ? ["Source photo 0 of the same person (primary identity and outfit reference):"]
            : []),
          ...(sourceFaceCropDataUrl
            ? ["Focused source face/head crop (primary direct identity reference):"]
            : []),
          ...references.slice(1).map(
            (_, index) => `Source photo ${index + 1} of the same person (alternate identity/view evidence):`,
          ),
          "Rendered Minecraft skin inspection montage (candidate output to evaluate, NOT a source photo):",
        ],
        prompt,
        responseSchema: SKIN_CRITIQUE_SCHEMA,
        maxOutputTokens: 1400,
      });
      neuronsSpent += visionNeuronsFromUsage(
        result,
        NEURONS_VISION_DETAIL_ESTIMATE,
      );
      const payload = extractPayload(result);
      const critique = payload ? parseSkinCritique(payload) : null;
      if (!critique) {
        lastError = new Error(`${model}: invalid critique response`);
        continue;
      }
      const { approved, failedP5 } = evaluateSkinReleaseGate(analysis, critique);
      const calibrationConflicts = findIdentityDiagnosisConflicts(analysis, critique);
      const defectCorrections = critique.defects
        .filter((defect) => isActionableCritiqueDefect(critique, defect))
        .slice(0, 4)
        .map(
          (defect) =>
            `${defect.targetRegions.join("+")}: ${defect.correction} (${defect.evidence})`,
        )
        .join("; ");
      const p5Corrections = failedP5
        .map((miss) => {
          const feature = analysis.canonicalIdentity.features.find((item) => item.priority === 5 && normalizeIdentityText(item.feature) === normalizeIdentityText(miss.feature))!;
          const check = critique.p5IdentityChecks.find((item) => normalizeIdentityText(item.feature) === normalizeIdentityText(feature.feature));
          return `${feature.targetRegions.join("+")}: restore hard-constraint P5 cue '${feature.feature}' (${check?.evidence || "review did not verify the cue"})`;
        })
        .join("; ");
      const correctionPrompt = [p5Corrections, defectCorrections].filter(Boolean).join("; ");
      return {
        ok: true,
        critique,
        approved,
        correctionPrompt,
        calibrationConflicts,
        neuronsSpent,
      };
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
