/**
 * Analysis-derived, pixel-space plans consumed by the deterministic renderer.
 *
 * Plans deliberately name palette roles instead of carrying arbitrary RGB.
 * The renderer owns the compact material ramps and resolves each role from the
 * analysed complexion, hair and outfit colours at render time.
 */
import type { PhotoAnalysis } from "./analysis";
import {
  buildQuantizedLayoutVariants,
  type FaceLayoutPlan,
  type IdentityRenderContract,
  type ProtectedGeometry,
} from "./identityQuantization";
import {
  buildGlassesStructurePlan,
  buildHairStructurePlan,
  type GlassesStructurePlan,
  type HairStructurePlan,
} from "./headStructure";
import {
  buildHairIdentitySaliencePlan,
  hairSalienceScore,
  type HairIdentitySaliencePlan,
} from "./hairIdentitySalience";
import type { FaceIdentitySaliencePlan } from "./faceIdentitySalience";
import { buildOutfitPlan, type OutfitPlan } from "./outfitIdentity";

export type {
  GlassesPixelRole,
  GlassesStructurePixel,
  GlassesStructurePlan,
  GlassesTopology,
  HairDirection,
  HairStructureGroup,
  HairStructureKind,
  HairStructurePlan,
  HairStructurePoint,
  HairStructureRole,
  HairTextureGrammar,
} from "./headStructure";

export type { EyeTopology, FaceLayoutPlan, IdentityRenderContract, MouthTopology, ProtectedGeometry, QuantizationAxis } from "./identityQuantization";
export type { FaceIdentityAxis, FaceIdentitySalienceCue, FaceIdentitySaliencePlan } from "./faceIdentitySalience";
export type { HairIdentityAxis, HairIdentitySalienceCue, HairIdentitySaliencePlan } from "./hairIdentitySalience";
export type { OutfitPlan } from "./outfitIdentity";

export type FacePaletteRole =
  | "skin_light"
  | "skin_mid"
  | "skin_shadow"
  | "hair_light"
  | "hair_mid"
  | "hair_shadow"
  | "brow"
  | "glasses"
  | "iris"
  | "sclera"
  | "nose_shadow"
  | "lip"
  | "teeth"
  | "mouth_shadow";

export interface FacePixelInstruction {
  x: number;
  y: number;
  role: FacePaletteRole;
  cluster: "complexion" | "fringe" | "left_eye" | "right_eye" | "glasses" | "nose" | "mouth";
}

export interface FacePixelPlan {
  width: 8;
  height: 8;
  coordinateSpace: "head.base.front";
  pixels: FacePixelInstruction[];
  protectedClusters: Array<{
    name: FacePixelInstruction["cluster"];
    minimumPixels: number;
  }>;
  layout: FaceLayoutPlan;
  variantId: "primary" | "geometry_alt_1" | "geometry_alt_2" | "semantic_alt_1" | "semantic_alt_2";
  source: "identity_geometry" | "semantic_fallback";
  protectedGeometry: ProtectedGeometry[];
  renderContract: IdentityRenderContract;
  glassesPlan: GlassesStructurePlan;
  candidateCost: PerceptualQuantizationCost;
  salience: FaceIdentitySaliencePlan;
}

export interface PerceptualQuantizationCost {
  direction: "lower_is_better";
  geometryError: number;
  eyeSpacingError: number;
  eyeWidthError: number;
  browRelationError: number;
  mouthGeometryError: number;
  faceWindowConflict: number;
  p5ContractViolations: number;
  clusterPenalty: number;
  isolatedPixelPenalty: number;
  expressionPenalty: number;
  overlayConflictPenalty: number;
  totalCost: number;
  meaningfulMargin: number;
  violations: string[];
}

export type HairTemplate =
  | "bald"
  | "short_cap"
  | "medium_bob"
  | "long_curtain"
  | "curly_volume"
  | "coily_volume";

export type HeadMaskFace = "front" | "top" | "left" | "right" | "back";
export interface HeadMaskPoint {
  x: number;
  y: number;
  role: "hair" | "covering";
}

export type CurlyMassRegion = NonNullable<PhotoAnalysis["identityGeometry"]>["majorVolumePeaks"][number]["region"];

export interface CurlySilhouetteMass {
  id: string;
  region: CurlyMassRegion;
  sourceRegions: CurlyMassRegion[];
  sourceEvidence: Array<{
    region: CurlyMassRegion;
    evidence: "observed" | "inferred" | "unknown";
    confidence: number;
  }>;
  centerRow: number;
  spanRows: number;
  width: number;
  protrusion: number;
  layerRole: "both";
  outerPoints: Array<{ face: HeadMaskFace; x: number; y: number }>;
}

export interface CurlySilhouettePlan {
  sourcePeakCount: number;
  masses: CurlySilhouetteMass[];
  crownOuterPoints: Array<{ face: "front" | "top"; x: number; y: number }>;
  endpointRows: { left: number; right: number };
  crownProfile: {
    leftRow: number;
    centerRow: number;
    rightRow: number;
    apexColumn: number;
  };
}

export interface HeadMaskPlan {
  coordinateSpace: "head.overlay";
  source: "identity_geometry" | "semantic_template";
  faces: Record<HeadMaskFace, HeadMaskPoint[]>;
  partColumn: number | null;
  endpointRows: { left: number; right: number };
  widthByRow: { left: number[]; right: number[]; back: number[] };
  foreheadExposure: number;
  earExposure: { left: number; right: number };
  curlySilhouette?: CurlySilhouettePlan;
}

export interface HairPlan {
  template: HairTemplate;
  lengthClass: "none" | "short" | "medium" | "long";
  texture: PhotoAnalysis["renderHints"]["hairTexture"];
  fringe: PhotoAnalysis["renderHints"]["bangs"];
  part: PhotoAnalysis["renderHints"]["hairPart"];
  continuousFaces: Array<
    | "head.front"
    | "head.top"
    | "head.left"
    | "head.right"
    | "head.back"
    | "body.back"
    | "body.left"
    | "body.right"
  >;
  overlayPolicy: "structure_aware";
  minimumInvention: true;
  salience: HairIdentitySaliencePlan;
  headMask: HeadMaskPlan;
  structure: HairStructurePlan;
}

export interface HeadIdentityPlan {
  baseFace: FacePixelPlan;
  baseHairGroupIds: string[];
  outerHairGroupIds: string[];
  glasses: GlassesStructurePlan;
  protectedBaseFront: Array<{ x: number; y: number }>;
  protectedOuter: Array<{ face: "front" | "left" | "right"; x: number; y: number }>;
  p5Contracts: IdentityRenderContract;
  geometryProvenance: FaceLayoutPlan["geometryProvenance"];
  compositionOrder: ["base_hair", "outer_hair", "face_landmarks", "glasses", "accessories"];
}

export type PaletteMaterial = "skin" | "hair" | "top" | "bottom" | "shoes" | "accent";

export interface PaletteRampPlan {
  material: PaletteMaterial;
  source: "observed" | "inferred";
  roles: ["shadow", "base", "light"];
  maxLocalColors: 6;
  hueShift: "warm_lights_cool_shadows" | "cool_lights_warm_shadows" | "neutral";
}

export interface PalettePlan {
  observedColors: string[];
  ramps: PaletteRampPlan[];
  maxGlobalColors: 36;
  noisePolicy: "connected_clusters_only";
}

export interface IdentityPixelPlans {
  facePixelPlan: FacePixelPlan;
  hairPlan: HairPlan;
  headIdentityPlan: HeadIdentityPlan;
  palettePlan: PalettePlan;
  outfitPlan: OutfitPlan;
}

export interface FacePlanSimilarity {
  eyeLayoutDistance: number;
  browRelationDistance: number;
  mouthLayoutDistance: number;
  topologyDistance: number;
  hairlineProfileDistance: number;
  glassesMaskDistance: number;
  faceWindowDistance: number;
  weightedSimilarity: number;
}

export function compareFacePlans(first: FacePixelPlan, second: FacePixelPlan): FacePlanSimilarity {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const eyeLayoutDistance = Math.min(1, mean([
    Math.abs(first.layout.leftEyeRow - second.layout.leftEyeRow) / 2,
    Math.abs(first.layout.rightEyeRow - second.layout.rightEyeRow) / 2,
    Math.abs(mean(first.layout.leftEyeXs) - mean(second.layout.leftEyeXs)) / 3,
    Math.abs(mean(first.layout.rightEyeXs) - mean(second.layout.rightEyeXs)) / 3,
  ]));
  const browRelationDistance = Math.min(1, mean([
    Math.abs((first.layout.leftEyeRow - first.layout.leftBrowRow) - (second.layout.leftEyeRow - second.layout.leftBrowRow)) / 2,
    Math.abs((first.layout.rightEyeRow - first.layout.rightBrowRow) - (second.layout.rightEyeRow - second.layout.rightBrowRow)) / 2,
    first.layout.browThickness === second.layout.browThickness ? 0 : 1,
  ]));
  const mouthLayoutDistance = Math.min(1, mean([
    Math.abs(first.layout.mouthRow - second.layout.mouthRow),
    Math.abs(first.layout.mouthWidth - second.layout.mouthWidth) / 2,
    Math.abs(first.layout.mouthCenterX - second.layout.mouthCenterX) / 5,
  ]));
  const hairlineProfileDistance = Math.min(1, mean(first.layout.hairlineDepthByColumn.map((depth, index) => Math.abs(depth - second.layout.hairlineDepthByColumn[index]) / 3)));
  const firstGlasses = new Set(first.layout.glassesMask.map((point) => `${point.x},${point.y}`));
  const secondGlasses = new Set(second.layout.glassesMask.map((point) => `${point.x},${point.y}`));
  const union = new Set([...firstGlasses, ...secondGlasses]);
  const intersection = [...firstGlasses].filter((point) => secondGlasses.has(point)).length;
  const glassesMaskDistance = union.size === 0 ? 0 : 1 - intersection / union.size;
  const faceWindowDistance = Math.abs(first.layout.exposedFaceWidth - second.layout.exposedFaceWidth) / 3;
  const topologyDistance = mean([
    first.layout.eyeTopology === second.layout.eyeTopology ? 0 : 1,
    first.layout.mouthTopology === second.layout.mouthTopology ? 0 : 1,
  ]);
  const weightedDistance =
    hairlineProfileDistance * 0.29 +
    eyeLayoutDistance * 0.27 +
    glassesMaskDistance * 0.2 +
    mouthLayoutDistance * 0.16 +
    faceWindowDistance * 0.08;
  return {
    eyeLayoutDistance,
    browRelationDistance,
    mouthLayoutDistance,
    topologyDistance,
    hairlineProfileDistance,
    glassesMaskDistance,
    faceWindowDistance,
    weightedSimilarity: Math.max(0, Math.min(1, 1 - weightedDistance)),
  };
}

export function measureFacePlanConvergence(plans: FacePixelPlan[]): {
  pairCount: number;
  meanSimilarity: number;
  maximumSimilarity: number;
  nearIdenticalPairs: number;
} {
  const similarities: number[] = [];
  for (let left = 0; left < plans.length; left++) {
    for (let right = left + 1; right < plans.length; right++) similarities.push(compareFacePlans(plans[left], plans[right]).weightedSimilarity);
  }
  return {
    pairCount: similarities.length,
    meanSimilarity: similarities.length ? meanNumber(similarities) : 0,
    maximumSimilarity: similarities.length ? Math.max(...similarities) : 0,
    nearIdenticalPairs: similarities.filter((similarity) => similarity >= 0.97).length,
  };
}

function meanNumber(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function pushPixel(
  pixels: FacePixelInstruction[],
  x: number,
  y: number,
  role: FacePaletteRole,
  cluster: FacePixelInstruction["cluster"],
): void {
  if (x < 0 || x > 7 || y < 0 || y > 7) return;
  const existing = pixels.findIndex((pixel) => pixel.x === x && pixel.y === y);
  const next = { x, y, role, cluster };
  if (existing === -1) pixels.push(next);
  else pixels[existing] = next;
}

function connectedComponents(points: Array<{ x: number; y: number }>): number {
  const remaining = new Set(points.map((point) => `${point.x},${point.y}`));
  let components = 0;
  while (remaining.size > 0) {
    components++;
    const first = remaining.values().next().value as string;
    remaining.delete(first);
    const queue = [first];
    while (queue.length > 0) {
      const [x, y] = queue.shift()!.split(",").map(Number);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const key = `${x + dx},${y + dy}`;
        if (remaining.delete(key)) queue.push(key);
      }
    }
  }
  return components;
}

export function measureFacePixelPlanCost(plan: Omit<FacePixelPlan, "candidateCost"> | FacePixelPlan): PerceptualQuantizationCost {
  const layout = plan.layout;
  const mouth = plan.pixels.filter((pixel) => pixel.cluster === "mouth");
  const violations: string[] = [];
  const mouthXs = mouth.map((pixel) => pixel.x);
  const mouthWidth = mouthXs.length ? Math.max(...mouthXs) - Math.min(...mouthXs) + 1 : 0;
  const contract = layout.renderContract;
  if (contract.mouth) {
    if (mouthWidth < contract.mouth.minimumPerceptualWidth) violations.push("mouth perceptual width below contract");
    const teeth = mouth.filter((pixel) => pixel.role === "teeth");
    const boundary = mouth.filter((pixel) => pixel.role === "lip" || pixel.role === "mouth_shadow");
    if (contract.mouth.teethReadable && teeth.length === 0) violations.push("teeth role missing");
    if (contract.mouth.teethReadable && boundary.length === 0) violations.push("mouth boundary missing");
    if (contract.mouth.opening === "closed" && teeth.length > 0) violations.push("closed mouth contains teeth topology");
    const flatWhiteBar = teeth.length >= 3 && mouth.every((pixel) => pixel.y === mouth[0].y && pixel.role === "teeth");
    if (flatWhiteBar) violations.push("mouth collapsed to flat white bar");
    if (contract.mouth.cornerDirection === "upward_or_level" && layout.mouthCornerOffsets.some((offset) => offset > 0)) violations.push("smile corner points downward");
    if (contract.mouth.preserveAsymmetry && layout.mouthCornerOffsets[0] === layout.mouthCornerOffsets[1]) violations.push("distinctive mouth asymmetry lost");
  }
  if (contract.eyes) {
    const gap = Math.min(...layout.rightEyeXs) - Math.max(...layout.leftEyeXs) - 1;
    if (gap < contract.eyes.minimumInterEyeGap) violations.push("eye spacing below contract");
    if (contract.eyes.preserveAsymmetry && layout.eyeTopology !== "asymmetric") violations.push("distinctive eye asymmetry lost");
  }
  if (contract.glasses) {
    const frontFrame = plan.glassesPlan.framePixels.filter((point) => point.face === "front");
    const left = frontFrame.filter((point) => point.x <= 3);
    const right = frontFrame.filter((point) => point.x >= 4);
    const bridge = frontFrame.filter((point) => point.role === "bridge");
    if (left.length === 0 || right.length === 0) violations.push("glasses lens footprint missing");
    if (bridge.length === 0) violations.push("glasses bridge missing");
    if (frontFrame.length < Math.max(contract.glasses.minimumFootprint, plan.glassesPlan.minimumReadablePixels)) violations.push("glasses footprint below contract");
  }
  const clusterPenalty = Math.max(0, connectedComponents(mouth) - 1) * 0.2;
  const isolated = mouth.filter((pixel) => !mouth.some((other) => other !== pixel && Math.abs(other.x - pixel.x) <= 1 && Math.abs(other.y - pixel.y) <= 1)).length;
  const isolatedPixelPenalty = isolated / Math.max(1, mouth.length);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const currentLeftEye = mean(layout.leftEyeXs);
  const currentRightEye = mean(layout.rightEyeXs);
  const salienceScore = (axis: string) => [...layout.salience.primary, ...layout.salience.secondary, ...layout.salience.tertiary]
    .find((cue) => cue.axis === axis)?.score ?? 0;
  const eyeSpacingError = Math.abs((currentRightEye - currentLeftEye) - layout.geometryTarget.eyeSpacing) / 4;
  const eyeWidthError = mean([
    Math.abs(layout.leftEyeWidth - layout.geometryTarget.leftEyeWidth) / 3,
    Math.abs(layout.rightEyeWidth - layout.geometryTarget.rightEyeWidth) / 3,
  ]);
  const eyePositionError = mean([
    Math.abs(currentLeftEye - layout.geometryTarget.leftEyeCenterX) / 4,
    Math.abs(currentRightEye - layout.geometryTarget.rightEyeCenterX) / 4,
    Math.abs(layout.leftEyeRow - layout.geometryTarget.leftEyeRow) / 2,
    Math.abs(layout.rightEyeRow - layout.geometryTarget.rightEyeRow) / 2,
  ]);
  const browRelationError = mean([
    Math.abs((layout.leftEyeRow - layout.leftBrowRow) - layout.geometryTarget.leftBrowEyeDistance) / 3,
    Math.abs((layout.rightEyeRow - layout.rightBrowRow) - layout.geometryTarget.rightBrowEyeDistance) / 3,
  ]);
  const mouthGeometryError = mean([
    Math.abs(layout.mouthCenterX - layout.geometryTarget.mouthCenterX) / 4,
    Math.abs(layout.mouthRow - layout.geometryTarget.mouthRow) / 2,
    Math.abs(layout.mouthWidth - layout.geometryTarget.mouthWidth) / 5,
  ]);
  const visibleStart = Math.floor((8 - layout.faceWindow.visibleWidthAtEyes) / 2);
  const visibleEnd = visibleStart + layout.faceWindow.visibleWidthAtEyes - 1;
  const outsideEyePixels = [...layout.leftEyeXs, ...layout.rightEyeXs].filter((x) => x < visibleStart || x > visibleEnd).length;
  const faceWindowConflict = outsideEyePixels / Math.max(1, layout.leftEyeXs.length + layout.rightEyeXs.length);
  const weightedGeometryTerms = [
    { value: eyeSpacingError, weight: 1 + salienceScore("eye_spacing") * 1.5 },
    { value: eyeWidthError, weight: 0.8 + salienceScore("eye_width") },
    { value: eyePositionError, weight: 1 },
    { value: browRelationError, weight: 0.65 + salienceScore("brow_position") },
    { value: mouthGeometryError, weight: 0.8 + Math.max(salienceScore("mouth_width"), salienceScore("mouth_topology")) },
    { value: faceWindowConflict, weight: 1.5 + salienceScore("face_width") },
  ];
  const geometryError = weightedGeometryTerms.reduce((sum, term) => sum + term.value * term.weight, 0) /
    weightedGeometryTerms.reduce((sum, term) => sum + term.weight, 0);
  const protectedViolation = (violation: string) =>
    (contract.mouth?.protected && /mouth|teeth|smile/.test(violation)) ||
    (contract.eyes?.protected && /eye/.test(violation)) ||
    (contract.glasses?.protected && /glasses/.test(violation));
  const p5ContractViolations = violations.filter(protectedViolation).length;
  const expressionPenalty =
    violations.filter((violation) => /mouth|teeth|smile/.test(violation)).length * 0.3 +
    (contract.mouth && layout.mouthTopology !== contract.mouth.preferredTopology ? 0.18 : 0);
  const overlayConflictPenalty = plan.glassesPlan.framePixels.filter((point) => point.face === "front" && point.y < layout.hairlineDepthByColumn[point.x]).length / Math.max(1, plan.glassesPlan.framePixels.length);
  // One mouth-width cell is the smallest normalized geometry change in the
  // six-term cost. This is the measurement resolution, not a tuned score.
  const meaningfulMargin = 1 / (5 * 6);
  return {
    direction: "lower_is_better",
    geometryError,
    eyeSpacingError,
    eyeWidthError,
    browRelationError,
    mouthGeometryError,
    faceWindowConflict,
    p5ContractViolations,
    clusterPenalty,
    isolatedPixelPenalty,
    expressionPenalty,
    overlayConflictPenalty,
    totalCost: geometryError + p5ContractViolations * 10 + clusterPenalty + isolatedPixelPenalty + expressionPenalty + overlayConflictPenalty * 0.4,
    meaningfulMargin,
    violations,
  };
}

function facePixelPlan(
  analysis: PhotoAnalysis,
  layout: FaceLayoutPlan,
  variantId: FacePixelPlan["variantId"] = "primary",
): FacePixelPlan {
  const pixels: FacePixelInstruction[] = [];
  const pushFringePixel = (x: number, y: number, role: "hair_mid" | "hair_shadow") => {
    const owner = pixels.find((pixel) => pixel.x === x && pixel.y === y);
    if (owner && owner.cluster !== "fringe" && owner.cluster !== "complexion") return;
    pushPixel(pixels, x, y, role, "fringe");
  };
  if (layout.geometryUsage.faceShape && layout.salience.pixelBudget.faceBoundary > 0) {
    const shadeBoundary = (row: number, width: number) => {
      const inset = Math.max(0, Math.min(2, Math.floor((8 - width) / 2)));
      if (inset === 0) return;
      const shifted = layout.faceShape.asymmetryOffset;
      pushPixel(pixels, Math.max(0, inset - 1 + shifted), row, "skin_shadow", "complexion");
      pushPixel(pixels, Math.min(7, 8 - inset + shifted), row, "skin_shadow", "complexion");
    };
    shadeBoundary(5, layout.faceShape.cheekWidth);
    shadeBoundary(6, layout.faceShape.jawWidth);
  }

  const eyePairs = [
    { xs: layout.leftEyeXs, width: layout.leftEyeWidth, row: layout.leftEyeRow, browRow: layout.leftBrowRow },
    { xs: layout.rightEyeXs, width: layout.rightEyeWidth, row: layout.rightEyeRow, browRow: layout.rightBrowRow },
  ];
  const asymmetricOpenSide = layout.leftEyeWidth !== layout.rightEyeWidth
    ? layout.leftEyeWidth > layout.rightEyeWidth ? 0 : 1
    : layout.leftEyeRow !== layout.rightEyeRow
      ? layout.leftEyeRow < layout.rightEyeRow ? 0 : 1
      : 1;
  eyePairs.forEach(({ xs, width, row, browRow }, index) => {
    const cluster = index === 0 ? "left_eye" : "right_eye";
    const ordered = index === 0 ? [...xs] : [...xs].reverse();
    const extension = index === 0 ? Math.max(...ordered) + 1 : Math.min(...ordered) - 1;
    const eyeXs = width === 1 ? [ordered[0]] : width === 3 && ordered.length < 3 ? [...ordered, extension] : ordered;
    eyeXs.forEach((x, position) => {
      const tiltOffset = position === 0 ? layout.eyeTiltOffset : 0;
      const openTopology = layout.eyeTopology === "open_iris_sclera" || (layout.eyeTopology === "asymmetric" && index === asymmetricOpenSide);
      const smilingSquint = layout.eyeTopology === "smiling_squint";
      pushPixel(pixels, x, row + tiltOffset, openTopology && position === 0 ? "sclera" : "iris", cluster);
      if (openTopology && position === eyeXs.length - 1) pushPixel(pixels, x, Math.min(7, row + 1), "iris", cluster);
      if (smilingSquint && position === 0 && eyeXs.length > 1) pushPixel(pixels, x, Math.max(3, row - 1), "iris", cluster);
      const browTilt = position === 0 ? layout.browTiltOffset : 0;
      const browY = Math.max(1, Math.min(row - 1, browRow + browTilt));
      pushPixel(pixels, x, browY, "brow", cluster);
      if (layout.browThickness === "strong" && position === 0) pushPixel(pixels, x, Math.max(1, browY - 1), "brow", cluster);
    });
    // One-cell eyes otherwise collapse a confident brow tilt to a single
    // dot. Spend one adjacent cell to retain the measured slope while keeping
    // both cells above the eye row.
    if (width === 1 && layout.browTiltOffset !== 0 && layout.salience.pixelBudget.brows >= 2) {
      const innerX = ordered[0] + (index === 0 ? 1 : -1);
      const innerY = layout.browTiltOffset > 0
        ? Math.max(1, browRow - 1)
        : Math.min(row - 1, browRow);
      pushPixel(pixels, innerX, innerY, "brow", cluster);
    }
  });
  // glassesMask is declarative layout evidence. The renderer applies it on
  // the outer layer so frames do not overwrite the base-layer irises.
  if (layout.salience.pixelBudget.nose > 0 && layout.noseStrength >= 0.35) pushPixel(pixels, layout.noseX, layout.noseY, "nose_shadow", "nose");
  const mouthStart = Math.max(0, Math.min(8 - layout.mouthWidth, Math.round(layout.mouthCenterX - (layout.mouthWidth - 1) / 2)));
  const mouthEnd = mouthStart + layout.mouthWidth - 1;
  const mouthY = (offset = 0) => Math.max(4, Math.min(7, layout.mouthRow + offset));
  const semanticCornerLift = layout.mouthTopology === "wide_teeth_smile" && layout.renderContract.mouth?.cornerDirection === "upward_or_level" ? -1 : 0;
  const leftCornerY = mouthY(Math.min(layout.mouthCornerOffsets[0], semanticCornerLift));
  const rightCornerY = mouthY(Math.min(layout.mouthCornerOffsets[1], semanticCornerLift));
  const putMouth = (x: number, y: number, role: FacePaletteRole) => pushPixel(pixels, x, y, role, "mouth");
  if (layout.mouthOpening === "closed" || layout.mouthTopology === "closed_compact" || layout.mouthTopology === "closed_wide") {
    for (let x = mouthStart; x <= mouthEnd; x++) putMouth(x, x === mouthStart ? leftCornerY : x === mouthEnd ? rightCornerY : mouthY(), "lip");
  } else {
    putMouth(mouthStart, leftCornerY, "lip");
    putMouth(mouthEnd, rightCornerY, "lip");
    const teethTopology = layout.mouthOpening === "teeth" && ["teeth_smile", "wide_teeth_smile", "asymmetric_smile"].includes(layout.mouthTopology);
    for (let x = mouthStart + 1; x < mouthEnd; x++) putMouth(x, mouthY(), teethTopology ? "teeth" : "mouth_shadow");
    if (layout.mouthWidth === 2) putMouth(mouthEnd, mouthY(), teethTopology ? "teeth" : "mouth_shadow");
    if (["open_wide", "teeth_smile", "wide_teeth_smile", "asymmetric_smile"].includes(layout.mouthTopology) && layout.mouthRow < 7) {
      const center = Math.max(mouthStart + 1, Math.min(mouthEnd - 1, Math.round(layout.mouthCenterX)));
      putMouth(center, mouthY(1), "mouth_shadow");
      if (layout.mouthTopology === "wide_teeth_smile" && layout.mouthWidth >= 4) {
        const secondBoundary = Math.min(mouthEnd - 1, center + 1) === center
          ? Math.max(mouthStart + 1, center - 1)
          : Math.min(mouthEnd - 1, center + 1);
        putMouth(secondBoundary, mouthY(1), "mouth_shadow");
      }
    }
  }

  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < layout.hairlineDepthByColumn[x]; y++) {
      const isTip = y === layout.hairlineDepthByColumn[x] - 1;
      const fallsAwayFromPart = analysis.renderHints.hairPart === "left" ? x <= 2 : analysis.renderHints.hairPart === "right" ? x >= 5 : x >= 4;
      pushFringePixel(x, y, isTip || fallsAwayFromPart ? "hair_shadow" : "hair_mid");
    }
  }
  const leftSideMargin = layout.geometryUsage.faceWindow
    ? Math.max(0, Math.min(2, 2 - layout.faceWindow.leftTempleWidth))
    : Math.floor((8 - layout.exposedFaceWidth) / 2);
  const rightSideMargin = layout.geometryUsage.faceWindow
    ? Math.max(0, Math.min(2, 2 - layout.faceWindow.rightTempleWidth))
    : Math.floor((8 - layout.exposedFaceWidth) / 2);
  for (let y = 1; y < Math.min(layout.leftEyeRow, layout.rightEyeRow); y++) {
    for (let x = 0; x < leftSideMargin; x++) {
      pushFringePixel(x, y, "hair_shadow");
    }
    for (let x = 0; x < rightSideMargin; x++) pushFringePixel(7 - x, y, "hair_mid");
  }

  const plan: Omit<FacePixelPlan, "candidateCost"> = {
    width: 8,
    height: 8,
    coordinateSpace: "head.base.front",
    pixels,
    protectedClusters: [
      { name: "left_eye", minimumPixels: 2 },
      { name: "right_eye", minimumPixels: 2 },
      { name: "mouth", minimumPixels: 2 },
      ...(layout.protectedGeometry.includes("glasses") && layout.glassesMask.length > 0
        ? [{ name: "glasses" as const, minimumPixels: Math.min(4, layout.glassesMask.length) }]
        : []),
      ...(layout.protectedGeometry.includes("hairline") && layout.hairlineDepth > 0
        ? [{ name: "fringe" as const, minimumPixels: 2 }]
        : []),
    ],
    layout,
    variantId,
    source: analysis.identityGeometry ? "identity_geometry" : "semantic_fallback",
    protectedGeometry: [...layout.protectedGeometry],
    renderContract: structuredClone(layout.renderContract),
    glassesPlan: buildGlassesStructurePlan(analysis, layout),
    salience: structuredClone(layout.salience),
  };
  return { ...plan, candidateCost: measureFacePixelPlanCost(plan) };
}

export function buildFacePixelPlanVariants(
  analysis: PhotoAnalysis,
  maximum = 3,
): FacePixelPlan[] {
  const explicitNoGlasses = /\b(?:no|without|not wearing)\s+(?:any\s+)?(?:eye)?glasses\b/.test(
    `${analysis.observed.accessories} ${analysis.negativePrompt}`.toLowerCase(),
  );
  // Observation/explicit absence outranks the coarse fallback enum before the
  // render contract is built. Normalizing only the final glasses painter is
  // too late: it leaves a protected glasses contract with no valid footprint.
  const planningAnalysis = explicitNoGlasses && analysis.fallbackFeatures.glasses !== "none"
    ? {
        ...analysis,
        fallbackFeatures: { ...analysis.fallbackFeatures, glasses: "none" as const },
      }
    : analysis;
  const plans = buildQuantizedLayoutVariants(planningAnalysis, maximum)
    .map((variant) => facePixelPlan(planningAnalysis, variant.layout, variant.id))
    .filter((plan) => plan.candidateCost.violations.length === 0);
  if (plans.length <= 1) return plans;
  const primary = plans.find((plan) => plan.variantId === "primary");
  const alternatives = plans.filter((plan) => plan !== primary).sort((first, second) => first.candidateCost.totalCost - second.candidateCost.totalCost);
  return [...(primary ? [primary] : []), ...alternatives].slice(0, Math.max(1, Math.min(3, maximum)));
}

function hairPlan(analysis: PhotoAnalysis, facePlan: FacePixelPlan): HairPlan {
  const hints = analysis.renderHints;
  const hairEvidence = `${analysis.observed.hair} ${analysis.identityPrompt} ${analysis.canonicalIdentity.overallImpression} ${analysis.canonicalIdentity.mustPreserve.join(" ")}`.toLowerCase();
  const bald = analysis.fallbackFeatures.hairstyle === "bald" || /\b(?:bald|balding|bald top|bare scalp|receding hairline)\b/.test(hairEvidence);
  const lengthClass: HairPlan["lengthClass"] = bald
    ? "none"
    : ["cropped", "ear"].includes(hints.overallHairLength)
      ? "short"
      : ["jaw", "shoulder"].includes(hints.overallHairLength)
        ? "medium"
        : "long";
  const template: HairTemplate = bald
    ? "bald"
    : hints.hairTexture === "coily"
      ? "coily_volume"
      : hints.hairTexture === "curly"
        ? "curly_volume"
        : lengthClass === "long"
          ? "long_curtain"
          : lengthClass === "medium"
            ? "medium_bob"
            : "short_cap";
  const continuousFaces: HairPlan["continuousFaces"] =
    lengthClass === "long"
      ? ["head.front", "head.top", "head.left", "head.right", "head.back", "body.back", "body.left", "body.right"]
      : ["head.front", "head.top", "head.left", "head.right", "head.back"];
  const salience = buildHairIdentitySaliencePlan(analysis);
  const headMask = buildHeadMaskPlan(analysis, facePlan.layout, template, lengthClass, salience);
  const structure = buildHairStructurePlan(analysis, facePlan.layout, headMask, salience);
  return {
    template,
    lengthClass,
    texture: hints.hairTexture,
    fringe: hints.bangs,
    part: hints.hairPart,
    continuousFaces,
    overlayPolicy: "structure_aware",
    minimumInvention: true,
    salience,
    headMask,
    structure,
  };
}

function curlyFootprint(
  region: CurlyMassRegion,
  centerRow: number,
  width: number,
  spanRows: number,
): Array<{ face: HeadMaskFace; x: number; y: number }> {
  const left = region.endsWith("left");
  const crown = region.startsWith("crown");
  const lower = region.startsWith("lower");
  const points: Array<{ face: HeadMaskFace; x: number; y: number }> = [];
  const addPoint = (face: HeadMaskFace, x: number, y: number) => {
    const point = { face, x: Math.max(0, Math.min(7, x)), y: Math.max(0, Math.min(7, y)) };
    if (!points.some((candidate) => candidate.face === point.face && candidate.x === point.x && candidate.y === point.y)) points.push(point);
  };
  const addScallop = (face: HeadMaskFace, centerX: number, centerY: number, footprintWidth: number, footprintHeight: number) => {
    const leftX = centerX - Math.floor((footprintWidth - 1) / 2);
    const topY = centerY - Math.floor((footprintHeight - 1) / 2);
    for (let dy = 0; dy < footprintHeight; dy++) for (let dx = 0; dx < footprintWidth; dx++) {
      const corner = footprintWidth >= 3 && footprintHeight >= 3 &&
        ((dx === 0 || dx === footprintWidth - 1) && (dy === 0 || dy === footprintHeight - 1));
      if (!corner) addPoint(face, leftX + dx, topY + dy);
    }
  };
  const readableWidth = Math.max(2, Math.min(4, width));
  const readableHeight = Math.max(2, Math.min(4, spanRows));
  if (crown) {
    const centerX = left ? 2 : 5;
    const topCenterY = Math.max(2, Math.min(6, 6 - Math.floor(centerRow / 2)));
    addScallop("top", centerX, topCenterY, readableWidth, readableHeight);
    // Crown bumps cross the top/front edge as paired pixels; the profile is
    // source-shaped instead of a uniform one-row outer cap.
    addPoint("top", centerX, 7);
    addPoint("front", centerX, 0);
    return points;
  }
  const face: HeadMaskFace = left ? "left" : "right";
  const centerX = lower ? (left ? 5 : 2) : (left ? 1 : 6);
  addScallop(face, centerX, centerRow, readableWidth, readableHeight);
  if (lower) {
    const backX = left ? 1 : 6;
    addScallop("back", backX, centerRow, Math.max(2, readableWidth - 1), readableHeight);
    // left x7 <-> back x0 and right x0 <-> back x7
    addPoint(face, left ? 7 : 0, centerRow);
    addPoint("back", left ? 0 : 7, centerRow);
  } else {
    // left x0 <-> front x7 and right x7 <-> front x0
    addPoint(face, left ? 0 : 7, centerRow);
    addPoint("front", left ? 7 : 0, centerRow);
  }
  return points;
}

function buildCurlySilhouettePlan(
  analysis: PhotoAnalysis,
  layout: FaceLayoutPlan,
  endpointRows: { left: number; right: number },
): CurlySilhouettePlan | undefined {
  if (!layout.geometryUsage.majorVolumePeaks || layout.majorVolumePeaks.length === 0) return undefined;
  const geometryByRegion = new Map((analysis.identityGeometry?.majorVolumePeaks ?? []).map((peak) => [peak.region, peak]));
  const candidates: CurlySilhouetteMass[] = layout.majorVolumePeaks.map((peak) => {
    const source = geometryByRegion.get(peak.region);
    return {
      id: `curl-lobe-${peak.region.replace("_", "-")}`,
      region: peak.region,
      sourceRegions: [peak.region],
      sourceEvidence: [{ region: peak.region, evidence: source?.evidence ?? "inferred", confidence: source?.confidence ?? 0.5 }],
      centerRow: peak.row,
      spanRows: Math.max(2, peak.height),
      width: Math.max(2, peak.width),
      protrusion: peak.protrusion,
      layerRole: "both" as const,
      outerPoints: curlyFootprint(peak.region, peak.row, peak.width, peak.height),
    };
  });
  const merged: CurlySilhouetteMass[] = [];
  for (const candidate of candidates) {
    const candidateKeys = new Set(candidate.outerPoints.map((point) => `${point.face}:${point.x},${point.y}`));
    const collision = merged.find((mass) => {
      if (mass.region !== candidate.region) return false;
      const overlap = mass.outerPoints.filter((point) => candidateKeys.has(`${point.face}:${point.x},${point.y}`)).length;
      return overlap / Math.max(1, Math.min(mass.outerPoints.length, candidate.outerPoints.length)) >= 0.6;
    });
    if (!collision) {
      merged.push(candidate);
      continue;
    }
    // Repeated source peaks that collapse to the same 8x8 footprint are
    // merged deterministically. Keep every source region/evidence record and
    // bias the retained dimensions toward the stronger physical protrusion.
    const firstWeight = Math.max(0.1, collision.protrusion);
    const secondWeight = Math.max(0.1, candidate.protrusion);
    const weight = firstWeight + secondWeight;
    collision.centerRow = Math.round((collision.centerRow * firstWeight + candidate.centerRow * secondWeight) / weight);
    collision.spanRows = Math.max(collision.spanRows, candidate.spanRows);
    collision.width = Math.max(collision.width, candidate.width);
    collision.protrusion = Math.max(collision.protrusion, candidate.protrusion);
    collision.sourceRegions.push(...candidate.sourceRegions);
    collision.sourceEvidence.push(...candidate.sourceEvidence);
    collision.outerPoints = curlyFootprint(collision.region, collision.centerRow, collision.width, collision.spanRows);
  }
  const crownOuterPoints: CurlySilhouettePlan["crownOuterPoints"] = [];
  const addCrownPoint = (face: "front" | "top", x: number, y: number) => {
    if (!crownOuterPoints.some((point) => point.face === face && point.x === x && point.y === y)) crownOuterPoints.push({ face, x, y });
  };
  for (let x = 0; x < 8; x++) {
    const row = x <= 2 ? layout.crownGeometry.leftRow : x >= 5 ? layout.crownGeometry.rightRow : layout.crownGeometry.centerRow;
    const depth = Math.max(1, Math.min(3, 3 - row));
    for (let y = 8 - depth; y < 8; y++) addCrownPoint("top", x, y);
    for (let y = row; y <= Math.min(1, row + 1); y++) addCrownPoint("front", x, y);
  }
  // The measured apex gets one interior top cell, so shifting apex X changes
  // top-view occupancy even when left/center/right rows quantize together.
  addCrownPoint("top", layout.crownGeometry.apexColumn, 5);
  return {
    sourcePeakCount: candidates.length,
    masses: merged,
    crownOuterPoints,
    endpointRows: { ...endpointRows },
    crownProfile: {
      leftRow: layout.crownGeometry.leftRow,
      centerRow: layout.crownGeometry.centerRow,
      rightRow: layout.crownGeometry.rightRow,
      apexColumn: layout.crownGeometry.apexColumn,
    },
  };
}

function buildHeadMaskPlan(
  analysis: PhotoAnalysis,
  layout: FaceLayoutPlan,
  template: HairTemplate,
  lengthClass: HairPlan["lengthClass"],
  salience: HairIdentitySaliencePlan,
): HeadMaskPlan {
  const geometry = analysis.identityGeometry?.headSilhouette;
  const useGeometry = Boolean(geometry && geometry.confidence >= 0.55 && analysis.identityGeometry!.confidence.headSilhouette >= 0.55);
  const faces: HeadMaskPlan["faces"] = { front: [], top: [], left: [], right: [], back: [] };
  const widthByRow: HeadMaskPlan["widthByRow"] = { left: Array(8).fill(0), right: Array(8).fill(0), back: Array(8).fill(0) };
  const add = (face: HeadMaskFace, x: number, y: number, role: HeadMaskPoint["role"] = "hair") => {
    if (x < 0 || x > 7 || y < 0 || y > 7 || faces[face].some((point) => point.x === x && point.y === y)) return;
    faces[face].push({ x, y, role });
  };
  if (template === "bald") {
    return { coordinateSpace: "head.overlay", source: useGeometry ? "identity_geometry" : "semantic_template", faces, partColumn: null, endpointRows: { left: 0, right: 0 }, widthByRow, foreheadExposure: 1, earExposure: { left: 1, right: 1 } };
  }
  if (useGeometry && geometry) {
    const covering = geometry.covering;
    const role: HeadMaskPoint["role"] = covering ? "covering" : "hair";
    const leftContour = covering?.leftContourByRow ?? geometry.leftContourByRow;
    const rightContour = covering?.rightContourByRow ?? geometry.rightContourByRow;
    const crownRows = layout.geometryUsage.crown
      ? [layout.crownGeometry.leftRow, layout.crownGeometry.centerRow, layout.crownGeometry.rightRow]
      : [Math.max(0, Math.min(2, Math.round(geometry.crownTopY * 7)))];
    const crownRow = Math.min(...crownRows);
    const crownRowAt = (x: number) => layout.geometryUsage.crown
      ? x <= 2 ? layout.crownGeometry.leftRow : x >= 5 ? layout.crownGeometry.rightRow : layout.crownGeometry.centerRow
      : crownRow;
    const endpointLeftRaw = geometry.hairEndpointLeftY * 7;
    const endpointRightRaw = geometry.hairEndpointRightY * 7;
    let endpointLeft = Math.max(crownRow, Math.min(7, Math.round(endpointLeftRaw)));
    let endpointRight = Math.max(crownRow, Math.min(7, Math.round(endpointRightRaw)));
    if (endpointLeft === endpointRight && Math.abs(geometry.hairEndpointLeftY - geometry.hairEndpointRightY) + Number.EPSILON >= 0.08 && Math.max(
      hairSalienceScore(salience, "endpoint_height"),
      hairSalienceScore(salience, "side_volume"),
      hairSalienceScore(salience, "crown_asymmetry"),
    ) >= 0.45) {
      // At a half-cell collision, preserve the measured ordering by moving the
      // lower-error endpoint, never by extending beyond the source interval.
      // Curly termination is a visible mass boundary, so keep the longer side
      // at nearest-row and conservatively shorten the compact side. Extending
      // both masses downward invents length and recreates a symmetric bob.
      if (template === "curly_volume") {
        if (endpointLeftRaw > endpointRightRaw) endpointRight = Math.max(crownRow, Math.floor(endpointRightRaw));
        else endpointLeft = Math.max(crownRow, Math.floor(endpointLeftRaw));
      } else if (endpointLeftRaw > endpointRightRaw) {
        const shortenRightError = endpointRightRaw - Math.floor(endpointRightRaw);
        const extendLeftError = Math.ceil(endpointLeftRaw) - endpointLeftRaw;
        if (shortenRightError <= extendLeftError) endpointRight = Math.max(crownRow, Math.floor(endpointRightRaw));
        else endpointLeft = Math.min(7, Math.ceil(endpointLeftRaw));
      } else {
        const shortenLeftError = endpointLeftRaw - Math.floor(endpointLeftRaw);
        const extendRightError = Math.ceil(endpointRightRaw) - endpointRightRaw;
        if (shortenLeftError <= extendRightError) endpointLeft = Math.max(crownRow, Math.floor(endpointLeftRaw));
        else endpointRight = Math.min(7, Math.ceil(endpointRightRaw));
      }
    }
    for (let y = crownRow; y <= Math.max(endpointLeft, endpointRight); y++) {
      const left = Math.max(0, Math.min(7, Math.floor(leftContour[y] * 8)));
      const right = Math.max(left, Math.min(7, Math.ceil(rightContour[y] * 8) - 1));
      for (let x = left; x <= right; x++) {
        if (y < crownRowAt(x)) continue;
        if ((x <= 1 && y <= endpointLeft) || (x >= 6 && y <= endpointRight) || y <= 1) add("front", x, y, role);
      }
    }
    const maximumSideWidth = covering ? 8 : 5;
    const sideScale = covering ? 7 : 3;
    const hairPriority = analysis.canonicalIdentity.features
      .filter((feature) => feature.category === "hair" || feature.category === "silhouette")
      .reduce((maximum, feature) => Math.max(maximum, feature.priority), 1);
    // Error diffusion preserves the average of sub-pixel contour measurements
    // across connected rows. High-priority identity hair gets the full residual;
    // lower-priority hair stays closer to ordinary nearest-cell rounding.
    const quantizeConnectedWidths = (raw: number[], side: "left" | "right"): number[] => {
      let residual = 0;
      const salienceWeight = Math.max(
        hairSalienceScore(salience, "side_volume"),
        hairSalienceScore(salience, "crown_asymmetry"),
        hairSalienceScore(salience, "ear_exposure"),
      );
      const residualWeight = 0.25 + (hairPriority / 5) * 0.35 + salienceWeight * 0.4;
      return raw.map((value, row) => {
        if (value <= 0) return 0;
        const bounded = Math.max(1, Math.min(maximumSideWidth, value));
        const adjusted = bounded + residual * residualWeight;
        const quantized = Math.max(1, Math.min(maximumSideWidth, Math.round(adjusted)));
        // Carry more of a high-salience contour residual into the adjacent row,
        // where a coherent one-cell step can retain it without adding noise.
        const endpoint = side === "left" ? endpointLeft : endpointRight;
        const endpointWeight = row >= endpoint - 1 ? 0.65 : 1;
        residual = (adjusted - quantized) * endpointWeight;
        return quantized;
      });
    };
    const rawLeftWidths = Array(8).fill(0) as number[];
    const rawRightWidths = Array(8).fill(0) as number[];
    for (let y = crownRow; y <= endpointLeft; y++) {
      const templeTaper = layout.geometryUsage.temple && y >= layout.templeGeometry.leftStartRow
        ? layout.templeGeometry.leftRecession * 0.65
        : 0;
      const earTaper = y >= endpointLeft - 1 ? geometry.earExposureLeft * 2 : 0;
      const contourWidth = (0.5 - leftContour[y]) * 5;
      const contourDelta = (leftContour[Math.max(crownRow, y - 1)] - leftContour[y]) * 8;
      rawLeftWidths[y] = 1 + geometry.sideVolumeLeft * sideScale + contourWidth + contourDelta - earTaper - templeTaper;
    }
    for (let y = crownRow; y <= endpointRight; y++) {
      const templeTaper = layout.geometryUsage.temple && y >= layout.templeGeometry.rightStartRow
        ? layout.templeGeometry.rightRecession * 0.65
        : 0;
      const earTaper = y >= endpointRight - 1 ? geometry.earExposureRight * 2 : 0;
      const contourWidth = (rightContour[y] - 0.5) * 5;
      const contourDelta = (rightContour[y] - rightContour[Math.max(crownRow, y - 1)]) * 8;
      rawRightWidths[y] = 1 + geometry.sideVolumeRight * sideScale + contourWidth + contourDelta - earTaper - templeTaper;
    }
    const quantizedLeftWidths = quantizeConnectedWidths(rawLeftWidths, "left");
    const quantizedRightWidths = quantizeConnectedWidths(rawRightWidths, "right");
    const sourceSideDelta = geometry.sideVolumeLeft - geometry.sideVolumeRight;
    const activeRows = Array.from({ length: Math.max(endpointLeft, endpointRight) - crownRow + 1 }, (_, index) => crownRow + index);
    const quantizedDelta = activeRows.reduce((sum, row) => sum + quantizedLeftWidths[row] - quantizedRightWidths[row], 0);
    if (Math.abs(sourceSideDelta) >= 0.08 && quantizedDelta === 0 && hairSalienceScore(salience, "crown_asymmetry") >= 0.45) {
      const stronger = sourceSideDelta > 0 ? quantizedLeftWidths : quantizedRightWidths;
      const strongerRaw = sourceSideDelta > 0 ? rawLeftWidths : rawRightWidths;
      const row = activeRows
        .filter((candidate) => stronger[candidate] < Math.min(maximumSideWidth, Math.ceil(strongerRaw[candidate])))
        .sort((first, second) => (strongerRaw[second] - stronger[second]) - (strongerRaw[first] - stronger[first]))[0];
      if (row !== undefined) stronger[row]++;
    }
    for (let y = crownRow; y <= endpointLeft; y++) {
      const width = quantizedLeftWidths[y];
      widthByRow.left[y] = width;
      for (let x = 0; x < width; x++) add("left", x, y, role);
    }
    for (let y = crownRow; y <= endpointRight; y++) {
      const width = quantizedRightWidths[y];
      widthByRow.right[y] = width;
      for (let x = 8 - width; x < 8; x++) add("right", x, y, role);
    }
    for (let y = crownRow; y <= Math.max(endpointLeft, endpointRight); y++) {
      const crownBevel = !covering && y === crownRow ? 1 : 0;
      const endpointTaper = !covering && y >= Math.max(endpointLeft, endpointRight) - 1
        ? Math.round(Math.max(geometry.earExposureLeft, geometry.earExposureRight))
        : 0;
      const leftInset = Math.min(2, crownBevel + endpointTaper);
      const rightInset = Math.min(2, crownBevel + endpointTaper);
      for (let x = leftInset; x < 8 - rightInset; x++) {
        const silhouetteEdge = x <= leftInset + 1 || x >= 6 - rightInset;
        const endpointBand = y >= Math.max(endpointLeft, endpointRight) - 1;
        if (covering || silhouetteEdge || endpointBand) add("back", x, y, role);
      }
      widthByRow.back[y] = faces.back.filter((point) => point.y === y).length;
    }
    const leftRootWidth = covering ? 4 : layout.geometryUsage.crown ? layout.crownGeometry.leftWidth : Math.max(1, Math.min(3, Math.round(1 + geometry.sideVolumeLeft * 2)));
    const rightRootWidth = covering ? 4 : layout.geometryUsage.crown ? layout.crownGeometry.rightWidth : Math.max(1, Math.min(3, Math.round(1 + geometry.sideVolumeRight * 2)));
    for (let y = 0; y < 8; y++) {
      const contourIndex = Math.min(7, y);
      const leftInset = covering ? 0 : Math.min(2, Math.max(y === 0 || y === 7 ? 1 : 0, Math.round(leftContour[contourIndex])));
      const rightInset = covering ? 0 : Math.min(2, Math.max(y === 0 || y === 7 ? 1 : 0, Math.round(1 - rightContour[contourIndex])));
      for (let x = leftInset; x < 8 - rightInset; x++) {
        const crownBand = y <= 1 || y >= 6;
        const sideRoot = x < leftRootWidth || x >= 8 - rightRootWidth;
        if (covering || crownBand || sideRoot) add("top", x, y, role);
      }
    }
    const partColumn = geometry.partCenterX === null ? null : Math.max(0, Math.min(7, Math.round(geometry.partCenterX * 7)));
    if (!covering) {
      const openingColumn = partColumn ?? (layout.geometryUsage.crown ? layout.crownGeometry.apexColumn : 3);
      // Hair is an outer silhouette accent, never an opaque second cube.
      // Keep the opening internal so every physical seam remains continuous.
      faces.top = faces.top.filter((point) => !(point.x === openingColumn && point.y >= 2 && point.y <= 4));
    }
    const curlySilhouette = !covering && template === "curly_volume"
      ? buildCurlySilhouettePlan(analysis, layout, { left: endpointLeft, right: endpointRight })
      : undefined;
    if (curlySilhouette) {
      // Endpoints are rendered as two-cell mass terminations, never a single
      // decorative pixel. Attribute them to the lowest measured mass on each
      // side so their provenance survives into HairStructurePlan.
      for (const side of ["left", "right"] as const) {
        const endpoint = side === "left" ? endpointLeft : endpointRight;
        const sideMasses = curlySilhouette.masses.filter((mass) => mass.region.endsWith(side));
        const owner = [...sideMasses].sort((first, second) => {
          const lowerFirst = Number(first.region.startsWith("lower"));
          const lowerSecond = Number(second.region.startsWith("lower"));
          return lowerSecond - lowerFirst || second.centerRow - first.centerRow || second.protrusion - first.protrusion;
        })[0];
        if (!owner || owner.region.startsWith("crown")) continue;
        const face: HeadMaskFace = side;
        const anchor = owner.region.startsWith("lower") ? (side === "left" ? 5 : 2) : (side === "left" ? 1 : 6);
        const terminalXs = [anchor, side === "left" ? Math.min(7, anchor + 1) : Math.max(0, anchor - 1)];
        const existingSideRows = owner.outerPoints.filter((point) => point.face === face).map((point) => point.y);
        const startRow = existingSideRows.length > 0 ? Math.min(endpoint, Math.max(...existingSideRows)) : endpoint;
        for (let y = startRow; y <= endpoint; y++) for (const x of terminalXs) {
          if (!owner.outerPoints.some((point) => point.face === face && point.x === x && point.y === y)) {
            owner.outerPoints.push({ face, x, y });
          }
        }
      }

      const frontFoundation = faces.front.map((point) => ({ ...point }));
      for (const face of ["top", "left", "right", "back"] as const) faces[face] = [];
      faces.front = frontFoundation;
      for (const point of curlySilhouette.crownOuterPoints) add(point.face, point.x, point.y, role);
      for (const mass of curlySilhouette.masses) {
        for (const point of mass.outerPoints) add(point.face, point.x, point.y, role);
        // A narrow, source-positioned root keeps every side/back lobe attached
        // without inflating the complete edge into a generic outer shell.
        for (const face of ["left", "right", "back"] as const) {
          const footprint = mass.outerPoints.filter((point) => point.face === face);
          if (footprint.length === 0) continue;
          const minimumY = Math.min(...footprint.map((point) => point.y));
          const rootX = Math.round(footprint.reduce((sum, point) => sum + point.x, 0) / footprint.length);
          for (let y = 0; y <= minimumY; y++) add(face, rootX, y, role);
        }
      }
      // Complete only the physical top seams that have an occupied neighbor.
      // Both sides of each UV edge receive the same occupancy contract.
      for (const point of faces.front.filter((point) => point.y === 0)) add("top", point.x, 7, role);
      for (const point of faces.back.filter((point) => point.y === 0)) add("top", 7 - point.x, 0, role);
      for (const point of faces.left.filter((point) => point.y === 0)) add("top", 7, 7 - point.x, role);
      for (const point of faces.right.filter((point) => point.y === 0)) add("top", 0, point.x, role);
      for (const face of ["left", "right", "back"] as const) {
        widthByRow[face].fill(0);
        for (let y = 0; y < 8; y++) widthByRow[face][y] = faces[face].filter((point) => point.y === y).length;
      }
    }
    return {
      coordinateSpace: "head.overlay", source: "identity_geometry", faces, partColumn,
      endpointRows: { left: endpointLeft, right: endpointRight }, widthByRow, foreheadExposure: geometry.foreheadExposure,
      earExposure: { left: geometry.earExposureLeft, right: geometry.earExposureRight },
      curlySilhouette,
    };
  }
  const endpoint = lengthClass === "long" ? 7 : lengthClass === "medium" ? 6 : 4;
  for (let y = 0; y <= endpoint; y++) for (let x = 0; x < 8; x++) {
    if (y <= 1 || x <= 1 || x >= 6) add("front", x, y);
    add("back", x, y);
    if (x < (lengthClass === "short" ? 4 : 6)) add("left", x, y);
    if (x >= (lengthClass === "short" ? 4 : 2)) add("right", x, y);
  }
  for (let y = 0; y <= endpoint; y++) {
    const taper = y >= endpoint - 1 ? 1 : 0;
    widthByRow.left[y] = Math.max(1, (lengthClass === "short" ? 4 : 6) - taper);
    widthByRow.right[y] = Math.max(1, (lengthClass === "short" ? 4 : 6) - taper);
    widthByRow.back[y] = 8 - taper * 2;
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) add("top", x, y);
  return { coordinateSpace: "head.overlay", source: "semantic_template", faces, partColumn: null, endpointRows: { left: endpoint, right: endpoint }, widthByRow, foreheadExposure: 0.4, earExposure: { left: 0.5, right: 0.5 } };
}

export function buildIdentityPixelPlans(analysis: PhotoAnalysis): IdentityPixelPlans {
  const facePixelPlan = buildFacePixelPlanVariants(analysis, 1)[0];
  const plannedHair = hairPlan(analysis, facePixelPlan);
  const hueShift: PaletteRampPlan["hueShift"] =
    analysis.renderHints.skinUndertone === "warm"
      ? "warm_lights_cool_shadows"
      : analysis.renderHints.skinUndertone === "cool"
        ? "cool_lights_warm_shadows"
        : "neutral";
  const source: PaletteRampPlan["source"] = "observed";
  const ramps: PaletteRampPlan[] = (["skin", "hair", "top"] as PaletteMaterial[]).map((material) => ({
    material,
    source,
    roles: ["shadow", "base", "light"],
    maxLocalColors: 6,
    hueShift,
  }));
  ramps.push(
    { material: "bottom", source: analysis.visibleRegions.lowerBody ? "observed" : "inferred", roles: ["shadow", "base", "light"], maxLocalColors: 6, hueShift },
    { material: "shoes", source: analysis.visibleRegions.feet ? "observed" : "inferred", roles: ["shadow", "base", "light"], maxLocalColors: 6, hueShift },
  );
  const baseHairGroupIds = plannedHair.structure.groups
    .filter((group) => group.points.some((point) => point.layer === "base"))
    .map((group) => group.id);
  const outerHairGroupIds = plannedHair.structure.groups
    .filter((group) => group.points.some((point) => point.layer === "outer"))
    .map((group) => group.id);
  const protectedBaseFront = facePixelPlan.pixels
    .filter((pixel) => pixel.cluster !== "fringe")
    .map((pixel) => ({ x: pixel.x, y: pixel.y }));
  const protectedOuter = [
    ...facePixelPlan.glassesPlan.framePixels,
    ...facePixelPlan.glassesPlan.sideArms,
  ].map((pixel) => ({ face: pixel.face, x: pixel.x, y: pixel.y }));
  const headIdentityPlan: HeadIdentityPlan = {
    baseFace: facePixelPlan,
    baseHairGroupIds,
    outerHairGroupIds,
    glasses: facePixelPlan.glassesPlan,
    protectedBaseFront,
    protectedOuter,
    p5Contracts: structuredClone(facePixelPlan.renderContract),
    geometryProvenance: { ...facePixelPlan.layout.geometryProvenance },
    compositionOrder: ["base_hair", "outer_hair", "face_landmarks", "glasses", "accessories"],
  };
  return {
    facePixelPlan,
    hairPlan: plannedHair,
    headIdentityPlan,
    palettePlan: {
      observedColors: analysis.observed.colorPalette.slice(0, 12),
      ramps,
      maxGlobalColors: 36,
      noisePolicy: "connected_clusters_only",
    },
    outfitPlan: buildOutfitPlan(analysis),
  };
}
