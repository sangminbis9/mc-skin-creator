/** Inactive, audit-only fixed-section contract. No provider execution or remote registration. */
import { FACE_GEOMETRY_MODEL } from "../../src/faceIdentityGeometry";
import type { CompactV3Schema } from "../../src/compactPhotoAnalysisV3";

export const EYE_APERTURE_V2_VERSION = "eye_aperture_midpoint_section_v2" as const;
export type CropDimensions = { widthPx: number; heightPx: number };
export type Corner = { x: number | null; y: number | null };
export type PixelPoint = { x: number; y: number };
export type ApertureV2Eye = {
  visibility: "observed" | "occluded" | "blink" | "unknown";
  outerCorner: Corner; innerCorner: Corner;
  upperLidOffsetPx: number | null; lowerLidOffsetPx: number | null; confidence: number;
};
export type EyeApertureV2Observation = {
  version: typeof EYE_APERTURE_V2_VERSION;
  cropWidthPx: number; cropHeightPx: number;
  pose: "frontal" | "mild_tilt" | "unsupported";
  left: ApertureV2Eye; right: ApertureV2Eye;
};
const object = (properties: Record<string, CompactV3Schema>): CompactV3Schema =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const corner = object({ x: { type: ["number", "null"], minimum: 0, maximum: 1 },
  y: { type: ["number", "null"], minimum: 0, maximum: 1 } });
const eye = object({
  visibility: { type: "string", enum: ["observed", "occluded", "blink", "unknown"] },
  outerCorner: corner, innerCorner: corner,
  upperLidOffsetPx: { type: ["number", "null"] },
  lowerLidOffsetPx: { type: ["number", "null"] },
  confidence: { type: "number", minimum: 0, maximum: 1 },
});
export const EYE_APERTURE_V2_SCHEMA: CompactV3Schema = object({
  version: { type: "string", enum: [EYE_APERTURE_V2_VERSION] },
  cropWidthPx: { type: "number", minimum: 1 }, cropHeightPx: { type: "number", minimum: 1 },
  pose: { type: "string", enum: ["frontal", "mild_tilt", "unsupported"] }, left: eye, right: eye,
});

export const EYE_APERTURE_V2_PROMPT = `Audit-only midpoint-section eye aperture, version eye_aperture_midpoint_section_v2. One tight face crop. Use viewer-left and viewer-right eyes, not anatomical sides. A is outerCorner and B is innerCorner: viewer-left outer.x < inner.x, viewer-right outer.x > inner.x, and left.inner.x < right.inner.x when both are present. Corners use independently normalized coordinates in [0,1], origin top-left, image y increasing downward. Convert x by the supplied crop width W and y by height H, not W-1/H-1. Copy the supplied crop dimensions exactly; they are positive integer caller metadata. In pixels D=B-A, chordWidth=length(D)>0, e=D/chordWidth, M=(A+B)/2, n=sign(D.x)*(-e.y,e.x); n is fixed toward positive image-y. Vertical or unordered corner chords are invalid. The section is exactly the normal line through M. Locate the actual unique visible upper and lower eyelid intersections on this section, not independent central points, iris centers or maximum opening. Report upperLidOffsetPx and lowerLidOffsetPx as signed pixel offsets dU,dL from M along n. U=M+dU*n and L=M+dL*n must lie within the continuous image rectangle [0,W] x [0,H]. Offsets are pixels, not normalized coordinates or subjective openness scores; values exceeding one pixel are allowed. Both offsets may have the same sign or one may be zero. Require finite positive gap dL-dU and finite positive gap/chordWidth. Never force straddling, flip n based on the lids, swap upper/lower, use absolute gap, clamp points, project off-section landmarks, or infer offsets from eye width or a desired category. Use pose frontal, mild_tilt, or unsupported and per-eye visibility observed, occluded, blink, or unknown. Observed requires complete visible corners/intersections and finite confidence >0 and <=1. Hidden corners, occlusion, blink, downcast or indeterminate boundaries, ambiguous intersections, uncertainty or unsupported pose must not be guessed: use occluded/blink/unknown, both corner objects with x=null and y=null, both offsets null, confidence=0 for the affected eye. Unsupported pose requires both eyes unavailable. One observed eye is allowed; do not fabricate the other eye. Preserve measured asymmetry. Return only the exact versioned JSON schema, with finite numbers and no extra fields.`;

function validDimensions(d: CropDimensions): boolean {
  return !!d && Number.isSafeInteger(d.widthPx) && d.widthPx > 0
    && Number.isSafeInteger(d.heightPx) && d.heightPx > 0;
}
/** Caller supplies dimensions verified from input, not from model output. Pure: does not send anything. */
export function buildEyeApertureV2Request(imageDataUrl: string, dimensions: CropDimensions) {
  if (!validDimensions(dimensions)) throw new Error("eyeApertureV2.crop:invalid_caller_dimensions");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl))
    throw new Error("eyeApertureV2.input:invalid_png_data_url");
  return { version: EYE_APERTURE_V2_VERSION, model: FACE_GEOMETRY_MODEL,
    prompt: `${EYE_APERTURE_V2_PROMPT}\nCrop dimensions: ${dimensions.widthPx} x ${dimensions.heightPx} pixels.`,
    responseSchema: structuredClone(EYE_APERTURE_V2_SCHEMA), imageDataUrls: [imageDataUrl], imageCount: 1 as const,
    cropWidthPx: dimensions.widthPx, cropHeightPx: dimensions.heightPx };
}

function shapeErrors(schema: CompactV3Schema, raw: unknown, path: string): string[] {
  const type = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
  if (!(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(type)) return [`${path}:type`];
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(raw)) errors.push(`${path}:enum`);
  if (typeof raw === "number" && (!Number.isFinite(raw) || raw < (schema.minimum ?? -Infinity)
    || raw > (schema.maximum ?? Infinity))) errors.push(`${path}:range`);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key}:required`);
    for (const [key, value] of Object.entries(obj)) {
      if (schema.properties?.[key]) errors.push(...shapeErrors(schema.properties[key], value, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}:additional`);
    }
  }
  return errors;
}
export const eyeApertureV2ShapeErrors = (raw: unknown) => shapeErrors(EYE_APERTURE_V2_SCHEMA, raw, "eyeApertureV2");
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const completeCorner = (p: Corner): p is PixelPoint => finite(p.x) && finite(p.y);
const nullCorner = (p: Corner) => p.x === null && p.y === null;
export type FixedSection = {
  outerPx: PixelPoint; innerPx: PixelPoint; midpointPx: PixelPoint; normal: PixelPoint;
  upperPx: PixelPoint; lowerPx: PixelPoint; chordWidthPx: number; gapPx: number; ratio: number;
  baselineRelation: "straddling" | "upper_on_chord" | "lower_on_chord" | "both_positive" | "both_negative";
};
type GeometryResult = { ok: true; measurement: FixedSection } | { ok: false; reason: string };
/** Geometry only, not evidence/state acceptance. No sorting, tolerance, projection or correction. */
export function reconstructEyeApertureV2(
  corners: { outerCorner: Corner; innerCorner: Corner }, upperLidOffsetPx: number | null,
  lowerLidOffsetPx: number | null, dimensions: CropDimensions, side: "left" | "right",
): GeometryResult {
  if (!validDimensions(dimensions)) return { ok: false, reason: "invalid_caller_dimensions" };
  if (!completeCorner(corners.outerCorner) || !completeCorner(corners.innerCorner)
    || !finite(upperLidOffsetPx) || !finite(lowerLidOffsetPx)) return { ok: false, reason: "incomplete_or_nonfinite" };
  if (![corners.outerCorner, corners.innerCorner].every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1))
    return { ok: false, reason: "corner_range" };
  const px = (p: PixelPoint) => ({ x: p.x * dimensions.widthPx, y: p.y * dimensions.heightPx });
  const a = px(corners.outerCorner), b = px(corners.innerCorner);
  const dx = b.x - a.x, dy = b.y - a.y, width = Math.hypot(dx, dy);
  if (!finite(width) || width <= 0) return { ok: false, reason: "invalid_chord_width" };
  if (side === "left" ? dx <= 0 : dx >= 0) return { ok: false, reason: "corner_order" };
  const sign = dx > 0 ? 1 : -1;
  const n = { x: -sign * dy / width, y: sign * dx / width };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const onLine = (d: number) => ({ x: m.x + d * n.x, y: m.y + d * n.y });
  const u = onLine(upperLidOffsetPx), l = onLine(lowerLidOffsetPx);
  if (![u, l].every(p => finite(p.x) && finite(p.y) && p.x >= 0 && p.x <= dimensions.widthPx
    && p.y >= 0 && p.y <= dimensions.heightPx)) return { ok: false, reason: "lid_outside_image" };
  const gap = lowerLidOffsetPx - upperLidOffsetPx;
  if (!finite(gap) || gap <= 0) return { ok: false, reason: "nonpositive_or_nonfinite_gap" };
  const ratio = gap / width;
  if (!finite(ratio) || ratio <= 0) return { ok: false, reason: "invalid_ratio" };
  const baselineRelation = upperLidOffsetPx === 0 ? "upper_on_chord" : lowerLidOffsetPx === 0 ? "lower_on_chord"
    : upperLidOffsetPx < 0 && lowerLidOffsetPx > 0 ? "straddling"
      : upperLidOffsetPx > 0 ? "both_positive" : "both_negative";
  return { ok: true, measurement: { outerPx: a, innerPx: b, midpointPx: m, normal: n,
    upperPx: u, lowerPx: l, chordWidthPx: width, gapPx: gap, ratio, baselineRelation } };
}
export type AcceptedV2Eye = ApertureV2Eye & { measurementAvailable: boolean; measurement: FixedSection | null };
export type AcceptedEyeApertureV2 = {
  contractVersion: typeof EYE_APERTURE_V2_VERSION; providerOrigin: false; executionMode: "offline_synthetic";
  cropWidthPx: number; cropHeightPx: number; pose: EyeApertureV2Observation["pose"];
  semanticContractValid: true; measurementAvailable: boolean; binocularMeasurementAvailable: boolean;
  left: AcceptedV2Eye; right: AcceptedV2Eye; meanRatio: number | null;
};
type Validation = { ok: false; semanticContractValid: false; stage: "caller" | "shape" | "semantic"; errors: string[] }
  | { ok: true; semanticContractValid: true; errors: []; accepted: AcceptedEyeApertureV2 };

/** Caller metadata -> shape -> dimensions -> existing corner order -> state -> geometry. */
export function validateEyeApertureV2(raw: unknown, dimensions: CropDimensions): Validation {
  const fail = (stage: "caller" | "shape" | "semantic", errors: string[]): Validation =>
    ({ ok: false, semanticContractValid: false, stage, errors });
  if (!validDimensions(dimensions)) return fail("caller", ["eyeApertureV2.crop:invalid_caller_dimensions"]);
  const structural = eyeApertureV2ShapeErrors(raw);
  if (structural.length) return fail("shape", structural);
  const value = raw as EyeApertureV2Observation;
  if (value.cropWidthPx !== dimensions.widthPx || value.cropHeightPx !== dimensions.heightPx)
    return fail("semantic", ["eyeApertureV2.crop:request_mismatch"]);
  const errors: string[] = [];
  // Retain v1's corner-check order; this change does not refactor state-error ordering.
  if (value.left.outerCorner.x !== null && value.left.innerCorner.x !== null
    && value.left.outerCorner.x >= value.left.innerCorner.x) errors.push("eyeApertureV2.left:corner_order");
  if (value.right.outerCorner.x !== null && value.right.innerCorner.x !== null
    && value.right.outerCorner.x <= value.right.innerCorner.x) errors.push("eyeApertureV2.right:corner_order");
  if (value.left.innerCorner.x !== null && value.right.innerCorner.x !== null
    && value.left.innerCorner.x >= value.right.innerCorner.x) errors.push("eyeApertureV2:viewer_left_right_order");
  const measurements: Record<"left" | "right", FixedSection | null> = { left: null, right: null };
  for (const side of ["left", "right"] as const) {
    const e = value[side];
    if (e.visibility !== "observed" || value.pose === "unsupported") {
      if (e.visibility === "observed" || !nullCorner(e.outerCorner) || !nullCorner(e.innerCorner)
        || e.upperLidOffsetPx !== null || e.lowerLidOffsetPx !== null || e.confidence !== 0)
        errors.push(`eyeApertureV2.${side}:unknown_requires_null_and_zero_confidence`);
      continue;
    }
    if (!completeCorner(e.outerCorner) || !completeCorner(e.innerCorner)
      || e.upperLidOffsetPx === null || e.lowerLidOffsetPx === null || e.confidence <= 0) {
      errors.push(`eyeApertureV2.${side}:observed_requires_landmarks`); continue;
    }
    const geometry = reconstructEyeApertureV2(e, e.upperLidOffsetPx, e.lowerLidOffsetPx, dimensions, side);
    if (!geometry.ok) errors.push(`eyeApertureV2.${side}:${geometry.reason}`);
    else measurements[side] = geometry.measurement;
  }
  if (errors.length) return fail("semantic", errors);
  const acceptedEye = (side: "left" | "right"): AcceptedV2Eye => {
    const e = value[side];
    return { visibility: e.visibility, outerCorner: { x: e.outerCorner.x, y: e.outerCorner.y },
      innerCorner: { x: e.innerCorner.x, y: e.innerCorner.y }, upperLidOffsetPx: e.upperLidOffsetPx,
      lowerLidOffsetPx: e.lowerLidOffsetPx, confidence: e.confidence,
      measurementAvailable: measurements[side] !== null, measurement: measurements[side] };
  };
  return { ok: true, semanticContractValid: true, errors: [], accepted: {
    contractVersion: EYE_APERTURE_V2_VERSION, providerOrigin: false, executionMode: "offline_synthetic",
    cropWidthPx: dimensions.widthPx, cropHeightPx: dimensions.heightPx, pose: value.pose,
    semanticContractValid: true, measurementAvailable: !!(measurements.left || measurements.right),
    binocularMeasurementAvailable: !!(measurements.left && measurements.right),
    left: acceptedEye("left"), right: acceptedEye("right"),
    meanRatio: measurements.left && measurements.right
      ? measurements.left.ratio + (measurements.right.ratio - measurements.left.ratio) / 2 : null,
  } };
}
/** Allowlisted synthetic projection only; invalid input yields paths, never rejected coordinates/prose. */
export function projectAcceptedEyeApertureV2(raw: unknown, dimensions: CropDimensions) {
  const validation = validateEyeApertureV2(raw, dimensions);
  return validation.ok ? { ok: true as const, result: validation.accepted }
    : { ok: false as const, stage: validation.stage, errors: [...validation.errors] };
}
