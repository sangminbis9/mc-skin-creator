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
  type ProtectedGeometry,
} from "./identityQuantization";

export type { FaceLayoutPlan, ProtectedGeometry, QuantizationAxis } from "./identityQuantization";

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
  overlayPolicy: "silhouette_only";
  minimumInvention: true;
  headMask: HeadMaskPlan;
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
      pushPixel(pixels, x, row + tiltOffset, layout.eyeOpenness === "open" && position === 0 ? "sclera" : "iris", cluster);
      if (layout.eyeOpenness === "open" && position === eyeXs.length - 1) pushPixel(pixels, x, Math.min(7, row + 1), "iris", cluster);
      const browTilt = position === 0 ? layout.browTiltOffset : 0;
      pushPixel(pixels, x, Math.max(1, Math.min(4, browRow + browTilt)), "brow", cluster);
      if (layout.browThickness === "strong" && position === 0) pushPixel(pixels, x, Math.min(4, browRow + browTilt + 1), "brow", cluster);
    });
  });
  // glassesMask is declarative layout evidence. The renderer applies it on
  // the outer layer so frames do not overwrite the base-layer irises.
  if (layout.noseStrength >= 0.35) pushPixel(pixels, layout.noseX, layout.noseY, "nose_shadow", "nose");
  const mouthStart = Math.max(0, Math.min(8 - layout.mouthWidth, Math.round(layout.mouthCenterX - (layout.mouthWidth - 1) / 2)));
  for (let position = 0; position < layout.mouthWidth; position++) {
    const x = mouthStart + position;
    const edgeOffset = position === 0 ? layout.mouthCornerOffsets[0] : position === layout.mouthWidth - 1 ? layout.mouthCornerOffsets[1] : 0;
    const teethPosition = layout.mouthWidth <= 2 ? position === 1 : position > 0 && position < layout.mouthWidth - 1;
    pushPixel(
      pixels,
      x,
      Math.max(4, Math.min(7, layout.mouthRow + edgeOffset)),
      layout.mouthOpening === "closed" ? "lip" : layout.mouthOpening === "teeth" && teethPosition ? "teeth" : "mouth_shadow",
      "mouth",
    );
  }

  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < layout.hairlineDepthByColumn[x]; y++) {
      pushPixel(pixels, x, y, (x + y) % 3 === 0 ? "hair_shadow" : "hair_mid", "fringe");
    }
  }
  const sideMargin = Math.floor((8 - layout.exposedFaceWidth) / 2);
  for (let y = 1; y < Math.min(layout.leftEyeRow, layout.rightEyeRow); y++) {
    for (let x = 0; x < sideMargin; x++) {
      pushPixel(pixels, x, y, "hair_shadow", "fringe");
      pushPixel(pixels, 7 - x, y, "hair_mid", "fringe");
    }
  }

  return {
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
  };
}

export function buildFacePixelPlanVariants(
  analysis: PhotoAnalysis,
  maximum = 3,
): FacePixelPlan[] {
  return buildQuantizedLayoutVariants(analysis, maximum)
    .map((variant) => facePixelPlan(analysis, variant.layout, variant.id));
}

function hairPlan(analysis: PhotoAnalysis): HairPlan {
  const hints = analysis.renderHints;
  const bald = analysis.fallbackFeatures.hairstyle === "bald";
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
  return {
    template,
    lengthClass,
    texture: hints.hairTexture,
    fringe: hints.bangs,
    part: hints.hairPart,
    continuousFaces,
    overlayPolicy: "silhouette_only",
    minimumInvention: true,
    headMask,
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
  const add = (face: HeadMaskFace, x: number, y: number, role: HeadMaskPoint["role"] = "hair") => {
    if (x < 0 || x > 7 || y < 0 || y > 7 || faces[face].some((point) => point.x === x && point.y === y)) return;
    faces[face].push({ x, y, role });
  };
  if (template === "bald") {
    return { coordinateSpace: "head.overlay", source: useGeometry ? "identity_geometry" : "semantic_template", faces, partColumn: null, endpointRows: { left: 0, right: 0 }, foreheadExposure: 1, earExposure: { left: 1, right: 1 } };
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
    const leftWidth = Math.max(1, Math.min(8, Math.round(1 + geometry.sideVolumeLeft * 7)));
    const rightWidth = Math.max(1, Math.min(8, Math.round(1 + geometry.sideVolumeRight * 7)));
    for (let y = crownRow; y <= endpointLeft; y++) for (let x = 0; x < leftWidth; x++) add("left", x, y, role);
    for (let y = crownRow; y <= endpointRight; y++) for (let x = 8 - rightWidth; x < 8; x++) add("right", x, y, role);
    for (let y = crownRow; y <= Math.max(endpointLeft, endpointRight); y++) for (let x = 0; x < 8; x++) add("back", x, y, role);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) add("top", x, y, role);
    const partColumn = geometry.partCenterX === null ? null : Math.max(0, Math.min(7, Math.round(geometry.partCenterX * 7)));
    if (!covering) {
      const openingColumn = partColumn ?? 3;
      // Hair is an outer silhouette accent, never an opaque second cube.
      // Keep the opening internal so every physical seam remains continuous.
      faces.top = faces.top.filter((point) => !(point.x === openingColumn && point.y >= 2 && point.y <= 4));
    }
    return {
      coordinateSpace: "head.overlay", source: "identity_geometry", faces, partColumn,
      endpointRows: { left: endpointLeft, right: endpointRight }, foreheadExposure: geometry.foreheadExposure,
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
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) add("top", x, y);
  return { coordinateSpace: "head.overlay", source: "semantic_template", faces, partColumn: null, endpointRows: { left: endpoint, right: endpoint }, foreheadExposure: 0.4, earExposure: { left: 0.5, right: 0.5 } };
}

export function buildIdentityPixelPlans(analysis: PhotoAnalysis): IdentityPixelPlans {
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
  return {
    facePixelPlan: buildFacePixelPlanVariants(analysis, 1)[0],
    hairPlan: hairPlan(analysis),
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
