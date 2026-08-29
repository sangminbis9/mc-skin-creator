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
  const hints = analysis.renderHints;
  const pixels: FacePixelInstruction[] = [];

  // A connected, three-role complexion field is the stable base. Landmark
  // clusters below replace only the coordinates they explicitly own.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const role: FacePaletteRole =
        x === 0 || x === 7 || y === 7
          ? "skin_shadow"
          : x <= 2 && y >= 4
            ? "skin_light"
            : "skin_mid";
      pushPixel(pixels, x, y, role, "complexion");
    }
  }

  const eyePairs = [
    { xs: layout.leftEyeXs, row: layout.leftEyeRow, browRow: layout.leftBrowRow },
    { xs: layout.rightEyeXs, row: layout.rightEyeRow, browRow: layout.rightBrowRow },
  ];
  eyePairs.forEach(({ xs, row, browRow }, index) => {
    const cluster = index === 0 ? "left_eye" : "right_eye";
    const ordered = index === 0 ? [...xs] : [...xs].reverse();
    const extension = index === 0 ? Math.max(...ordered) + 1 : Math.min(...ordered) - 1;
    const eyeXs = layout.eyeWidth === 1 ? [ordered[0]] : layout.eyeWidth === 3 ? [...ordered, extension] : ordered;
    eyeXs.forEach((x, position) => {
      const tiltOffset = position === 0 ? (hints.eyeTilt === "upturned" ? -1 : hints.eyeTilt === "downturned" ? 1 : 0) : 0;
      pushPixel(pixels, x, row + tiltOffset, hints.eyeShape === "round" && position === 0 ? "sclera" : "iris", cluster);
      pushPixel(pixels, x, browRow, "brow", cluster);
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
      hints.mouthOpening === "closed" ? "lip" : hints.mouthOpening === "teeth_visible" && teethPosition ? "teeth" : "mouth_shadow",
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
  return {
    template,
    lengthClass,
    texture: hints.hairTexture,
    fringe: hints.bangs,
    part: hints.hairPart,
    continuousFaces,
    overlayPolicy: "silhouette_only",
    minimumInvention: true,
  };
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
