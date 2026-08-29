import type { PhotoAnalysis } from "./analysis";
import { generateGeminiStructuredJson, isGeminiQuotaError } from "./gemini";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";
import type { Env } from "./types";

export interface NormalizedBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface IdentityGeometryAnalysis {
  face: {
    visibleLeft: number;
    visibleRight: number;
    foreheadY: number;
    chinY: number;
    widthWithinHead: number;
  };
  eyes: {
    leftCenterX: number;
    leftCenterY: number;
    rightCenterX: number;
    rightCenterY: number;
    leftWidth: number;
    rightWidth: number;
    interEyeDistance: number;
    verticalAsymmetry: number;
    openness: number;
  };
  brows: {
    leftY: number;
    rightY: number;
    thickness: number;
    tilt: number;
  };
  nose: {
    centerX: number;
    contrastY: number;
    leftRightBias: number;
    visibleStrength: number;
  };
  mouth: {
    centerX: number;
    centerY: number;
    width: number;
    leftCornerY: number;
    rightCornerY: number;
    opening: "closed" | "open" | "teeth";
  };
  hairline: {
    /** Downward coverage from the visible forehead toward the eye line, 0..1. */
    depthByColumn: [number, number, number, number, number, number, number, number];
    foreheadOpeningLeft: number;
    foreheadOpeningRight: number;
    asymmetry: number;
  };
  headSilhouette: {
    crownTopY: number;
    leftContourByRow: [number, number, number, number, number, number, number, number];
    rightContourByRow: [number, number, number, number, number, number, number, number];
    sideVolumeLeft: number;
    sideVolumeRight: number;
    partCenterX: number | null;
    hairEndpointLeftY: number;
    hairEndpointRightY: number;
    foreheadExposure: number;
    earExposureLeft: number;
    earExposureRight: number;
    covering: {
      leftContourByRow: [number, number, number, number, number, number, number, number];
      rightContourByRow: [number, number, number, number, number, number, number, number];
    } | null;
    confidence: number;
  };
  glasses: {
    leftBox: NormalizedBox;
    rightBox: NormalizedBox;
    bridgeCenterX: number;
    bridgeY: number;
    thickness: number;
  } | null;
  confidence: {
    faceBounds: number;
    eyes: number;
    brows: number;
    nose: number;
    mouth: number;
    hairline: number;
    headSilhouette: number;
    glasses: number;
  };
  source: "normalized_face_head_crops";
}

export type IdentityGeometryCallResult =
  | { ok: true; geometry: IdentityGeometryAnalysis; neuronsSpent: number }
  | { ok: false; quotaExceeded: boolean; detail: string; neuronsSpent: number };

const unit = { type: "number", minimum: 0, maximum: 1 } as const;
const signedUnit = { type: "number", minimum: -1, maximum: 1 } as const;
const boxSchema = {
  type: "object",
  additionalProperties: false,
  properties: { left: unit, top: unit, right: unit, bottom: unit },
  required: ["left", "top", "right", "bottom"],
} as const;

export const IDENTITY_GEOMETRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    face: {
      type: "object",
      additionalProperties: false,
      properties: {
        visibleLeft: unit,
        visibleRight: unit,
        foreheadY: unit,
        chinY: unit,
        widthWithinHead: unit,
      },
      required: ["visibleLeft", "visibleRight", "foreheadY", "chinY", "widthWithinHead"],
    },
    eyes: {
      type: "object",
      additionalProperties: false,
      properties: {
        leftCenterX: unit,
        leftCenterY: unit,
        rightCenterX: unit,
        rightCenterY: unit,
        leftWidth: unit,
        rightWidth: unit,
        interEyeDistance: unit,
        verticalAsymmetry: signedUnit,
        openness: unit,
      },
      required: ["leftCenterX", "leftCenterY", "rightCenterX", "rightCenterY", "leftWidth", "rightWidth", "interEyeDistance", "verticalAsymmetry", "openness"],
    },
    brows: {
      type: "object",
      additionalProperties: false,
      properties: { leftY: unit, rightY: unit, thickness: unit, tilt: signedUnit },
      required: ["leftY", "rightY", "thickness", "tilt"],
    },
    nose: {
      type: "object",
      additionalProperties: false,
      properties: { centerX: unit, contrastY: unit, leftRightBias: signedUnit, visibleStrength: unit },
      required: ["centerX", "contrastY", "leftRightBias", "visibleStrength"],
    },
    mouth: {
      type: "object",
      additionalProperties: false,
      properties: {
        centerX: unit,
        centerY: unit,
        width: unit,
        leftCornerY: unit,
        rightCornerY: unit,
        opening: { type: "string", enum: ["closed", "open", "teeth"] },
      },
      required: ["centerX", "centerY", "width", "leftCornerY", "rightCornerY", "opening"],
    },
    hairline: {
      type: "object",
      additionalProperties: false,
      properties: {
        depthByColumn: { type: "array", minItems: 8, maxItems: 8, items: unit },
        foreheadOpeningLeft: unit,
        foreheadOpeningRight: unit,
        asymmetry: signedUnit,
      },
      required: ["depthByColumn", "foreheadOpeningLeft", "foreheadOpeningRight", "asymmetry"],
    },
    headSilhouette: {
      type: "object",
      additionalProperties: false,
      properties: {
        crownTopY: unit,
        leftContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        rightContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        sideVolumeLeft: unit,
        sideVolumeRight: unit,
        partCenterX: { type: ["number", "null"], minimum: 0, maximum: 1 },
        hairEndpointLeftY: unit,
        hairEndpointRightY: unit,
        foreheadExposure: unit,
        earExposureLeft: unit,
        earExposureRight: unit,
        covering: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            leftContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
            rightContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
          },
          required: ["leftContourByRow", "rightContourByRow"],
        },
        confidence: unit,
      },
      required: ["crownTopY", "leftContourByRow", "rightContourByRow", "sideVolumeLeft", "sideVolumeRight", "partCenterX", "hairEndpointLeftY", "hairEndpointRightY", "foreheadExposure", "earExposureLeft", "earExposureRight", "covering", "confidence"],
    },
    glasses: { type: ["object", "null"], additionalProperties: false, properties: {
      leftBox: boxSchema,
      rightBox: boxSchema,
      bridgeCenterX: unit,
      bridgeY: unit,
      thickness: unit,
    }, required: ["leftBox", "rightBox", "bridgeCenterX", "bridgeY", "thickness"] },
    confidence: {
      type: "object",
      additionalProperties: false,
      properties: { faceBounds: unit, eyes: unit, brows: unit, nose: unit, mouth: unit, hairline: unit, headSilhouette: unit, glasses: unit },
      required: ["faceBounds", "eyes", "brows", "nose", "mouth", "hairline", "headSilhouette", "glasses"],
    },
  },
  required: ["face", "eyes", "brows", "nose", "mouth", "hairline", "headSilhouette", "glasses", "confidence"],
} as const;

export const IDENTITY_GEOMETRY_PROMPT = `Measure the identity geometry of the SAME real person. Image 0 is a tight FACE crop for facial landmarks. Image 1 is a wider HEAD crop for the crown, hair silhouette, hairline, fringe, ears, head covering and face window.

Do NOT choose Minecraft pixels yet. Report normalized 0.0..1 positions and proportions relative to the relevant crop. Do not normalize toward an average face. Preserve unusual spacing, asymmetry and proportions because these measurements will be quantized to an 8x8 Minecraft face later.

FACE crop priorities: visible face bounds, forehead-to-chin span, each eye center/width/height, inter-eye distance, vertical asymmetry, brow height/thickness/tilt, nose contrast location, mouth center/width/corner offsets/opening and glasses footprint. HEAD crop priorities: face width within the full head silhouette, crown, hairline, part, fringe, left/right hair endpoints, forehead and ear exposure, and head covering. hairline.depthByColumn has exactly eight left-to-right samples; each value is downward hair/fringe coverage from the visible forehead toward the eye line (0=no coverage, 1=reaches the eye line). headSilhouette.leftContourByRow and rightContourByRow have exactly eight top-to-bottom samples in head-crop coordinates and trace the stable outer mass, excluding flyaway strands. Use covering only for a visibly identity-relevant hat, hood, scarf or similar covering and trace it independently. Keep coherent profiles; preserve real asymmetry rather than photographic noise. Use null glasses only when no frame is visible. A weakly readable feature gets lower confidence rather than invented average geometry.`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberIn(value: unknown, minimum = 0, maximum = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parseBox(value: unknown): NormalizedBox | null {
  const box = record(value);
  if (!box || !numberIn(box.left) || !numberIn(box.top) || !numberIn(box.right) || !numberIn(box.bottom)) return null;
  if (box.left >= box.right || box.top >= box.bottom) return null;
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

export function parseIdentityGeometry(raw: Record<string, unknown>): IdentityGeometryAnalysis | null {
  const face = record(raw.face);
  const eyes = record(raw.eyes);
  const brows = record(raw.brows);
  const nose = record(raw.nose);
  const mouth = record(raw.mouth);
  const hairline = record(raw.hairline);
  const headSilhouette = record(raw.headSilhouette);
  const confidence = record(raw.confidence);
  if (!face || !eyes || !brows || !nose || !mouth || !hairline || !headSilhouette || !confidence) return null;
  const unitValues = [
    face.visibleLeft, face.visibleRight, face.foreheadY, face.chinY, face.widthWithinHead,
    eyes.leftCenterX, eyes.leftCenterY, eyes.rightCenterX, eyes.rightCenterY, eyes.leftWidth, eyes.rightWidth, eyes.interEyeDistance, eyes.openness,
    brows.leftY, brows.rightY, brows.thickness,
    nose.centerX, nose.contrastY, nose.visibleStrength,
    mouth.centerX, mouth.centerY, mouth.width, mouth.leftCornerY, mouth.rightCornerY,
    hairline.foreheadOpeningLeft, hairline.foreheadOpeningRight,
    headSilhouette.crownTopY, headSilhouette.sideVolumeLeft, headSilhouette.sideVolumeRight,
    headSilhouette.hairEndpointLeftY, headSilhouette.hairEndpointRightY, headSilhouette.foreheadExposure,
    headSilhouette.earExposureLeft, headSilhouette.earExposureRight, headSilhouette.confidence,
    confidence.faceBounds, confidence.eyes, confidence.brows, confidence.nose, confidence.mouth, confidence.hairline, confidence.headSilhouette, confidence.glasses,
  ];
  if (!unitValues.every((value) => numberIn(value))) return null;
  if (!numberIn(eyes.verticalAsymmetry, -1, 1) || !numberIn(brows.tilt, -1, 1) || !numberIn(nose.leftRightBias, -1, 1) || !numberIn(hairline.asymmetry, -1, 1)) return null;
  if (Number(face.visibleLeft) >= Number(face.visibleRight) || Number(face.foreheadY) >= Number(face.chinY)) return null;
  if (!["closed", "open", "teeth"].includes(String(mouth.opening))) return null;
  if (!Array.isArray(hairline.depthByColumn) || hairline.depthByColumn.length !== 8 || !hairline.depthByColumn.every((value) => numberIn(value))) return null;
  const contour = (value: unknown): value is number[] => Array.isArray(value) && value.length === 8 && value.every((item) => numberIn(item));
  if (!contour(headSilhouette.leftContourByRow) || !contour(headSilhouette.rightContourByRow)) return null;
  if (headSilhouette.partCenterX !== null && !numberIn(headSilhouette.partCenterX)) return null;
  let covering: IdentityGeometryAnalysis["headSilhouette"]["covering"] = null;
  if (headSilhouette.covering !== null) {
    const coveringRaw = record(headSilhouette.covering);
    if (!coveringRaw || !contour(coveringRaw.leftContourByRow) || !contour(coveringRaw.rightContourByRow)) return null;
    covering = { leftContourByRow: coveringRaw.leftContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["leftContourByRow"], rightContourByRow: coveringRaw.rightContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["rightContourByRow"] };
  }
  let glasses: IdentityGeometryAnalysis["glasses"] = null;
  if (raw.glasses !== null) {
    const glassesRaw = record(raw.glasses);
    const leftBox = parseBox(glassesRaw?.leftBox);
    const rightBox = parseBox(glassesRaw?.rightBox);
    if (!glassesRaw || !leftBox || !rightBox || !numberIn(glassesRaw.bridgeCenterX) || !numberIn(glassesRaw.bridgeY) || !numberIn(glassesRaw.thickness)) return null;
    glasses = { leftBox, rightBox, bridgeCenterX: glassesRaw.bridgeCenterX, bridgeY: glassesRaw.bridgeY, thickness: glassesRaw.thickness };
  }
  return {
    face: { visibleLeft: Number(face.visibleLeft), visibleRight: Number(face.visibleRight), foreheadY: Number(face.foreheadY), chinY: Number(face.chinY), widthWithinHead: Number(face.widthWithinHead) },
    eyes: { leftCenterX: Number(eyes.leftCenterX), leftCenterY: Number(eyes.leftCenterY), rightCenterX: Number(eyes.rightCenterX), rightCenterY: Number(eyes.rightCenterY), leftWidth: Number(eyes.leftWidth), rightWidth: Number(eyes.rightWidth), interEyeDistance: Number(eyes.interEyeDistance), verticalAsymmetry: Number(eyes.verticalAsymmetry), openness: Number(eyes.openness) },
    brows: { leftY: Number(brows.leftY), rightY: Number(brows.rightY), thickness: Number(brows.thickness), tilt: Number(brows.tilt) },
    nose: { centerX: Number(nose.centerX), contrastY: Number(nose.contrastY), leftRightBias: Number(nose.leftRightBias), visibleStrength: Number(nose.visibleStrength) },
    mouth: { centerX: Number(mouth.centerX), centerY: Number(mouth.centerY), width: Number(mouth.width), leftCornerY: Number(mouth.leftCornerY), rightCornerY: Number(mouth.rightCornerY), opening: mouth.opening as IdentityGeometryAnalysis["mouth"]["opening"] },
    hairline: { depthByColumn: hairline.depthByColumn.map(Number) as IdentityGeometryAnalysis["hairline"]["depthByColumn"], foreheadOpeningLeft: Number(hairline.foreheadOpeningLeft), foreheadOpeningRight: Number(hairline.foreheadOpeningRight), asymmetry: Number(hairline.asymmetry) },
    headSilhouette: {
      crownTopY: Number(headSilhouette.crownTopY),
      leftContourByRow: headSilhouette.leftContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["leftContourByRow"],
      rightContourByRow: headSilhouette.rightContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["rightContourByRow"],
      sideVolumeLeft: Number(headSilhouette.sideVolumeLeft), sideVolumeRight: Number(headSilhouette.sideVolumeRight),
      partCenterX: headSilhouette.partCenterX === null ? null : Number(headSilhouette.partCenterX),
      hairEndpointLeftY: Number(headSilhouette.hairEndpointLeftY), hairEndpointRightY: Number(headSilhouette.hairEndpointRightY),
      foreheadExposure: Number(headSilhouette.foreheadExposure), earExposureLeft: Number(headSilhouette.earExposureLeft), earExposureRight: Number(headSilhouette.earExposureRight),
      covering, confidence: Number(headSilhouette.confidence),
    },
    glasses,
    confidence: { faceBounds: Number(confidence.faceBounds), eyes: Number(confidence.eyes), brows: Number(confidence.brows), nose: Number(confidence.nose), mouth: Number(confidence.mouth), hairline: Number(confidence.hairline), headSilhouette: Number(confidence.headSilhouette), glasses: Number(confidence.glasses) },
    source: "normalized_face_head_crops",
  };
}

function extractPayload(result: unknown): Record<string, unknown> | null {
  const outer = record(result);
  const response = outer?.response;
  if (typeof response === "string") {
    try { return record(JSON.parse(response)); } catch { return null; }
  }
  return record(response);
}

export async function runIdentityGeometryAnalysis(
  env: Env,
  faceCropDataUrl: string,
  headCropDataUrl: string,
  analysis: Pick<PhotoAnalysis, "canonicalIdentity">,
): Promise<IdentityGeometryCallResult> {
  const models = [env.VISION_MODEL?.trim() || "gemini-3.6-flash", env.VISION_FALLBACK_MODEL?.trim()]
    .filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index);
  const p5 = analysis.canonicalIdentity.features.filter((feature) => feature.priority === 5).map((feature) => feature.feature).join("; ") || "none labelled";
  let neuronsSpent = 0;
  let lastError: unknown;
  for (const model of models) {
    try {
      const result = await generateGeminiStructuredJson(env, {
        model,
        imageDataUrls: [faceCropDataUrl, headCropDataUrl],
        imageLabels: ["Tight face crop (facial landmark coordinate space):", "Wider head crop (hair/head coordinate space):"],
        prompt: `${IDENTITY_GEOMETRY_PROMPT}\n\nP5 identity cues to measure faithfully: ${p5}`,
        responseSchema: IDENTITY_GEOMETRY_SCHEMA,
        maxOutputTokens: 1800,
      });
      neuronsSpent += visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
      const payload = extractPayload(result);
      const geometry = payload ? parseIdentityGeometry(payload) : null;
      if (geometry) return { ok: true, geometry, neuronsSpent };
      lastError = new Error(`${model}: invalid identity geometry response`);
    } catch (error) {
      lastError = error;
      neuronsSpent += NEURONS_VISION_DETAIL_ESTIMATE;
    }
  }
  return { ok: false, quotaExceeded: isGeminiQuotaError(lastError), detail: lastError instanceof Error ? lastError.message : String(lastError), neuronsSpent };
}
