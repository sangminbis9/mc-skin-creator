import type { PhotoAnalysis } from "./analysis";
import type { GeometryCompleteness, GeometryDecisionProvenance, IdentityGeometryAnalysis } from "./identityGeometry";
import { buildFaceIdentitySaliencePlan, faceSalienceScore, type FaceIdentitySaliencePlan } from "./faceIdentitySalience";
import { buildHairIdentitySaliencePlan, hairSalienceScore } from "./hairIdentitySalience";

export type ProtectedGeometry = "glasses" | "hairline" | "head_silhouette" | "eye_layout" | "mouth" | "face_window";
export type MouthTopology = "closed_compact" | "closed_wide" | "open_compact" | "open_wide" | "teeth_smile" | "wide_teeth_smile" | "asymmetric_smile";
export type EyeTopology = "compact_dark" | "readable_iris" | "open_iris_sclera" | "smiling_squint" | "asymmetric";
export type QuantizationAxis =
  | "eye_row"
  | "eye_pair"
  | "left_eye_x"
  | "right_eye_x"
  | "mouth_row"
  | "mouth_width"
  | "mouth_topology"
  | "smile_corner_topology"
  | "eye_openness_topology"
  | "eye_asymmetry"
  | "glasses_footprint"
  | "hairline_profile"
  | "fringe_peak_x"
  | "crown_apex";

export interface IdentityRenderContract {
  mouth?: {
    protected: boolean;
    opening: "closed" | "open" | "teeth";
    minimumPerceptualWidth: 2 | 3 | 4 | 5;
    teethReadable: boolean;
    cornerDirection: "any" | "upward_or_level" | "preserve_asymmetry";
    preserveAsymmetry: boolean;
    preferredTopology: MouthTopology;
  };
  eyes?: {
    protected: boolean;
    minimumInterEyeGap: number;
    openness: "compact" | "readable" | "open";
    preserveAsymmetry: boolean;
  };
  glasses?: {
    protected: boolean;
    bothLenses: true;
    bridge: true;
    minimumFootprint: number;
  };
  hairline?: {
    protected: boolean;
    opening: PhotoAnalysis["renderHints"]["fringeOpening"];
    minimumForeheadColumns: number;
  };
  headSilhouette?: {
    protected: boolean;
    preservePart: boolean;
    preserveEarExposure: boolean;
  };
}

export interface QuantizationAmbiguity {
  axis: QuantizationAxis;
  distanceToBoundary: number;
  identityWeight: number;
  alternateValue: number | MouthTopology | EyeTopology;
  column?: number;
  index?: number;
  alternateLeftEyeXs?: number[];
  alternateRightEyeXs?: number[];
}

export interface FaceLayoutPlan {
  salience: FaceIdentitySaliencePlan;
  eyeRow: 3 | 4 | 5;
  leftEyeRow: 3 | 4 | 5;
  rightEyeRow: 3 | 4 | 5;
  leftEyeXs: number[];
  rightEyeXs: number[];
  eyeWidth: 1 | 2 | 3;
  leftEyeWidth: 1 | 2 | 3;
  rightEyeWidth: 1 | 2 | 3;
  eyeOpenness: "compact" | "readable" | "open";
  eyeTopology: EyeTopology;
  eyeTiltOffset: -1 | 0 | 1;
  browRow: 1 | 2 | 3 | 4;
  leftBrowRow: 1 | 2 | 3 | 4;
  rightBrowRow: 1 | 2 | 3 | 4;
  browThickness: "subtle" | "strong";
  browTiltOffset: -1 | 0 | 1;
  mouthRow: 5 | 6;
  mouthWidth: 2 | 3 | 4 | 5;
  mouthCenterX: number;
  mouthCornerOffsets: [number, number];
  mouthOpening: "closed" | "open" | "teeth";
  mouthTopology: MouthTopology;
  hairlineDepth: 0 | 1 | 2 | 3;
  hairlineDepthByColumn: [number, number, number, number, number, number, number, number];
  fringeOpening: PhotoAnalysis["renderHints"]["fringeOpening"];
  fringePeaks: Array<{ column: number; row: number; prominence: number }>;
  fringeDirection: IdentityGeometryAnalysis["fringe"]["direction"];
  templeGeometry: { leftRecession: number; rightRecession: number; leftStartRow: number; rightStartRow: number };
  crownGeometry: { leftRow: number; centerRow: number; rightRow: number; leftWidth: number; rightWidth: number; apexColumn: number };
  majorVolumePeaks: Array<{ region: IdentityGeometryAnalysis["majorVolumePeaks"][number]["region"]; row: number; height: number; width: number; protrusion: number }>;
  faceWindow: { foreheadRows: number; leftTempleWidth: number; rightTempleWidth: number; visibleWidthAtEyes: 5 | 6 | 7 | 8; visibleWidthAtCheeks: 5 | 6 | 7 | 8; leftEyeToHairRows: number; rightEyeToHairRows: number; leftEarExposure: number; rightEarExposure: number };
  faceShape: { upperWidth: number; cheekWidth: number; jawWidth: number; verticalLength: number; asymmetryOffset: -1 | 0 | 1 };
  exposedFaceWidth: 5 | 6 | 7 | 8;
  noseX: number;
  noseY: number;
  noseStrength: number;
  glassesMask: Array<{ x: number; y: number }>;
  uncertainAxes: QuantizationAxis[];
  quantizationAmbiguities: QuantizationAmbiguity[];
  protectedGeometry: ProtectedGeometry[];
  renderContract: IdentityRenderContract;
  geometryTarget: {
    leftEyeCenterX: number;
    rightEyeCenterX: number;
    eyeSpacing: number;
    leftEyeWidth: number;
    rightEyeWidth: number;
    eyeRow: number;
    leftEyeRow: number;
    rightEyeRow: number;
    leftBrowRow: number;
    rightBrowRow: number;
    leftBrowEyeDistance: number;
    rightBrowEyeDistance: number;
    mouthCenterX: number;
    mouthRow: number;
    mouthWidth: number;
    visibleFaceWidthAtEyes: number;
  };
  geometryUsage: {
    faceBounds: boolean;
    eyes: boolean;
    brows: boolean;
    nose: boolean;
    mouth: boolean;
    hairline: boolean;
    glasses: boolean;
    fringePeaks: boolean;
    temple: boolean;
    crown: boolean;
    majorVolumePeaks: boolean;
    faceWindow: boolean;
    faceShape: boolean;
  };
  geometryProvenance: Record<
    | "face" | "eyes" | "brows" | "nose" | "mouth" | "hairline" | "glasses"
    | "fringe" | "temple.left" | "temple.right"
    | "crown.left" | "crown.center" | "crown.right"
    | "majorVolumePeaks" | "faceWindow.left" | "faceWindow.right" | "faceShape",
    GeometryDecisionProvenance
  >;
  geometryCompleteness: GeometryCompleteness;
}

export interface QuantizedLayoutVariant {
  id: "primary" | "geometry_alt_1" | "geometry_alt_2" | "semantic_alt_1" | "semantic_alt_2";
  layout: FaceLayoutPlan;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded<T extends number>(value: number, minimum: T, maximum: T): T {
  return clamp(Math.round(value), minimum, maximum) as T;
}

function evidenceUsable(
  evidence: IdentityGeometryAnalysis["fringe"]["evidence"],
  confidence: number,
  clipped = false,
  provenance?: GeometryDecisionProvenance,
): boolean {
  if (clipped || evidence === "unknown") return false;
  if (provenance === "derived_geometry") return confidence >= 0.5;
  return confidence >= (evidence === "observed" ? 0.55 : 0.78);
}

function boundaryAlternative(raw: number, minimum: number, maximum: number): { value: number; alternate?: number; distance: number } {
  const value = clamp(Math.round(raw), minimum, maximum);
  const floor = Math.floor(raw);
  const ceil = Math.ceil(raw);
  const alternate = value === floor ? ceil : floor;
  const distance = Math.abs(raw - (floor + 0.5));
  return { value, ...(alternate !== value && alternate >= minimum && alternate <= maximum && distance <= 0.2 ? { alternate } : {}), distance };
}

function pixelSpan(center: number, width: number, minimum: number, maximum: number): number[] {
  const start = clamp(Math.round(center - (width - 1) / 2), minimum, maximum - width + 1);
  return Array.from({ length: width }, (_, index) => start + index);
}

interface JointEyeCandidate {
  leftEyeXs: number[];
  rightEyeXs: number[];
  leftEyeWidth: 1 | 2 | 3;
  rightEyeWidth: 1 | 2 | 3;
  score: number;
}

interface JointEyeQuantization extends JointEyeCandidate {
  alternative?: JointEyeCandidate;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/**
 * Solves the two eyes as one bounded discrete system. The candidate set is the
 * complete set of contiguous spans in the visible face window (at most 36
 * pairs), not an open-ended search or random variation.
 */
export function quantizeEyesJointly(
  geometry: IdentityGeometryAnalysis,
  faceLeft: number,
  faceWidth: number,
  visibleWidthAtEyes: 5 | 6 | 7 | 8,
  salience: FaceIdentitySaliencePlan,
): JointEyeQuantization {
  const xRaw = (value: number) => ((value - faceLeft) / faceWidth) * 7;
  const sourceLeft = xRaw(geometry.eyes.leftCenterX);
  const sourceRight = xRaw(geometry.eyes.rightCenterX);
  const sourcePairCenter = (sourceLeft + sourceRight) / 2;
  const sourceSpacing = sourceRight - sourceLeft;
  const rawLeftWidth = (geometry.eyes.leftWidth / faceWidth) * 8;
  const rawRightWidth = (geometry.eyes.rightWidth / faceWidth) * 8;
  const confidentAsymmetry = geometry.confidence.eyes >= 0.75 && Math.abs(rawLeftWidth - rawRightWidth) >= 0.45;
  let leftWidth = rounded(confidentAsymmetry ? rawLeftWidth : (rawLeftWidth + rawRightWidth) / 2, 1, 3) as 1 | 2 | 3;
  let rightWidth = rounded(confidentAsymmetry ? rawRightWidth : (rawLeftWidth + rawRightWidth) / 2, 1, 3) as 1 | 2 | 3;
  if (confidentAsymmetry && leftWidth === rightWidth) {
    if (rawLeftWidth > rawRightWidth && leftWidth < 3) leftWidth = (leftWidth + 1) as 2 | 3;
    else if (rawRightWidth > rawLeftWidth && rightWidth < 3) rightWidth = (rightWidth + 1) as 2 | 3;
  }

  const faceStart = clamp(Math.floor((8 - visibleWidthAtEyes) / 2), 0, 3);
  const faceEnd = faceStart + visibleWidthAtEyes - 1;
  const glasses = geometry.glasses && geometry.confidence.glasses >= 0.55 ? geometry.glasses : null;
  const lensLeft = glasses ? rounded(xRaw((glasses.leftBox.left + glasses.leftBox.right) / 2), faceStart, faceEnd) : null;
  const lensRight = glasses ? rounded(xRaw((glasses.rightBox.left + glasses.rightBox.right) / 2), faceStart, faceEnd) : null;
  const spacingWeight = 1.2 + faceSalienceScore(salience, "eye_spacing") * 1.8;
  const widthWeight = 0.45 + faceSalienceScore(salience, "eye_width");
  const candidates: JointEyeCandidate[] = [];
  const leftWidths = [...new Set([leftWidth, Math.max(1, leftWidth - 1) as 1 | 2 | 3])];
  const rightWidths = [...new Set([rightWidth, Math.max(1, rightWidth - 1) as 1 | 2 | 3])];
  for (const candidateLeftWidth of leftWidths) for (const candidateRightWidth of rightWidths) {
    if (!confidentAsymmetry && candidateLeftWidth !== candidateRightWidth) continue;
    if (confidentAsymmetry && rawLeftWidth > rawRightWidth && candidateLeftWidth <= candidateRightWidth) continue;
    if (confidentAsymmetry && rawRightWidth > rawLeftWidth && candidateRightWidth <= candidateLeftWidth) continue;
    for (let leftStart = faceStart; leftStart <= faceEnd - candidateLeftWidth + 1; leftStart++) {
      const leftXs = Array.from({ length: candidateLeftWidth }, (_, index) => leftStart + index);
      const leftCenter = mean(leftXs);
      if (leftCenter > 3.5) continue;
      for (let rightStart = faceStart; rightStart <= faceEnd - candidateRightWidth + 1; rightStart++) {
        const rightXs = Array.from({ length: candidateRightWidth }, (_, index) => rightStart + index);
        const rightCenter = mean(rightXs);
        if (rightCenter < 3.5 || rightStart - (leftStart + candidateLeftWidth - 1) < 2) continue;
        const pairCenter = (leftCenter + rightCenter) / 2;
        const spacing = rightCenter - leftCenter;
        // Each eye span must keep the measured lens opening available. Extra
        // width may sit under the rim, but the identity-bearing iris stays clear.
        if (glasses && (!leftXs.includes(lensLeft!) || !rightXs.includes(lensRight!))) continue;
        const lensPenalty = glasses
          ? Math.abs(leftCenter - lensLeft!) * 0.55 + Math.abs(rightCenter - lensRight!) * 0.55
          : 0;
        const score =
          Math.abs(spacing - sourceSpacing) * spacingWeight +
          Math.abs(pairCenter - sourcePairCenter) * 1.4 +
          (Math.abs(leftCenter - sourceLeft) + Math.abs(rightCenter - sourceRight)) * 0.65 +
          (Math.abs(candidateLeftWidth - rawLeftWidth) + Math.abs(candidateRightWidth - rawRightWidth)) * widthWeight +
          lensPenalty;
        candidates.push({ leftEyeXs: leftXs, rightEyeXs: rightXs, leftEyeWidth: candidateLeftWidth, rightEyeWidth: candidateRightWidth, score });
      }
    }
  }
  candidates.sort((first, second) => first.score - second.score || mean(first.leftEyeXs) - mean(second.leftEyeXs) || mean(first.rightEyeXs) - mean(second.rightEyeXs));
  const primary = candidates[0] ?? {
    leftEyeXs: pixelSpan(sourceLeft, leftWidth, faceStart, Math.min(3, faceEnd)),
    rightEyeXs: pixelSpan(sourceRight, rightWidth, Math.max(4, faceStart), faceEnd),
    leftEyeWidth: leftWidth,
    rightEyeWidth: rightWidth,
    score: Number.POSITIVE_INFINITY,
  };
  const primarySpacing = mean(primary.rightEyeXs) - mean(primary.leftEyeXs);
  const alternative = candidates.find((candidate) =>
    Math.abs((mean(candidate.rightEyeXs) - mean(candidate.leftEyeXs)) - primarySpacing) >= 0.5 &&
    candidate.score <= primary.score + 1.25,
  );
  return { ...primary, ...(alternative ? { alternative } : {}) };
}

function p5ProtectedGeometry(analysis: PhotoAnalysis): ProtectedGeometry[] {
  const protectedGeometry: ProtectedGeometry[] = [];
  for (const feature of analysis.canonicalIdentity.features.filter((item) => item.priority === 5)) {
    const text = `${feature.feature} ${feature.evidence}`.toLowerCase();
    if (/glass|spectacle|frame/.test(text)) protectedGeometry.push("glasses");
    if ((feature.category === "hair" || feature.category === "silhouette" || feature.category === "accessory") && /hairline|fringe|bang|forehead|part|headscarf|hijab|hood/.test(text)) protectedGeometry.push("hairline");
    if ((feature.category === "hair" || feature.category === "silhouette" || feature.category === "accessory") && /silhouette|crown|volume|head shape|headscarf|hijab|hood/.test(text)) protectedGeometry.push("head_silhouette");
    if (feature.category === "face" && /\beye|inter-eye|eye spacing/.test(text)) protectedGeometry.push("eye_layout");
    if (feature.category === "face" && /mouth|smile|teeth|lip|grin/.test(text)) protectedGeometry.push("mouth");
    if (feature.category === "face" && /face width|wide face|narrow face|jaw/.test(text)) protectedGeometry.push("face_window");
  }
  return [...new Set(protectedGeometry)];
}

function p5Text(analysis: PhotoAnalysis): string {
  return analysis.canonicalIdentity.features
    .filter((feature) => feature.priority === 5)
    .map((feature) => `${feature.feature} ${feature.evidence}`)
    .join(" ")
    .toLowerCase();
}

function mouthTopologyFor(
  opening: FaceLayoutPlan["mouthOpening"],
  width: FaceLayoutPlan["mouthWidth"],
  cornerOffsets: FaceLayoutPlan["mouthCornerOffsets"],
  preserveAsymmetry: boolean,
): MouthTopology {
  if (preserveAsymmetry && cornerOffsets[0] !== cornerOffsets[1]) return "asymmetric_smile";
  if (opening === "closed") return width >= 4 ? "closed_wide" : "closed_compact";
  if (opening === "teeth") return width >= 4 ? "wide_teeth_smile" : "teeth_smile";
  return width >= 4 ? "open_wide" : "open_compact";
}

function eyeTopologyFor(
  openness: FaceLayoutPlan["eyeOpenness"],
  preserveAsymmetry: boolean,
  sourceP5Text: string,
): EyeTopology {
  if (preserveAsymmetry) return "asymmetric";
  if (openness === "compact" && /squint|smiling eye|crescent eye/.test(sourceP5Text)) return "smiling_squint";
  if (openness === "open") return "open_iris_sclera";
  return openness === "compact" ? "compact_dark" : "readable_iris";
}

function buildRenderContract(
  analysis: PhotoAnalysis,
  protectedGeometry: ProtectedGeometry[],
  mouthOpening: FaceLayoutPlan["mouthOpening"],
  mouthWidth: FaceLayoutPlan["mouthWidth"],
  mouthCornerOffsets: FaceLayoutPlan["mouthCornerOffsets"],
  eyeOpenness: FaceLayoutPlan["eyeOpenness"],
  leftEyeXs: number[],
  rightEyeXs: number[],
  glassesMask: Array<{ x: number; y: number }>,
  fringeOpening: FaceLayoutPlan["fringeOpening"],
): IdentityRenderContract {
  const text = p5Text(analysis);
  const mouthProtected = protectedGeometry.includes("mouth");
  const smile = /smile|grin|upturned/.test(text) || analysis.fallbackFeatures.expression === "smile";
  const asymmetricMouth = mouthCornerOffsets[0] !== mouthCornerOffsets[1] && (analysis.identityGeometry?.confidence.mouth ?? 0) >= 0.75;
  const leftInner = Math.max(...leftEyeXs);
  const rightInner = Math.min(...rightEyeXs);
  const eyeGeometry = analysis.identityGeometry?.eyes;
  const eyeAsymmetry = Boolean(eyeGeometry) && (analysis.identityGeometry?.confidence.eyes ?? 0) >= 0.75 && (
    Math.abs(eyeGeometry!.verticalAsymmetry) >= 0.16 || Math.abs(eyeGeometry!.leftWidth - eyeGeometry!.rightWidth) >= 0.04
  );
  const contract: IdentityRenderContract = {
    mouth: {
      protected: mouthProtected,
      opening: mouthOpening,
      minimumPerceptualWidth: mouthProtected && /wide|broad|large/.test(text)
        ? Math.max(4, mouthWidth) as 4 | 5
        : mouthWidth,
      teethReadable: mouthOpening === "teeth",
      cornerDirection: asymmetricMouth ? "preserve_asymmetry" : smile ? "upward_or_level" : "any",
      preserveAsymmetry: asymmetricMouth,
      preferredTopology: mouthTopologyFor(mouthOpening, mouthWidth, mouthCornerOffsets, asymmetricMouth),
    },
    eyes: {
      protected: protectedGeometry.includes("eye_layout"),
      minimumInterEyeGap: Math.max(0, rightInner - leftInner - 1),
      openness: eyeOpenness,
      preserveAsymmetry: eyeAsymmetry,
    },
  };
  if (glassesMask.length > 0) {
    contract.glasses = {
      protected: protectedGeometry.includes("glasses"),
      bothLenses: true,
      bridge: true,
      minimumFootprint: Math.max(3, Math.min(glassesMask.length, protectedGeometry.includes("glasses") ? 5 : 4)),
    };
  }
  if (analysis.renderHints.bangs !== "none" || protectedGeometry.includes("hairline")) {
    contract.hairline = {
      protected: protectedGeometry.includes("hairline"),
      opening: fringeOpening,
      minimumForeheadColumns: fringeOpening === "none" ? 0 : 1,
    };
  }
  if (analysis.identityGeometry?.headSilhouette || protectedGeometry.includes("head_silhouette")) {
    contract.headSilhouette = {
      protected: protectedGeometry.includes("head_silhouette"),
      preservePart: analysis.identityGeometry?.headSilhouette.partCenterX !== null,
      preserveEarExposure: true,
    };
  }
  return contract;
}

export function layoutSatisfiesIdentityRenderContract(layout: FaceLayoutPlan): boolean {
  const contract = layout.renderContract;
  if (contract.mouth) {
    if (layout.mouthOpening !== contract.mouth.opening || layout.mouthWidth < contract.mouth.minimumPerceptualWidth) return false;
    if (contract.mouth.teethReadable && !["teeth_smile", "wide_teeth_smile", "asymmetric_smile"].includes(layout.mouthTopology)) return false;
    if (contract.mouth.cornerDirection === "upward_or_level" && layout.mouthCornerOffsets.some((offset) => offset > 0)) return false;
    if (contract.mouth.preserveAsymmetry && layout.mouthCornerOffsets[0] === layout.mouthCornerOffsets[1]) return false;
  }
  if (contract.eyes) {
    const gap = Math.min(...layout.rightEyeXs) - Math.max(...layout.leftEyeXs) - 1;
    if (gap < contract.eyes.minimumInterEyeGap) return false;
    if (contract.eyes.preserveAsymmetry && layout.eyeTopology !== "asymmetric") return false;
  }
  if (contract.glasses) {
    const left = layout.glassesMask.some((point) => point.x <= 3);
    const right = layout.glassesMask.some((point) => point.x >= 4);
    const bridge = layout.glassesMask.some((point) => point.x === 3 || point.x === 4);
    if (!left || !right || !bridge || layout.glassesMask.length < contract.glasses.minimumFootprint) return false;
  }
  return true;
}

function smoothHairline(values: number[]): FaceLayoutPlan["hairlineDepthByColumn"] {
  const median = values.map((value, index) => {
    const window = values.slice(Math.max(0, index - 1), Math.min(values.length, index + 2)).sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)] ?? value;
  });
  for (let index = 1; index < median.length; index++) {
    median[index] = clamp(median[index], median[index - 1] - 1, median[index - 1] + 1);
  }
  for (let index = median.length - 2; index >= 0; index--) {
    median[index] = clamp(median[index], median[index + 1] - 1, median[index + 1] + 1);
  }
  return median.map((value) => rounded(value, 0, 3)) as FaceLayoutPlan["hairlineDepthByColumn"];
}

/**
 * Quantize the whole fringe profile, retaining meaningful accumulated residual
 * instead of independently rounding every source column to the same row.
 */
export function quantizeHairlineProfile(
  analysis: PhotoAnalysis,
  normalizedDepths: readonly number[],
): FaceLayoutPlan["hairlineDepthByColumn"] {
  const salience = buildHairIdentitySaliencePlan(analysis);
  const fringeScore = hairSalienceScore(salience, "fringe_shape");
  const scaled = normalizedDepths.slice(0, 8).map((value) => clamp(value, 0, 1) * 3);
  while (scaled.length < 8) scaled.push(0);
  const result: number[] = scaled.map((value) => Math.round(clamp(value, 0, 3)));
  const targetTotal = Math.round(scaled.reduce((sum, value) => sum + value, 0));
  let delta = targetTotal - result.reduce((sum, value) => sum + value, 0);
  // A one-cell global residual is below the resolution of an eight-column
  // silhouette unless a distinctive edge or side sweep makes it meaningful.
  const meaningfulResidual = Math.abs(delta) >= 2 || fringeScore >= 0.72 || analysis.renderHints.bangs === "side";
  if (meaningfulResidual && delta !== 0) {
    const sideDirection = analysis.renderHints.hairPart === "left" ? 1 : analysis.renderHints.hairPart === "right" ? -1 : 0;
    const ranked = scaled.map((value, column) => {
      const roundedValue = result[column];
      const residual = value - roundedValue;
      const previous = scaled[Math.max(0, column - 1)];
      const next = scaled[Math.min(7, column + 1)];
      const contour = Math.abs(value - previous) + Math.abs(value - next);
      const sourceSideBias = sideDirection === 0 ? 0 : (sideDirection > 0 ? column : 7 - column) * 0.025;
      return { column, priority: (delta > 0 ? residual : -residual) + contour * 0.16 + sourceSideBias };
    }).sort((first, second) => second.priority - first.priority || first.column - second.column);
    for (const { column } of ranked) {
      if (delta === 0) break;
      const step = delta > 0 ? 1 : -1;
      if (result[column] + step < 0 || result[column] + step > 3) continue;
      result[column] += step;
      delta -= step;
    }
  }
  const opening = analysis.renderHints.fringeOpening;
  const openingColumns = opening === "center" ? [3, 4] : opening === "left" ? [2] : opening === "right" ? [5] : [];
  for (const column of openingColumns) result[column] = 0;
  // Only repair impossible two-row jumps. Median filtering erased genuine
  // source peaks; a one-row step is a useful fringe silhouette at 8x8.
  for (let index = 1; index < result.length; index++) {
    result[index] = clamp(result[index], result[index - 1] - 1, result[index - 1] + 1);
  }
  for (let index = result.length - 2; index >= 0; index--) {
    result[index] = clamp(result[index], result[index + 1] - 1, result[index + 1] + 1);
  }
  for (const column of openingColumns) result[column] = 0;
  return result as FaceLayoutPlan["hairlineDepthByColumn"];
}

function glassesMaskFromGeometry(
  geometry: IdentityGeometryAnalysis,
  faceLeft: number,
  faceWidth: number,
  forehead: number,
  faceHeight: number,
): Array<{ x: number; y: number }> {
  if (!geometry.glasses) return [];
  const points = new Map<string, { x: number; y: number }>();
  const add = (x: number, y: number) => {
    const point = { x: rounded(((x - faceLeft) / faceWidth) * 7, 0, 7), y: rounded(2 + ((y - forehead) / faceHeight) * 4, 2, 6) };
    points.set(`${point.x},${point.y}`, point);
  };
  for (const box of [geometry.glasses.leftBox, geometry.glasses.rightBox]) {
    const centerY = (box.top + box.bottom) / 2;
    add(box.left, centerY);
    add(box.right, centerY);
    if (geometry.glasses.thickness >= 0.45 || box.bottom - box.top >= 0.12) {
      add(box.left, box.bottom);
      add(box.right, box.bottom);
    }
  }
  add(geometry.glasses.bridgeCenterX, geometry.glasses.bridgeY);
  return [...points.values()];
}

export function quantizeIdentityGeometry(analysis: PhotoAnalysis, geometry: IdentityGeometryAnalysis): FaceLayoutPlan {
  const fallback = deriveFallbackFaceLayout(analysis);
  const salience = buildFaceIdentitySaliencePlan(analysis);
  const faceLeft = geometry.face.visibleLeft;
  const faceWidth = Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft);
  const forehead = geometry.face.foreheadY;
  const faceHeight = Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY);
  const xRaw = (value: number) => ((value - faceLeft) / faceWidth) * 7;
  const facialYRaw = (value: number) => 2 + ((value - forehead) / faceHeight) * 4;
  const protectedGeometry = p5ProtectedGeometry(analysis);
  const ambiguities: QuantizationAmbiguity[] = [];
  const meanEyeRaw = (facialYRaw(geometry.eyes.leftCenterY) + facialYRaw(geometry.eyes.rightCenterY)) / 2;
  const eyeRowChoice = boundaryAlternative(meanEyeRaw, 3, 5);
  const eyesFromGeometry = geometry.confidence.eyes >= 0.55;
  const browsFromGeometry = geometry.confidence.brows >= 0.55;
  const mouthFromGeometry = geometry.confidence.mouth >= 0.55;
  const noseFromGeometry = geometry.confidence.nose >= 0.55;
  const hairlineFromGeometry = geometry.confidence.hairline >= 0.55;
  const faceFromGeometry = geometry.confidence.faceBounds >= 0.55;
  const glassesFromGeometry = geometry.confidence.glasses >= 0.55;
  const clippingKnown = geometry.visibility.cropClippingKnown;
  const provenance = geometry.diagnostics.provenance;
  const fringeFromGeometry = evidenceUsable(geometry.fringe.evidence, geometry.fringe.confidence, false, provenance.fringe);
  const leftTempleFromGeometry = evidenceUsable(geometry.temple.leftEvidence, geometry.temple.leftConfidence, clippingKnown && (geometry.visibility.leftHairClipped || geometry.visibility.leftEarClipped), provenance["temple.left"]);
  const rightTempleFromGeometry = evidenceUsable(geometry.temple.rightEvidence, geometry.temple.rightConfidence, clippingKnown && (geometry.visibility.rightHairClipped || geometry.visibility.rightEarClipped), provenance["temple.right"]);
  const templeFromGeometry = leftTempleFromGeometry || rightTempleFromGeometry;
  const leftCrownFromGeometry = evidenceUsable(geometry.crown.leftEvidence, geometry.crown.leftConfidence, clippingKnown && geometry.visibility.crownClipped, provenance["crown.left"]);
  const centerCrownFromGeometry = evidenceUsable(geometry.crown.centerEvidence, geometry.crown.centerConfidence, clippingKnown && geometry.visibility.crownClipped, provenance["crown.center"]);
  const rightCrownFromGeometry = evidenceUsable(geometry.crown.rightEvidence, geometry.crown.rightConfidence, clippingKnown && geometry.visibility.crownClipped, provenance["crown.right"]);
  const crownFromGeometry = leftCrownFromGeometry || centerCrownFromGeometry || rightCrownFromGeometry;
  const leftFaceWindowFromGeometry = evidenceUsable(geometry.faceWindow.leftEvidence, geometry.faceWindow.leftConfidence, clippingKnown && (geometry.visibility.leftHairClipped || geometry.visibility.leftEarClipped), provenance["faceWindow.left"]);
  const rightFaceWindowFromGeometry = evidenceUsable(geometry.faceWindow.rightEvidence, geometry.faceWindow.rightConfidence, clippingKnown && (geometry.visibility.rightHairClipped || geometry.visibility.rightEarClipped), provenance["faceWindow.right"]);
  const faceWindowFromGeometry = leftFaceWindowFromGeometry || rightFaceWindowFromGeometry;
  const completeFaceWindowFromGeometry = leftFaceWindowFromGeometry && rightFaceWindowFromGeometry;
  const visibleWidthAtEyesForEyes = completeFaceWindowFromGeometry
    ? rounded(geometry.faceWindow.visibleFaceWidthAtEyes * 8, 5, 8)
    : faceFromGeometry
      ? rounded(5 + geometry.face.widthWithinHead * 3, 5, 8)
      : fallback.faceWindow.visibleWidthAtEyes;
  const jointEyes = eyesFromGeometry
    ? quantizeEyesJointly(geometry, faceLeft, faceWidth, visibleWidthAtEyesForEyes, salience)
    : null;
  const leftEyeRawRow = facialYRaw(geometry.eyes.leftCenterY);
  const rightEyeRawRow = facialYRaw(geometry.eyes.rightCenterY);
  const preserveEyeRowAsymmetry = eyesFromGeometry && geometry.confidence.eyes >= 0.75 && Math.abs(leftEyeRawRow - rightEyeRawRow) >= 0.55;
  const leftEyeRow = preserveEyeRowAsymmetry ? rounded(leftEyeRawRow, 3, 5) : rounded(meanEyeRaw, 3, 5);
  const rightEyeRow = preserveEyeRowAsymmetry ? rounded(rightEyeRawRow, 3, 5) : rounded(meanEyeRaw, 3, 5);
  const faceShapeFromGeometry = evidenceUsable(geometry.faceShape.evidence, geometry.faceShape.confidence, clippingKnown && geometry.visibility.chinClipped);
  const volumePeaks = geometry.majorVolumePeaks.filter((peak) => evidenceUsable(
    peak.evidence,
    peak.confidence,
    clippingKnown && (
      peak.region.startsWith("crown")
        ? geometry.visibility.crownClipped || (peak.region.endsWith("left") ? geometry.visibility.leftHairClipped : geometry.visibility.rightHairClipped)
        : peak.region.endsWith("left") ? geometry.visibility.leftHairClipped : geometry.visibility.rightHairClipped
    ),
    provenance[`majorVolumePeaks.${peak.region}`],
  ));
  const majorVolumePeaksFromGeometry = volumePeaks.length > 0;
  const leftEyeWidth = jointEyes?.leftEyeWidth ?? fallback.leftEyeWidth;
  const rightEyeWidth = jointEyes?.rightEyeWidth ?? fallback.rightEyeWidth;
  const eyeWidth = rounded((leftEyeWidth + rightEyeWidth) / 2, 1, 3);
  const leftEyeXs = jointEyes?.leftEyeXs ?? fallback.leftEyeXs;
  const rightEyeXs = jointEyes?.rightEyeXs ?? fallback.rightEyeXs;
  const leftBrowRawRow = facialYRaw(geometry.brows.leftY);
  const rightBrowRawRow = facialYRaw(geometry.brows.rightY);
  let leftBrowRow: FaceLayoutPlan["leftBrowRow"] = rounded(Math.min(leftEyeRow - 1, leftBrowRawRow), 1, 4);
  let rightBrowRow: FaceLayoutPlan["rightBrowRow"] = rounded(Math.min(rightEyeRow - 1, rightBrowRawRow), 1, 4);
  const preserveBrowAsymmetry = browsFromGeometry && geometry.confidence.brows >= 0.75 && Math.abs(leftBrowRawRow - rightBrowRawRow) >= 0.55;
  if (preserveBrowAsymmetry && leftBrowRow === rightBrowRow) {
    if (leftBrowRawRow < rightBrowRawRow && leftBrowRow > 1) leftBrowRow = (leftBrowRow - 1) as FaceLayoutPlan["leftBrowRow"];
    else if (rightBrowRawRow < leftBrowRawRow && rightBrowRow > 1) rightBrowRow = (rightBrowRow - 1) as FaceLayoutPlan["rightBrowRow"];
  }
  const mouthRowChoice = boundaryAlternative(facialYRaw(geometry.mouth.centerY), 5, 6);
  const mouthWidthRaw = (geometry.mouth.width / faceWidth) * 8;
  const mouthWidthBaseChoice = boundaryAlternative(mouthWidthRaw, 2, 5);
  const mouthWidthSalience = faceSalienceScore(salience, "mouth_width");
  const mouthWidthChoice = {
    ...mouthWidthBaseChoice,
    value: mouthWidthSalience >= 0.34 && mouthWidthRaw - Math.floor(mouthWidthRaw) >= 0.32
      ? clamp(Math.ceil(mouthWidthRaw), 2, 5)
      : mouthWidthBaseChoice.value,
  };
  const hairlineRaw = geometry.hairline.depthByColumn.map((depth) => depth * 3);
  const hairlineDepthByColumn = hairlineFromGeometry ? quantizeHairlineProfile(analysis, geometry.hairline.depthByColumn) : fallback.hairlineDepthByColumn;
  const addAmbiguity = (axis: QuantizationAxis, choice: { alternate?: number; distance: number }, identityWeight: number) => {
    if (choice.alternate === undefined) return;
    ambiguities.push({ axis, alternateValue: choice.alternate, distanceToBoundary: choice.distance, identityWeight });
  };
  addAmbiguity("eye_row", eyeRowChoice, 0.9);
  if (jointEyes?.alternative) {
    ambiguities.push({
      axis: "eye_pair",
      alternateValue: 0,
      alternateLeftEyeXs: jointEyes.alternative.leftEyeXs,
      alternateRightEyeXs: jointEyes.alternative.rightEyeXs,
      distanceToBoundary: Math.min(0.2, Math.max(0, jointEyes.alternative.score - jointEyes.score) / 6),
      identityWeight: 0.92 + faceSalienceScore(salience, "eye_spacing") * 0.45,
    });
  }
  addAmbiguity("mouth_row", mouthRowChoice, 0.72);
  addAmbiguity("mouth_width", mouthWidthChoice, 0.68);
  let bestColumn = -1;
  let bestDistance = 1;
  for (let column = 0; column < hairlineRaw.length; column++) {
    const distance = Math.abs(hairlineRaw[column] - (Math.floor(hairlineRaw[column]) + 0.5));
    if (distance < bestDistance && distance <= 0.2) { bestColumn = column; bestDistance = distance; }
  }
  if (bestColumn >= 0) {
    const current = hairlineDepthByColumn[bestColumn];
    const alternateValue = clamp(hairlineRaw[bestColumn] < current ? current - 1 : current + 1, 0, 3);
    if (alternateValue !== current) ambiguities.push({ axis: "hairline_profile", column: bestColumn, alternateValue, distanceToBoundary: bestDistance, identityWeight: 1 });
  }
  const cornerOffset = (value: number) => rounded((value - geometry.mouth.centerY) / Math.max(0.015, faceHeight / 8), -1, 1);
  const depths = hairlineDepthByColumn.filter((depth) => depth > 0);
  const hairlineDepth = rounded(depths.length ? Math.max(...depths) : 0, 0, 3);
  const openingLeft = fringeFromGeometry && geometry.fringe.openingCenterX !== null && geometry.fringe.openingWidth !== null
    ? geometry.fringe.openingCenterX - geometry.fringe.openingWidth / 2
    : geometry.hairline.foreheadOpeningLeft;
  const openingRight = fringeFromGeometry && geometry.fringe.openingCenterX !== null && geometry.fringe.openingWidth !== null
    ? geometry.fringe.openingCenterX + geometry.fringe.openingWidth / 2
    : geometry.hairline.foreheadOpeningRight;
  const geometryFringeOpening = openingRight - openingLeft >= 0.12
    ? Math.abs(((openingLeft + openingRight) / 2) - 0.5) <= 0.12
      ? "center"
      : ((openingLeft + openingRight) / 2) < 0.5 ? "left" : "right"
    : "none";
  const eyeOpenness: FaceLayoutPlan["eyeOpenness"] = eyesFromGeometry
    ? geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"
    : fallback.eyeOpenness;
  const eyeTiltOffset: FaceLayoutPlan["eyeTiltOffset"] = eyesFromGeometry
    ? rounded(geometry.eyes.verticalAsymmetry * 4, -1, 1)
    : fallback.eyeTiltOffset;
  const browTiltOffset: FaceLayoutPlan["browTiltOffset"] = browsFromGeometry
    ? geometry.confidence.brows >= 0.8 && Math.abs(geometry.brows.tilt) >= 0.08
      ? (geometry.brows.tilt > 0 ? 1 : -1)
      : 0
    : fallback.browTiltOffset;
  const mouthOpening = mouthFromGeometry ? geometry.mouth.opening : fallback.mouthOpening;
  let mouthWidth = mouthFromGeometry ? mouthWidthChoice.value as FaceLayoutPlan["mouthWidth"] : fallback.mouthWidth;
  const mouthCornerOffsets: FaceLayoutPlan["mouthCornerOffsets"] = mouthFromGeometry
    ? [cornerOffset(geometry.mouth.leftCornerY), cornerOffset(geometry.mouth.rightCornerY)]
    : fallback.mouthCornerOffsets;
  const sourceP5Text = p5Text(analysis);
  const perceptuallyWideExpression =
    (protectedGeometry.includes("mouth") && /wide|broad|large/.test(sourceP5Text)) ||
    (analysis.renderHints.mouthShape === "wide" && mouthOpening === "teeth" && (geometry.mouth.width / faceWidth) * 8 >= 3);
  if (perceptuallyWideExpression) {
    mouthWidth = Math.max(4, mouthWidth) as FaceLayoutPlan["mouthWidth"];
  }
  const preserveMouthAsymmetry = mouthFromGeometry && geometry.confidence.mouth >= 0.75 && mouthCornerOffsets[0] !== mouthCornerOffsets[1];
  const mouthTopology = mouthTopologyFor(mouthOpening, mouthWidth, mouthCornerOffsets, preserveMouthAsymmetry);
  const preserveEyeAsymmetry = eyesFromGeometry && geometry.confidence.eyes >= 0.75 && (
    preserveEyeRowAsymmetry || leftEyeWidth !== rightEyeWidth
  );
  const eyeTopology = eyeTopologyFor(eyeOpenness, preserveEyeAsymmetry, sourceP5Text);
  const glassesMask = glassesFromGeometry ? glassesMaskFromGeometry(geometry, faceLeft, faceWidth, forehead, faceHeight) : fallback.glassesMask;
  const fringeOpening = hairlineFromGeometry ? geometryFringeOpening : fallback.fringeOpening;
  const fringePeaks = fringeFromGeometry
    ? geometry.fringe.peaks.map((peak) => ({ column: rounded(peak.x * 7, 0, 7), row: rounded(peak.depthY * 3, 1, 4), prominence: peak.prominence }))
      .filter((peak, index, all) => all.findIndex((candidate) => candidate.column === peak.column) === index)
      .slice(0, 3)
    : fallback.fringePeaks;
  const fringeDirection = fringeFromGeometry ? geometry.fringe.direction : fallback.fringeDirection;
  const templeGeometry = templeFromGeometry ? {
    leftRecession: leftTempleFromGeometry ? rounded(geometry.temple.leftRecession * 3, 0, 3) : fallback.templeGeometry.leftRecession,
    rightRecession: rightTempleFromGeometry ? rounded(geometry.temple.rightRecession * 3, 0, 3) : fallback.templeGeometry.rightRecession,
    leftStartRow: leftTempleFromGeometry ? rounded(geometry.temple.leftStartY * 7, 1, 6) : fallback.templeGeometry.leftStartRow,
    rightStartRow: rightTempleFromGeometry ? rounded(geometry.temple.rightStartY * 7, 1, 6) : fallback.templeGeometry.rightStartRow,
  } : fallback.templeGeometry;
  const crownGeometry = crownFromGeometry ? {
    leftRow: leftCrownFromGeometry ? rounded(geometry.crown.leftY * 7, 0, 2) : fallback.crownGeometry.leftRow,
    centerRow: centerCrownFromGeometry ? rounded(geometry.crown.centerY * 7, 0, 2) : fallback.crownGeometry.centerRow,
    rightRow: rightCrownFromGeometry ? rounded(geometry.crown.rightY * 7, 0, 2) : fallback.crownGeometry.rightRow,
    leftWidth: leftCrownFromGeometry ? rounded(1 + geometry.crown.leftWidth * 2, 1, 3) : fallback.crownGeometry.leftWidth,
    rightWidth: rightCrownFromGeometry ? rounded(1 + geometry.crown.rightWidth * 2, 1, 3) : fallback.crownGeometry.rightWidth,
    apexColumn: centerCrownFromGeometry ? rounded(geometry.crown.apexX * 7, 0, 7) : fallback.crownGeometry.apexColumn,
  } : fallback.crownGeometry;
  if (fringeFromGeometry) {
    const fringeSalience = hairSalienceScore(buildHairIdentitySaliencePlan(analysis), "fringe_shape");
    geometry.fringe.peaks.forEach((peak, index) => {
      const choice = boundaryAlternative(peak.x * 7, 0, 7);
      if (choice.alternate === undefined || (geometry.fringe.confidence >= 0.82 && fringeSalience < 0.65)) return;
      ambiguities.push({ axis: "fringe_peak_x", index, alternateValue: choice.alternate, distanceToBoundary: choice.distance, identityWeight: 0.82 + fringeSalience * 0.35 });
    });
  }
  if (centerCrownFromGeometry) {
    const crownSalience = hairSalienceScore(buildHairIdentitySaliencePlan(analysis), "crown_asymmetry");
    const choice = boundaryAlternative(geometry.crown.apexX * 7, 0, 7);
    if (choice.alternate !== undefined && (geometry.crown.centerConfidence < 0.82 || crownSalience >= 0.65)) {
      ambiguities.push({ axis: "crown_apex", alternateValue: choice.alternate, distanceToBoundary: choice.distance, identityWeight: 0.78 + crownSalience * 0.35 });
    }
  }
  const majorVolumePeaks = majorVolumePeaksFromGeometry ? volumePeaks.map((peak) => ({
    region: peak.region,
    row: rounded(peak.verticalCenter * 7, 1, 6),
    height: rounded(1 + peak.verticalExtent * 3, 1, 4),
    width: rounded(1 + peak.protrusion * 3, 1, 4),
    protrusion: peak.protrusion,
  })) : fallback.majorVolumePeaks;
  const faceWindow = faceWindowFromGeometry ? {
    foreheadRows: completeFaceWindowFromGeometry ? rounded(geometry.faceWindow.foreheadHeight * 4, 1, 4) : fallback.faceWindow.foreheadRows,
    leftTempleWidth: leftFaceWindowFromGeometry ? rounded(geometry.faceWindow.leftTempleWidth * 3, 0, 3) : fallback.faceWindow.leftTempleWidth,
    rightTempleWidth: rightFaceWindowFromGeometry ? rounded(geometry.faceWindow.rightTempleWidth * 3, 0, 3) : fallback.faceWindow.rightTempleWidth,
    visibleWidthAtEyes: visibleWidthAtEyesForEyes,
    visibleWidthAtCheeks: completeFaceWindowFromGeometry ? rounded(geometry.faceWindow.visibleFaceWidthAtCheeks * 8, 5, 8) : fallback.faceWindow.visibleWidthAtCheeks,
    leftEyeToHairRows: leftFaceWindowFromGeometry ? rounded(geometry.faceWindow.leftEyeToHairDistance * 7, 1, 5) : fallback.faceWindow.leftEyeToHairRows,
    rightEyeToHairRows: rightFaceWindowFromGeometry ? rounded(geometry.faceWindow.rightEyeToHairDistance * 7, 1, 5) : fallback.faceWindow.rightEyeToHairRows,
    leftEarExposure: leftFaceWindowFromGeometry ? geometry.faceWindow.leftEarExposure : fallback.faceWindow.leftEarExposure,
    rightEarExposure: rightFaceWindowFromGeometry ? geometry.faceWindow.rightEarExposure : fallback.faceWindow.rightEarExposure,
  } : fallback.faceWindow;
  const faceShape = faceShapeFromGeometry ? {
    upperWidth: rounded(geometry.faceShape.upperWidth * 8, 4, 8),
    cheekWidth: rounded(geometry.faceShape.cheekWidth * 8, 4, 8),
    jawWidth: rounded(geometry.faceShape.jawWidth * 8, 4, 8),
    verticalLength: rounded(geometry.faceShape.verticalLength * 7, 4, 7),
    asymmetryOffset: rounded(geometry.faceShape.leftRightAsymmetry * 4, -1, 1),
  } : fallback.faceShape;
  const renderContract = buildRenderContract(
    analysis,
    protectedGeometry,
    mouthOpening,
    mouthWidth,
    mouthCornerOffsets,
    eyeOpenness,
    leftEyeXs,
    rightEyeXs,
    glassesMask,
    fringeOpening,
  );
  if (protectedGeometry.includes("mouth") || (mouthFromGeometry && geometry.confidence.mouth >= 0.75 && mouthOpening === "teeth" && mouthWidth >= 4)) {
    const alternateTopology: MouthTopology | null = mouthTopology === "wide_teeth_smile"
      ? "teeth_smile"
      : mouthTopology === "teeth_smile" && mouthWidth >= 4
        ? "wide_teeth_smile"
        : mouthTopology === "open_wide"
          ? "open_compact"
          : mouthTopology === "closed_wide"
            ? "closed_compact"
            : null;
    if (alternateTopology) ambiguities.push({ axis: "mouth_topology", alternateValue: alternateTopology, distanceToBoundary: 0, identityWeight: 1.15 });
  }
  ambiguities.sort((a, b) => (b.identityWeight * (0.21 - b.distanceToBoundary)) - (a.identityWeight * (0.21 - a.distanceToBoundary)));
  return {
    salience,
    eyeRow: eyesFromGeometry ? eyeRowChoice.value as FaceLayoutPlan["eyeRow"] : fallback.eyeRow,
    leftEyeRow: eyesFromGeometry ? leftEyeRow : fallback.leftEyeRow, rightEyeRow: eyesFromGeometry ? rightEyeRow : fallback.rightEyeRow,
    leftEyeXs, rightEyeXs, eyeWidth, leftEyeWidth, rightEyeWidth, eyeOpenness, eyeTopology, eyeTiltOffset,
    browRow: browsFromGeometry ? rounded((leftBrowRow + rightBrowRow) / 2, 1, 4) : fallback.browRow,
    leftBrowRow: browsFromGeometry ? leftBrowRow : fallback.leftBrowRow, rightBrowRow: browsFromGeometry ? rightBrowRow : fallback.rightBrowRow,
    browThickness: browsFromGeometry ? geometry.brows.thickness >= 0.55 ? "strong" : "subtle" : fallback.browThickness,
    browTiltOffset,
    mouthRow: mouthFromGeometry ? mouthRowChoice.value as FaceLayoutPlan["mouthRow"] : fallback.mouthRow,
    mouthWidth,
    mouthCenterX: mouthFromGeometry ? rounded(xRaw(geometry.mouth.centerX), 1, 6) : fallback.mouthCenterX,
    mouthCornerOffsets,
    mouthOpening,
    mouthTopology,
    hairlineDepth: hairlineFromGeometry ? hairlineDepth : fallback.hairlineDepth, hairlineDepthByColumn,
    fringeOpening, fringePeaks, fringeDirection, templeGeometry, crownGeometry, majorVolumePeaks, faceWindow, faceShape,
    exposedFaceWidth: completeFaceWindowFromGeometry ? faceWindow.visibleWidthAtEyes : faceFromGeometry ? rounded(5 + geometry.face.widthWithinHead * 3, 5, 8) : fallback.exposedFaceWidth,
    noseX: noseFromGeometry ? rounded(xRaw(geometry.nose.centerX) + geometry.nose.leftRightBias * 0.45, 2, 5) : fallback.noseX,
    noseY: noseFromGeometry ? rounded(facialYRaw(geometry.nose.contrastY), 4, 6) : fallback.noseY,
    noseStrength: noseFromGeometry ? geometry.nose.visibleStrength : fallback.noseStrength,
    glassesMask,
    uncertainAxes: ambiguities.map((ambiguity) => ambiguity.axis),
    quantizationAmbiguities: ambiguities,
    protectedGeometry,
    renderContract,
    geometryTarget: {
      leftEyeCenterX: eyesFromGeometry ? xRaw(geometry.eyes.leftCenterX) : leftEyeXs.reduce((sum, value) => sum + value, 0) / leftEyeXs.length,
      rightEyeCenterX: eyesFromGeometry ? xRaw(geometry.eyes.rightCenterX) : rightEyeXs.reduce((sum, value) => sum + value, 0) / rightEyeXs.length,
      eyeSpacing: eyesFromGeometry ? xRaw(geometry.eyes.rightCenterX) - xRaw(geometry.eyes.leftCenterX) : mean(rightEyeXs) - mean(leftEyeXs),
      leftEyeWidth: eyesFromGeometry ? (geometry.eyes.leftWidth / faceWidth) * 8 : leftEyeWidth,
      rightEyeWidth: eyesFromGeometry ? (geometry.eyes.rightWidth / faceWidth) * 8 : rightEyeWidth,
      eyeRow: eyesFromGeometry ? meanEyeRaw : eyeRowChoice.value,
      leftEyeRow: eyesFromGeometry ? leftEyeRawRow : leftEyeRow,
      rightEyeRow: eyesFromGeometry ? rightEyeRawRow : rightEyeRow,
      leftBrowRow: browsFromGeometry ? leftBrowRawRow : leftBrowRow,
      rightBrowRow: browsFromGeometry ? rightBrowRawRow : rightBrowRow,
      leftBrowEyeDistance: browsFromGeometry ? leftEyeRawRow - leftBrowRawRow : leftEyeRow - leftBrowRow,
      rightBrowEyeDistance: browsFromGeometry ? rightEyeRawRow - rightBrowRawRow : rightEyeRow - rightBrowRow,
      mouthCenterX: mouthFromGeometry ? xRaw(geometry.mouth.centerX) : fallback.mouthCenterX,
      mouthRow: mouthFromGeometry ? facialYRaw(geometry.mouth.centerY) : fallback.mouthRow,
      mouthWidth: mouthFromGeometry ? (geometry.mouth.width / faceWidth) * 8 : fallback.mouthWidth,
      visibleFaceWidthAtEyes: completeFaceWindowFromGeometry ? geometry.faceWindow.visibleFaceWidthAtEyes * 8 : visibleWidthAtEyesForEyes,
    },
    geometryUsage: { faceBounds: faceFromGeometry, eyes: eyesFromGeometry, brows: browsFromGeometry, nose: noseFromGeometry, mouth: mouthFromGeometry, hairline: hairlineFromGeometry, glasses: glassesFromGeometry, fringePeaks: fringeFromGeometry, temple: templeFromGeometry, crown: crownFromGeometry, majorVolumePeaks: majorVolumePeaksFromGeometry, faceWindow: faceWindowFromGeometry, faceShape: faceShapeFromGeometry },
    geometryProvenance: {
      face: faceFromGeometry ? "observed_geometry" : "semantic_fallback",
      eyes: eyesFromGeometry ? "observed_geometry" : "semantic_fallback",
      brows: browsFromGeometry ? "observed_geometry" : "semantic_fallback",
      nose: noseFromGeometry ? "observed_geometry" : "semantic_fallback",
      mouth: mouthFromGeometry ? "observed_geometry" : "semantic_fallback",
      hairline: hairlineFromGeometry ? "observed_geometry" : "semantic_fallback",
      glasses: glassesFromGeometry ? "observed_geometry" : "semantic_fallback",
      fringe: fringeFromGeometry ? provenance.fringe ?? "observed_geometry" : "semantic_fallback",
      "temple.left": leftTempleFromGeometry ? provenance["temple.left"] ?? "observed_geometry" : "semantic_fallback",
      "temple.right": rightTempleFromGeometry ? provenance["temple.right"] ?? "observed_geometry" : "semantic_fallback",
      "crown.left": leftCrownFromGeometry ? provenance["crown.left"] ?? "observed_geometry" : "semantic_fallback",
      "crown.center": centerCrownFromGeometry ? provenance["crown.center"] ?? "observed_geometry" : "semantic_fallback",
      "crown.right": rightCrownFromGeometry ? provenance["crown.right"] ?? "observed_geometry" : "semantic_fallback",
      majorVolumePeaks: majorVolumePeaksFromGeometry ? (volumePeaks.some((peak) => provenance[`majorVolumePeaks.${peak.region}`] === "observed_geometry") ? "observed_geometry" : volumePeaks.some((peak) => provenance[`majorVolumePeaks.${peak.region}`] === "derived_geometry") ? "derived_geometry" : "inferred_geometry") : "semantic_fallback",
      "faceWindow.left": leftFaceWindowFromGeometry ? provenance["faceWindow.left"] ?? "observed_geometry" : "semantic_fallback",
      "faceWindow.right": rightFaceWindowFromGeometry ? provenance["faceWindow.right"] ?? "observed_geometry" : "semantic_fallback",
      faceShape: faceShapeFromGeometry ? provenance.faceShape ?? "observed_geometry" : "semantic_fallback",
    },
    geometryCompleteness: geometry.diagnostics.completeness,
  };
}

export function deriveFallbackFaceLayout(analysis: PhotoAnalysis): FaceLayoutPlan {
  const salience = buildFaceIdentitySaliencePlan(analysis);
  const hints = analysis.renderHints;
  const eyeRow: FaceLayoutPlan["eyeRow"] = analysis.fallbackFeatures.glasses !== "none" ? 4 : hints.bangsLength === "eye" ? 5 : hints.faceShape === "round" || hints.faceShape === "square" ? 3 : 4;
  const leftEyeXs = hints.eyeSpacing === "wide" ? [0, 1] : hints.eyeSpacing === "close" ? [2] : [1, 2];
  const rightEyeXs = hints.eyeSpacing === "wide" ? [6, 7] : hints.eyeSpacing === "close" ? [5] : [5, 6];
  const eyeWidth: FaceLayoutPlan["eyeWidth"] = hints.eyeSize === "large" ? 3 : hints.eyeSize === "small" ? 1 : 2;
  const eyeOpenness: FaceLayoutPlan["eyeOpenness"] = hints.eyeShape === "round" ? "open" : hints.eyeSize === "small" ? "compact" : "readable";
  const eyeTiltOffset: FaceLayoutPlan["eyeTiltOffset"] = hints.eyeTilt === "upturned" ? -1 : hints.eyeTilt === "downturned" ? 1 : 0;
  const browRow = rounded(eyeRow - (hints.eyeSize === "large" ? 2 : 1), 1, 4);
  // A readable tooth row needs the lower facial row even on round faces; row
  // five makes its boundary collide with the nose and turns the legacy broad
  // smile into a dark lower line after the exact plan is reasserted.
  const mouthRow: FaceLayoutPlan["mouthRow"] = hints.mouthOpening === "teeth_visible"
    ? 6
    : hints.faceShape === "round" || hints.faceShape === "square"
      ? 5
      : 6;
  const protectedGeometry = p5ProtectedGeometry(analysis);
  const mouthOpening: FaceLayoutPlan["mouthOpening"] = hints.mouthOpening === "teeth_visible" ? "teeth" : hints.mouthOpening === "slightly_open" ? "open" : "closed";
  const mouthWidth: FaceLayoutPlan["mouthWidth"] = hints.mouthShape === "wide"
    ? mouthOpening === "teeth" && protectedGeometry.includes("mouth") ? 5 : 4
    : hints.mouthShape === "full" ? 3 : 2;
  const mouthCornerOffsets: FaceLayoutPlan["mouthCornerOffsets"] = analysis.fallbackFeatures.expression === "smile" ? [-1, -1] : [0, 0];
  const mouthTopology = mouthTopologyFor(mouthOpening, mouthWidth, mouthCornerOffsets, false);
  const eyeTopology = eyeTopologyFor(eyeOpenness, false, p5Text(analysis));
  const hairlineDepth: FaceLayoutPlan["hairlineDepth"] = hints.bangs === "none" || hints.bangsLength === "none" ? 0 : hints.bangsLength === "eye" ? 3 : hints.bangsLength === "brow" ? 2 : 1;
  const hairlineDepthByColumn = Array.from({ length: 8 }, (_, x) => hints.fringeOpening === "center" && (x === 3 || x === 4) ? 0 : hairlineDepth) as FaceLayoutPlan["hairlineDepthByColumn"];
  const exposedFaceWidth: FaceLayoutPlan["exposedFaceWidth"] = hints.sideHairShape === "face_framing" || hints.earExposure === "covered" ? 5 : hints.earExposure === "partial" || hints.hairVolume === "full" ? 6 : hints.faceShape === "round" || hints.faceShape === "square" ? 8 : 7;
  const fringePeaks = hairlineDepth > 0 ? [{ column: hints.hairPart === "left" ? 5 : hints.hairPart === "right" ? 2 : 4, row: hairlineDepth, prominence: 0.35 }] : [];
  const fringeDirection: FaceLayoutPlan["fringeDirection"] = hints.bangs !== "side" ? "irregular" : hints.hairPart === "left" ? "right_swept" : "left_swept";
  const semanticEarExposure = hints.earExposure === "visible" ? 0.8 : hints.earExposure === "partial" ? 0.5 : 0.15;
  const templeGeometry: FaceLayoutPlan["templeGeometry"] = { leftRecession: Math.round(semanticEarExposure * 2), rightRecession: Math.round(semanticEarExposure * 2), leftStartRow: 3, rightStartRow: 3 };
  const crownGeometry: FaceLayoutPlan["crownGeometry"] = { leftRow: 0, centerRow: 0, rightRow: 0, leftWidth: hints.hairVolume === "full" ? 3 : 2, rightWidth: hints.hairVolume === "full" ? 3 : 2, apexColumn: hints.hairPart === "left" ? 2 : hints.hairPart === "right" ? 5 : 4 };
  const majorVolumePeaks: FaceLayoutPlan["majorVolumePeaks"] = [];
  const faceWindow: FaceLayoutPlan["faceWindow"] = { foreheadRows: Math.max(1, 4 - hairlineDepth), leftTempleWidth: templeGeometry.leftRecession, rightTempleWidth: templeGeometry.rightRecession, visibleWidthAtEyes: exposedFaceWidth, visibleWidthAtCheeks: exposedFaceWidth, leftEyeToHairRows: Math.max(1, eyeRow - hairlineDepth), rightEyeToHairRows: Math.max(1, eyeRow - hairlineDepth), leftEarExposure: semanticEarExposure, rightEarExposure: semanticEarExposure };
  const semanticFaceWidth = hints.faceShape === "round" || hints.faceShape === "square" ? 8 : hints.faceShape === "angular" ? 7 : 6;
  const faceShape: FaceLayoutPlan["faceShape"] = { upperWidth: semanticFaceWidth, cheekWidth: hints.faceShape === "round" ? 8 : semanticFaceWidth, jawWidth: hints.faceShape === "angular" ? 5 : hints.faceShape === "square" ? 8 : 6, verticalLength: hints.faceShape === "long" ? 7 : 6, asymmetryOffset: 0 };
  const glassesMask: Array<{ x: number; y: number }> = [];
  if (analysis.fallbackFeatures.glasses !== "none") {
    for (const x of [...leftEyeXs, ...rightEyeXs]) glassesMask.push({ x, y: eyeRow });
    if (analysis.fallbackFeatures.glasses === "round" || hints.eyeSize === "large") for (const x of [...leftEyeXs, ...rightEyeXs]) glassesMask.push({ x, y: Math.min(7, eyeRow + 1) });
    glassesMask.push({ x: 3, y: eyeRow }, { x: 4, y: eyeRow });
  }
  const uncertainAxes: QuantizationAxis[] = [];
  const faceConfidence = analysis.canonicalIdentity.features.filter((feature) => feature.category === "face").map((feature) => feature.confidence);
  if (faceConfidence.length === 0 || faceConfidence.some((confidence) => confidence !== "high")) uncertainAxes.push("eye_row", "mouth_row");
  if (hairlineDepth > 0) uncertainAxes.push("hairline_profile");
  const quantizationAmbiguities: QuantizationAmbiguity[] = uncertainAxes.map((axis, index) => ({
    axis,
    alternateValue: axis === "eye_row" ? (eyeRow === 3 ? 4 : 3) : axis === "mouth_row" ? (mouthRow === 5 ? 6 : 5) : Math.max(0, hairlineDepth - 1),
    distanceToBoundary: 0.2,
    identityWeight: 0.5 - index * 0.05,
  }));
  if (protectedGeometry.includes("mouth") || (mouthOpening === "teeth" && mouthWidth >= 4)) {
    const alternateTopology: MouthTopology | null = mouthTopology === "wide_teeth_smile" ? "teeth_smile" : mouthTopology === "open_wide" ? "open_compact" : mouthTopology === "closed_wide" ? "closed_compact" : null;
    if (alternateTopology) quantizationAmbiguities.unshift({ axis: "mouth_topology", alternateValue: alternateTopology, distanceToBoundary: 0, identityWeight: 1.15 });
  }
  const renderContract = buildRenderContract(analysis, protectedGeometry, mouthOpening, mouthWidth, mouthCornerOffsets, eyeOpenness, leftEyeXs, rightEyeXs, glassesMask, hints.fringeOpening);
  return {
    salience,
    eyeRow, leftEyeRow: eyeRow, rightEyeRow: eyeRow, leftEyeXs, rightEyeXs, eyeWidth,
    leftEyeWidth: eyeWidth, rightEyeWidth: eyeWidth, eyeOpenness, eyeTopology, eyeTiltOffset,
    browRow, leftBrowRow: browRow, rightBrowRow: browRow,
    browThickness: "subtle", browTiltOffset: 0,
    mouthRow, mouthWidth, mouthCenterX: 4, mouthCornerOffsets, mouthOpening, mouthTopology,
    hairlineDepth, hairlineDepthByColumn, fringeOpening: hints.fringeOpening, fringePeaks, fringeDirection, templeGeometry, crownGeometry, majorVolumePeaks, faceWindow, faceShape, exposedFaceWidth,
    noseX: hints.noseShape === "prominent" ? 3 : 4, noseY: Math.min(6, eyeRow + 1), noseStrength: hints.noseShape === "small" ? 0.25 : 0.7,
    glassesMask, uncertainAxes,
    quantizationAmbiguities,
    protectedGeometry,
    renderContract,
    geometryTarget: {
      leftEyeCenterX: leftEyeXs.reduce((sum, value) => sum + value, 0) / leftEyeXs.length,
      rightEyeCenterX: rightEyeXs.reduce((sum, value) => sum + value, 0) / rightEyeXs.length,
      eyeSpacing: mean(rightEyeXs) - mean(leftEyeXs),
      leftEyeWidth: leftEyeXs.length,
      rightEyeWidth: rightEyeXs.length,
      eyeRow,
      leftEyeRow: eyeRow,
      rightEyeRow: eyeRow,
      leftBrowRow: browRow,
      rightBrowRow: browRow,
      leftBrowEyeDistance: eyeRow - browRow,
      rightBrowEyeDistance: eyeRow - browRow,
      mouthCenterX: 4,
      mouthRow,
      mouthWidth,
      visibleFaceWidthAtEyes: exposedFaceWidth,
    },
    geometryUsage: { faceBounds: false, eyes: false, brows: false, nose: false, mouth: false, hairline: false, glasses: false, fringePeaks: false, temple: false, crown: false, majorVolumePeaks: false, faceWindow: false, faceShape: false },
    geometryProvenance: {
      face: "semantic_fallback", eyes: "semantic_fallback", brows: "semantic_fallback", nose: "semantic_fallback", mouth: "semantic_fallback", hairline: "semantic_fallback", glasses: "semantic_fallback",
      fringe: "semantic_fallback", "temple.left": "semantic_fallback", "temple.right": "semantic_fallback",
      "crown.left": "semantic_fallback", "crown.center": "semantic_fallback", "crown.right": "semantic_fallback",
      majorVolumePeaks: "semantic_fallback", "faceWindow.left": "semantic_fallback", "faceWindow.right": "semantic_fallback", faceShape: "semantic_fallback",
    },
    geometryCompleteness: { fringeObserved: false, leftTempleObserved: false, rightTempleObserved: false, crownObservedFraction: 0, volumePeakObservedFraction: 0, faceWindowObservedFraction: 0 },
  };
}

function applyAmbiguity(layout: FaceLayoutPlan, ambiguity: QuantizationAmbiguity): FaceLayoutPlan {
  const next: FaceLayoutPlan = { ...layout, leftEyeXs: [...layout.leftEyeXs], rightEyeXs: [...layout.rightEyeXs], hairlineDepthByColumn: [...layout.hairlineDepthByColumn] as FaceLayoutPlan["hairlineDepthByColumn"], fringePeaks: layout.fringePeaks.map((peak) => ({ ...peak })), crownGeometry: { ...layout.crownGeometry }, glassesMask: layout.glassesMask.map((point) => ({ ...point })), quantizationAmbiguities: layout.quantizationAmbiguities.map((item) => ({ ...item })), uncertainAxes: [...layout.uncertainAxes], protectedGeometry: [...layout.protectedGeometry], renderContract: structuredClone(layout.renderContract) };
  if (ambiguity.axis === "eye_row") {
    const alternate = Number(ambiguity.alternateValue);
    const delta = alternate - next.eyeRow;
    next.eyeRow = alternate as FaceLayoutPlan["eyeRow"];
    next.leftEyeRow = rounded(next.leftEyeRow + delta, 3, 5);
    next.rightEyeRow = rounded(next.rightEyeRow + delta, 3, 5);
    next.leftBrowRow = rounded(next.leftBrowRow + delta, 1, 4);
    next.rightBrowRow = rounded(next.rightBrowRow + delta, 1, 4);
    next.browRow = rounded((next.leftBrowRow + next.rightBrowRow) / 2, 1, 4);
    next.glassesMask = next.glassesMask.map((point) => ({ ...point, y: clamp(point.y + delta, 0, 7) }));
  } else if (ambiguity.axis === "eye_pair" && ambiguity.alternateLeftEyeXs && ambiguity.alternateRightEyeXs) {
    next.leftEyeXs = [...ambiguity.alternateLeftEyeXs];
    next.rightEyeXs = [...ambiguity.alternateRightEyeXs];
    next.leftEyeWidth = Math.max(1, Math.min(3, next.leftEyeXs.length)) as FaceLayoutPlan["leftEyeWidth"];
    next.rightEyeWidth = Math.max(1, Math.min(3, next.rightEyeXs.length)) as FaceLayoutPlan["rightEyeWidth"];
    next.eyeWidth = rounded((next.leftEyeWidth + next.rightEyeWidth) / 2, 1, 3);
  } else if (ambiguity.axis === "left_eye_x" || ambiguity.axis === "right_eye_x") {
    const key = ambiguity.axis === "left_eye_x" ? "leftEyeXs" : "rightEyeXs";
    const current = next[key];
    const center = current.reduce((sum, value) => sum + value, 0) / current.length;
    const delta = Number(ambiguity.alternateValue) - Math.round(center);
    next[key] = current.map((value) => clamp(value + delta, key === "leftEyeXs" ? 0 : 4, key === "leftEyeXs" ? 3 : 7));
  } else if (ambiguity.axis === "mouth_row") next.mouthRow = Number(ambiguity.alternateValue) as FaceLayoutPlan["mouthRow"];
  else if (ambiguity.axis === "mouth_width") next.mouthWidth = Number(ambiguity.alternateValue) as FaceLayoutPlan["mouthWidth"];
  else if (ambiguity.axis === "mouth_topology" || ambiguity.axis === "smile_corner_topology") next.mouthTopology = ambiguity.alternateValue as MouthTopology;
  else if (ambiguity.axis === "eye_openness_topology" || ambiguity.axis === "eye_asymmetry") next.eyeTopology = ambiguity.alternateValue as EyeTopology;
  else if (ambiguity.axis === "hairline_profile" && ambiguity.column !== undefined) {
    next.hairlineDepthByColumn[ambiguity.column] = Number(ambiguity.alternateValue);
    next.hairlineDepthByColumn = smoothHairline(next.hairlineDepthByColumn);
    next.hairlineDepth = rounded(Math.max(...next.hairlineDepthByColumn), 0, 3);
  }
  else if (ambiguity.axis === "fringe_peak_x" && ambiguity.index !== undefined && next.fringePeaks[ambiguity.index]) {
    next.fringePeaks[ambiguity.index].column = Number(ambiguity.alternateValue);
  }
  else if (ambiguity.axis === "crown_apex") next.crownGeometry.apexColumn = Number(ambiguity.alternateValue);
  return next;
}

export function buildQuantizedLayoutVariants(analysis: PhotoAnalysis, maximum = 3): QuantizedLayoutVariant[] {
  const geometry = analysis.identityGeometry;
  const primary = geometry ? quantizeIdentityGeometry(analysis, geometry) : deriveFallbackFaceLayout(analysis);
  const prefix = geometry ? "geometry" : "semantic";
  const variants: QuantizedLayoutVariant[] = [{ id: "primary", layout: primary }];
  for (const ambiguity of primary.quantizationAmbiguities) {
    if (variants.length >= Math.max(1, Math.min(3, maximum))) break;
    const layout = applyAmbiguity(primary, ambiguity);
    if (!layoutSatisfiesIdentityRenderContract(layout)) continue;
    variants.push({ id: `${prefix}_alt_${variants.length}` as QuantizedLayoutVariant["id"], layout });
  }
  return variants;
}
