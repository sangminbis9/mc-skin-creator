import type { GeometryDecisionProvenance, GeometryEvidence, GeometryVisibility } from "./identityGeometry";

/** All coordinates belong to the tight face crop, never the head crop. */
export interface DirectFaceBoundary {
  left: number | null;
  right: number | null;
  y: number | null;
  evidence: GeometryEvidence;
  confidence: number;
}
export type DirectLowerFaceContour = Record<"cheek" | "jaw" | "chin", DirectFaceBoundary>;
export const DIRECT_CONTOUR_FIELDS = ["cheek", "jaw", "chin"] as const;
const boundary = {
  type: "object", additionalProperties: false,
  properties: {
    left: { type: ["number", "null"], minimum: 0, maximum: 1 },
    right: { type: ["number", "null"], minimum: 0, maximum: 1 },
    y: { type: ["number", "null"], minimum: 0, maximum: 1 },
    evidence: { type: "string", enum: ["observed", "inferred", "unknown"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  }, required: ["left", "right", "y", "evidence", "confidence"],
} as const;
export const DIRECT_LOWER_FACE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { cheek: boundary, jaw: boundary, chin: boundary },
  required: DIRECT_CONTOUR_FIELDS,
} as const;

const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function directBoundaryWidth(boundary: DirectFaceBoundary): number | undefined {
  return boundary.left !== null && boundary.right !== null ? boundary.right - boundary.left : undefined;
}
export function directBoundaryUsable(boundary: DirectFaceBoundary | undefined): boolean {
  return !!boundary && unit(boundary.left) && unit(boundary.right) && unit(boundary.y)
    && boundary.left < boundary.right && unit(boundary.confidence)
    && (boundary.evidence === "observed" ? boundary.confidence >= 0.55
      : boundary.evidence === "inferred" && boundary.confidence >= 0.75);
}
export function directBoundaryProvenance(boundary: DirectFaceBoundary): GeometryDecisionProvenance {
  return boundary.evidence === "observed" ? "observed_geometry"
    : boundary.evidence === "inferred" ? "inferred_geometry" : "semantic_fallback";
}

/**
 * Adjacent rows are independent slices of the visible face, so a square jaw
 * may be equal to or slightly wider than the cheek row. Reject only an
 * outward step whose per-side displacement is larger than the normalized
 * vertical distance between those rows. This is a 1:1 face-space contour
 * envelope derived from the measured row/boundary geometry, not a target
 * face ratio and never a clamp.
 */
export function directBoundaryExpansionPlausible(
  upper: DirectFaceBoundary,
  lower: DirectFaceBoundary,
  face: { visibleLeft: number; visibleRight: number; foreheadY: number; chinY: number },
): boolean {
  const upperWidth = directBoundaryWidth(upper);
  const lowerWidth = directBoundaryWidth(lower);
  if (upperWidth === undefined || lowerWidth === undefined || upper.y === null || lower.y === null || lowerWidth <= upperWidth) return true;
  const visibleFaceWidth = face.visibleRight - face.visibleLeft;
  const visibleFaceHeight = face.chinY - face.foreheadY;
  if (visibleFaceWidth <= 0 || visibleFaceHeight <= 0) return false;
  const outwardDisplacementPerSide = (lowerWidth - upperWidth) / (2 * visibleFaceWidth);
  const rowDisplacement = (lower.y - upper.y) / visibleFaceHeight;
  return outwardDisplacementPerSide <= rowDisplacement;
}

/** Reject contradictory numbers, never clamp or synthesize boundaries. */
export function parseDirectLowerFaceContour(raw: unknown, face: { visibleLeft: number; visibleRight: number; foreheadY: number; chinY: number }, errors?: string[]): DirectLowerFaceContour | null {
  const reject = (path: string) => { errors?.push(`geometry.directLowerFaceContour.${path}`); return null; };
  if (!object(raw) || Object.keys(raw).length !== 3) return reject("object:shape");
  const result = {} as DirectLowerFaceContour;
  for (const field of DIRECT_CONTOUR_FIELDS) {
    const b = raw[field];
    if (!object(b) || Object.keys(b).sort().join() !== "confidence,evidence,left,right,y"
      || !unit(b.confidence) || !["observed", "inferred", "unknown"].includes(String(b.evidence))) return reject(`${field}:shape`);
    if (b.evidence === "unknown") {
      if (b.left !== null || b.right !== null || b.y !== null) return reject(`${field}.boundary:unknown_requires_null`);
      if (b.confidence !== 0) return reject(`${field}.confidence:unknown_requires_zero`);
    } else if (!unit(b.left) || !unit(b.right) || !unit(b.y) || b.left >= b.right
      || b.left < face.visibleLeft || b.right > face.visibleRight || b.y < face.foreheadY || b.y > face.chinY) return reject(`${field}.boundary:outside_visible_face`);
    result[field] = { left: b.left, right: b.right, y: b.y, evidence: b.evidence, confidence: b.confidence } as DirectFaceBoundary;
  }
  for (const [upperKey, lowerKey] of [["cheek", "jaw"], ["jaw", "chin"]] as const) {
    const upper = result[upperKey], lower = result[lowerKey];
    if (upper.y === null || lower.y === null) continue;
    if (lower.y <= upper.y) return reject(`${lowerKey}.y:row_order`);
    if (!directBoundaryExpansionPlausible(upper, lower, face)) return reject(`${lowerKey}.width:implausible_cross_row_expansion`);
  }
  return result;
}

/** Crop facts override the provider's chin claim only, not visible cheek/jaw. */
export function applyDirectContourVisibility(contour: DirectLowerFaceContour, visibility: GeometryVisibility): DirectLowerFaceContour {
  if (!visibility.chinClipped && !visibility.sourceChinClipped && !visibility.chinOccluded) return contour;
  return { ...contour, chin: { left: null, right: null, y: null, evidence: "unknown", confidence: 0 } };
}
