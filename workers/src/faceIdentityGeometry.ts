import { extractAnalysisPayload, type PhotoAnalysis } from "./analysis";
import type { CompactV3Schema } from "./compactPhotoAnalysisV3";
import { DIRECT_LOWER_FACE_SCHEMA, DIRECT_CONTOUR_FIELDS, directBoundaryExpansionPlausible, parseDirectLowerFaceContour, type DirectLowerFaceContour } from "./directFaceContour";
import { generateWorkersAiStructuredJson, geminiProviderErrorDiagnostic, type GeminiStructuredRequest } from "./gemini";
import type { IdentityGeometryAnalysis } from "./identityGeometry";
import { NEURONS_VISION_DETAIL_ESTIMATE, visionNeuronsFromUsage } from "./quota";
import type { Env } from "./types";

/** Server-internal, single-crop measurements. No head/hair placeholders. */
export interface FaceIdentityGeometryAnalysis {
  source: "tight_face_crop";
  face: { envelopeLeft: number; envelopeRight: number; foreheadY: number; chinY: number };
  eyes: IdentityGeometryAnalysis["eyes"];
  brows: IdentityGeometryAnalysis["brows"];
  nose: IdentityGeometryAnalysis["nose"];
  mouth: IdentityGeometryAnalysis["mouth"];
  confidence: Pick<IdentityGeometryAnalysis["confidence"], "faceBounds" | "eyes" | "brows" | "nose" | "mouth">;
  directLowerFaceContour: DirectLowerFaceContour;
}

/** Shared face grammar input, deliberately not a full IdentityGeometryAnalysis. */
export type ResolvedFaceGeometry = Pick<FaceIdentityGeometryAnalysis, "eyes" | "brows" | "nose" | "mouth">
  & { confidence: FaceIdentityGeometryAnalysis["confidence"] & { glasses?: number }; glasses?: IdentityGeometryAnalysis["glasses"];
    face: Pick<IdentityGeometryAnalysis["face"], "visibleLeft" | "visibleRight" | "foreheadY" | "chinY">; directLowerFaceContour?: DirectLowerFaceContour };

export function resolveFaceGeometry(analysis: PhotoAnalysis): ResolvedFaceGeometry | null {
  const g = analysis.faceIdentityGeometry;
  if (!g) return analysis.identityGeometry ?? null;
  return { eyes: g.eyes, brows: g.brows, nose: g.nose, mouth: g.mouth, confidence: g.confidence,
    face: { visibleLeft: g.face.envelopeLeft, visibleRight: g.face.envelopeRight, foreheadY: g.face.foreheadY, chinY: g.face.chinY },
    directLowerFaceContour: g.directLowerFaceContour };
}

const unit = { type: "number", minimum: 0, maximum: 1 } as const;
const object = (properties: Record<string, CompactV3Schema>): CompactV3Schema => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
export const FACE_IDENTITY_GEOMETRY_SCHEMA = object({
  face: object({ envelopeLeft: unit, envelopeRight: unit, foreheadY: unit, chinY: unit }),
  eyes: object({ leftCenterX: unit, leftCenterY: unit, rightCenterX: unit, rightCenterY: unit, leftWidth: unit, rightWidth: unit, openness: unit }),
  brows: object({ leftY: unit, rightY: unit, thickness: unit, tilt: { type: "number", minimum: -1, maximum: 1 } }),
  nose: object({ centerX: unit, contrastY: unit, visibleStrength: unit }),
  mouth: object({ centerX: unit, centerY: unit, width: unit, leftCornerY: unit, rightCornerY: unit, opening: { type: "string", enum: ["closed", "open", "teeth"] } }),
  confidence: object({ faceBounds: unit, eyes: unit, brows: unit, nose: unit, mouth: unit }),
  directLowerFaceContour: DIRECT_LOWER_FACE_SCHEMA,
});
export const FACE_IDENTITY_GEOMETRY_PROMPT = `This request contains exactly one image: the tight face crop.
Measure only visible facial identity geometry. All coordinates use this crop: left=0, right=1, top=0, bottom=1. Left/right always mean viewer-left/right. Return the exact JSON schema, no prose.
face: envelopeLeft/envelopeRight are the maximum visible facial skin envelope over the whole face, not a width at eye level. These are a horizontal scale reference. foreheadY is the upper visible forehead and chinY the bottom visible chin, with foreheadY < chinY. Do not measure hair or head silhouette.
eyes: measure viewer-left/right centers and each visible eye width, openness 0=narrow/closed to 1=fully open. Left center is left of right center. brows: Y at each brow center, thickness 0=subtle to 1=thick; tilt -1=angled down, 0=straight, +1=arched. nose: centerX and contrastY locate the visible nose contrast; visibleStrength 0=not visibly distinct to 1=strong. Never invent a strong nose. mouth: visible center, width, both corner Y positions, opening closed/open/teeth.
confidence: separate 0..1 certainty for faceBounds/eyes/brows/nose/mouth; do not treat hidden landmarks as confident observations. Confident brows are above eyes, eyes above the nose contrast, mouth below eyes and above chin.
directLowerFaceContour: independent paired visible skin boundaries. cheek is the visible lower-mid-face side boundaries at its specified Y; jaw is visible mandibular side boundaries at a lower Y; chin is visible chin-side boundaries near the bottom, below jaw. Each gives left/right/y/evidence/confidence; code derives width=right-left. Do not output widths or a target ratio. Do not use faceShape labels, reconstruct hidden sides, clamp, repair or symmetrize. Jaw may be slightly wider than cheek if the observed outline supports it; abrupt outward jumps across nearby rows are implausible.
For evidence=unknown, left=null, right=null, y=null and confidence=0 exactly. Clipped or occluded chin is unknown independently of usable cheek/jaw. Inferred means a locally visible but uncertain edge, never an invented hidden edge. Observed means directly visible evidence. Preserve actual asymmetry. No hair, crown, fringe, temple, ears or covering geometry.`;
export const FACE_GEOMETRY_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const FACE_GEOMETRY_TIMEOUT_MS = 25_000;
export function faceIdentityGeometryRequest(faceCrop: string): GeminiStructuredRequest {
  return { model: FACE_GEOMETRY_MODEL, imageDataUrls: [faceCrop], prompt: FACE_IDENTITY_GEOMETRY_PROMPT,
    responseSchema: FACE_IDENTITY_GEOMETRY_SCHEMA, maxOutputTokens: 4096, timeoutCapMs: FACE_GEOMETRY_TIMEOUT_MS, allowWorkersAiFallback: false };
}

/** Paths only; values never enter errors/logs. */
export function validateFaceGeometryProviderShape(raw: unknown): string[] {
  const errors: string[] = [];
  function visit(s: CompactV3Schema, value: unknown, path: string) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!(Array.isArray(s.type) ? s.type : [s.type]).includes(kind)) { errors.push(`${path}:type`); return; }
    if (s.enum && !s.enum.includes(value)) errors.push(`${path}:enum`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity))) errors.push(`${path}:range`);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}:required`);
      for (const [k, v] of Object.entries(obj)) {
        if (s.properties?.[k]) visit(s.properties[k], v, `${path}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${path}:additionalProperty`);
      }
    }
  }
  visit(FACE_IDENTITY_GEOMETRY_SCHEMA, raw, "faceGeometry");
  return errors;
}
type FaceWire = Omit<FaceIdentityGeometryAnalysis, "source" | "eyes" | "nose"> & {
  eyes: Omit<FaceIdentityGeometryAnalysis["eyes"], "interEyeDistance" | "verticalAsymmetry">;
  nose: Omit<FaceIdentityGeometryAnalysis["nose"], "leftRightBias">;
};
/** Numeric/canonical-enum summary only, including semantically rejected rows. */
function measurementSummary(raw: unknown) {
  if (validateFaceGeometryProviderShape(raw).length) return null;
  const v = raw as FaceWire;
  const widths = Object.fromEntries(Object.entries(v.directLowerFaceContour).map(([key, b]) => [key, b.left === null || b.right === null ? null : b.right - b.left]));
  return {
    eyes: { ...v.eyes, confidence: v.confidence.eyes },
    brows: { leftGap: v.eyes.leftCenterY - v.brows.leftY, rightGap: v.eyes.rightCenterY - v.brows.rightY, slope: v.brows.tilt, confidence: v.confidence.brows },
    nose: { x: v.nose.centerX, y: v.nose.contrastY, strength: v.nose.visibleStrength, confidence: v.confidence.nose },
    mouth: { x: v.mouth.centerX, y: v.mouth.centerY, width: v.mouth.width, leftCornerY: v.mouth.leftCornerY, rightCornerY: v.mouth.rightCornerY, opening: v.mouth.opening, confidence: v.confidence.mouth },
    contour: v.directLowerFaceContour, widths,
    jawCheekRatio: widths.cheek && widths.jaw ? widths.jaw / widths.cheek : null,
    chinJawRatio: widths.jaw && widths.chin ? widths.chin / widths.jaw : null,
  };
}
export function parseFaceIdentityGeometry(raw: unknown, errors: string[] = []): FaceIdentityGeometryAnalysis | null {
  const shapeErrors = validateFaceGeometryProviderShape(raw);
  errors.push(...shapeErrors);
  if (shapeErrors.length) return null;
  const v = raw as FaceWire;
  const { face: f, eyes: e, brows: b, nose: n, mouth: m, confidence: c } = v;
  if (f.envelopeLeft >= f.envelopeRight || f.foreheadY >= f.chinY) errors.push("faceGeometry.face:reference_order");
  if (e.leftCenterX >= e.rightCenterX || e.leftWidth <= 0 || e.rightWidth <= 0) errors.push("faceGeometry.eyes:order_or_width");
  const eyeY = (e.leftCenterY + e.rightCenterY) / 2;
  if (c.eyes >= 0.55 && (Math.min(e.leftCenterY, e.rightCenterY) <= f.foreheadY || Math.max(e.leftCenterY, e.rightCenterY) >= f.chinY)) errors.push("faceGeometry.eyes:vertical_reference");
  if (c.brows >= 0.55 && c.eyes >= 0.55 && (b.leftY >= e.leftCenterY || b.rightY >= e.rightCenterY)) errors.push("faceGeometry.brows:above_eyes");
  if (c.nose >= 0.72 && c.eyes >= 0.55 && (n.contrastY <= eyeY || n.contrastY >= f.chinY)) errors.push("faceGeometry.nose:vertical_order");
  if (m.width <= 0 || (c.mouth >= 0.55 && (Math.min(m.centerY, m.leftCornerY, m.rightCornerY) <= eyeY || Math.max(m.centerY, m.leftCornerY, m.rightCornerY) >= f.chinY))) errors.push("faceGeometry.mouth:order_or_width");
  // Crop bounds (0..1), never the provider's horizontal scale reference, are
  // the contour container. The audited slope rule runs in normalized crop space.
  const contour = parseDirectLowerFaceContour(v.directLowerFaceContour, { visibleLeft: 0, visibleRight: 1, foreheadY: 0, chinY: 1 }, errors);
  // Unknown intermediate rows do not erase ordering of the remaining evidence.
  const known = contour && DIRECT_CONTOUR_FIELDS.map(key => ({ key, boundary: contour[key] })).filter(row => row.boundary.y !== null);
  if (known) for (let i = 1; i < known.length; i++) {
    const upper = known[i - 1].boundary, lower = known[i].boundary;
    if (lower.y! <= upper.y!) errors.push(`faceGeometry.directLowerFaceContour.${known[i].key}:row_order`);
    else if (!directBoundaryExpansionPlausible(upper, lower, { visibleLeft: 0, visibleRight: 1, foreheadY: 0, chinY: 1 })) errors.push(`faceGeometry.directLowerFaceContour.${known[i].key}:cross_row_expansion`);
  }
  if (!contour || errors.length) return null;
  return { source: "tight_face_crop", face: { ...f }, eyes: { ...e, interEyeDistance: e.rightCenterX - e.leftCenterX, verticalAsymmetry: e.rightCenterY - e.leftCenterY },
    brows: { ...b }, nose: { ...n, leftRightBias: n.centerX - (f.envelopeLeft + f.envelopeRight) / 2 }, mouth: { ...m }, confidence: { ...c }, directLowerFaceContour: contour };
}

export async function runFaceIdentityGeometryAnalysis(env: Env, faceCrop: string) {
  const started = Date.now();
  let neuronsSpent = NEURONS_VISION_DETAIL_ESTIMATE;
  try {
    const result = await generateWorkersAiStructuredJson({ ...env, WORKERS_VISION_MODEL: FACE_GEOMETRY_MODEL }, faceIdentityGeometryRequest(faceCrop));
    neuronsSpent = visionNeuronsFromUsage(result, neuronsSpent);
    const raw = extractAnalysisPayload(result);
    const providerErrors = validateFaceGeometryProviderShape(raw);
    const errors: string[] = [];
    const geometry = providerErrors.length ? null : parseFaceIdentityGeometry(raw, errors);
    return { ok: !!geometry, geometry, measurements: measurementSummary(raw), providerShapeValid: providerErrors.length === 0, errors: [...providerErrors, ...errors], elapsedMs: Date.now() - started, neuronsSpent,
      httpStatus: null as number | null, providerStatus: "binding_success" as string | null };
  } catch (error) {
    const d = geminiProviderErrorDiagnostic(error);
    return { ok: false, geometry: null, measurements: null, providerShapeValid: false, errors: ["faceGeometry:provider_failure"], elapsedMs: Date.now() - started, neuronsSpent, httpStatus: d.httpStatus, providerStatus: d.providerStatus };
  }
}
