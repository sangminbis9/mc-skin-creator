/** Offline-only v1 experiment. Nothing in production imports or dispatches this contract. */
import { FACE_GEOMETRY_MODEL } from "../../src/faceIdentityGeometry";
import type { CompactV3Schema } from "../../src/compactPhotoAnalysisV3";

export const EYE_APERTURE_CONTRACT_VERSION = "eye_aperture_landmarks_v1" as const;
const unit: CompactV3Schema = { type: "number", minimum: 0, maximum: 1 };
const nullableUnit: CompactV3Schema = { type: ["number", "null"], minimum: 0, maximum: 1 };
const object = (properties: Record<string, CompactV3Schema>): CompactV3Schema =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const point = object({ x: nullableUnit, y: nullableUnit });
const eye = object({
  visibility: { type: "string", enum: ["observed", "occluded", "blink", "unknown"] },
  outerCorner: point, innerCorner: point, upperLid: point, lowerLid: point,
  confidence: unit,
});

export const EYE_APERTURE_SCHEMA: CompactV3Schema = object({
  version: { type: "string", enum: [EYE_APERTURE_CONTRACT_VERSION] },
  cropWidthPx: { type: "number", minimum: 1 },
  cropHeightPx: { type: "number", minimum: 1 },
  pose: { type: "string", enum: ["frontal", "mild_tilt", "unsupported"] },
  left: eye, right: eye,
});

export const EYE_APERTURE_PROMPT = `Audit-only eye-aperture landmarks, version eye_aperture_landmarks_v1. One tight face crop. Use viewer-left and viewer-right eyes, not the subject's anatomical sides. Coordinates are normalized independently: x/pixel-width and y/pixel-height, origin at top-left. Report visible outer and inner eye corners, plus upper and lower eyelid boundary points at the same central position along each eye's corner-to-corner chord. These are actual visible boundary landmarks, not a subjective 0..1 openness score. Do not derive eyelid coordinates from eye width or from a desired openness category. Use frontal, mild_tilt, or unsupported pose. Blink, downcast/indeterminate lid boundary, occlusion, or unsupported pose must not be guessed: mark the affected eye blink/occluded/unknown and set all four points to null and confidence to 0. If both boundaries cannot be located, use unknown. Preserve measured asymmetry. Return only the exact JSON schema.`;

export function buildEyeAperturePrototypeRequest(imageDataUrl: string, widthPx: number, heightPx: number) {
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx <= 0 || heightPx <= 0)
    throw new Error("eyeAperture:invalid_crop_dimensions");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl))
    throw new Error("eyeAperture:invalid_png_data_url");
  return { version: EYE_APERTURE_CONTRACT_VERSION, model: FACE_GEOMETRY_MODEL,
    prompt: `${EYE_APERTURE_PROMPT}\nCrop dimensions: ${widthPx} x ${heightPx} pixels.`,
    responseSchema: EYE_APERTURE_SCHEMA, imageDataUrls: [imageDataUrl],
    imageCount: 1 as const, cropWidthPx: widthPx, cropHeightPx: heightPx };
}

type Point = { x: number | null; y: number | null };
type Eye = { visibility: "observed" | "occluded" | "blink" | "unknown";
  outerCorner: Point; innerCorner: Point; upperLid: Point; lowerLid: Point; confidence: number };
export type EyeApertureObservation = { version: typeof EYE_APERTURE_CONTRACT_VERSION;
  cropWidthPx: number; cropHeightPx: number; pose: "frontal" | "mild_tilt" | "unsupported";
  left: Eye; right: Eye };
export type EyeApertureDerived = { left: number | null; right: number | null; mean: number | null };

function structuralErrors(schema: CompactV3Schema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(type)) return [`${path}:type`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`);
  if (typeof value === "number" && (!Number.isFinite(value)
    || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) errors.push(`${path}:range`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key}:required`);
    for (const [key, child] of Object.entries(obj)) {
      if (schema.properties?.[key]) errors.push(...structuralErrors(schema.properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}:additional`);
    }
  }
  return errors;
}

const pointIsNull = (point: Point) => point.x === null && point.y === null;
const pointIsComplete = (point: Point) => point.x !== null && point.y !== null;

/** Structural and geometric validation is separate from the pure derived ratio. */
export function validateEyeApertureObservation(raw: unknown, expected?: { widthPx: number; heightPx: number }) {
  const errors = structuralErrors(EYE_APERTURE_SCHEMA, raw, "eyeAperture");
  if (errors.length) return { ok: false as const, errors };
  const value = raw as EyeApertureObservation;
  if (!Number.isSafeInteger(value.cropWidthPx) || !Number.isSafeInteger(value.cropHeightPx)) errors.push("eyeAperture.crop:integer_dimensions");
  if (expected && (value.cropWidthPx !== expected.widthPx || value.cropHeightPx !== expected.heightPx)) errors.push("eyeAperture.crop:request_mismatch");
  if (value.left.outerCorner.x !== null && value.left.innerCorner.x !== null
    && value.left.outerCorner.x >= value.left.innerCorner.x) errors.push("eyeAperture.left:corner_order");
  if (value.right.outerCorner.x !== null && value.right.innerCorner.x !== null
    && value.right.outerCorner.x <= value.right.innerCorner.x) errors.push("eyeAperture.right:corner_order");
  if (value.left.innerCorner.x !== null && value.right.innerCorner.x !== null
    && value.left.innerCorner.x >= value.right.innerCorner.x) errors.push("eyeAperture:viewer_left_right_order");
  for (const side of ["left", "right"] as const) {
    const e = value[side];
    const points = [e.outerCorner, e.innerCorner, e.upperLid, e.lowerLid];
    if (e.visibility !== "observed" || value.pose === "unsupported") {
      if (e.visibility === "observed" || !points.every(pointIsNull) || e.confidence !== 0)
        errors.push(`eyeAperture.${side}:unknown_requires_null_and_zero_confidence`);
      continue;
    }
    if (!points.every(pointIsComplete) || e.confidence <= 0) {
      errors.push(`eyeAperture.${side}:observed_requires_landmarks`); continue;
    }
    if (eyeRatio(value, e) === null) errors.push(`eyeAperture.${side}:invalid_chord_or_lid_geometry`);
  }
  return errors.length ? { ok: false as const, errors } : { ok: true as const, value, errors: [] as string[] };
}

function eyeRatio(observation: EyeApertureObservation, eye: Eye): number | null {
  if (![eye.outerCorner, eye.innerCorner, eye.upperLid, eye.lowerLid].every(pointIsComplete)) return null;
  const { cropWidthPx: w, cropHeightPx: h } = observation;
  const px = (p: Point) => ({ x: p.x! * w, y: p.y! * h });
  const outer = px(eye.outerCorner), inner = px(eye.innerCorner);
  const upper = px(eye.upperLid), lower = px(eye.lowerLid);
  const dx = inner.x - outer.x, dy = inner.y - outer.y;
  const width = Math.hypot(dx, dy);
  if (width <= 0 || !Number.isFinite(width)) return null;
  const along = (p: typeof outer) => ((p.x - outer.x) * dx + (p.y - outer.y) * dy) / (width * width);
  const upperAt = along(upper), lowerAt = along(lower);
  if (Math.abs(upperAt - 0.5) > 0.2 || Math.abs(lowerAt - 0.5) > 0.2 || Math.abs(upperAt - lowerAt) > 0.1)
    return null;
  // Choose the chord normal with positive image-y, then project lid separation.
  const sign = dx >= 0 ? 1 : -1;
  const offset = (p: typeof outer) => sign * ((p.x - outer.x) * -dy + (p.y - outer.y) * dx) / width;
  const upperOffset = offset(upper), lowerOffset = offset(lower);
  if (upperOffset >= 0 || lowerOffset <= 0) return null;
  const aperture = lowerOffset - upperOffset;
  return aperture > 0 && Number.isFinite(aperture) ? aperture / width : null;
}

export function deriveEyeApertureRatio(value: EyeApertureObservation): EyeApertureDerived {
  if (value.pose === "unsupported") return { left: null, right: null, mean: null };
  const left = value.left.visibility === "observed" ? eyeRatio(value, value.left) : null;
  const right = value.right.visibility === "observed" ? eyeRatio(value, value.right) : null;
  return { left, right, mean: left === null || right === null ? null : (left + right) / 2 };
}
