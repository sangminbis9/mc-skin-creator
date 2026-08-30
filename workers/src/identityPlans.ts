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
}

export interface PerceptualQuantizationCost {
  direction: "lower_is_better";
  geometryError: number;
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

export interface HeadMaskPlan {
  coordinateSpace: "head.overlay";
  source: "identity_geometry" | "semantic_template";
  faces: Record<HeadMaskFace, HeadMaskPoint[]>;
  partColumn: number | null;
  endpointRows: { left: number; right: number };
  widthByRow: { left: number[]; right: number[]; back: number[] };
  foreheadExposure: number;
  earExposure: { left: number; right: number };
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

export interface OutfitPlan {
  observedConstruction: string;
  hiddenCompletion: string;
  lowerBodySource: "observed" | "minimum_inference";
  outerLayerRegions: string[];
  inventionPolicy: "extend_existing_materials_only";
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
  mouthLayoutDistance: number;
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
  const weightedDistance =
    hairlineProfileDistance * 0.29 +
    eyeLayoutDistance * 0.27 +
    glassesMaskDistance * 0.2 +
    mouthLayoutDistance * 0.16 +
    faceWindowDistance * 0.08;
  return {
    eyeLayoutDistance,
    mouthLayoutDistance,
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
  const geometryError = mean([
    Math.abs(currentLeftEye - layout.geometryTarget.leftEyeCenterX) / 4,
    Math.abs(currentRightEye - layout.geometryTarget.rightEyeCenterX) / 4,
    Math.abs(layout.eyeRow - layout.geometryTarget.eyeRow) / 2,
    Math.abs(layout.mouthCenterX - layout.geometryTarget.mouthCenterX) / 4,
    Math.abs(layout.mouthRow - layout.geometryTarget.mouthRow) / 2,
    Math.abs(layout.mouthWidth - layout.geometryTarget.mouthWidth) / 5,
  ]);
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

  const eyePairs = [
    { xs: layout.leftEyeXs, width: layout.leftEyeWidth, row: layout.leftEyeRow, browRow: layout.leftBrowRow },
    { xs: layout.rightEyeXs, width: layout.rightEyeWidth, row: layout.rightEyeRow, browRow: layout.rightBrowRow },
  ];
  eyePairs.forEach(({ xs, width, row, browRow }, index) => {
    const cluster = index === 0 ? "left_eye" : "right_eye";
    const ordered = index === 0 ? [...xs] : [...xs].reverse();
    const extension = index === 0 ? Math.max(...ordered) + 1 : Math.min(...ordered) - 1;
    const eyeXs = width === 1 ? [ordered[0]] : width === 3 && ordered.length < 3 ? [...ordered, extension] : ordered;
    eyeXs.forEach((x, position) => {
      const tiltOffset = position === 0 ? layout.eyeTiltOffset : 0;
      const openTopology = layout.eyeTopology === "open_iris_sclera" || (layout.eyeTopology === "asymmetric" && index === 1);
      const smilingSquint = layout.eyeTopology === "smiling_squint";
      pushPixel(pixels, x, row + tiltOffset, openTopology && position === 0 ? "sclera" : "iris", cluster);
      if (openTopology && position === eyeXs.length - 1) pushPixel(pixels, x, Math.min(7, row + 1), "iris", cluster);
      if (smilingSquint && position === 0 && eyeXs.length > 1) pushPixel(pixels, x, Math.max(3, row - 1), "iris", cluster);
      const browTilt = position === 0 ? layout.browTiltOffset : 0;
      const browY = Math.max(1, Math.min(row - 1, browRow + browTilt));
      pushPixel(pixels, x, browY, "brow", cluster);
      if (layout.browThickness === "strong" && position === 0) pushPixel(pixels, x, Math.max(1, browY - 1), "brow", cluster);
    });
  });
  // glassesMask is declarative layout evidence. The renderer applies it on
  // the outer layer so frames do not overwrite the base-layer irises.
  if (layout.noseStrength >= 0.35) pushPixel(pixels, layout.noseX, layout.noseY, "nose_shadow", "nose");
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
      pushPixel(pixels, x, y, isTip || fallsAwayFromPart ? "hair_shadow" : "hair_mid", "fringe");
    }
  }
  const sideMargin = Math.floor((8 - layout.exposedFaceWidth) / 2);
  for (let y = 1; y < Math.min(layout.leftEyeRow, layout.rightEyeRow); y++) {
    for (let x = 0; x < sideMargin; x++) {
      pushPixel(pixels, x, y, "hair_shadow", "fringe");
      pushPixel(pixels, 7 - x, y, "hair_mid", "fringe");
    }
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
  const headMask = buildHeadMaskPlan(analysis, template, lengthClass);
  const structure = buildHairStructurePlan(analysis, facePlan.layout, headMask);
  return {
    template,
    lengthClass,
    texture: hints.hairTexture,
    fringe: hints.bangs,
    part: hints.hairPart,
    continuousFaces,
    overlayPolicy: "structure_aware",
    minimumInvention: true,
    headMask,
    structure,
  };
}

function buildHeadMaskPlan(
  analysis: PhotoAnalysis,
  template: HairTemplate,
  lengthClass: HairPlan["lengthClass"],
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
    const crownRow = Math.max(0, Math.min(2, Math.round(geometry.crownTopY * 7)));
    const endpointLeft = Math.max(crownRow, Math.min(7, Math.round(geometry.hairEndpointLeftY * 7)));
    const endpointRight = Math.max(crownRow, Math.min(7, Math.round(geometry.hairEndpointRightY * 7)));
    for (let y = crownRow; y <= Math.max(endpointLeft, endpointRight); y++) {
      const left = Math.max(0, Math.min(7, Math.floor(leftContour[y] * 8)));
      const right = Math.max(left, Math.min(7, Math.ceil(rightContour[y] * 8) - 1));
      for (let x = left; x <= right; x++) {
        if ((x <= 1 && y <= endpointLeft) || (x >= 6 && y <= endpointRight) || y <= 1) add("front", x, y, role);
      }
    }
    const maximumSideWidth = covering ? 8 : 5;
    const sideScale = covering ? 7 : 3;
    for (let y = crownRow; y <= endpointLeft; y++) {
      const earTaper = y >= endpointLeft - 1 ? Math.round(geometry.earExposureLeft * 2) : 0;
      const contourWidth = Math.round((0.5 - leftContour[y]) * 5);
      const contourDelta = Math.round((leftContour[Math.max(crownRow, y - 1)] - leftContour[y]) * 8);
      const width = Math.max(1, Math.min(maximumSideWidth, Math.round(1 + geometry.sideVolumeLeft * sideScale) + contourWidth + contourDelta - earTaper));
      widthByRow.left[y] = width;
      for (let x = 0; x < width; x++) add("left", x, y, role);
    }
    for (let y = crownRow; y <= endpointRight; y++) {
      const earTaper = y >= endpointRight - 1 ? Math.round(geometry.earExposureRight * 2) : 0;
      const contourWidth = Math.round((rightContour[y] - 0.5) * 5);
      const contourDelta = Math.round((rightContour[y] - rightContour[Math.max(crownRow, y - 1)]) * 8);
      const width = Math.max(1, Math.min(maximumSideWidth, Math.round(1 + geometry.sideVolumeRight * sideScale) + contourWidth + contourDelta - earTaper));
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
    for (let y = 0; y < 8; y++) {
      const contourIndex = Math.min(7, y);
      const leftInset = covering ? 0 : Math.min(2, Math.max(y === 0 || y === 7 ? 1 : 0, Math.round(leftContour[contourIndex])));
      const rightInset = covering ? 0 : Math.min(2, Math.max(y === 0 || y === 7 ? 1 : 0, Math.round(1 - rightContour[contourIndex])));
      for (let x = leftInset; x < 8 - rightInset; x++) {
        const crownBand = y <= 1 || y >= 6;
        const sideRoot = x <= leftInset + 1 || x >= 6 - rightInset;
        if (covering || crownBand || sideRoot) add("top", x, y, role);
      }
    }
    const partColumn = geometry.partCenterX === null ? null : Math.max(0, Math.min(7, Math.round(geometry.partCenterX * 7)));
    if (!covering) {
      const openingColumn = partColumn ?? 3;
      // Hair is an outer silhouette accent, never an opaque second cube.
      // Keep the opening internal so every physical seam remains continuous.
      faces.top = faces.top.filter((point) => !(point.x === openingColumn && point.y >= 2 && point.y <= 4));
    }
    return {
      coordinateSpace: "head.overlay", source: "identity_geometry", faces, partColumn,
      endpointRows: { left: endpointLeft, right: endpointRight }, widthByRow, foreheadExposure: geometry.foreheadExposure,
      earExposure: { left: geometry.earExposureLeft, right: geometry.earExposureRight },
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
  const lowerCompletion = analysis.visibleRegions.lowerBody
    ? analysis.observed.clothing
    : analysis.inferred.lowerBody?.value || analysis.inferred.lowerBodyDesign?.rationale || "continue the visible outfit with the fewest new cues";
  const outerLayerRegions = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "hair" || feature.category === "accessory" || feature.category === "silhouette")
    .flatMap((feature) => feature.targetRegions);
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
    outfitPlan: {
      observedConstruction: analysis.observed.clothing,
      hiddenCompletion: lowerCompletion,
      lowerBodySource: analysis.visibleRegions.lowerBody ? "observed" : "minimum_inference",
      outerLayerRegions: [...new Set(outerLayerRegions)],
      inventionPolicy: "extend_existing_materials_only",
    },
  };
}
