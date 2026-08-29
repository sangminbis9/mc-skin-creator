import type { PhotoAnalysis } from "./analysis";
import type { IdentityGeometryAnalysis } from "./identityGeometry";

export type ProtectedGeometry = "glasses" | "hairline" | "head_silhouette" | "eye_layout" | "mouth" | "face_window";
export type MouthTopology = "closed_compact" | "closed_wide" | "open_compact" | "open_wide" | "teeth_smile" | "wide_teeth_smile" | "asymmetric_smile";
export type EyeTopology = "compact_dark" | "readable_iris" | "open_iris_sclera" | "smiling_squint" | "asymmetric";
export type QuantizationAxis =
  | "eye_row"
  | "left_eye_x"
  | "right_eye_x"
  | "mouth_row"
  | "mouth_width"
  | "mouth_topology"
  | "smile_corner_topology"
  | "eye_openness_topology"
  | "eye_asymmetry"
  | "glasses_footprint"
  | "hairline_profile";

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
}

export interface FaceLayoutPlan {
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
    eyeRow: number;
    mouthCenterX: number;
    mouthRow: number;
    mouthWidth: number;
  };
  geometryUsage: {
    faceBounds: boolean;
    eyes: boolean;
    brows: boolean;
    nose: boolean;
    mouth: boolean;
    hairline: boolean;
    glasses: boolean;
  };
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
  const eyeAsymmetry = Math.abs(analysis.identityGeometry?.eyes.verticalAsymmetry ?? 0) >= 0.16 && (analysis.identityGeometry?.confidence.eyes ?? 0) >= 0.75;
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
  const faceLeft = geometry.face.visibleLeft;
  const faceWidth = Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft);
  const forehead = geometry.face.foreheadY;
  const faceHeight = Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY);
  const xRaw = (value: number) => ((value - faceLeft) / faceWidth) * 7;
  const facialYRaw = (value: number) => 2 + ((value - forehead) / faceHeight) * 4;
  const protectedGeometry = p5ProtectedGeometry(analysis);
  const ambiguities: QuantizationAmbiguity[] = [];
  const leftEyeX = boundaryAlternative(xRaw(geometry.eyes.leftCenterX), 0, 3);
  const rightEyeX = boundaryAlternative(xRaw(geometry.eyes.rightCenterX), 4, 7);
  const meanEyeRaw = (facialYRaw(geometry.eyes.leftCenterY) + facialYRaw(geometry.eyes.rightCenterY)) / 2;
  const eyeRowChoice = boundaryAlternative(meanEyeRaw, 3, 5);
  const leftEyeRow = rounded(facialYRaw(geometry.eyes.leftCenterY), 3, 5);
  const rightEyeRow = rounded(facialYRaw(geometry.eyes.rightCenterY), 3, 5);
  const eyesFromGeometry = geometry.confidence.eyes >= 0.55;
  const browsFromGeometry = geometry.confidence.brows >= 0.55;
  const mouthFromGeometry = geometry.confidence.mouth >= 0.55;
  const noseFromGeometry = geometry.confidence.nose >= 0.55;
  const hairlineFromGeometry = geometry.confidence.hairline >= 0.55;
  const faceFromGeometry = geometry.confidence.faceBounds >= 0.55;
  const glassesFromGeometry = geometry.confidence.glasses >= 0.55;
  const leftEyeWidth = eyesFromGeometry ? rounded((geometry.eyes.leftWidth / faceWidth) * 8, 1, 3) : fallback.leftEyeWidth;
  const rightEyeWidth = eyesFromGeometry ? rounded((geometry.eyes.rightWidth / faceWidth) * 8, 1, 3) : fallback.rightEyeWidth;
  const eyeWidth = rounded((leftEyeWidth + rightEyeWidth) / 2, 1, 3);
  const leftEyeXs = eyesFromGeometry ? pixelSpan(leftEyeX.value, leftEyeWidth, 0, 3) : fallback.leftEyeXs;
  const rightEyeXs = eyesFromGeometry ? pixelSpan(rightEyeX.value, rightEyeWidth, 4, 7) : fallback.rightEyeXs;
  const leftBrowRow = rounded(facialYRaw(geometry.brows.leftY), 1, 4);
  const rightBrowRow = rounded(facialYRaw(geometry.brows.rightY), 1, 4);
  const mouthRowChoice = boundaryAlternative(facialYRaw(geometry.mouth.centerY), 5, 6);
  const mouthWidthChoice = boundaryAlternative((geometry.mouth.width / faceWidth) * 8, 2, 5);
  const hairlineRaw = geometry.hairline.depthByColumn.map((depth) => depth * 3);
  const hairlineDepthByColumn = hairlineFromGeometry ? smoothHairline(hairlineRaw.map((value) => Math.round(value))) : fallback.hairlineDepthByColumn;
  const addAmbiguity = (axis: QuantizationAxis, choice: { alternate?: number; distance: number }, identityWeight: number) => {
    if (choice.alternate === undefined) return;
    ambiguities.push({ axis, alternateValue: choice.alternate, distanceToBoundary: choice.distance, identityWeight });
  };
  addAmbiguity("eye_row", eyeRowChoice, 0.9);
  addAmbiguity("left_eye_x", leftEyeX, 0.95);
  addAmbiguity("right_eye_x", rightEyeX, 0.95);
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
  const geometryFringeOpening = geometry.hairline.foreheadOpeningRight - geometry.hairline.foreheadOpeningLeft >= 0.12
    ? Math.abs(((geometry.hairline.foreheadOpeningLeft + geometry.hairline.foreheadOpeningRight) / 2) - 0.5) <= 0.12
      ? "center"
      : ((geometry.hairline.foreheadOpeningLeft + geometry.hairline.foreheadOpeningRight) / 2) < 0.5 ? "left" : "right"
    : "none";
  const eyeOpenness: FaceLayoutPlan["eyeOpenness"] = eyesFromGeometry
    ? geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"
    : fallback.eyeOpenness;
  const eyeTiltOffset: FaceLayoutPlan["eyeTiltOffset"] = eyesFromGeometry
    ? rounded(geometry.eyes.verticalAsymmetry * 4, -1, 1)
    : fallback.eyeTiltOffset;
  const browTiltOffset: FaceLayoutPlan["browTiltOffset"] = browsFromGeometry
    ? rounded(geometry.brows.tilt * 2.5, -1, 1)
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
  const preserveEyeAsymmetry = eyesFromGeometry && geometry.confidence.eyes >= 0.75 && Math.abs(geometry.eyes.verticalAsymmetry) >= 0.16;
  const eyeTopology = eyeTopologyFor(eyeOpenness, preserveEyeAsymmetry, sourceP5Text);
  const glassesMask = glassesFromGeometry ? glassesMaskFromGeometry(geometry, faceLeft, faceWidth, forehead, faceHeight) : fallback.glassesMask;
  const fringeOpening = hairlineFromGeometry ? geometryFringeOpening : fallback.fringeOpening;
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
    fringeOpening,
    exposedFaceWidth: faceFromGeometry ? rounded(5 + geometry.face.widthWithinHead * 3, 5, 8) : fallback.exposedFaceWidth,
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
      eyeRow: eyesFromGeometry ? meanEyeRaw : eyeRowChoice.value,
      mouthCenterX: mouthFromGeometry ? xRaw(geometry.mouth.centerX) : fallback.mouthCenterX,
      mouthRow: mouthFromGeometry ? facialYRaw(geometry.mouth.centerY) : fallback.mouthRow,
      mouthWidth: mouthFromGeometry ? (geometry.mouth.width / faceWidth) * 8 : fallback.mouthWidth,
    },
    geometryUsage: { faceBounds: faceFromGeometry, eyes: eyesFromGeometry, brows: browsFromGeometry, nose: noseFromGeometry, mouth: mouthFromGeometry, hairline: hairlineFromGeometry, glasses: glassesFromGeometry },
  };
}

export function deriveFallbackFaceLayout(analysis: PhotoAnalysis): FaceLayoutPlan {
  const hints = analysis.renderHints;
  const eyeRow: FaceLayoutPlan["eyeRow"] = analysis.fallbackFeatures.glasses !== "none" ? 4 : hints.bangsLength === "eye" ? 5 : hints.faceShape === "round" || hints.faceShape === "square" ? 3 : 4;
  const leftEyeXs = hints.eyeSpacing === "wide" ? [0, 1] : hints.eyeSpacing === "close" ? [2] : [1, 2];
  const rightEyeXs = hints.eyeSpacing === "wide" ? [6, 7] : hints.eyeSpacing === "close" ? [5] : [5, 6];
  const eyeWidth: FaceLayoutPlan["eyeWidth"] = hints.eyeSize === "large" ? 3 : hints.eyeSize === "small" ? 1 : 2;
  const eyeOpenness: FaceLayoutPlan["eyeOpenness"] = hints.eyeShape === "round" ? "open" : hints.eyeSize === "small" ? "compact" : "readable";
  const eyeTiltOffset: FaceLayoutPlan["eyeTiltOffset"] = hints.eyeTilt === "upturned" ? -1 : hints.eyeTilt === "downturned" ? 1 : 0;
  const browRow = rounded(eyeRow - (hints.eyeSize === "large" ? 2 : 1), 1, 4);
  const mouthRow: FaceLayoutPlan["mouthRow"] = hints.faceShape === "round" || hints.faceShape === "square" ? 5 : 6;
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
    eyeRow, leftEyeRow: eyeRow, rightEyeRow: eyeRow, leftEyeXs, rightEyeXs, eyeWidth,
    leftEyeWidth: eyeWidth, rightEyeWidth: eyeWidth, eyeOpenness, eyeTopology, eyeTiltOffset,
    browRow, leftBrowRow: browRow, rightBrowRow: browRow,
    browThickness: "subtle", browTiltOffset: 0,
    mouthRow, mouthWidth, mouthCenterX: 4, mouthCornerOffsets, mouthOpening, mouthTopology,
    hairlineDepth, hairlineDepthByColumn, fringeOpening: hints.fringeOpening, exposedFaceWidth,
    noseX: hints.noseShape === "prominent" ? 3 : 4, noseY: Math.min(6, eyeRow + 1), noseStrength: hints.noseShape === "small" ? 0.25 : 0.7,
    glassesMask, uncertainAxes,
    quantizationAmbiguities,
    protectedGeometry,
    renderContract,
    geometryTarget: {
      leftEyeCenterX: leftEyeXs.reduce((sum, value) => sum + value, 0) / leftEyeXs.length,
      rightEyeCenterX: rightEyeXs.reduce((sum, value) => sum + value, 0) / rightEyeXs.length,
      eyeRow,
      mouthCenterX: 4,
      mouthRow,
      mouthWidth,
    },
    geometryUsage: { faceBounds: false, eyes: false, brows: false, nose: false, mouth: false, hairline: false, glasses: false },
  };
}

function applyAmbiguity(layout: FaceLayoutPlan, ambiguity: QuantizationAmbiguity): FaceLayoutPlan {
  const next: FaceLayoutPlan = { ...layout, leftEyeXs: [...layout.leftEyeXs], rightEyeXs: [...layout.rightEyeXs], hairlineDepthByColumn: [...layout.hairlineDepthByColumn] as FaceLayoutPlan["hairlineDepthByColumn"], glassesMask: layout.glassesMask.map((point) => ({ ...point })), quantizationAmbiguities: layout.quantizationAmbiguities.map((item) => ({ ...item })), uncertainAxes: [...layout.uncertainAxes], protectedGeometry: [...layout.protectedGeometry], renderContract: structuredClone(layout.renderContract) };
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
