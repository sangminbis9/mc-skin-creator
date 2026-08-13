import type { PhotoAnalysis } from "./analysis";
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

export interface SkinCritique {
  identityScore: number;
  faceHairScore: number;
  outfitScore: number;
  consistencyScore: number;
  layerScore: number;
  defects: SkinCritiqueDefect[];
}

export type SkinCritiqueResult =
  | {
      ok: true;
      critique: SkinCritique;
      approved: boolean;
      correctionPrompt: string;
      neuronsSpent: number;
    }
  | {
      ok: false;
      quotaExceeded: boolean;
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

function validateCritique(raw: Record<string, unknown>): SkinCritique | null {
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
  return {
    identityScore: scores.identityScore!,
    faceHairScore: scores.faceHairScore!,
    outfitScore: scores.outfitScore!,
    consistencyScore: scores.consistencyScore!,
    layerScore: scores.layerScore!,
    defects,
  };
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
): Promise<SkinCritiqueResult> {
  const skinPlan = suppliedPlan ?? buildSkinPlan(analysis);
  // Preserve the full UI contract: primary photo plus up to four alternate
  // same-person views. The rendered montage is a separate sixth input.
  const references = referenceImageDataUrls.slice(0, 5);
  const prompt = `You are a strict Minecraft skin likeness reviewer. The first ${references.length} image(s) are photos of the SAME person. The final image is a deterministic render of one exact 64x64 Java skin. Its top two rows contain the six full-body views in this order: front, back, left, right, front-left 3/4, front-right 3/4. The third row contains enlarged head close-ups in this order: front, front-left 3/4, front-right 3/4. The fourth row contains enlarged upper-body close-ups in this order: front, back, front-left 3/4. Use the head close-ups to judge glasses, eyes, fringe, earrings, and hair texture; use the upper-body close-ups for collars, ties, knit, jackets, and shoulder hair; use the full-body views for overall outfit and cross-view consistency.

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

Score identity and face/hair against the photos, outfit fidelity, cross-view physical consistency, and meaningful second-layer depth. Penalize generic faces, wrong fringe/part/silhouette, missing accessories, incorrect color blocks, repeated or mirrored views, disconnected seams, hollow shells, random noise and blank surfaces. Report only visible, actionable defects that are achievable within the standard Minecraft skin format. targetRegions must use Minecraft regions such as head.front, head.overlay, torso.front, torso.back, arm.left, arm.right, leg.left or leg.right. Keep corrections narrow and preserve already-correct features.`;
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
        imageDataUrls: [...references, renderedMontageDataUrl],
        imageLabels: [
          ...references.map(
            (_, index) =>
              `Source photo ${index} of the same person${index === 0 ? " (primary identity and outfit reference)" : " (alternate identity/view evidence)"}:`,
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
      const critique = payload ? validateCritique(payload) : null;
      if (!critique) {
        lastError = new Error(`${model}: invalid critique response`);
        continue;
      }
      const critical = critique.defects.some(
        (defect) => defect.severity === "critical",
      );
      const approved =
        !critical &&
        critique.identityScore >= 78 &&
        critique.faceHairScore >= 75 &&
        critique.outfitScore >= 70 &&
        critique.consistencyScore >= 75 &&
        critique.layerScore >= 65;
      const correctionPrompt = critique.defects
        .filter((defect) => defect.severity !== "minor")
        .slice(0, 4)
        .map(
          (defect) =>
            `${defect.targetRegions.join("+")}: ${defect.correction} (${defect.evidence})`,
        )
        .join("; ");
      return {
        ok: true,
        critique,
        approved,
        correctionPrompt,
        neuronsSpent,
      };
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
