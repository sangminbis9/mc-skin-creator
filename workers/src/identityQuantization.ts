import type { PhotoAnalysis } from "./analysis";
import type { IdentityGeometryAnalysis } from "./identityGeometry";

export type ProtectedGeometry = "glasses" | "hairline" | "eye_layout" | "mouth" | "face_window";
export type QuantizationAxis = "eye_row" | "left_eye_x" | "right_eye_x" | "mouth_row" | "mouth_width" | "hairline_profile";

export interface QuantizationAmbiguity {
  axis: QuantizationAxis;
  distanceToBoundary: number;
  identityWeight: number;
  alternateValue: number;
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
  eyeTiltOffset: -1 | 0 | 1;
  browRow: 1 | 2 | 3 | 4;
  leftBrowRow: 1 | 2 | 3 | 4;
  rightBrowRow: 1 | 2 | 3 | 4;
  browThickness: "subtle" | "strong";
  browTiltOffset: -1 | 0 | 1;
  mouthRow: 5 | 6;
  mouthWidth: 2 | 3 | 4;
  mouthCenterX: number;
  mouthCornerOffsets: [number, number];
  mouthOpening: "closed" | "open" | "teeth";
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
    if (feature.category === "face" && /\beye|inter-eye|eye spacing/.test(text)) protectedGeometry.push("eye_layout");
    if (feature.category === "face" && /mouth|smile|teeth|lip|grin/.test(text)) protectedGeometry.push("mouth");
    if (feature.category === "face" && /face width|wide face|narrow face|jaw/.test(text)) protectedGeometry.push("face_window");
  }
  return [...new Set(protectedGeometry)];
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
  const mouthWidthChoice = boundaryAlternative((geometry.mouth.width / faceWidth) * 8, 2, 4);
  const hairlineRaw = geometry.hairline.depthByColumn.map((depth) => depth * 3);
  const hairlineDepthByColumn = hairlineFromGeometry ? smoothHairline(hairlineRaw.map((value) => Math.round(value))) : fallback.hairlineDepthByColumn;
  const addAmbiguity = (axis: QuantizationAxis, choice: { alternate?: number; distance: number }, identityWeight: number, protectedBy?: ProtectedGeometry) => {
    if (choice.alternate === undefined || (protectedBy && protectedGeometry.includes(protectedBy))) return;
    ambiguities.push({ axis, alternateValue: choice.alternate, distanceToBoundary: choice.distance, identityWeight });
  };
  addAmbiguity("eye_row", eyeRowChoice, 0.9, "eye_layout");
  addAmbiguity("left_eye_x", leftEyeX, 0.95, "eye_layout");
  addAmbiguity("right_eye_x", rightEyeX, 0.95, "eye_layout");
  addAmbiguity("mouth_row", mouthRowChoice, 0.72, "mouth");
  addAmbiguity("mouth_width", mouthWidthChoice, 0.68, "mouth");
  if (!protectedGeometry.includes("hairline")) {
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
  }
  ambiguities.sort((a, b) => (b.identityWeight * (0.21 - b.distanceToBoundary)) - (a.identityWeight * (0.21 - a.distanceToBoundary)));
  const meanCornerY = (geometry.mouth.leftCornerY + geometry.mouth.rightCornerY) / 2;
  const cornerOffset = (value: number) => rounded((value - meanCornerY) / Math.max(0.015, faceHeight / 8), -1, 1);
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
  return {
    eyeRow: eyesFromGeometry ? eyeRowChoice.value as FaceLayoutPlan["eyeRow"] : fallback.eyeRow,
    leftEyeRow: eyesFromGeometry ? leftEyeRow : fallback.leftEyeRow, rightEyeRow: eyesFromGeometry ? rightEyeRow : fallback.rightEyeRow,
    leftEyeXs, rightEyeXs, eyeWidth, leftEyeWidth, rightEyeWidth, eyeOpenness, eyeTiltOffset,
    browRow: browsFromGeometry ? rounded((leftBrowRow + rightBrowRow) / 2, 1, 4) : fallback.browRow,
    leftBrowRow: browsFromGeometry ? leftBrowRow : fallback.leftBrowRow, rightBrowRow: browsFromGeometry ? rightBrowRow : fallback.rightBrowRow,
    browThickness: browsFromGeometry ? geometry.brows.thickness >= 0.55 ? "strong" : "subtle" : fallback.browThickness,
    browTiltOffset,
    mouthRow: mouthFromGeometry ? mouthRowChoice.value as FaceLayoutPlan["mouthRow"] : fallback.mouthRow,
    mouthWidth: mouthFromGeometry ? mouthWidthChoice.value as FaceLayoutPlan["mouthWidth"] : fallback.mouthWidth,
    mouthCenterX: mouthFromGeometry ? rounded(xRaw(geometry.mouth.centerX), 1, 6) : fallback.mouthCenterX,
    mouthCornerOffsets: mouthFromGeometry ? [cornerOffset(geometry.mouth.leftCornerY), cornerOffset(geometry.mouth.rightCornerY)] : fallback.mouthCornerOffsets,
    mouthOpening: mouthFromGeometry ? geometry.mouth.opening : fallback.mouthOpening,
    hairlineDepth: hairlineFromGeometry ? hairlineDepth : fallback.hairlineDepth, hairlineDepthByColumn,
    fringeOpening: hairlineFromGeometry ? geometryFringeOpening : fallback.fringeOpening,
    exposedFaceWidth: faceFromGeometry ? rounded(5 + geometry.face.widthWithinHead * 3, 5, 8) : fallback.exposedFaceWidth,
    noseX: noseFromGeometry ? rounded(xRaw(geometry.nose.centerX) + geometry.nose.leftRightBias * 0.45, 2, 5) : fallback.noseX,
    noseY: noseFromGeometry ? rounded(facialYRaw(geometry.nose.contrastY), 4, 6) : fallback.noseY,
    noseStrength: noseFromGeometry ? geometry.nose.visibleStrength : fallback.noseStrength,
    glassesMask: glassesFromGeometry ? glassesMaskFromGeometry(geometry, faceLeft, faceWidth, forehead, faceHeight) : fallback.glassesMask,
    uncertainAxes: ambiguities.map((ambiguity) => ambiguity.axis),
    quantizationAmbiguities: ambiguities,
    protectedGeometry,
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
  const mouthWidth: FaceLayoutPlan["mouthWidth"] = hints.mouthShape === "wide" ? 4 : hints.mouthShape === "full" ? 3 : 2;
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
  const protectedGeometry = p5ProtectedGeometry(analysis);
  const allowedUncertainAxes = uncertainAxes.filter((axis) =>
    !(axis === "hairline_profile" && protectedGeometry.includes("hairline")) &&
    !(axis === "eye_row" && protectedGeometry.includes("eye_layout")) &&
    !(axis === "mouth_row" && protectedGeometry.includes("mouth")),
  );
  return {
    eyeRow, leftEyeRow: eyeRow, rightEyeRow: eyeRow, leftEyeXs, rightEyeXs, eyeWidth,
    leftEyeWidth: eyeWidth, rightEyeWidth: eyeWidth, eyeOpenness, eyeTiltOffset,
    browRow, leftBrowRow: browRow, rightBrowRow: browRow,
    browThickness: "subtle", browTiltOffset: 0,
    mouthRow, mouthWidth, mouthCenterX: 4, mouthCornerOffsets: [0, 0], mouthOpening: hints.mouthOpening === "teeth_visible" ? "teeth" : hints.mouthOpening === "slightly_open" ? "open" : "closed",
    hairlineDepth, hairlineDepthByColumn, fringeOpening: hints.fringeOpening, exposedFaceWidth,
    noseX: hints.noseShape === "prominent" ? 3 : 4, noseY: Math.min(6, eyeRow + 1), noseStrength: hints.noseShape === "small" ? 0.25 : 0.7,
    glassesMask, uncertainAxes: allowedUncertainAxes,
    quantizationAmbiguities: allowedUncertainAxes.map((axis, index) => ({ axis, alternateValue: axis === "eye_row" ? (eyeRow === 3 ? 4 : 3) : axis === "mouth_row" ? (mouthRow === 5 ? 6 : 5) : Math.max(0, hairlineDepth - 1), distanceToBoundary: 0.2, identityWeight: 0.5 - index * 0.05 })),
    protectedGeometry,
    geometryUsage: { faceBounds: false, eyes: false, brows: false, nose: false, mouth: false, hairline: false, glasses: false },
  };
}

function applyAmbiguity(layout: FaceLayoutPlan, ambiguity: QuantizationAmbiguity): FaceLayoutPlan {
  const next: FaceLayoutPlan = { ...layout, leftEyeXs: [...layout.leftEyeXs], rightEyeXs: [...layout.rightEyeXs], hairlineDepthByColumn: [...layout.hairlineDepthByColumn] as FaceLayoutPlan["hairlineDepthByColumn"], glassesMask: layout.glassesMask.map((point) => ({ ...point })), quantizationAmbiguities: layout.quantizationAmbiguities.map((item) => ({ ...item })), uncertainAxes: [...layout.uncertainAxes], protectedGeometry: [...layout.protectedGeometry] };
  if (ambiguity.axis === "eye_row") {
    const delta = ambiguity.alternateValue - next.eyeRow;
    next.eyeRow = ambiguity.alternateValue as FaceLayoutPlan["eyeRow"];
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
    const delta = ambiguity.alternateValue - Math.round(center);
    next[key] = current.map((value) => clamp(value + delta, key === "leftEyeXs" ? 0 : 4, key === "leftEyeXs" ? 3 : 7));
  } else if (ambiguity.axis === "mouth_row") next.mouthRow = ambiguity.alternateValue as FaceLayoutPlan["mouthRow"];
  else if (ambiguity.axis === "mouth_width") next.mouthWidth = ambiguity.alternateValue as FaceLayoutPlan["mouthWidth"];
  else if (ambiguity.axis === "hairline_profile" && ambiguity.column !== undefined) {
    next.hairlineDepthByColumn[ambiguity.column] = ambiguity.alternateValue;
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
    variants.push({ id: `${prefix}_alt_${variants.length}` as QuantizedLayoutVariant["id"], layout: applyAmbiguity(primary, ambiguity) });
  }
  return variants;
}
