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

export type GeometryEvidence = "observed" | "inferred" | "unknown";
export type FringeDirection = "left_swept" | "right_swept" | "centered" | "split" | "irregular";
export type HairVolumeRegion = "crown_left" | "crown_right" | "side_left" | "side_right" | "lower_left" | "lower_right";

export interface FringePeakGeometry {
  visible: boolean;
  peaks: Array<{ x: number; depthY: number; prominence: number }>;
  direction: FringeDirection;
  openingCenterX: number | null;
  openingWidth: number | null;
  leftTempleTransitionY: number;
  rightTempleTransitionY: number;
  evidence: GeometryEvidence;
  confidence: number;
}

export interface TempleGeometry {
  leftRecession: number;
  rightRecession: number;
  leftStartY: number;
  rightStartY: number;
  asymmetry: number;
  leftEvidence: GeometryEvidence;
  rightEvidence: GeometryEvidence;
  confidence: number;
}

export interface CrownContourGeometry {
  leftY: number;
  centerY: number;
  rightY: number;
  leftWidth: number;
  rightWidth: number;
  apexX: number;
  asymmetry: number;
  evidence: GeometryEvidence;
  confidence: number;
}

export interface MajorHairVolumePeak {
  region: HairVolumeRegion;
  protrusion: number;
  verticalCenter: number;
  verticalExtent: number;
  evidence: GeometryEvidence;
  confidence: number;
}

export interface FaceWindowGeometry {
  foreheadHeight: number;
  leftTempleWidth: number;
  rightTempleWidth: number;
  visibleFaceWidthAtEyes: number;
  visibleFaceWidthAtCheeks: number;
  leftEyeToHairDistance: number;
  rightEyeToHairDistance: number;
  leftEarExposure: number;
  rightEarExposure: number;
  leftEvidence: GeometryEvidence;
  rightEvidence: GeometryEvidence;
  confidence: number;
}

export interface FaceShapeGeometry {
  upperWidth: number;
  cheekWidth: number;
  jawWidth: number;
  verticalLength: number;
  leftRightAsymmetry: number;
  evidence: GeometryEvidence;
  confidence: number;
}

export interface GeometryVisibility {
  cropClippingKnown: boolean;
  crownClipped: boolean;
  leftHairClipped: boolean;
  rightHairClipped: boolean;
  chinClipped: boolean;
  leftEarClipped: boolean;
  rightEarClipped: boolean;
}

export type GeometryCropVisibility = Omit<GeometryVisibility, "cropClippingKnown">;

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
  fringe: FringePeakGeometry;
  temple: TempleGeometry;
  crown: CrownContourGeometry;
  majorVolumePeaks: MajorHairVolumePeak[];
  faceWindow: FaceWindowGeometry;
  faceShape: FaceShapeGeometry;
  visibility: GeometryVisibility;
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
const evidenceSchema = { type: "string", enum: ["observed", "inferred", "unknown"] } as const;
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
    fringe: {
      type: "object", additionalProperties: false,
      properties: {
        visible: { type: "boolean" },
        peaks: { type: "array", minItems: 0, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { x: unit, depthY: unit, prominence: unit }, required: ["x", "depthY", "prominence"] } },
        direction: { type: "string", enum: ["left_swept", "right_swept", "centered", "split", "irregular"] },
        openingCenterX: { type: ["number", "null"], minimum: 0, maximum: 1 },
        openingWidth: { type: ["number", "null"], minimum: 0, maximum: 1 },
        leftTempleTransitionY: unit, rightTempleTransitionY: unit,
        evidence: evidenceSchema, confidence: unit,
      },
      required: ["visible", "peaks", "direction", "openingCenterX", "openingWidth", "leftTempleTransitionY", "rightTempleTransitionY", "evidence", "confidence"],
    },
    temple: {
      type: "object", additionalProperties: false,
      properties: { leftRecession: unit, rightRecession: unit, leftStartY: unit, rightStartY: unit, asymmetry: signedUnit, leftEvidence: evidenceSchema, rightEvidence: evidenceSchema, confidence: unit },
      required: ["leftRecession", "rightRecession", "leftStartY", "rightStartY", "asymmetry", "leftEvidence", "rightEvidence", "confidence"],
    },
    crown: {
      type: "object", additionalProperties: false,
      properties: { leftY: unit, centerY: unit, rightY: unit, leftWidth: unit, rightWidth: unit, apexX: unit, asymmetry: signedUnit, evidence: evidenceSchema, confidence: unit },
      required: ["leftY", "centerY", "rightY", "leftWidth", "rightWidth", "apexX", "asymmetry", "evidence", "confidence"],
    },
    majorVolumePeaks: {
      type: "array", minItems: 0, maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { region: { type: "string", enum: ["crown_left", "crown_right", "side_left", "side_right", "lower_left", "lower_right"] }, protrusion: unit, verticalCenter: unit, verticalExtent: unit, evidence: evidenceSchema, confidence: unit }, required: ["region", "protrusion", "verticalCenter", "verticalExtent", "evidence", "confidence"] },
    },
    faceWindow: {
      type: "object", additionalProperties: false,
      properties: { foreheadHeight: unit, leftTempleWidth: unit, rightTempleWidth: unit, visibleFaceWidthAtEyes: unit, visibleFaceWidthAtCheeks: unit, leftEyeToHairDistance: unit, rightEyeToHairDistance: unit, leftEarExposure: unit, rightEarExposure: unit, leftEvidence: evidenceSchema, rightEvidence: evidenceSchema, confidence: unit },
      required: ["foreheadHeight", "leftTempleWidth", "rightTempleWidth", "visibleFaceWidthAtEyes", "visibleFaceWidthAtCheeks", "leftEyeToHairDistance", "rightEyeToHairDistance", "leftEarExposure", "rightEarExposure", "leftEvidence", "rightEvidence", "confidence"],
    },
    faceShape: {
      type: "object", additionalProperties: false,
      properties: { upperWidth: unit, cheekWidth: unit, jawWidth: unit, verticalLength: unit, leftRightAsymmetry: signedUnit, evidence: evidenceSchema, confidence: unit },
      required: ["upperWidth", "cheekWidth", "jawWidth", "verticalLength", "leftRightAsymmetry", "evidence", "confidence"],
    },
    visibility: {
      type: "object", additionalProperties: false,
      properties: { cropClippingKnown: { type: "boolean" }, crownClipped: { type: "boolean" }, leftHairClipped: { type: "boolean" }, rightHairClipped: { type: "boolean" }, chinClipped: { type: "boolean" }, leftEarClipped: { type: "boolean" }, rightEarClipped: { type: "boolean" } },
      required: ["cropClippingKnown", "crownClipped", "leftHairClipped", "rightHairClipped", "chinClipped", "leftEarClipped", "rightEarClipped"],
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
  required: ["face", "eyes", "brows", "nose", "mouth", "hairline", "fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "visibility", "headSilhouette", "glasses", "confidence"],
} as const;

export const IDENTITY_GEOMETRY_PROMPT = `Measure the identity geometry of the SAME real person. Image 0 is a tight FACE crop for facial landmarks. Image 1 is a wider HEAD crop for the crown, hair silhouette, hairline, fringe, ears, head covering and face window.

Do NOT choose Minecraft pixels yet. Report normalized 0.0..1 positions and proportions relative to the relevant crop. Do not normalize toward an average face. Preserve unusual spacing, asymmetry and proportions because these measurements will be quantized to an 8x8 Minecraft face later.

FACE crop priorities: visible face bounds; upper, cheek and jaw width; forehead-to-chin span; each eye center/width/height; eye position relative to the visible hairline; inter-eye distance; vertical asymmetry; brows, nose, mouth and glasses. HEAD crop priorities: the complete crown, stable outer silhouette, major fringe masses, temple recession, side/lower volume masses, ears, face window and any head covering. Do not use a semantic hairstyle label as geometry evidence.

Use FACE-crop coordinates for face, eyes, brows, nose, mouth, glasses and faceShape. Use HEAD-crop coordinates for hairline, fringe, temple, crown, majorVolumePeaks, faceWindow and headSilhouette. Width and distance fields are proportions of their relevant crop; crown.leftWidth/rightWidth are horizontal extents from apexX to the visible left/right crown shoulder.

hairline.depthByColumn has exactly eight left-to-right samples. fringe.peaks contains zero to three major fringe masses, never individual strands. crown is only left/center/right plus an apex. majorVolumePeaks contains at most six silhouette masses and is not a curl inventory. Measure faceWindow jointly with the hair boundary. headSilhouette contours have exactly eight stable top-to-bottom samples and exclude flyaways.

Mark geometry observed only when its relevant crop visibly supports it. If a side, ear, crown, chin or endpoint is cropped or occluded, mark the clipping flag, use inferred or unknown evidence, and lower that geometry group's confidence. Never store an assumed symmetric unseen side as observed. Use covering only for a visible hat, hood or scarf and keep its contour separate from hair. Do not choose Minecraft pixels, design a hairstyle, beautify the person or invent a back view.`;

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

function geometryEvidence(value: unknown): GeometryEvidence | null {
  return value === "observed" || value === "inferred" || value === "unknown" ? value : null;
}

function booleanValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function deriveLegacyGeometryExtensions(
  face: IdentityGeometryAnalysis["face"],
  eyes: IdentityGeometryAnalysis["eyes"],
  hairline: IdentityGeometryAnalysis["hairline"],
  silhouette: IdentityGeometryAnalysis["headSilhouette"],
  confidence: IdentityGeometryAnalysis["confidence"],
): Pick<IdentityGeometryAnalysis, "fringe" | "temple" | "crown" | "majorVolumePeaks" | "faceWindow" | "faceShape" | "visibility"> {
  const localPeaks = hairline.depthByColumn
    .map((depthY, column, values) => ({
      x: (column + 0.5) / 8,
      depthY,
      prominence: Math.max(0, depthY - Math.max(values[Math.max(0, column - 1)], values[Math.min(7, column + 1)])),
    }))
    .filter((peak) => peak.depthY >= 0.12 && peak.prominence >= 0.04)
    .sort((first, second) => second.prominence - first.prominence || second.depthY - first.depthY)
    .slice(0, 3);
  if (localPeaks.length === 0) {
    const depthY = Math.max(...hairline.depthByColumn);
    if (depthY >= 0.12) {
      const column = hairline.depthByColumn.indexOf(depthY);
      localPeaks.push({ x: (column + 0.5) / 8, depthY, prominence: depthY * 0.25 });
    }
  }
  const openingWidth = Math.max(0, hairline.foreheadOpeningRight - hairline.foreheadOpeningLeft);
  const openingCenterX = openingWidth >= 0.08
    ? (hairline.foreheadOpeningLeft + hairline.foreheadOpeningRight) / 2
    : null;
  const inferredConfidence = Math.min(confidence.hairline, confidence.headSilhouette, silhouette.confidence) * 0.72;
  const volumePeaks: MajorHairVolumePeak[] = [
    { region: "side_left", protrusion: silhouette.sideVolumeLeft, verticalCenter: 0.42, verticalExtent: Math.max(0.2, silhouette.hairEndpointLeftY - silhouette.crownTopY), evidence: "inferred", confidence: inferredConfidence },
    { region: "side_right", protrusion: silhouette.sideVolumeRight, verticalCenter: 0.42, verticalExtent: Math.max(0.2, silhouette.hairEndpointRightY - silhouette.crownTopY), evidence: "inferred", confidence: inferredConfidence },
  ];
  if (silhouette.hairEndpointLeftY >= 0.68) volumePeaks.push({ region: "lower_left", protrusion: silhouette.sideVolumeLeft, verticalCenter: silhouette.hairEndpointLeftY - 0.1, verticalExtent: 0.24, evidence: "inferred", confidence: inferredConfidence * 0.85 });
  if (silhouette.hairEndpointRightY >= 0.68) volumePeaks.push({ region: "lower_right", protrusion: silhouette.sideVolumeRight, verticalCenter: silhouette.hairEndpointRightY - 0.1, verticalExtent: 0.24, evidence: "inferred", confidence: inferredConfidence * 0.85 });
  return {
    fringe: {
      visible: Math.max(...hairline.depthByColumn) >= 0.12,
      peaks: localPeaks,
      direction: Math.abs(hairline.asymmetry) < 0.08 ? "irregular" : hairline.asymmetry < 0 ? "left_swept" : "right_swept",
      openingCenterX,
      openingWidth: openingCenterX === null ? null : openingWidth,
      leftTempleTransitionY: Math.min(1, Math.max(hairline.depthByColumn[0], hairline.depthByColumn[1])),
      rightTempleTransitionY: Math.min(1, Math.max(hairline.depthByColumn[6], hairline.depthByColumn[7])),
      evidence: "inferred",
      confidence: confidence.hairline * 0.72,
    },
    temple: {
      leftRecession: (silhouette.foreheadExposure + silhouette.earExposureLeft) / 2,
      rightRecession: (silhouette.foreheadExposure + silhouette.earExposureRight) / 2,
      leftStartY: Math.max(hairline.depthByColumn[0], hairline.depthByColumn[1]),
      rightStartY: Math.max(hairline.depthByColumn[6], hairline.depthByColumn[7]),
      asymmetry: silhouette.earExposureLeft - silhouette.earExposureRight,
      leftEvidence: "inferred",
      rightEvidence: "inferred",
      confidence: inferredConfidence,
    },
    crown: {
      leftY: silhouette.crownTopY,
      centerY: silhouette.crownTopY,
      rightY: silhouette.crownTopY,
      leftWidth: silhouette.sideVolumeLeft,
      rightWidth: silhouette.sideVolumeRight,
      apexX: silhouette.partCenterX ?? 0.5,
      asymmetry: silhouette.sideVolumeLeft - silhouette.sideVolumeRight,
      evidence: "inferred",
      confidence: inferredConfidence,
    },
    majorVolumePeaks: volumePeaks,
    faceWindow: {
      foreheadHeight: silhouette.foreheadExposure,
      leftTempleWidth: silhouette.earExposureLeft,
      rightTempleWidth: silhouette.earExposureRight,
      visibleFaceWidthAtEyes: face.widthWithinHead,
      visibleFaceWidthAtCheeks: face.visibleRight - face.visibleLeft,
      leftEyeToHairDistance: Math.max(0, eyes.leftCenterY - face.foreheadY),
      rightEyeToHairDistance: Math.max(0, eyes.rightCenterY - face.foreheadY),
      leftEarExposure: silhouette.earExposureLeft,
      rightEarExposure: silhouette.earExposureRight,
      leftEvidence: "inferred",
      rightEvidence: "inferred",
      confidence: Math.min(confidence.faceBounds, confidence.eyes, confidence.hairline) * 0.72,
    },
    faceShape: {
      upperWidth: face.widthWithinHead,
      cheekWidth: face.visibleRight - face.visibleLeft,
      jawWidth: Math.max(0, (face.visibleRight - face.visibleLeft) * 0.88),
      verticalLength: face.chinY - face.foreheadY,
      leftRightAsymmetry: 0,
      evidence: "inferred",
      confidence: confidence.faceBounds * 0.72,
    },
    visibility: { cropClippingKnown: false, crownClipped: false, leftHairClipped: false, rightHairClipped: false, chinClipped: false, leftEarClipped: false, rightEarClipped: false },
  };
}

function parseExtendedGeometry(
  raw: Record<string, unknown>,
  fallback: ReturnType<typeof deriveLegacyGeometryExtensions>,
): ReturnType<typeof deriveLegacyGeometryExtensions> | null {
  const parseOptionalUnit = (value: unknown): number | null | undefined => value === null ? null : numberIn(value) ? value : undefined;
  const fringeRaw = record(raw.fringe);
  const templeRaw = record(raw.temple);
  const crownRaw = record(raw.crown);
  const faceWindowRaw = record(raw.faceWindow);
  const faceShapeRaw = record(raw.faceShape);
  const visibilityRaw = record(raw.visibility);
  const peaksRaw = fringeRaw?.peaks;
  const volumeRaw = raw.majorVolumePeaks;
  const fringe = fringeRaw ? (() => {
    const evidence = geometryEvidence(fringeRaw.evidence);
    const openingCenterX = parseOptionalUnit(fringeRaw.openingCenterX);
    const openingWidth = parseOptionalUnit(fringeRaw.openingWidth);
    if (!booleanValue(fringeRaw.visible) || !Array.isArray(peaksRaw) || peaksRaw.length > 3 || !evidence || openingCenterX === undefined || openingWidth === undefined || !numberIn(fringeRaw.leftTempleTransitionY) || !numberIn(fringeRaw.rightTempleTransitionY) || !numberIn(fringeRaw.confidence) || !["left_swept", "right_swept", "centered", "split", "irregular"].includes(String(fringeRaw.direction))) return null;
    const peaks = peaksRaw.map(record);
    if (peaks.some((peak) => !peak || !numberIn(peak.x) || !numberIn(peak.depthY) || !numberIn(peak.prominence))) return null;
    return { visible: fringeRaw.visible, peaks: peaks.map((peak) => ({ x: Number(peak!.x), depthY: Number(peak!.depthY), prominence: Number(peak!.prominence) })), direction: fringeRaw.direction as FringeDirection, openingCenterX, openingWidth, leftTempleTransitionY: Number(fringeRaw.leftTempleTransitionY), rightTempleTransitionY: Number(fringeRaw.rightTempleTransitionY), evidence, confidence: Number(fringeRaw.confidence) };
  })() : fallback.fringe;
  if (!fringe) return null;
  const temple = templeRaw ? (() => {
    const leftEvidence = geometryEvidence(templeRaw.leftEvidence);
    const rightEvidence = geometryEvidence(templeRaw.rightEvidence);
    if (![templeRaw.leftRecession, templeRaw.rightRecession, templeRaw.leftStartY, templeRaw.rightStartY, templeRaw.confidence].every((value) => numberIn(value)) || !numberIn(templeRaw.asymmetry, -1, 1) || !leftEvidence || !rightEvidence) return null;
    return { leftRecession: Number(templeRaw.leftRecession), rightRecession: Number(templeRaw.rightRecession), leftStartY: Number(templeRaw.leftStartY), rightStartY: Number(templeRaw.rightStartY), asymmetry: Number(templeRaw.asymmetry), leftEvidence, rightEvidence, confidence: Number(templeRaw.confidence) };
  })() : fallback.temple;
  const crown = crownRaw ? (() => {
    const evidence = geometryEvidence(crownRaw.evidence);
    if (![crownRaw.leftY, crownRaw.centerY, crownRaw.rightY, crownRaw.leftWidth, crownRaw.rightWidth, crownRaw.apexX, crownRaw.confidence].every((value) => numberIn(value)) || !numberIn(crownRaw.asymmetry, -1, 1) || !evidence) return null;
    return { leftY: Number(crownRaw.leftY), centerY: Number(crownRaw.centerY), rightY: Number(crownRaw.rightY), leftWidth: Number(crownRaw.leftWidth), rightWidth: Number(crownRaw.rightWidth), apexX: Number(crownRaw.apexX), asymmetry: Number(crownRaw.asymmetry), evidence, confidence: Number(crownRaw.confidence) };
  })() : fallback.crown;
  if (!temple || !crown) return null;
  let majorVolumePeaks = fallback.majorVolumePeaks;
  if (volumeRaw !== undefined) {
    if (!Array.isArray(volumeRaw) || volumeRaw.length > 6) return null;
    const regions: HairVolumeRegion[] = ["crown_left", "crown_right", "side_left", "side_right", "lower_left", "lower_right"];
    const parsed = volumeRaw.map(record);
    if (parsed.some((peak) => !peak || !regions.includes(peak.region as HairVolumeRegion) || ![peak.protrusion, peak.verticalCenter, peak.verticalExtent, peak.confidence].every((value) => numberIn(value)) || !geometryEvidence(peak.evidence))) return null;
    majorVolumePeaks = parsed.map((peak) => ({ region: peak!.region as HairVolumeRegion, protrusion: Number(peak!.protrusion), verticalCenter: Number(peak!.verticalCenter), verticalExtent: Number(peak!.verticalExtent), evidence: geometryEvidence(peak!.evidence)!, confidence: Number(peak!.confidence) }));
  }
  const faceWindow = faceWindowRaw ? (() => {
    const leftEvidence = geometryEvidence(faceWindowRaw.leftEvidence);
    const rightEvidence = geometryEvidence(faceWindowRaw.rightEvidence);
    const values = [faceWindowRaw.foreheadHeight, faceWindowRaw.leftTempleWidth, faceWindowRaw.rightTempleWidth, faceWindowRaw.visibleFaceWidthAtEyes, faceWindowRaw.visibleFaceWidthAtCheeks, faceWindowRaw.leftEyeToHairDistance, faceWindowRaw.rightEyeToHairDistance, faceWindowRaw.leftEarExposure, faceWindowRaw.rightEarExposure, faceWindowRaw.confidence];
    if (!values.every((value) => numberIn(value)) || !leftEvidence || !rightEvidence) return null;
    return { foreheadHeight: Number(faceWindowRaw.foreheadHeight), leftTempleWidth: Number(faceWindowRaw.leftTempleWidth), rightTempleWidth: Number(faceWindowRaw.rightTempleWidth), visibleFaceWidthAtEyes: Number(faceWindowRaw.visibleFaceWidthAtEyes), visibleFaceWidthAtCheeks: Number(faceWindowRaw.visibleFaceWidthAtCheeks), leftEyeToHairDistance: Number(faceWindowRaw.leftEyeToHairDistance), rightEyeToHairDistance: Number(faceWindowRaw.rightEyeToHairDistance), leftEarExposure: Number(faceWindowRaw.leftEarExposure), rightEarExposure: Number(faceWindowRaw.rightEarExposure), leftEvidence, rightEvidence, confidence: Number(faceWindowRaw.confidence) };
  })() : fallback.faceWindow;
  const faceShape = faceShapeRaw ? (() => {
    const evidence = geometryEvidence(faceShapeRaw.evidence);
    if (![faceShapeRaw.upperWidth, faceShapeRaw.cheekWidth, faceShapeRaw.jawWidth, faceShapeRaw.verticalLength, faceShapeRaw.confidence].every((value) => numberIn(value)) || !numberIn(faceShapeRaw.leftRightAsymmetry, -1, 1) || !evidence) return null;
    return { upperWidth: Number(faceShapeRaw.upperWidth), cheekWidth: Number(faceShapeRaw.cheekWidth), jawWidth: Number(faceShapeRaw.jawWidth), verticalLength: Number(faceShapeRaw.verticalLength), leftRightAsymmetry: Number(faceShapeRaw.leftRightAsymmetry), evidence, confidence: Number(faceShapeRaw.confidence) };
  })() : fallback.faceShape;
  const visibility = visibilityRaw ? (() => {
    const keys = ["cropClippingKnown", "crownClipped", "leftHairClipped", "rightHairClipped", "chinClipped", "leftEarClipped", "rightEarClipped"] as const;
    if (!keys.every((key) => booleanValue(visibilityRaw[key]))) return null;
    return {
      cropClippingKnown: visibilityRaw.cropClippingKnown as boolean,
      crownClipped: visibilityRaw.crownClipped as boolean,
      leftHairClipped: visibilityRaw.leftHairClipped as boolean,
      rightHairClipped: visibilityRaw.rightHairClipped as boolean,
      chinClipped: visibilityRaw.chinClipped as boolean,
      leftEarClipped: visibilityRaw.leftEarClipped as boolean,
      rightEarClipped: visibilityRaw.rightEarClipped as boolean,
    };
  })() : fallback.visibility;
  if (!faceWindow || !faceShape || !visibility) return null;
  return { fringe, temple, crown, majorVolumePeaks, faceWindow, faceShape, visibility };
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
  const parsedFace: IdentityGeometryAnalysis["face"] = { visibleLeft: Number(face.visibleLeft), visibleRight: Number(face.visibleRight), foreheadY: Number(face.foreheadY), chinY: Number(face.chinY), widthWithinHead: Number(face.widthWithinHead) };
  const parsedEyes: IdentityGeometryAnalysis["eyes"] = { leftCenterX: Number(eyes.leftCenterX), leftCenterY: Number(eyes.leftCenterY), rightCenterX: Number(eyes.rightCenterX), rightCenterY: Number(eyes.rightCenterY), leftWidth: Number(eyes.leftWidth), rightWidth: Number(eyes.rightWidth), interEyeDistance: Number(eyes.interEyeDistance), verticalAsymmetry: Number(eyes.verticalAsymmetry), openness: Number(eyes.openness) };
  const parsedHairline: IdentityGeometryAnalysis["hairline"] = { depthByColumn: hairline.depthByColumn.map(Number) as IdentityGeometryAnalysis["hairline"]["depthByColumn"], foreheadOpeningLeft: Number(hairline.foreheadOpeningLeft), foreheadOpeningRight: Number(hairline.foreheadOpeningRight), asymmetry: Number(hairline.asymmetry) };
  const parsedSilhouette: IdentityGeometryAnalysis["headSilhouette"] = {
    crownTopY: Number(headSilhouette.crownTopY),
    leftContourByRow: headSilhouette.leftContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["leftContourByRow"],
    rightContourByRow: headSilhouette.rightContourByRow.map(Number) as IdentityGeometryAnalysis["headSilhouette"]["rightContourByRow"],
    sideVolumeLeft: Number(headSilhouette.sideVolumeLeft), sideVolumeRight: Number(headSilhouette.sideVolumeRight),
    partCenterX: headSilhouette.partCenterX === null ? null : Number(headSilhouette.partCenterX),
    hairEndpointLeftY: Number(headSilhouette.hairEndpointLeftY), hairEndpointRightY: Number(headSilhouette.hairEndpointRightY),
    foreheadExposure: Number(headSilhouette.foreheadExposure), earExposureLeft: Number(headSilhouette.earExposureLeft), earExposureRight: Number(headSilhouette.earExposureRight),
    covering, confidence: Number(headSilhouette.confidence),
  };
  const parsedConfidence: IdentityGeometryAnalysis["confidence"] = { faceBounds: Number(confidence.faceBounds), eyes: Number(confidence.eyes), brows: Number(confidence.brows), nose: Number(confidence.nose), mouth: Number(confidence.mouth), hairline: Number(confidence.hairline), headSilhouette: Number(confidence.headSilhouette), glasses: Number(confidence.glasses) };
  const legacyExtensions = deriveLegacyGeometryExtensions(parsedFace, parsedEyes, parsedHairline, parsedSilhouette, parsedConfidence);
  const extensions = parseExtendedGeometry(raw, legacyExtensions);
  if (!extensions) return null;
  return {
    face: parsedFace,
    eyes: parsedEyes,
    brows: { leftY: Number(brows.leftY), rightY: Number(brows.rightY), thickness: Number(brows.thickness), tilt: Number(brows.tilt) },
    nose: { centerX: Number(nose.centerX), contrastY: Number(nose.contrastY), leftRightBias: Number(nose.leftRightBias), visibleStrength: Number(nose.visibleStrength) },
    mouth: { centerX: Number(mouth.centerX), centerY: Number(mouth.centerY), width: Number(mouth.width), leftCornerY: Number(mouth.leftCornerY), rightCornerY: Number(mouth.rightCornerY), opening: mouth.opening as IdentityGeometryAnalysis["mouth"]["opening"] },
    hairline: parsedHairline,
    ...extensions,
    headSilhouette: parsedSilhouette,
    glasses,
    confidence: parsedConfidence,
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

export function applyCropVisibility(
  geometry: IdentityGeometryAnalysis,
  crop: GeometryCropVisibility | undefined,
): IdentityGeometryAnalysis {
  if (!crop) return geometry;
  const leftOccluded = crop.leftHairClipped || crop.leftEarClipped;
  const rightOccluded = crop.rightHairClipped || crop.rightEarClipped;
  const anyHairClipped = crop.crownClipped || crop.leftHairClipped || crop.rightHairClipped;
  const lowerEvidence = (evidence: GeometryEvidence, clipped: boolean): GeometryEvidence => clipped
    ? evidence === "unknown" ? "unknown" : "inferred"
    : evidence;
  return {
    ...geometry,
    fringe: geometry.fringe,
    temple: {
      ...geometry.temple,
      leftEvidence: lowerEvidence(geometry.temple.leftEvidence, leftOccluded),
      rightEvidence: lowerEvidence(geometry.temple.rightEvidence, rightOccluded),
      confidence: geometry.temple.confidence,
    },
    crown: { ...geometry.crown, evidence: lowerEvidence(geometry.crown.evidence, crop.crownClipped), confidence: crop.crownClipped ? Math.min(0.45, geometry.crown.confidence) : geometry.crown.confidence },
    majorVolumePeaks: geometry.majorVolumePeaks.map((peak) => {
      const clipped = peak.region.startsWith("crown")
        ? crop.crownClipped || (peak.region.endsWith("left") ? crop.leftHairClipped : crop.rightHairClipped)
        : peak.region.endsWith("left") ? crop.leftHairClipped : crop.rightHairClipped;
      return { ...peak, evidence: lowerEvidence(peak.evidence, clipped), confidence: clipped ? Math.min(0.45, peak.confidence) : peak.confidence };
    }),
    faceWindow: {
      ...geometry.faceWindow,
      leftEvidence: lowerEvidence(geometry.faceWindow.leftEvidence, leftOccluded),
      rightEvidence: lowerEvidence(geometry.faceWindow.rightEvidence, rightOccluded),
      confidence: geometry.faceWindow.confidence,
    },
    faceShape: { ...geometry.faceShape, evidence: lowerEvidence(geometry.faceShape.evidence, crop.chinClipped), confidence: crop.chinClipped ? Math.min(0.45, geometry.faceShape.confidence) : geometry.faceShape.confidence },
    headSilhouette: { ...geometry.headSilhouette, confidence: anyHairClipped ? Math.min(0.5, geometry.headSilhouette.confidence) : geometry.headSilhouette.confidence },
    confidence: {
      ...geometry.confidence,
      hairline: geometry.confidence.hairline,
      headSilhouette: anyHairClipped ? Math.min(0.5, geometry.confidence.headSilhouette) : geometry.confidence.headSilhouette,
      faceBounds: crop.chinClipped ? Math.min(0.5, geometry.confidence.faceBounds) : geometry.confidence.faceBounds,
    },
    visibility: { cropClippingKnown: true, ...crop },
  };
}

export async function runIdentityGeometryAnalysis(
  env: Env,
  faceCropDataUrl: string,
  headCropDataUrl: string,
  analysis: Pick<PhotoAnalysis, "canonicalIdentity">,
  cropVisibility?: GeometryCropVisibility,
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
        maxOutputTokens: 2600,
      });
      neuronsSpent += visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
      const payload = extractPayload(result);
      const geometry = payload ? parseIdentityGeometry(payload) : null;
      if (geometry) return { ok: true, geometry: applyCropVisibility(geometry, cropVisibility), neuronsSpent };
      lastError = new Error(`${model}: invalid identity geometry response`);
    } catch (error) {
      lastError = error;
      neuronsSpent += NEURONS_VISION_DETAIL_ESTIMATE;
    }
  }
  return { ok: false, quotaExceeded: isGeminiQuotaError(lastError), detail: lastError instanceof Error ? lastError.message : String(lastError), neuronsSpent };
}
