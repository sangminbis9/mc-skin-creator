import type { PhotoAnalysis } from "./analysis";
import type { FacePixelInstruction, FacePixelPlan, MouthTopology } from "./identityPlans";

export interface FaceIdentitySignature {
  leftEyeColumns: number[];
  rightEyeColumns: number[];
  leftEyeRow: number;
  rightEyeRow: number;
  leftEyeWidth: number;
  rightEyeWidth: number;
  eyeTopology: FacePixelPlan["layout"]["eyeTopology"];
  leftBrowRow: number;
  rightBrowRow: number;
  leftBrowCells: string[];
  rightBrowCells: string[];
  browThickness: FacePixelPlan["layout"]["browThickness"];
  mouthWidth: number;
  mouthRow: number;
  mouthTopology: MouthTopology;
  faceWindow: number;
}

export interface FaceIdentityRetention {
  source: {
    eyeSpacing: number;
    leftEyeWidth: number;
    rightEyeWidth: number;
    eyeHeight: number;
    leftBrowEyeDistance: number;
    rightBrowEyeDistance: number;
    mouthWidth: number;
    mouthHeight: number;
    mouthTopology: string;
    faceWidth: number;
  };
  geometry: FacePixelPlan["layout"]["geometryTarget"];
  quantized: FaceIdentitySignature;
  rendered: FaceIdentitySignature;
  metrics: {
    eyeSpacingRetention: number;
    leftEyeWidthRetention: number;
    rightEyeWidthRetention: number;
    eyeHeightRetention: number;
    browPositionRetention: number;
    browAsymmetryRetention: number;
    mouthWidthRetention: number;
    mouthHeightRetention: number;
    mouthTopologyRetention: number;
    faceWidthRetention: number;
    verticalProportionRetention: number;
  };
  stageRetention: {
    geometryToQuantized: number;
    quantizedToRendered: number;
    overall: number;
  };
  largestLossStage: "source_to_geometry_unmeasured" | "geometry_to_quantization" | "quantization_to_render" | "retained";
}

export interface FacePixelDifference {
  changedFace: number;
  eyes: number;
  brows: number;
  mouth: number;
  faceBoundary: number;
  shadingOnly: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function retention(error: number, scale: number): number {
  return Math.max(0, Math.min(1, 1 - Math.abs(error) / Math.max(0.001, scale)));
}

function rangeWidth(pixels: FacePixelInstruction[]): number {
  if (pixels.length === 0) return 0;
  const xs = pixels.map((pixel) => pixel.x);
  return Math.max(...xs) - Math.min(...xs) + 1;
}

function visibleFaceWidth(plan: FacePixelPlan): number {
  const layout = plan.layout as FacePixelPlan["layout"] & {
    faceWindow?: { visibleWidthAtEyes?: number };
    exposedFaceWidth?: number;
  };
  return layout.faceWindow?.visibleWidthAtEyes ?? layout.exposedFaceWidth ?? 8;
}

export function measureFaceIdentitySignature(plan: FacePixelPlan): FaceIdentitySignature {
  const feature = (cluster: "left_eye" | "right_eye", roles: FacePixelInstruction["role"][]) =>
    plan.pixels.filter((pixel) => pixel.cluster === cluster && roles.includes(pixel.role));
  const leftEye = feature("left_eye", ["iris", "sclera"]);
  const rightEye = feature("right_eye", ["iris", "sclera"]);
  const leftBrow = feature("left_eye", ["brow"]);
  const rightBrow = feature("right_eye", ["brow"]);
  const mouth = plan.pixels.filter((pixel) => pixel.cluster === "mouth");
  return {
    leftEyeColumns: [...new Set(leftEye.map((pixel) => pixel.x))].sort((a, b) => a - b),
    rightEyeColumns: [...new Set(rightEye.map((pixel) => pixel.x))].sort((a, b) => a - b),
    leftEyeRow: Math.min(...leftEye.map((pixel) => pixel.y), plan.layout.leftEyeRow),
    rightEyeRow: Math.min(...rightEye.map((pixel) => pixel.y), plan.layout.rightEyeRow),
    leftEyeWidth: rangeWidth(leftEye),
    rightEyeWidth: rangeWidth(rightEye),
    eyeTopology: plan.layout.eyeTopology,
    // A strong brow adds a second pixel above the anchor. The lower rendered
    // row is therefore the position comparable to the quantized brow row.
    leftBrowRow: Math.max(...leftBrow.map((pixel) => pixel.y), plan.layout.leftBrowRow),
    rightBrowRow: Math.max(...rightBrow.map((pixel) => pixel.y), plan.layout.rightBrowRow),
    leftBrowCells: leftBrow.map((pixel) => `${pixel.x},${pixel.y}`).sort(),
    rightBrowCells: rightBrow.map((pixel) => `${pixel.x},${pixel.y}`).sort(),
    browThickness: plan.layout.browThickness,
    mouthWidth: rangeWidth(mouth),
    mouthRow: Math.min(...mouth.map((pixel) => pixel.y), plan.layout.mouthRow),
    mouthTopology: plan.layout.mouthTopology,
    faceWindow: visibleFaceWidth(plan),
  };
}

export function measureFaceIdentityRetention(analysis: PhotoAnalysis, plan: FacePixelPlan): FaceIdentityRetention {
  const geometry = analysis.identityGeometry;
  const target = plan.layout.geometryTarget;
  const quantized: FaceIdentitySignature = {
    leftEyeColumns: [...plan.layout.leftEyeXs], rightEyeColumns: [...plan.layout.rightEyeXs],
    leftEyeRow: plan.layout.leftEyeRow, rightEyeRow: plan.layout.rightEyeRow,
    leftEyeWidth: plan.layout.leftEyeWidth, rightEyeWidth: plan.layout.rightEyeWidth,
    eyeTopology: plan.layout.eyeTopology,
    leftBrowRow: plan.layout.leftBrowRow, rightBrowRow: plan.layout.rightBrowRow,
    leftBrowCells: [], rightBrowCells: [],
    browThickness: plan.layout.browThickness,
    mouthWidth: plan.layout.mouthWidth, mouthRow: plan.layout.mouthRow,
    mouthTopology: plan.layout.mouthTopology,
    faceWindow: visibleFaceWidth(plan),
  };
  const rendered = measureFaceIdentitySignature(plan);
  const source = {
    eyeSpacing: geometry?.eyes.interEyeDistance ?? target.eyeSpacing,
    leftEyeWidth: geometry?.eyes.leftWidth ?? target.leftEyeWidth,
    rightEyeWidth: geometry?.eyes.rightWidth ?? target.rightEyeWidth,
    eyeHeight: geometry ? (geometry.eyes.leftCenterY + geometry.eyes.rightCenterY) / 2 : target.eyeRow,
    leftBrowEyeDistance: geometry ? geometry.eyes.leftCenterY - geometry.brows.leftY : target.leftBrowEyeDistance,
    rightBrowEyeDistance: geometry ? geometry.eyes.rightCenterY - geometry.brows.rightY : target.rightBrowEyeDistance,
    mouthWidth: geometry?.mouth.width ?? target.mouthWidth,
    mouthHeight: geometry?.mouth.centerY ?? target.mouthRow,
    mouthTopology: geometry?.mouth.opening ?? plan.layout.mouthOpening,
    faceWidth: geometry?.face.widthWithinHead ?? target.visibleFaceWidthAtEyes,
  };
  const quantizedLeftCenter = mean(quantized.leftEyeColumns);
  const quantizedRightCenter = mean(quantized.rightEyeColumns);
  const renderedLeftCenter = mean(rendered.leftEyeColumns);
  const renderedRightCenter = mean(rendered.rightEyeColumns);
  const metrics = {
    eyeSpacingRetention: retention((quantizedRightCenter - quantizedLeftCenter) - target.eyeSpacing, 2),
    leftEyeWidthRetention: retention(quantized.leftEyeWidth - target.leftEyeWidth, 2),
    rightEyeWidthRetention: retention(quantized.rightEyeWidth - target.rightEyeWidth, 2),
    eyeHeightRetention: retention(mean([quantized.leftEyeRow, quantized.rightEyeRow]) - target.eyeRow, 2),
    browPositionRetention: retention(mean([quantized.leftEyeRow - quantized.leftBrowRow, quantized.rightEyeRow - quantized.rightBrowRow]) - mean([target.leftBrowEyeDistance, target.rightBrowEyeDistance]), 2),
    browAsymmetryRetention: retention(((quantized.leftEyeRow - quantized.leftBrowRow) - (quantized.rightEyeRow - quantized.rightBrowRow)) - (target.leftBrowEyeDistance - target.rightBrowEyeDistance), 2),
    mouthWidthRetention: retention(quantized.mouthWidth - target.mouthWidth, 2),
    mouthHeightRetention: retention(quantized.mouthRow - target.mouthRow, 2),
    mouthTopologyRetention: plan.layout.mouthOpening === source.mouthTopology ? 1 : 0,
    faceWidthRetention: retention(quantized.faceWindow - target.visibleFaceWidthAtEyes, 3),
    verticalProportionRetention: retention((quantized.mouthRow - mean([quantized.leftEyeRow, quantized.rightEyeRow])) - (target.mouthRow - target.eyeRow), 2),
  };
  const quantizedToRendered = mean([
    retention((renderedRightCenter - renderedLeftCenter) - (quantizedRightCenter - quantizedLeftCenter), 1),
    retention(rendered.mouthWidth - quantized.mouthWidth, 1),
    retention(rendered.leftBrowRow - quantized.leftBrowRow, 1),
    retention(rendered.rightBrowRow - quantized.rightBrowRow, 1),
  ]);
  const geometryToQuantized = mean(Object.values(metrics));
  const overall = geometryToQuantized * quantizedToRendered;
  return {
    source, geometry: { ...target }, quantized, rendered, metrics,
    stageRetention: { geometryToQuantized, quantizedToRendered, overall },
    largestLossStage: geometryToQuantized < 0.999
      ? "geometry_to_quantization"
      : quantizedToRendered < 0.999 ? "quantization_to_render" : "retained",
  };
}

function category(pixel: FacePixelInstruction | undefined): keyof Omit<FacePixelDifference, "changedFace"> {
  if (!pixel) return "shadingOnly";
  if (pixel.role === "brow") return "brows";
  if (pixel.cluster === "left_eye" || pixel.cluster === "right_eye") return "eyes";
  if (pixel.cluster === "mouth") return "mouth";
  if (pixel.cluster === "complexion" || pixel.cluster === "fringe") return "faceBoundary";
  return "shadingOnly";
}

export function measureFacePlanPixelDifference(before: FacePixelPlan, after: FacePixelPlan): FacePixelDifference {
  // Hair/fringe geometry is outside this face-only iteration and must not
  // inflate the identity diff when replaying a plan produced by an older
  // geometry pipeline.
  const keyed = (plan: FacePixelPlan) => new Map(plan.pixels
    .filter((pixel) => pixel.cluster !== "fringe")
    .map((pixel) => [`${pixel.x},${pixel.y}`, pixel]));
  const first = keyed(before);
  const second = keyed(after);
  const keys = new Set([...first.keys(), ...second.keys()]);
  const result: FacePixelDifference = { changedFace: 0, eyes: 0, brows: 0, mouth: 0, faceBoundary: 0, shadingOnly: 0 };
  for (const key of keys) {
    const left = first.get(key);
    const right = second.get(key);
    if (left?.role === right?.role && left?.cluster === right?.cluster) continue;
    result.changedFace++;
    const leftCategory = category(left);
    const rightCategory = category(right);
    const chosen = ["eyes", "brows", "mouth", "faceBoundary"].find((value) => value === leftCategory || value === rightCategory) as keyof Omit<FacePixelDifference, "changedFace"> | undefined;
    result[chosen ?? "shadingOnly"]++;
  }
  return result;
}

export function measureGenericFaceConvergence(plans: FacePixelPlan[]): {
  pairCount: number;
  identicalEyePairs: number;
  identicalBrowRelations: number;
  identicalMouths: number;
  identicalFullPatterns: number;
  convergence: number;
} {
  const signatures = plans.map(measureFaceIdentitySignature);
  let pairCount = 0;
  let identicalEyePairs = 0;
  let identicalBrowRelations = 0;
  let identicalMouths = 0;
  let identicalFullPatterns = 0;
  for (let left = 0; left < signatures.length; left++) for (let right = left + 1; right < signatures.length; right++) {
    pairCount++;
    const a = signatures[left];
    const b = signatures[right];
    const eye = JSON.stringify([a.leftEyeColumns, a.rightEyeColumns, a.leftEyeRow, a.rightEyeRow, a.eyeTopology]) === JSON.stringify([b.leftEyeColumns, b.rightEyeColumns, b.leftEyeRow, b.rightEyeRow, b.eyeTopology]);
    const brow = JSON.stringify([a.leftBrowCells, a.rightBrowCells, a.browThickness]) === JSON.stringify([b.leftBrowCells, b.rightBrowCells, b.browThickness]);
    const mouth = JSON.stringify([a.mouthWidth, a.mouthRow, a.mouthTopology]) === JSON.stringify([b.mouthWidth, b.mouthRow, b.mouthTopology]);
    if (eye) identicalEyePairs++;
    if (brow) identicalBrowRelations++;
    if (mouth) identicalMouths++;
    if (eye && brow && mouth && a.faceWindow === b.faceWindow) identicalFullPatterns++;
  }
  return {
    pairCount, identicalEyePairs, identicalBrowRelations, identicalMouths, identicalFullPatterns,
    convergence: pairCount === 0 ? 0 : (identicalEyePairs + identicalBrowRelations + identicalMouths + identicalFullPatterns) / (pairCount * 4),
  };
}
