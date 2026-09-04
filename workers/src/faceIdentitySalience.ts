import type { PhotoAnalysis } from "./analysis";

export type FaceIdentityAxis =
  | "eye_spacing"
  | "eye_width"
  | "eye_openness"
  | "eye_asymmetry"
  | "brow_position"
  | "brow_strength"
  | "mouth_width"
  | "mouth_topology"
  | "mouth_asymmetry"
  | "face_width";

export interface FaceIdentitySalienceCue {
  axis: FaceIdentityAxis;
  score: number;
  source: "geometry" | "semantic" | "geometry_and_semantic";
  evidence: string;
}

export interface FaceIdentitySaliencePlan {
  primary: FaceIdentitySalienceCue[];
  secondary: FaceIdentitySalienceCue[];
  tertiary: FaceIdentitySalienceCue[];
  pixelBudget: {
    eyes: number;
    brows: number;
    mouth: number;
    faceBoundary: number;
    nose: 0 | 1;
  };
}

const AXIS_PATTERN: Record<FaceIdentityAxis, RegExp> = {
  eye_spacing: /wide[- ]set|close[- ]set|eye spacing|inter-eye/,
  eye_width: /wide eyes?|narrow eyes?|large eyes?|small eyes?/,
  eye_openness: /open eyes?|half[- ]open|squint|crescent|eye openness/,
  eye_asymmetry: /asymmetric eyes?|one eye|uneven eyes?/,
  brow_position: /high brows?|low brows?|brow position|brow[- ]to[- ]eye/,
  brow_strength: /thick brows?|strong brows?|thin brows?|subtle brows?/,
  mouth_width: /wide mouth|broad smile|small mouth|narrow mouth/,
  mouth_topology: /smile|teeth|toothy|open mouth|closed mouth|lip/,
  mouth_asymmetry: /asymmetric (?:mouth|smile)|crooked smile|one corner/,
  face_width: /wide face|narrow face|round face|jaw|face width/,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function semanticScore(analysis: PhotoAnalysis, axis: FaceIdentityAxis): number {
  let score = 0;
  for (const feature of analysis.canonicalIdentity.features) {
    const text = `${feature.feature} ${feature.evidence}`.toLowerCase();
    if (!AXIS_PATTERN[axis].test(text)) continue;
    const confidence = feature.confidence === "high" ? 1 : feature.confidence === "medium" ? 0.72 : 0.42;
    score = Math.max(score, (feature.priority / 5) * confidence);
  }
  return score;
}

/**
 * Ranks only source-supported facial differences. Geometry extremeness is
 * measured against the middle of the small 8x8 vocabulary; semantic P5 cues
 * can raise, but never fabricate, a geometry cue.
 */
export function buildFaceIdentitySaliencePlan(analysis: PhotoAnalysis): FaceIdentitySaliencePlan {
  const geometry = analysis.identityGeometry;
  const faceWidth = geometry ? Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft) : 1;
  const faceHeight = geometry ? Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY) : 1;
  const geometryScores: Record<FaceIdentityAxis, number> = geometry ? {
    eye_spacing: clamp01(Math.abs((geometry.eyes.interEyeDistance / faceWidth) * 7 - 3) / 1.6) * geometry.confidence.eyes,
    eye_width: clamp01(Math.max(Math.abs((geometry.eyes.leftWidth / faceWidth) * 8 - 1.5), Math.abs((geometry.eyes.rightWidth / faceWidth) * 8 - 1.5)) / 1.2) * geometry.confidence.eyes,
    eye_openness: clamp01(Math.abs(geometry.eyes.openness - 0.52) / 0.38) * geometry.confidence.eyes,
    eye_asymmetry: clamp01(Math.max(Math.abs(geometry.eyes.leftWidth - geometry.eyes.rightWidth) / faceWidth * 8, Math.abs(geometry.eyes.leftCenterY - geometry.eyes.rightCenterY) / faceHeight * 4) / 1.1) * geometry.confidence.eyes,
    brow_position: clamp01(Math.max(
      Math.abs((geometry.eyes.leftCenterY - geometry.brows.leftY) / faceHeight * 4 - 1),
      Math.abs((geometry.eyes.rightCenterY - geometry.brows.rightY) / faceHeight * 4 - 1),
    ) / 1.2) * geometry.confidence.brows,
    brow_strength: clamp01(Math.abs(geometry.brows.thickness - 0.38) / 0.42) * geometry.confidence.brows,
    mouth_width: clamp01(Math.abs((geometry.mouth.width / faceWidth) * 8 - 3.2) / 1.8) * geometry.confidence.mouth,
    mouth_topology: (geometry.mouth.opening === "closed" ? 0.2 : geometry.mouth.opening === "open" ? 0.68 : 0.82) * geometry.confidence.mouth,
    mouth_asymmetry: clamp01(Math.abs(geometry.mouth.leftCornerY - geometry.mouth.rightCornerY) / faceHeight * 8) * geometry.confidence.mouth,
    face_width: clamp01(Math.max(
      Math.abs(geometry.face.widthWithinHead - 0.7) / 0.25,
      Math.abs(geometry.faceShape.cheekWidth - geometry.faceShape.jawWidth) / 0.28,
      Math.abs(geometry.faceShape.upperWidth - geometry.faceShape.jawWidth) / 0.28,
    )) * Math.min(geometry.confidence.faceBounds, geometry.faceShape.confidence),
  } : {
    eye_spacing: 0, eye_width: 0, eye_openness: 0, eye_asymmetry: 0,
    brow_position: 0, brow_strength: 0, mouth_width: 0, mouth_topology: 0,
    mouth_asymmetry: 0, face_width: 0,
  };

  const cues = (Object.keys(geometryScores) as FaceIdentityAxis[]).map((axis) => {
    const semantic = semanticScore(analysis, axis);
    const measured = geometryScores[axis];
    const score = clamp01(Math.max(measured, semantic * (geometry ? 0.92 : 1)));
    return {
      axis,
      score,
      source: measured > 0 && semantic > 0 ? "geometry_and_semantic" as const : measured > 0 ? "geometry" as const : "semantic" as const,
      evidence: geometry
        ? `geometry=${measured.toFixed(3)} semantic=${semantic.toFixed(3)}`
        : `semantic=${semantic.toFixed(3)}`,
    };
  }).sort((first, second) => second.score - first.score || first.axis.localeCompare(second.axis));

  const eyeWidthPixels = geometry
    ? Math.round(((geometry.eyes.leftWidth + geometry.eyes.rightWidth) / faceWidth) * 8)
    : analysis.renderHints.eyeSize === "large" ? 6 : analysis.renderHints.eyeSize === "small" ? 2 : 4;
  const mouthWidthPixels = geometry ? Math.round((geometry.mouth.width / faceWidth) * 8) : analysis.renderHints.mouthShape === "wide" ? 4 : 3;
  const browPixels = geometry
    ? Math.round((geometry.brows.thickness >= 0.55 ? 2 : 1) * 2)
    : analysis.fallbackFeatures.eyebrowThickness === "thick" ? 4 : 2;
  return {
    primary: cues.filter((cue) => cue.score >= 0.62).slice(0, 3),
    secondary: cues.filter((cue) => cue.score >= 0.34 && cue.score < 0.62).slice(0, 4),
    tertiary: cues.filter((cue) => cue.score < 0.34),
    pixelBudget: {
      eyes: Math.max(2, Math.min(6, eyeWidthPixels + ((geometry?.eyes.openness ?? 0) >= 0.7 ? 2 : 0))),
      brows: Math.max(0, Math.min(6, browPixels)),
      mouth: Math.max(2, Math.min(7, mouthWidthPixels + (geometry?.mouth.opening === "closed" ? 0 : 2))),
      faceBoundary: geometry && geometry.confidence.faceBounds >= 0.55
        ? Math.max(2, Math.min(4, Math.round(Math.max(
            Math.abs(geometry.face.widthWithinHead - 0.7) * 10,
            Math.abs(geometry.faceShape.cheekWidth - geometry.faceShape.jawWidth) * 10,
          ))))
        : 0,
      nose: geometry && geometry.confidence.nose >= 0.72 && geometry.nose.visibleStrength >= 0.62 ? 1 : 0,
    },
  };
}

export function faceSalienceScore(plan: FaceIdentitySaliencePlan, axis: FaceIdentityAxis): number {
  return [...plan.primary, ...plan.secondary, ...plan.tertiary].find((cue) => cue.axis === axis)?.score ?? 0;
}
