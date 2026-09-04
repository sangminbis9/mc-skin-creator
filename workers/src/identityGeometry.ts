import type { PhotoAnalysis } from "./analysis";
import { GeminiApiError, geminiProviderErrorDiagnostic, generateGeminiStructuredJson, isGeminiQuotaError, type GeminiProviderErrorDiagnostic, type GeminiStructuredRequestShape } from "./gemini";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";
import type { Env } from "./types";

export interface NormalizedBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Exact affine transforms used by overlay and crop-space round-trip tests. */
export function cropNormalizedToSource(point: NormalizedPoint, crop: NormalizedBox): NormalizedPoint {
  return {
    x: crop.left + point.x * (crop.right - crop.left),
    y: crop.top + point.y * (crop.bottom - crop.top),
  };
}

export function sourceNormalizedToCrop(point: NormalizedPoint, crop: NormalizedBox): NormalizedPoint {
  const width = crop.right - crop.left;
  const height = crop.bottom - crop.top;
  if (width <= 0 || height <= 0) throw new Error("Invalid normalized crop box");
  return { x: (point.x - crop.left) / width, y: (point.y - crop.top) / height };
}

export type GeometryEvidence = "observed" | "inferred" | "unknown";
export type GeometryDecisionProvenance =
  | "observed_geometry"
  | "derived_geometry"
  | "inferred_geometry"
  | "semantic_fallback";
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
  leftConfidence: number;
  rightConfidence: number;
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
  leftEvidence: GeometryEvidence;
  centerEvidence: GeometryEvidence;
  rightEvidence: GeometryEvidence;
  leftConfidence: number;
  centerConfidence: number;
  rightConfidence: number;
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
  leftConfidence: number;
  rightConfidence: number;
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
  sourceClippingKnown: boolean;
  crownClipped: boolean;
  leftHairClipped: boolean;
  rightHairClipped: boolean;
  chinClipped: boolean;
  leftEarClipped: boolean;
  rightEarClipped: boolean;
  sourceCrownClipped: boolean;
  sourceLeftHairClipped: boolean;
  sourceRightHairClipped: boolean;
  sourceChinClipped: boolean;
  crownOccluded: boolean;
  leftHairOccluded: boolean;
  rightHairOccluded: boolean;
  chinOccluded: boolean;
  leftEarOccluded: boolean;
  rightEarOccluded: boolean;
}

export type GeometryCropVisibility = Partial<GeometryVisibility> & Pick<GeometryVisibility,
  "crownClipped" | "leftHairClipped" | "rightHairClipped" | "chinClipped" | "leftEarClipped" | "rightEarClipped"
>;

export interface GeometryCompleteness {
  fringeObserved: boolean;
  leftTempleObserved: boolean;
  rightTempleObserved: boolean;
  crownObservedFraction: number;
  volumePeakObservedFraction: number;
  faceWindowObservedFraction: number;
}

export interface GeometryValidationIssue {
  field: string;
  code:
    | "evidence_confidence_conflict"
    | "clipping_evidence_conflict"
    | "occlusion_evidence_conflict"
    | "outside_visible_region"
    | "cross_field_conflict"
    | "coordinate_space_conflict";
  action: "degraded" | "removed";
}

export interface GeometryDiagnostics {
  issues: GeometryValidationIssue[];
  completeness: GeometryCompleteness;
  directMeasurements: string[];
  derivedMeasurements: string[];
  provenance: Record<string, GeometryDecisionProvenance>;
}

export interface IdentityGeometryAnalysis {
  coordinateSpaces: {
    faceMeasurements: "tight_face_crop";
    headMeasurements: "wide_head_crop";
  };
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
  diagnostics: GeometryDiagnostics;
}

export type IdentityGeometryCallResult =
  | { ok: true; geometry: IdentityGeometryAnalysis; neuronsSpent: number; requestShape: GeminiStructuredRequestShape }
  | { ok: false; quotaExceeded: boolean; detail: string; neuronsSpent: number; diagnostic: IdentityGeometryErrorDiagnostic };

export interface IdentityGeometryErrorDiagnostic {
  stage: "identity_geometry";
  model: string;
  requestShape: GeminiStructuredRequestShape | null;
  providerError: GeminiProviderErrorDiagnostic;
}

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
    coordinateSpaces: {
      type: "object",
      additionalProperties: false,
      properties: {
        faceMeasurements: { type: "string", enum: ["tight_face_crop"] },
        headMeasurements: { type: "string", enum: ["wide_head_crop"] },
      },
      required: ["faceMeasurements", "headMeasurements"],
    },
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
      properties: { leftRecession: unit, rightRecession: unit, leftStartY: unit, rightStartY: unit, asymmetry: signedUnit, leftEvidence: evidenceSchema, rightEvidence: evidenceSchema, leftConfidence: unit, rightConfidence: unit, confidence: unit },
      required: ["leftRecession", "rightRecession", "leftStartY", "rightStartY", "asymmetry", "leftEvidence", "rightEvidence", "leftConfidence", "rightConfidence", "confidence"],
    },
    crown: {
      type: "object", additionalProperties: false,
      properties: { leftY: unit, centerY: unit, rightY: unit, leftWidth: unit, rightWidth: unit, apexX: unit, asymmetry: signedUnit, evidence: evidenceSchema, leftEvidence: evidenceSchema, centerEvidence: evidenceSchema, rightEvidence: evidenceSchema, leftConfidence: unit, centerConfidence: unit, rightConfidence: unit, confidence: unit },
      required: ["leftY", "centerY", "rightY", "leftWidth", "rightWidth", "apexX", "asymmetry", "evidence", "leftEvidence", "centerEvidence", "rightEvidence", "leftConfidence", "centerConfidence", "rightConfidence", "confidence"],
    },
    majorVolumePeaks: {
      type: "array", minItems: 0, maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { region: { type: "string", enum: ["crown_left", "crown_right", "side_left", "side_right", "lower_left", "lower_right"] }, protrusion: unit, verticalCenter: unit, verticalExtent: unit, evidence: evidenceSchema, confidence: unit }, required: ["region", "protrusion", "verticalCenter", "verticalExtent", "evidence", "confidence"] },
    },
    faceWindow: {
      type: "object", additionalProperties: false,
      properties: { foreheadHeight: unit, leftTempleWidth: unit, rightTempleWidth: unit, visibleFaceWidthAtEyes: unit, visibleFaceWidthAtCheeks: unit, leftEyeToHairDistance: unit, rightEyeToHairDistance: unit, leftEarExposure: unit, rightEarExposure: unit, leftEvidence: evidenceSchema, rightEvidence: evidenceSchema, leftConfidence: unit, rightConfidence: unit, confidence: unit },
      required: ["foreheadHeight", "leftTempleWidth", "rightTempleWidth", "visibleFaceWidthAtEyes", "visibleFaceWidthAtCheeks", "leftEyeToHairDistance", "rightEyeToHairDistance", "leftEarExposure", "rightEarExposure", "leftEvidence", "rightEvidence", "leftConfidence", "rightConfidence", "confidence"],
    },
    faceShape: {
      type: "object", additionalProperties: false,
      properties: { upperWidth: unit, cheekWidth: unit, jawWidth: unit, verticalLength: unit, leftRightAsymmetry: signedUnit, evidence: evidenceSchema, confidence: unit },
      required: ["upperWidth", "cheekWidth", "jawWidth", "verticalLength", "leftRightAsymmetry", "evidence", "confidence"],
    },
    visibility: {
      type: "object", additionalProperties: false,
      properties: {
        cropClippingKnown: { type: "boolean" }, sourceClippingKnown: { type: "boolean" },
        crownClipped: { type: "boolean" }, leftHairClipped: { type: "boolean" }, rightHairClipped: { type: "boolean" }, chinClipped: { type: "boolean" }, leftEarClipped: { type: "boolean" }, rightEarClipped: { type: "boolean" },
        sourceCrownClipped: { type: "boolean" }, sourceLeftHairClipped: { type: "boolean" }, sourceRightHairClipped: { type: "boolean" }, sourceChinClipped: { type: "boolean" },
        crownOccluded: { type: "boolean" }, leftHairOccluded: { type: "boolean" }, rightHairOccluded: { type: "boolean" }, chinOccluded: { type: "boolean" }, leftEarOccluded: { type: "boolean" }, rightEarOccluded: { type: "boolean" },
      },
      required: ["cropClippingKnown", "sourceClippingKnown", "crownClipped", "leftHairClipped", "rightHairClipped", "chinClipped", "leftEarClipped", "rightEarClipped", "sourceCrownClipped", "sourceLeftHairClipped", "sourceRightHairClipped", "sourceChinClipped", "crownOccluded", "leftHairOccluded", "rightHairOccluded", "chinOccluded", "leftEarOccluded", "rightEarOccluded"],
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
  required: ["coordinateSpaces", "face", "eyes", "brows", "nose", "mouth", "hairline", "fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "visibility", "headSilhouette", "glasses", "confidence"],
} as const;

/**
 * Gemini-facing schema. The richer schema above documents the normalized
 * internal contract and remains useful for compatibility tests, but is not
 * sent to the provider. Metadata and landmark relationships already known to
 * code are deliberately omitted from this wire shape.
 */
export const IDENTITY_GEOMETRY_WIRE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    face: {
      type: "object", additionalProperties: false,
      properties: { visibleLeft: unit, visibleRight: unit, foreheadY: unit, chinY: unit, widthWithinHead: unit },
      required: ["visibleLeft", "visibleRight", "foreheadY", "chinY", "widthWithinHead"],
    },
    eyes: {
      type: "object", additionalProperties: false,
      properties: { leftCenterX: unit, leftCenterY: unit, rightCenterX: unit, rightCenterY: unit, leftWidth: unit, rightWidth: unit, openness: unit },
      required: ["leftCenterX", "leftCenterY", "rightCenterX", "rightCenterY", "leftWidth", "rightWidth", "openness"],
    },
    brows: {
      type: "object", additionalProperties: false,
      properties: { leftY: unit, rightY: unit, thickness: unit },
      required: ["leftY", "rightY", "thickness"],
    },
    nose: {
      type: "object", additionalProperties: false,
      properties: { centerX: unit, contrastY: unit, visibleStrength: unit },
      required: ["centerX", "contrastY", "visibleStrength"],
    },
    mouth: {
      type: "object", additionalProperties: false,
      properties: { centerX: unit, centerY: unit, width: unit, leftCornerY: unit, rightCornerY: unit, opening: { type: "string", enum: ["closed", "open", "teeth"] } },
      required: ["centerX", "centerY", "width", "leftCornerY", "rightCornerY", "opening"],
    },
    hairline: {
      type: "object", additionalProperties: false,
      properties: { depthByColumn: { type: "array", minItems: 8, maxItems: 8, items: unit }, foreheadOpeningLeft: unit, foreheadOpeningRight: unit },
      required: ["depthByColumn", "foreheadOpeningLeft", "foreheadOpeningRight"],
    },
    fringe: {
      type: "object", additionalProperties: false,
      properties: {
        visible: { type: "boolean" },
        peaks: { type: "array", minItems: 0, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { x: unit, depthY: unit, prominence: unit }, required: ["x", "depthY", "prominence"] } },
        direction: { type: "string", enum: ["left_swept", "right_swept", "centered", "split", "irregular"] },
        openingCenterX: { type: ["number", "null"], minimum: 0, maximum: 1 },
        openingWidth: { type: ["number", "null"], minimum: 0, maximum: 1 },
        evidence: evidenceSchema, confidence: unit,
      },
      required: ["visible", "peaks", "direction", "openingCenterX", "openingWidth", "evidence", "confidence"],
    },
    temple: {
      type: "object", additionalProperties: false,
      properties: { leftRecession: unit, rightRecession: unit, leftStartY: unit, rightStartY: unit, leftEvidence: evidenceSchema, rightEvidence: evidenceSchema, leftConfidence: unit, rightConfidence: unit },
      required: ["leftRecession", "rightRecession", "leftStartY", "rightStartY", "leftEvidence", "rightEvidence", "leftConfidence", "rightConfidence"],
    },
    crown: {
      type: "object", additionalProperties: false,
      properties: { leftY: unit, centerY: unit, rightY: unit, leftWidth: unit, rightWidth: unit, apexX: unit, leftEvidence: evidenceSchema, centerEvidence: evidenceSchema, rightEvidence: evidenceSchema, leftConfidence: unit, centerConfidence: unit, rightConfidence: unit },
      required: ["leftY", "centerY", "rightY", "leftWidth", "rightWidth", "apexX", "leftEvidence", "centerEvidence", "rightEvidence", "leftConfidence", "centerConfidence", "rightConfidence"],
    },
    majorVolumePeaks: {
      type: "array", minItems: 0, maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { region: { type: "string", enum: ["crown_left", "crown_right", "side_left", "side_right", "lower_left", "lower_right"] }, protrusion: unit, verticalCenter: unit, verticalExtent: unit, evidence: evidenceSchema, confidence: unit }, required: ["region", "protrusion", "verticalCenter", "verticalExtent", "evidence", "confidence"] },
    },
    occlusion: {
      type: "object", additionalProperties: false,
      properties: { crown: { type: "boolean" }, leftHair: { type: "boolean" }, rightHair: { type: "boolean" }, chin: { type: "boolean" }, leftEar: { type: "boolean" }, rightEar: { type: "boolean" } },
      required: ["crown", "leftHair", "rightHair", "chin", "leftEar", "rightEar"],
    },
    headSilhouette: {
      type: "object", additionalProperties: false,
      properties: {
        crownTopY: unit,
        leftContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        rightContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        sideVolumeLeft: unit, sideVolumeRight: unit,
        partCenterX: { type: ["number", "null"], minimum: 0, maximum: 1 },
        hairEndpointLeftY: unit, hairEndpointRightY: unit,
        foreheadExposure: unit, earExposureLeft: unit, earExposureRight: unit,
        covering: {
          type: ["object", "null"], additionalProperties: false,
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
      leftBox: boxSchema, rightBox: boxSchema, bridgeCenterX: unit, bridgeY: unit, thickness: unit,
    }, required: ["leftBox", "rightBox", "bridgeCenterX", "bridgeY", "thickness"] },
    confidence: {
      type: "object", additionalProperties: false,
      properties: { faceBounds: unit, eyes: unit, brows: unit, nose: unit, mouth: unit, hairline: unit, headSilhouette: unit, glasses: unit },
      required: ["faceBounds", "eyes", "brows", "nose", "mouth", "hairline", "headSilhouette", "glasses"],
    },
  },
  required: ["face", "eyes", "brows", "nose", "mouth", "hairline", "fringe", "temple", "crown", "majorVolumePeaks", "occlusion", "headSilhouette", "glasses", "confidence"],
} as const;

const orderedPointSchema = {
  type: "object", additionalProperties: false,
  properties: { x: unit, y: unit, width: unit },
  required: ["x", "y", "width"],
} as const;

const sidedMeasurementSchema = {
  type: "object", additionalProperties: false,
  properties: { value: unit, y: unit, evidence: evidenceSchema, confidence: unit },
  required: ["value", "y", "evidence", "confidence"],
} as const;

/**
 * Compact production transport contract. Repeated left/right measurements use
 * fixed-order homogeneous arrays, while visibility booleans make every value
 * syntactically required without nullable-object expansion. The prompt owns
 * field semantics; the schema owns only a small, regular JSON grammar.
 */
export const IDENTITY_GEOMETRY_COMPACT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    face: {
      type: "object", additionalProperties: false,
      properties: { visibleLeft: unit, visibleRight: unit, foreheadY: unit, chinY: unit, widthWithinHead: unit, confidence: unit },
      required: ["visibleLeft", "visibleRight", "foreheadY", "chinY", "widthWithinHead", "confidence"],
    },
    eyes: {
      type: "object", additionalProperties: false,
      properties: { sides: { type: "array", minItems: 2, maxItems: 2, items: orderedPointSchema }, openness: unit, confidence: unit },
      required: ["sides", "openness", "confidence"],
    },
    brows: {
      type: "object", additionalProperties: false,
      properties: { yBySide: { type: "array", minItems: 2, maxItems: 2, items: unit }, thickness: unit, confidence: unit },
      required: ["yBySide", "thickness", "confidence"],
    },
    nose: {
      type: "object", additionalProperties: false,
      properties: { x: unit, y: unit, strength: unit, confidence: unit },
      required: ["x", "y", "strength", "confidence"],
    },
    mouth: {
      type: "object", additionalProperties: false,
      properties: { x: unit, y: unit, width: unit, cornerYBySide: { type: "array", minItems: 2, maxItems: 2, items: unit }, opening: { type: "string", enum: ["closed", "open", "teeth"] }, confidence: unit },
      required: ["x", "y", "width", "cornerYBySide", "opening", "confidence"],
    },
    hairline: {
      type: "object", additionalProperties: false,
      properties: { depthByColumn: { type: "array", minItems: 8, maxItems: 8, items: unit }, openingBySide: { type: "array", minItems: 2, maxItems: 2, items: unit }, evidence: evidenceSchema, confidence: unit },
      required: ["depthByColumn", "openingBySide", "evidence", "confidence"],
    },
    fringe: {
      type: "object", additionalProperties: false,
      properties: {
        visible: { type: "boolean" },
        peaks: { type: "array", minItems: 0, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { x: unit, y: unit, prominence: unit }, required: ["x", "y", "prominence"] } },
        direction: { type: "string", enum: ["left_swept", "right_swept", "centered", "split", "irregular"] },
        openingVisible: { type: "boolean" }, openingX: unit, openingWidth: unit,
        evidence: evidenceSchema, confidence: unit,
      },
      required: ["visible", "peaks", "direction", "openingVisible", "openingX", "openingWidth", "evidence", "confidence"],
    },
    temples: { type: "array", minItems: 2, maxItems: 2, items: sidedMeasurementSchema },
    crown: {
      type: "object", additionalProperties: false,
      properties: {
        sides: { type: "array", minItems: 3, maxItems: 3, items: sidedMeasurementSchema },
        apexX: unit,
      },
      required: ["sides", "apexX"],
    },
    majorVolumePeaks: {
      type: "array", minItems: 0, maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { region: { type: "string", enum: ["crown_left", "crown_right", "side_left", "side_right", "lower_left", "lower_right"] }, protrusion: unit, y: unit, extent: unit, evidence: evidenceSchema, confidence: unit }, required: ["region", "protrusion", "y", "extent", "evidence", "confidence"] },
    },
    occlusion: {
      type: "object", additionalProperties: false,
      properties: { crown: { type: "boolean" }, leftHair: { type: "boolean" }, rightHair: { type: "boolean" }, chin: { type: "boolean" }, leftEar: { type: "boolean" }, rightEar: { type: "boolean" } },
      required: ["crown", "leftHair", "rightHair", "chin", "leftEar", "rightEar"],
    },
    headSilhouette: {
      type: "object", additionalProperties: false,
      properties: {
        crownTopY: unit,
        leftContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        rightContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        sideVolumeBySide: { type: "array", minItems: 2, maxItems: 2, items: unit },
        partVisible: { type: "boolean" }, partX: unit,
        endpointYBySide: { type: "array", minItems: 2, maxItems: 2, items: unit },
        foreheadExposure: unit, earExposureBySide: { type: "array", minItems: 2, maxItems: 2, items: unit },
        coveringVisible: { type: "boolean" },
        coveringLeftContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        coveringRightContourByRow: { type: "array", minItems: 8, maxItems: 8, items: unit },
        evidence: evidenceSchema, confidence: unit,
      },
      required: ["crownTopY", "leftContourByRow", "rightContourByRow", "sideVolumeBySide", "partVisible", "partX", "endpointYBySide", "foreheadExposure", "earExposureBySide", "coveringVisible", "coveringLeftContourByRow", "coveringRightContourByRow", "evidence", "confidence"],
    },
    glasses: {
      type: "object", additionalProperties: false,
      properties: {
        visible: { type: "boolean" },
        leftBox: { type: "array", minItems: 4, maxItems: 4, items: unit },
        rightBox: { type: "array", minItems: 4, maxItems: 4, items: unit },
        bridgeX: unit, bridgeY: unit, thickness: unit, confidence: unit,
      },
      required: ["visible", "leftBox", "rightBox", "bridgeX", "bridgeY", "thickness", "confidence"],
    },
  },
  required: ["face", "eyes", "brows", "nose", "mouth", "hairline", "fringe", "temples", "crown", "majorVolumePeaks", "occlusion", "headSilhouette", "glasses"],
} as const;

export const IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX = `COMPACT RESPONSE ORDER:
- Every two-item side array is [viewer-left, viewer-right].
- crown.sides is [viewer-left, center, viewer-right]; each item uses value=boundary Y and y=horizontal extent.
- eyes.sides is [viewer-left, viewer-right].
- Values paired with *Visible=false are safe placeholders only; code discards them.
- Keep evidence and confidence source-visual, using the existing definitions above.`;

export const IDENTITY_GEOMETRY_PROMPT = `You are a conservative measurement instrument for the SAME real person, not a hairstyle designer.

TOP-LEVEL PROTOCOL:
- Measure visible geometry. Do not beautify. Do not stylize. Do not invent hidden structure.
- Do not use a semantic hairstyle label as geometry evidence. Do not infer geometry solely from labels such as curly, side-swept or round face; a semantic label is never boundary evidence.
- Do not choose Minecraft pixels. Return normalized measurements; deterministic code performs quantization later.
- Preserve unusual spacing, asymmetry and proportions. Never normalize toward an average face or a generic hairstyle template.

COORDINATE CONTRACT:
- Image 0 is the TIGHT FACE crop. Use this coordinate space only for face, eyes, brows, nose, mouth and glasses.
- Image 1 is the WIDE HEAD crop. Use this coordinate space only for hairline, fringe, temple, crown, majorVolumePeaks and headSilhouette.
- Never copy an Image 0 coordinate into an Image 1 field or vice versa. All positions and proportions are 0.0..1 within their declared crop.

FACE crop priorities:
- eyes, brows, nose, mouth, glasses and visible face proportions.

HEAD crop priorities:
- fringe, hairline, left/right temples, crown, side hair, connected major hair masses, ears, full visible head silhouette and head covering.
- Do not estimate the hair silhouette from the tight face crop. Do not estimate eyes or mouth from the wide head crop.

GEOMETRY DEFINITIONS:
- hairline.depthByColumn: exactly eight stable left-to-right samples of the visible front hair boundary.
- fringe peak: a large downward connected mass on the front hair boundary that would change an 8x8 silhouette, never an individual strand or curl. Return at most three. Peaks must agree with the local hairline samples.
- temple recession: how far the front hair boundary recedes from the visible face boundary, measured independently on each side. It is not ear visibility.
- crown: three coarse boundary heights (left, center, right), apexX, and left/right horizontal extents. Do not emit a dense contour.
- major volume peak: a connected mass that changes the outer silhouette, never an individual curl. Return at most one for each of crown_left, crown_right, side_left, side_right, lower_left and lower_right. Measure protrusion, vertical center and vertical extent.
- Face-window and eye-to-hair relationships are derived in code from the measured face, eyes, hairline, temples, forehead and ear exposure; do not return a separate faceWindow object.
- headSilhouette contours: exactly eight stable top-to-bottom outer-boundary samples. Ignore flyaways.

EVIDENCE AND CONFIDENCE:
- observed: the relevant boundary is actually visible in the declared crop.
- inferred: part of the boundary is visible, but the reported value needs a limited interpolation.
- unknown: clipping or occlusion prevents a reliable measurement.
- Confidence must reflect boundary visibility, crop/source clipping, occlusion, local contrast and face/head crop agreement. Clear observed and unclipped may be high; partial visibility is medium; clipped or occluded is low.
- Report left/right confidence independently for temples and faceWindow, and left/center/right confidence independently for crown. Never mark a symmetric guess for a hidden side as observed.

HEAD COVERINGS:
- When a scarf, hood or hat covers the head, put its visible outer contour only in headSilhouette.covering. Do not label the covering as hair crown, fringe, curls or hair volume.
- If hair under the covering is not visible, its evidence is unknown even if the covering boundary is clear.

Set only the occlusion flags for boundaries hidden by pose, hand, accessory, covering or overlapping hair. Crop and source clipping are supplied by code and must not be returned. Do not turn source-edge uncertainty into high-confidence observed geometry.`;

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
      leftConfidence: inferredConfidence,
      rightConfidence: inferredConfidence,
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
      leftEvidence: "inferred",
      centerEvidence: "inferred",
      rightEvidence: "inferred",
      leftConfidence: inferredConfidence,
      centerConfidence: inferredConfidence,
      rightConfidence: inferredConfidence,
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
      leftConfidence: Math.min(confidence.faceBounds, confidence.eyes, confidence.hairline) * 0.72,
      rightConfidence: Math.min(confidence.faceBounds, confidence.eyes, confidence.hairline) * 0.72,
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
    visibility: {
      cropClippingKnown: false, sourceClippingKnown: false,
      crownClipped: false, leftHairClipped: false, rightHairClipped: false, chinClipped: false, leftEarClipped: false, rightEarClipped: false,
      sourceCrownClipped: false, sourceLeftHairClipped: false, sourceRightHairClipped: false, sourceChinClipped: false,
      crownOccluded: false, leftHairOccluded: false, rightHairOccluded: false, chinOccluded: false, leftEarOccluded: false, rightEarOccluded: false,
    },
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
    const leftConfidence = templeRaw.leftConfidence === undefined ? templeRaw.confidence : templeRaw.leftConfidence;
    const rightConfidence = templeRaw.rightConfidence === undefined ? templeRaw.confidence : templeRaw.rightConfidence;
    if (![templeRaw.leftRecession, templeRaw.rightRecession, templeRaw.leftStartY, templeRaw.rightStartY, leftConfidence, rightConfidence, templeRaw.confidence].every((value) => numberIn(value)) || !numberIn(templeRaw.asymmetry, -1, 1) || !leftEvidence || !rightEvidence) return null;
    return { leftRecession: Number(templeRaw.leftRecession), rightRecession: Number(templeRaw.rightRecession), leftStartY: Number(templeRaw.leftStartY), rightStartY: Number(templeRaw.rightStartY), asymmetry: Number(templeRaw.asymmetry), leftEvidence, rightEvidence, leftConfidence: Number(leftConfidence), rightConfidence: Number(rightConfidence), confidence: Number(templeRaw.confidence) };
  })() : fallback.temple;
  const crown = crownRaw ? (() => {
    const evidence = geometryEvidence(crownRaw.evidence);
    const leftEvidence = geometryEvidence(crownRaw.leftEvidence) ?? evidence;
    const centerEvidence = geometryEvidence(crownRaw.centerEvidence) ?? evidence;
    const rightEvidence = geometryEvidence(crownRaw.rightEvidence) ?? evidence;
    const leftConfidence = crownRaw.leftConfidence === undefined ? crownRaw.confidence : crownRaw.leftConfidence;
    const centerConfidence = crownRaw.centerConfidence === undefined ? crownRaw.confidence : crownRaw.centerConfidence;
    const rightConfidence = crownRaw.rightConfidence === undefined ? crownRaw.confidence : crownRaw.rightConfidence;
    if (![crownRaw.leftY, crownRaw.centerY, crownRaw.rightY, crownRaw.leftWidth, crownRaw.rightWidth, crownRaw.apexX, leftConfidence, centerConfidence, rightConfidence, crownRaw.confidence].every((value) => numberIn(value)) || !numberIn(crownRaw.asymmetry, -1, 1) || !evidence || !leftEvidence || !centerEvidence || !rightEvidence) return null;
    return { leftY: Number(crownRaw.leftY), centerY: Number(crownRaw.centerY), rightY: Number(crownRaw.rightY), leftWidth: Number(crownRaw.leftWidth), rightWidth: Number(crownRaw.rightWidth), apexX: Number(crownRaw.apexX), asymmetry: Number(crownRaw.asymmetry), evidence, leftEvidence, centerEvidence, rightEvidence, leftConfidence: Number(leftConfidence), centerConfidence: Number(centerConfidence), rightConfidence: Number(rightConfidence), confidence: Number(crownRaw.confidence) };
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
    const leftConfidence = faceWindowRaw.leftConfidence === undefined ? faceWindowRaw.confidence : faceWindowRaw.leftConfidence;
    const rightConfidence = faceWindowRaw.rightConfidence === undefined ? faceWindowRaw.confidence : faceWindowRaw.rightConfidence;
    const values = [faceWindowRaw.foreheadHeight, faceWindowRaw.leftTempleWidth, faceWindowRaw.rightTempleWidth, faceWindowRaw.visibleFaceWidthAtEyes, faceWindowRaw.visibleFaceWidthAtCheeks, faceWindowRaw.leftEyeToHairDistance, faceWindowRaw.rightEyeToHairDistance, faceWindowRaw.leftEarExposure, faceWindowRaw.rightEarExposure, leftConfidence, rightConfidence, faceWindowRaw.confidence];
    if (!values.every((value) => numberIn(value)) || !leftEvidence || !rightEvidence) return null;
    return { foreheadHeight: Number(faceWindowRaw.foreheadHeight), leftTempleWidth: Number(faceWindowRaw.leftTempleWidth), rightTempleWidth: Number(faceWindowRaw.rightTempleWidth), visibleFaceWidthAtEyes: Number(faceWindowRaw.visibleFaceWidthAtEyes), visibleFaceWidthAtCheeks: Number(faceWindowRaw.visibleFaceWidthAtCheeks), leftEyeToHairDistance: Number(faceWindowRaw.leftEyeToHairDistance), rightEyeToHairDistance: Number(faceWindowRaw.rightEyeToHairDistance), leftEarExposure: Number(faceWindowRaw.leftEarExposure), rightEarExposure: Number(faceWindowRaw.rightEarExposure), leftEvidence, rightEvidence, leftConfidence: Number(leftConfidence), rightConfidence: Number(rightConfidence), confidence: Number(faceWindowRaw.confidence) };
  })() : fallback.faceWindow;
  const faceShape = faceShapeRaw ? (() => {
    const evidence = geometryEvidence(faceShapeRaw.evidence);
    if (![faceShapeRaw.upperWidth, faceShapeRaw.cheekWidth, faceShapeRaw.jawWidth, faceShapeRaw.verticalLength, faceShapeRaw.confidence].every((value) => numberIn(value)) || !numberIn(faceShapeRaw.leftRightAsymmetry, -1, 1) || !evidence) return null;
    return { upperWidth: Number(faceShapeRaw.upperWidth), cheekWidth: Number(faceShapeRaw.cheekWidth), jawWidth: Number(faceShapeRaw.jawWidth), verticalLength: Number(faceShapeRaw.verticalLength), leftRightAsymmetry: Number(faceShapeRaw.leftRightAsymmetry), evidence, confidence: Number(faceShapeRaw.confidence) };
  })() : fallback.faceShape;
  const visibility = visibilityRaw ? (() => {
    const requiredKeys = ["cropClippingKnown", "crownClipped", "leftHairClipped", "rightHairClipped", "chinClipped", "leftEarClipped", "rightEarClipped"] as const;
    if (!requiredKeys.every((key) => booleanValue(visibilityRaw[key]))) return null;
    const optionalBoolean = (key: string): boolean => booleanValue(visibilityRaw[key]) ? visibilityRaw[key] as boolean : false;
    return {
      cropClippingKnown: visibilityRaw.cropClippingKnown as boolean,
      sourceClippingKnown: optionalBoolean("sourceClippingKnown"),
      crownClipped: visibilityRaw.crownClipped as boolean,
      leftHairClipped: visibilityRaw.leftHairClipped as boolean,
      rightHairClipped: visibilityRaw.rightHairClipped as boolean,
      chinClipped: visibilityRaw.chinClipped as boolean,
      leftEarClipped: visibilityRaw.leftEarClipped as boolean,
      rightEarClipped: visibilityRaw.rightEarClipped as boolean,
      sourceCrownClipped: optionalBoolean("sourceCrownClipped"),
      sourceLeftHairClipped: optionalBoolean("sourceLeftHairClipped"),
      sourceRightHairClipped: optionalBoolean("sourceRightHairClipped"),
      sourceChinClipped: optionalBoolean("sourceChinClipped"),
      crownOccluded: optionalBoolean("crownOccluded"),
      leftHairOccluded: optionalBoolean("leftHairOccluded"),
      rightHairOccluded: optionalBoolean("rightHairOccluded"),
      chinOccluded: optionalBoolean("chinOccluded"),
      leftEarOccluded: optionalBoolean("leftEarOccluded"),
      rightEarOccluded: optionalBoolean("rightEarOccluded"),
    };
  })() : fallback.visibility;
  if (!faceWindow || !faceShape || !visibility) return null;
  return { fringe, temple, crown, majorVolumePeaks, faceWindow, faceShape, visibility };
}

const EMPTY_COMPLETENESS: GeometryCompleteness = {
  fringeObserved: false,
  leftTempleObserved: false,
  rightTempleObserved: false,
  crownObservedFraction: 0,
  volumePeakObservedFraction: 0,
  faceWindowObservedFraction: 0,
};

function evidenceProvenance(evidence: GeometryEvidence, derived: boolean): GeometryDecisionProvenance {
  if (derived) return "derived_geometry";
  if (evidence === "observed") return "observed_geometry";
  if (evidence === "inferred") return "inferred_geometry";
  return "semantic_fallback";
}

function normalizeEvidenceConfidence(
  issues: GeometryValidationIssue[],
  field: string,
  evidence: GeometryEvidence,
  confidence: number,
  conflict: "clipping" | "occlusion" | null = null,
): { evidence: GeometryEvidence; confidence: number } {
  if (evidence === "unknown" && confidence > 0.34) {
    issues.push({ field, code: "evidence_confidence_conflict", action: "degraded" });
    return { evidence, confidence: 0.34 };
  }
  if (conflict && evidence === "observed") {
    issues.push({ field, code: conflict === "clipping" ? "clipping_evidence_conflict" : "occlusion_evidence_conflict", action: "degraded" });
    return { evidence: "inferred", confidence: Math.min(confidence, 0.45) };
  }
  if (conflict) return { evidence, confidence: Math.min(confidence, 0.45) };
  return { evidence, confidence };
}

/**
 * Cross-field safety gate. It preserves valid measurements, degrades evidence
 * contradicted by visibility, and removes only local outliers so one bad hair
 * point cannot discard otherwise useful facial geometry.
 */
export function validateIdentityGeometry(
  geometry: IdentityGeometryAnalysis,
  derivedFields: readonly string[] = geometry.diagnostics?.derivedMeasurements ?? [],
): IdentityGeometryAnalysis {
  const next = structuredClone(geometry);
  const issues: GeometryValidationIssue[] = [];
  const visibility = next.visibility;
  const sourceCrownConflict = visibility.sourceClippingKnown && visibility.sourceCrownClipped;
  const sourceLeftConflict = visibility.sourceClippingKnown && visibility.sourceLeftHairClipped;
  const sourceRightConflict = visibility.sourceClippingKnown && visibility.sourceRightHairClipped;
  const sourceChinConflict = visibility.sourceClippingKnown && visibility.sourceChinClipped;
  const crownConflict = (visibility.cropClippingKnown && visibility.crownClipped) || sourceCrownConflict;
  const leftConflict = (visibility.cropClippingKnown && (visibility.leftHairClipped || visibility.leftEarClipped)) || sourceLeftConflict;
  const rightConflict = (visibility.cropClippingKnown && (visibility.rightHairClipped || visibility.rightEarClipped)) || sourceRightConflict;

  const fringe = normalizeEvidenceConfidence(issues, "fringe", next.fringe.evidence, next.fringe.confidence);
  Object.assign(next.fringe, fringe);
  const leftTemple = normalizeEvidenceConfidence(issues, "temple.left", next.temple.leftEvidence, next.temple.leftConfidence, leftConflict ? "clipping" : visibility.leftHairOccluded || visibility.leftEarOccluded ? "occlusion" : null);
  const rightTemple = normalizeEvidenceConfidence(issues, "temple.right", next.temple.rightEvidence, next.temple.rightConfidence, rightConflict ? "clipping" : visibility.rightHairOccluded || visibility.rightEarOccluded ? "occlusion" : null);
  Object.assign(next.temple, { leftEvidence: leftTemple.evidence, leftConfidence: leftTemple.confidence, rightEvidence: rightTemple.evidence, rightConfidence: rightTemple.confidence, confidence: Math.min(next.temple.confidence, Math.max(leftTemple.confidence, rightTemple.confidence)) });

  const crownParts = (["left", "center", "right"] as const).map((side) => {
    const sideConflict = crownConflict || (side === "left" ? leftConflict : side === "right" ? rightConflict : false);
    const occluded = visibility.crownOccluded || (side === "left" ? visibility.leftHairOccluded : side === "right" ? visibility.rightHairOccluded : false);
    return normalizeEvidenceConfidence(issues, `crown.${side}`, next.crown[`${side}Evidence`], next.crown[`${side}Confidence`], sideConflict ? "clipping" : occluded ? "occlusion" : null);
  });
  Object.assign(next.crown, {
    leftEvidence: crownParts[0].evidence, leftConfidence: crownParts[0].confidence,
    centerEvidence: crownParts[1].evidence, centerConfidence: crownParts[1].confidence,
    rightEvidence: crownParts[2].evidence, rightConfidence: crownParts[2].confidence,
  });
  const crownEvidenceOrder: GeometryEvidence[] = ["unknown", "inferred", "observed"];
  next.crown.evidence = crownEvidenceOrder[Math.min(...crownParts.map((part) => crownEvidenceOrder.indexOf(part.evidence)))] ?? "unknown";
  next.crown.confidence = Math.min(next.crown.confidence, Math.max(...crownParts.map((part) => part.confidence)));

  const leftWindow = normalizeEvidenceConfidence(issues, "faceWindow.left", next.faceWindow.leftEvidence, next.faceWindow.leftConfidence, leftConflict ? "clipping" : visibility.leftHairOccluded || visibility.leftEarOccluded ? "occlusion" : null);
  const rightWindow = normalizeEvidenceConfidence(issues, "faceWindow.right", next.faceWindow.rightEvidence, next.faceWindow.rightConfidence, rightConflict ? "clipping" : visibility.rightHairOccluded || visibility.rightEarOccluded ? "occlusion" : null);
  Object.assign(next.faceWindow, { leftEvidence: leftWindow.evidence, leftConfidence: leftWindow.confidence, rightEvidence: rightWindow.evidence, rightConfidence: rightWindow.confidence, confidence: Math.min(next.faceWindow.confidence, Math.max(leftWindow.confidence, rightWindow.confidence)) });
  const chinConflict = (visibility.cropClippingKnown && visibility.chinClipped) || sourceChinConflict;
  const faceShape = normalizeEvidenceConfidence(issues, "faceShape", next.faceShape.evidence, next.faceShape.confidence, chinConflict ? "clipping" : visibility.chinOccluded ? "occlusion" : null);
  Object.assign(next.faceShape, faceShape);

  const faceCoordinateConflict =
    next.eyes.leftCenterX < next.face.visibleLeft - 0.04 || next.eyes.rightCenterX > next.face.visibleRight + 0.04 ||
    next.eyes.leftCenterY < next.face.foreheadY || next.eyes.rightCenterY < next.face.foreheadY ||
    next.eyes.leftCenterY > next.face.chinY || next.eyes.rightCenterY > next.face.chinY ||
    next.mouth.centerX < next.face.visibleLeft - 0.04 || next.mouth.centerX > next.face.visibleRight + 0.04 ||
    next.mouth.centerY <= Math.max(next.eyes.leftCenterY, next.eyes.rightCenterY) || next.mouth.centerY > next.face.chinY;
  if (faceCoordinateConflict) {
    issues.push({ field: "face_landmarks", code: "coordinate_space_conflict", action: "degraded" });
    next.confidence.eyes = Math.min(next.confidence.eyes, 0.49);
    next.confidence.mouth = Math.min(next.confidence.mouth, 0.49);
  }
  if (next.faceWindow.visibleFaceWidthAtEyes < 0.18 || next.faceWindow.visibleFaceWidthAtCheeks < 0.18 || next.faceWindow.visibleFaceWidthAtEyes > 0.96 || next.faceWindow.visibleFaceWidthAtCheeks > 0.98) {
    issues.push({ field: "faceWindow.width", code: "outside_visible_region", action: "degraded" });
    next.faceWindow.leftEvidence = "unknown";
    next.faceWindow.rightEvidence = "unknown";
    next.faceWindow.leftConfidence = Math.min(next.faceWindow.leftConfidence, 0.34);
    next.faceWindow.rightConfidence = Math.min(next.faceWindow.rightConfidence, 0.34);
    next.faceWindow.confidence = Math.min(next.faceWindow.confidence, 0.34);
  }
  const expectedFaceWidthAtEyes = next.faceShape.upperWidth * next.face.widthWithinHead;
  const expectedFaceWidthAtCheeks = next.faceShape.cheekWidth * next.face.widthWithinHead;
  if (Math.abs(next.faceWindow.visibleFaceWidthAtEyes - expectedFaceWidthAtEyes) > 0.35 || Math.abs(next.faceWindow.visibleFaceWidthAtCheeks - expectedFaceWidthAtCheeks) > 0.35) {
    issues.push({ field: "faceWindow.faceShape", code: "cross_field_conflict", action: "degraded" });
    if (next.faceWindow.confidence < next.faceShape.confidence) {
      if (next.faceWindow.leftEvidence !== "unknown") next.faceWindow.leftEvidence = "inferred";
      if (next.faceWindow.rightEvidence !== "unknown") next.faceWindow.rightEvidence = "inferred";
      next.faceWindow.leftConfidence = Math.min(next.faceWindow.leftConfidence, 0.49);
      next.faceWindow.rightConfidence = Math.min(next.faceWindow.rightConfidence, 0.49);
      next.faceWindow.confidence = Math.min(next.faceWindow.confidence, 0.49);
    } else {
      next.faceShape.evidence = "inferred";
      next.faceShape.confidence = Math.min(next.faceShape.confidence, 0.49);
    }
  }
  const expectedLeftEyeToHair = Math.max(0, next.eyes.leftCenterX - next.face.visibleLeft) * next.face.widthWithinHead;
  const expectedRightEyeToHair = Math.max(0, next.face.visibleRight - next.eyes.rightCenterX) * next.face.widthWithinHead;
  if (Math.abs(next.faceWindow.leftEyeToHairDistance - expectedLeftEyeToHair) > 0.35) {
    issues.push({ field: "faceWindow.leftEyeToHairDistance", code: "cross_field_conflict", action: "degraded" });
    if (next.faceWindow.leftEvidence !== "unknown") next.faceWindow.leftEvidence = "inferred";
    next.faceWindow.leftConfidence = Math.min(next.faceWindow.leftConfidence, 0.49);
  }
  if (Math.abs(next.faceWindow.rightEyeToHairDistance - expectedRightEyeToHair) > 0.35) {
    issues.push({ field: "faceWindow.rightEyeToHairDistance", code: "cross_field_conflict", action: "degraded" });
    if (next.faceWindow.rightEvidence !== "unknown") next.faceWindow.rightEvidence = "inferred";
    next.faceWindow.rightConfidence = Math.min(next.faceWindow.rightConfidence, 0.49);
  }

  const contourValid = next.headSilhouette.leftContourByRow.every((left, row) => left < next.headSilhouette.rightContourByRow[row]);
  if (!contourValid) {
    issues.push({ field: "headSilhouette", code: "outside_visible_region", action: "degraded" });
    next.headSilhouette.confidence = Math.min(next.headSilhouette.confidence, 0.49);
    next.confidence.headSilhouette = Math.min(next.confidence.headSilhouette, 0.49);
  }
  const crownValues = [next.crown.leftY, next.crown.centerY, next.crown.rightY];
  crownValues.forEach((value, index) => {
    if (Math.abs(value - next.headSilhouette.crownTopY) <= 0.28) return;
    const side = (["left", "center", "right"] as const)[index];
    issues.push({ field: `crown.${side}`, code: "cross_field_conflict", action: "degraded" });
    next.crown[`${side}Evidence`] = "inferred";
    next.crown[`${side}Confidence`] = Math.min(next.crown[`${side}Confidence`], 0.49);
  });
  if (Math.abs(next.temple.leftRecession - next.faceWindow.leftTempleWidth) > 0.55) {
    issues.push({ field: "temple.left", code: "cross_field_conflict", action: "degraded" });
    next.temple.leftEvidence = "inferred"; next.temple.leftConfidence = Math.min(next.temple.leftConfidence, 0.49);
  }
  if (Math.abs(next.temple.rightRecession - next.faceWindow.rightTempleWidth) > 0.55) {
    issues.push({ field: "temple.right", code: "cross_field_conflict", action: "degraded" });
    next.temple.rightEvidence = "inferred"; next.temple.rightConfidence = Math.min(next.temple.rightConfidence, 0.49);
  }

  next.fringe.peaks = next.fringe.peaks.filter((peak) => {
    const column = Math.max(0, Math.min(7, Math.floor(peak.x * 8)));
    const outsideFrontBoundary = peak.depthY > Math.max(0.18, next.hairline.depthByColumn[column] + 0.22);
    if (!outsideFrontBoundary) return true;
    issues.push({ field: `fringe.peaks.${column}`, code: "outside_visible_region", action: "removed" });
    return false;
  });
  const seenRegions = new Set<HairVolumeRegion>();
  next.majorVolumePeaks = next.majorVolumePeaks.filter((peak) => {
    const sideConflict = peak.region.endsWith("left") ? leftConflict : rightConflict;
    const occluded = peak.region.endsWith("left") ? visibility.leftHairOccluded : visibility.rightHairOccluded;
    const visibilityAdjusted = normalizeEvidenceConfidence(issues, `majorVolumePeaks.${peak.region}`, peak.evidence, peak.confidence, sideConflict || (peak.region.startsWith("crown") && crownConflict) ? "clipping" : occluded ? "occlusion" : null);
    Object.assign(peak, visibilityAdjusted);
    const extentOutside = peak.verticalCenter - peak.verticalExtent / 2 < 0 || peak.verticalCenter + peak.verticalExtent / 2 > 1;
    const regionOutside = peak.region.startsWith("crown") ? peak.verticalCenter > 0.5 : peak.region.startsWith("lower") ? peak.verticalCenter < 0.42 : peak.verticalCenter > 0.88;
    const endpoint = peak.region.endsWith("left") ? next.headSilhouette.hairEndpointLeftY : next.headSilhouette.hairEndpointRightY;
    const beyondEndpoint = peak.verticalCenter > endpoint + 0.12;
    if (seenRegions.has(peak.region) || extentOutside || regionOutside || beyondEndpoint) {
      issues.push({ field: `majorVolumePeaks.${peak.region}`, code: "outside_visible_region", action: "removed" });
      return false;
    }
    const sideVolume = peak.region.endsWith("left") ? next.headSilhouette.sideVolumeLeft : next.headSilhouette.sideVolumeRight;
    if (Math.abs(peak.protrusion - sideVolume) > 0.55) {
      issues.push({ field: `majorVolumePeaks.${peak.region}`, code: "cross_field_conflict", action: "degraded" });
      peak.evidence = "inferred";
      peak.confidence = Math.min(peak.confidence, 0.49);
    }
    seenRegions.add(peak.region);
    return true;
  });
  if (next.headSilhouette.covering) {
    for (const side of ["left", "center", "right"] as const) {
      if (next.crown[`${side}Evidence`] !== "observed") continue;
      issues.push({ field: `crown.${side}`, code: "occlusion_evidence_conflict", action: "degraded" });
      next.crown[`${side}Evidence`] = "unknown";
      next.crown[`${side}Confidence`] = Math.min(next.crown[`${side}Confidence`], 0.34);
    }
    next.majorVolumePeaks = next.majorVolumePeaks.filter((peak) => {
      if (!peak.region.startsWith("crown")) return true;
      issues.push({ field: `majorVolumePeaks.${peak.region}`, code: "occlusion_evidence_conflict", action: "removed" });
      return false;
    });
  }

  const finalCrownParts = (["left", "center", "right"] as const).map((side) => ({
    evidence: next.crown[`${side}Evidence`],
    confidence: next.crown[`${side}Confidence`],
  }));
  next.crown.evidence = crownEvidenceOrder[Math.min(...finalCrownParts.map((part) => crownEvidenceOrder.indexOf(part.evidence)))] ?? "unknown";
  next.crown.confidence = Math.min(next.crown.confidence, ...finalCrownParts.map((part) => part.confidence));
  next.faceWindow.confidence = Math.min(next.faceWindow.confidence, Math.max(next.faceWindow.leftConfidence, next.faceWindow.rightConfidence));

  const isObserved = (evidence: GeometryEvidence, confidence: number) => evidence === "observed" && confidence >= 0.55;
  const crownObserved = (["left", "center", "right"] as const).filter((side) => isObserved(next.crown[`${side}Evidence`], next.crown[`${side}Confidence`])).length;
  const observedVolume = next.majorVolumePeaks.filter((peak) => isObserved(peak.evidence, peak.confidence)).length;
  const completeness: GeometryCompleteness = {
    fringeObserved: isObserved(next.fringe.evidence, next.fringe.confidence),
    leftTempleObserved: isObserved(next.temple.leftEvidence, next.temple.leftConfidence),
    rightTempleObserved: isObserved(next.temple.rightEvidence, next.temple.rightConfidence),
    crownObservedFraction: crownObserved / 3,
    volumePeakObservedFraction: next.majorVolumePeaks.length === 0 ? 0 : observedVolume / next.majorVolumePeaks.length,
    faceWindowObservedFraction: (Number(isObserved(next.faceWindow.leftEvidence, next.faceWindow.leftConfidence)) + Number(isObserved(next.faceWindow.rightEvidence, next.faceWindow.rightConfidence))) / 2,
  };
  const derived = new Set(derivedFields);
  const provenance: Record<string, GeometryDecisionProvenance> = {
    fringe: evidenceProvenance(next.fringe.evidence, derived.has("fringe")),
    "temple.left": evidenceProvenance(next.temple.leftEvidence, derived.has("temple")),
    "temple.right": evidenceProvenance(next.temple.rightEvidence, derived.has("temple")),
    "crown.left": evidenceProvenance(next.crown.leftEvidence, derived.has("crown")),
    "crown.center": evidenceProvenance(next.crown.centerEvidence, derived.has("crown")),
    "crown.right": evidenceProvenance(next.crown.rightEvidence, derived.has("crown")),
    "faceWindow.left": evidenceProvenance(next.faceWindow.leftEvidence, derived.has("faceWindow")),
    "faceWindow.right": evidenceProvenance(next.faceWindow.rightEvidence, derived.has("faceWindow")),
  };
  for (const peak of next.majorVolumePeaks) provenance[`majorVolumePeaks.${peak.region}`] = evidenceProvenance(peak.evidence, derived.has("majorVolumePeaks"));
  next.diagnostics = {
    issues,
    completeness,
    directMeasurements: ["face", "eyes", "brows", "nose", "mouth", "hairline", "headSilhouette", "fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "glasses"].filter((field) => !derived.has(field)),
    derivedMeasurements: [...derived],
    provenance,
  };
  return next;
}

function aggregateEvidence(values: unknown[]): GeometryEvidence | null {
  const parsed = values.map(geometryEvidence);
  if (parsed.some((value) => value === null)) return null;
  if (parsed.includes("unknown")) return "unknown";
  if (parsed.includes("inferred")) return "inferred";
  return "observed";
}

function fixedRecords(value: unknown, length: number): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const values = value.map(record);
  return values.every((item): item is Record<string, unknown> => item !== null) ? values : null;
}

function fixedValues(value: unknown, length: number): unknown[] | null {
  return Array.isArray(value) && value.length === length ? value : null;
}

/**
 * Expands the small Interactions transport grammar into the established wire
 * contract. This stage performs field renaming and fixed-order array mapping;
 * the existing wire normalizer remains the single owner of deterministic
 * relations, crop metadata, and semantic validation inputs.
 */
export function normalizeIdentityGeometryCompactResponse(
  raw: Record<string, unknown>,
  crop?: GeometryCropVisibility,
): Record<string, unknown> | null {
  const face = record(raw.face);
  const eyes = record(raw.eyes);
  const brows = record(raw.brows);
  const nose = record(raw.nose);
  const mouth = record(raw.mouth);
  const hairline = record(raw.hairline);
  const fringe = record(raw.fringe);
  const crown = record(raw.crown);
  const occlusion = record(raw.occlusion);
  const head = record(raw.headSilhouette);
  const glasses = record(raw.glasses);
  const eyeSides = fixedRecords(eyes?.sides, 2);
  const browSides = fixedValues(brows?.yBySide, 2);
  const mouthCorners = fixedValues(mouth?.cornerYBySide, 2);
  const hairlineOpenings = fixedValues(hairline?.openingBySide, 2);
  const temples = fixedRecords(raw.temples, 2);
  const crownSides = fixedRecords(crown?.sides, 3);
  const sideVolume = fixedValues(head?.sideVolumeBySide, 2);
  const endpointY = fixedValues(head?.endpointYBySide, 2);
  const earExposure = fixedValues(head?.earExposureBySide, 2);
  const leftBox = fixedValues(glasses?.leftBox, 4);
  const rightBox = fixedValues(glasses?.rightBox, 4);
  if (!face || !eyes || !brows || !nose || !mouth || !hairline || !fringe || !crown || !occlusion || !head || !glasses ||
      !eyeSides || !browSides || !mouthCorners || !hairlineOpenings || !temples || !crownSides ||
      !sideVolume || !endpointY || !earExposure || !leftBox || !rightBox ||
      !booleanValue(fringe.openingVisible) || !booleanValue(head.partVisible) ||
      !booleanValue(head.coveringVisible) || !booleanValue(glasses.visible)) return null;

  const peaks = Array.isArray(fringe.peaks)
    ? fringe.peaks.map((value) => {
      const peak = record(value);
      return peak ? { x: peak.x, depthY: peak.y, prominence: peak.prominence } : null;
    })
    : null;
  if (!peaks || peaks.some((peak) => peak === null)) return null;

  const volumePeaks = Array.isArray(raw.majorVolumePeaks)
    ? raw.majorVolumePeaks.map((value) => {
      const peak = record(value);
      return peak ? {
        region: peak.region,
        protrusion: peak.protrusion,
        verticalCenter: peak.y,
        verticalExtent: peak.extent,
        evidence: peak.evidence,
        confidence: peak.confidence,
      } : null;
    })
    : null;
  if (!volumePeaks || volumePeaks.some((peak) => peak === null)) return null;

  const expanded: Record<string, unknown> = {
    face: {
      visibleLeft: face.visibleLeft,
      visibleRight: face.visibleRight,
      foreheadY: face.foreheadY,
      chinY: face.chinY,
      widthWithinHead: face.widthWithinHead,
    },
    eyes: {
      leftCenterX: eyeSides[0].x,
      leftCenterY: eyeSides[0].y,
      leftWidth: eyeSides[0].width,
      rightCenterX: eyeSides[1].x,
      rightCenterY: eyeSides[1].y,
      rightWidth: eyeSides[1].width,
      openness: eyes.openness,
    },
    brows: { leftY: browSides[0], rightY: browSides[1], thickness: brows.thickness },
    nose: { centerX: nose.x, contrastY: nose.y, visibleStrength: nose.strength },
    mouth: {
      centerX: mouth.x,
      centerY: mouth.y,
      width: mouth.width,
      leftCornerY: mouthCorners[0],
      rightCornerY: mouthCorners[1],
      opening: mouth.opening,
    },
    hairline: {
      depthByColumn: hairline.depthByColumn,
      foreheadOpeningLeft: hairlineOpenings[0],
      foreheadOpeningRight: hairlineOpenings[1],
    },
    fringe: {
      visible: fringe.visible,
      peaks,
      direction: fringe.direction,
      openingCenterX: fringe.openingVisible ? fringe.openingX : null,
      openingWidth: fringe.openingVisible ? fringe.openingWidth : null,
      evidence: fringe.evidence,
      confidence: fringe.confidence,
    },
    temple: {
      leftRecession: temples[0].value,
      rightRecession: temples[1].value,
      leftStartY: temples[0].y,
      rightStartY: temples[1].y,
      leftEvidence: temples[0].evidence,
      rightEvidence: temples[1].evidence,
      leftConfidence: temples[0].confidence,
      rightConfidence: temples[1].confidence,
    },
    crown: {
      leftY: crownSides[0].value,
      centerY: crownSides[1].value,
      rightY: crownSides[2].value,
      leftWidth: crownSides[0].y,
      rightWidth: crownSides[2].y,
      apexX: crown.apexX,
      leftEvidence: crownSides[0].evidence,
      centerEvidence: crownSides[1].evidence,
      rightEvidence: crownSides[2].evidence,
      leftConfidence: crownSides[0].confidence,
      centerConfidence: crownSides[1].confidence,
      rightConfidence: crownSides[2].confidence,
    },
    majorVolumePeaks: volumePeaks,
    occlusion,
    headSilhouette: {
      crownTopY: head.crownTopY,
      leftContourByRow: head.leftContourByRow,
      rightContourByRow: head.rightContourByRow,
      sideVolumeLeft: sideVolume[0],
      sideVolumeRight: sideVolume[1],
      partCenterX: head.partVisible ? head.partX : null,
      hairEndpointLeftY: endpointY[0],
      hairEndpointRightY: endpointY[1],
      foreheadExposure: head.foreheadExposure,
      earExposureLeft: earExposure[0],
      earExposureRight: earExposure[1],
      covering: head.coveringVisible ? {
        leftContourByRow: head.coveringLeftContourByRow,
        rightContourByRow: head.coveringRightContourByRow,
      } : null,
      confidence: head.confidence,
    },
    glasses: glasses.visible ? {
      leftBox: { left: leftBox[0], top: leftBox[1], right: leftBox[2], bottom: leftBox[3] },
      rightBox: { left: rightBox[0], top: rightBox[1], right: rightBox[2], bottom: rightBox[3] },
      bridgeCenterX: glasses.bridgeX,
      bridgeY: glasses.bridgeY,
      thickness: glasses.thickness,
    } : null,
    confidence: {
      faceBounds: face.confidence,
      eyes: eyes.confidence,
      brows: brows.confidence,
      nose: nose.confidence,
      mouth: mouth.confidence,
      hairline: hairline.confidence,
      headSilhouette: head.confidence,
      glasses: glasses.confidence,
    },
  };
  return normalizeIdentityGeometryWireResponse(expanded, crop);
}

/**
 * Expands the compact provider response into the stable internal contract.
 * Only source-visible values remain provider-owned; coordinate and clipping
 * metadata plus landmark relationships are assigned deterministically.
 */
export function normalizeIdentityGeometryWireResponse(
  raw: Record<string, unknown>,
  crop?: GeometryCropVisibility,
): Record<string, unknown> | null {
  const eyes = record(raw.eyes);
  const brows = record(raw.brows);
  const nose = record(raw.nose);
  const hairline = record(raw.hairline);
  const fringe = record(raw.fringe);
  const temple = record(raw.temple);
  const crown = record(raw.crown);
  const occlusion = record(raw.occlusion);
  const occlusionKeys = ["crown", "leftHair", "rightHair", "chin", "leftEar", "rightEar"] as const;
  if (!eyes || !brows || !nose || !hairline || !fringe || !temple || !crown || !occlusion || !occlusionKeys.every((key) => booleanValue(occlusion[key]))) return null;
  const crownEvidence = aggregateEvidence([crown.leftEvidence, crown.centerEvidence, crown.rightEvidence]);
  const sideConfidence = [crown.leftConfidence, crown.centerConfidence, crown.rightConfidence];
  if (!crownEvidence || !sideConfidence.every((value) => numberIn(value))) return null;
  const leftTempleConfidence = temple.leftConfidence;
  const rightTempleConfidence = temple.rightConfidence;
  if (!numberIn(leftTempleConfidence) || !numberIn(rightTempleConfidence)) return null;
  const normalized = structuredClone(raw);
  delete normalized.occlusion;
  normalized.coordinateSpaces = { faceMeasurements: "tight_face_crop", headMeasurements: "wide_head_crop" };
  normalized.eyes = {
    ...eyes,
    interEyeDistance: typeof eyes.leftCenterX === "number" && typeof eyes.rightCenterX === "number" ? eyes.rightCenterX - eyes.leftCenterX : Number.NaN,
    verticalAsymmetry: typeof eyes.leftCenterY === "number" && typeof eyes.rightCenterY === "number" ? eyes.leftCenterY - eyes.rightCenterY : Number.NaN,
  };
  normalized.brows = {
    ...brows,
    tilt: typeof brows.leftY === "number" && typeof brows.rightY === "number" ? brows.rightY - brows.leftY : Number.NaN,
  };
  normalized.nose = {
    ...nose,
    leftRightBias: typeof nose.centerX === "number" ? Math.max(-1, Math.min(1, (nose.centerX - 0.5) * 2)) : Number.NaN,
  };
  normalized.hairline = {
    ...hairline,
    asymmetry: typeof hairline.foreheadOpeningLeft === "number" && typeof hairline.foreheadOpeningRight === "number"
      ? hairline.foreheadOpeningLeft - hairline.foreheadOpeningRight
      : Number.NaN,
  };
  normalized.fringe = {
    ...fringe,
    leftTempleTransitionY: temple.leftStartY,
    rightTempleTransitionY: temple.rightStartY,
  };
  normalized.temple = {
    ...temple,
    asymmetry: typeof temple.leftRecession === "number" && typeof temple.rightRecession === "number" ? temple.leftRecession - temple.rightRecession : Number.NaN,
    confidence: Math.max(leftTempleConfidence, rightTempleConfidence),
  };
  normalized.crown = {
    ...crown,
    asymmetry: typeof crown.leftWidth === "number" && typeof crown.rightWidth === "number" ? crown.leftWidth - crown.rightWidth : Number.NaN,
    evidence: crownEvidence,
    confidence: Math.min(...sideConfidence as number[]),
  };
  const cropKnown = crop?.cropClippingKnown ?? false;
  const sourceKnown = crop?.sourceClippingKnown ?? false;
  normalized.visibility = {
    cropClippingKnown: cropKnown,
    sourceClippingKnown: sourceKnown,
    crownClipped: crop?.crownClipped ?? false,
    leftHairClipped: crop?.leftHairClipped ?? false,
    rightHairClipped: crop?.rightHairClipped ?? false,
    chinClipped: crop?.chinClipped ?? false,
    leftEarClipped: crop?.leftEarClipped ?? false,
    rightEarClipped: crop?.rightEarClipped ?? false,
    sourceCrownClipped: crop?.sourceCrownClipped ?? false,
    sourceLeftHairClipped: crop?.sourceLeftHairClipped ?? false,
    sourceRightHairClipped: crop?.sourceRightHairClipped ?? false,
    sourceChinClipped: crop?.sourceChinClipped ?? false,
    crownOccluded: occlusion.crown,
    leftHairOccluded: occlusion.leftHair,
    rightHairOccluded: occlusion.rightHair,
    chinOccluded: occlusion.chin,
    leftEarOccluded: occlusion.leftEar,
    rightEarOccluded: occlusion.rightEar,
  };
  return normalized;
}

export function parseIdentityGeometry(raw: Record<string, unknown>): IdentityGeometryAnalysis | null {
  const coordinateSpaces = record(raw.coordinateSpaces);
  if (coordinateSpaces && (
    coordinateSpaces.faceMeasurements !== "tight_face_crop" ||
    coordinateSpaces.headMeasurements !== "wide_head_crop"
  )) return null;
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
  const derivedMeasurements = ["fringe", "temple", "crown", "majorVolumePeaks", "faceWindow", "faceShape", "visibility"]
    .filter((field) => raw[field] === undefined);
  const parsed: IdentityGeometryAnalysis = {
    coordinateSpaces: { faceMeasurements: "tight_face_crop", headMeasurements: "wide_head_crop" },
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
    diagnostics: {
      issues: [], completeness: EMPTY_COMPLETENESS,
      directMeasurements: [], derivedMeasurements,
      provenance: {},
    },
  };
  return validateIdentityGeometry(parsed, derivedMeasurements);
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
  const visibility: GeometryVisibility = {
    ...geometry.visibility,
    ...crop,
    cropClippingKnown: crop.cropClippingKnown ?? true,
    sourceClippingKnown: crop.sourceClippingKnown ?? geometry.visibility.sourceClippingKnown,
  };
  const cropLeftClipped = visibility.cropClippingKnown && (visibility.leftHairClipped || visibility.leftEarClipped);
  const cropRightClipped = visibility.cropClippingKnown && (visibility.rightHairClipped || visibility.rightEarClipped);
  const cropCrownClipped = visibility.cropClippingKnown && visibility.crownClipped;
  const sourceLeftClipped = visibility.sourceClippingKnown && visibility.sourceLeftHairClipped;
  const sourceRightClipped = visibility.sourceClippingKnown && visibility.sourceRightHairClipped;
  const sourceCrownClipped = visibility.sourceClippingKnown && visibility.sourceCrownClipped;
  const chinClipped = (visibility.cropClippingKnown && visibility.chinClipped) || (visibility.sourceClippingKnown && visibility.sourceChinClipped);
  const leftOccluded = cropLeftClipped || sourceLeftClipped;
  const rightOccluded = cropRightClipped || sourceRightClipped;
  const anyHairClipped = cropCrownClipped || cropLeftClipped || cropRightClipped || sourceCrownClipped || sourceLeftClipped || sourceRightClipped;
  const lowerEvidence = (evidence: GeometryEvidence, clipped: boolean): GeometryEvidence => clipped
    ? evidence === "unknown" ? "unknown" : "inferred"
    : evidence;
  const adjusted: IdentityGeometryAnalysis = {
    ...geometry,
    fringe: geometry.fringe,
    temple: {
      ...geometry.temple,
      leftEvidence: lowerEvidence(geometry.temple.leftEvidence, leftOccluded),
      rightEvidence: lowerEvidence(geometry.temple.rightEvidence, rightOccluded),
      confidence: geometry.temple.confidence,
    },
    crown: { ...geometry.crown, evidence: lowerEvidence(geometry.crown.evidence, cropCrownClipped || sourceCrownClipped), confidence: cropCrownClipped || sourceCrownClipped ? Math.min(0.45, geometry.crown.confidence) : geometry.crown.confidence },
    majorVolumePeaks: geometry.majorVolumePeaks.map((peak) => {
      const clipped = peak.region.startsWith("crown")
        ? cropCrownClipped || sourceCrownClipped || (peak.region.endsWith("left") ? leftOccluded : rightOccluded)
        : peak.region.endsWith("left") ? leftOccluded : rightOccluded;
      return { ...peak, evidence: lowerEvidence(peak.evidence, clipped), confidence: clipped ? Math.min(0.45, peak.confidence) : peak.confidence };
    }),
    faceWindow: {
      ...geometry.faceWindow,
      leftEvidence: lowerEvidence(geometry.faceWindow.leftEvidence, leftOccluded),
      rightEvidence: lowerEvidence(geometry.faceWindow.rightEvidence, rightOccluded),
      confidence: geometry.faceWindow.confidence,
    },
    faceShape: { ...geometry.faceShape, evidence: lowerEvidence(geometry.faceShape.evidence, chinClipped), confidence: chinClipped ? Math.min(0.45, geometry.faceShape.confidence) : geometry.faceShape.confidence },
    headSilhouette: { ...geometry.headSilhouette, confidence: anyHairClipped ? Math.min(0.5, geometry.headSilhouette.confidence) : geometry.headSilhouette.confidence },
    confidence: {
      ...geometry.confidence,
      hairline: geometry.confidence.hairline,
      headSilhouette: anyHairClipped ? Math.min(0.5, geometry.confidence.headSilhouette) : geometry.confidence.headSilhouette,
      faceBounds: chinClipped ? Math.min(0.5, geometry.confidence.faceBounds) : geometry.confidence.faceBounds,
    },
    visibility,
  };
  return validateIdentityGeometry(adjusted, geometry.diagnostics.derivedMeasurements);
}

export async function runIdentityGeometryAnalysis(
  env: Env,
  faceCropDataUrl: string,
  headCropDataUrl: string,
  analysis: Pick<PhotoAnalysis, "canonicalIdentity">,
  cropVisibility?: GeometryCropVisibility,
): Promise<IdentityGeometryCallResult> {
  // Identity geometry is exactly one measurement stage and one provider call.
  // A fallback-model loop would silently turn an invalid response into a retry
  // and make call accounting data-dependent.
  const model = env.VISION_MODEL?.trim() || "gemini-3.6-flash";
  const p5 = analysis.canonicalIdentity.features.filter((feature) => feature.priority === 5).map((feature) => feature.feature).join("; ") || "none labelled";
  let requestShape: GeminiStructuredRequestShape | null = null;
  try {
    const result = await generateGeminiStructuredJson(env, {
      model,
      imageDataUrls: [faceCropDataUrl, headCropDataUrl],
      imageLabels: ["Tight face crop (facial landmark coordinate space):", "Wider head crop (hair/head coordinate space):"],
      prompt: `${IDENTITY_GEOMETRY_PROMPT}\n\nP5 identity cues to measure faithfully: ${p5}`,
      responseSchema: IDENTITY_GEOMETRY_WIRE_SCHEMA,
      maxOutputTokens: 2600,
      allowWorkersAiFallback: false,
      onRequestShape: (shape) => { requestShape = shape; },
    });
    const neuronsSpent = visionNeuronsFromUsage(result, NEURONS_VISION_DETAIL_ESTIMATE);
    const payload = extractPayload(result);
    // Older injected Workers AI fixtures already use the stable internal
    // contract. Production Gemini receives only the compact wire schema.
    const normalized = payload
      ? payload.coordinateSpaces !== undefined || payload.visibility !== undefined
        ? payload
        : normalizeIdentityGeometryWireResponse(payload, cropVisibility)
      : null;
    const geometry = normalized ? parseIdentityGeometry(normalized) : null;
    if (geometry && requestShape) return { ok: true, geometry: applyCropVisibility(geometry, cropVisibility), neuronsSpent, requestShape };
    const parseError = new Error(`${model}: invalid identity geometry response`);
    return {
      ok: false,
      quotaExceeded: false,
      detail: parseError.message,
      neuronsSpent,
      diagnostic: { stage: "identity_geometry", model, requestShape, providerError: geminiProviderErrorDiagnostic(parseError) },
    };
  } catch (error) {
    const errorShape = error instanceof GeminiApiError ? error.requestShape ?? requestShape : requestShape;
    return {
      ok: false,
      quotaExceeded: isGeminiQuotaError(error),
      detail: error instanceof Error ? error.message : String(error),
      neuronsSpent: NEURONS_VISION_DETAIL_ESTIMATE,
      diagnostic: { stage: "identity_geometry", model, requestShape: errorShape, providerError: geminiProviderErrorDiagnostic(error) },
    };
  }
}
