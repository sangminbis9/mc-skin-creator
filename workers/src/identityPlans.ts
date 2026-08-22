/**
 * Analysis-derived, pixel-space plans consumed by the deterministic renderer.
 *
 * Plans deliberately name palette roles instead of carrying arbitrary RGB.
 * The renderer owns the compact material ramps and resolves each role from the
 * analysed complexion, hair and outfit colours at render time.
 */
import type { PhotoAnalysis } from "./analysis";

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

export interface FaceLayoutPlan {
  eyeRow: 3 | 4 | 5;
  leftEyeXs: number[];
  rightEyeXs: number[];
  eyeWidth: 1 | 2 | 3;
  browRow: 1 | 2 | 3 | 4;
  mouthRow: 5 | 6;
  mouthWidth: 2 | 3 | 4;
  hairlineDepth: 0 | 1 | 2 | 3;
  fringeOpening: PhotoAnalysis["renderHints"]["fringeOpening"];
  exposedFaceWidth: 5 | 6 | 7 | 8;
  glassesMask: Array<{ x: number; y: number }>;
  uncertainAxes: Array<"eye_row" | "mouth_row" | "hairline_depth">;
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
  variantId: "primary" | "eye_row_alt" | "mouth_or_hairline_alt";
  source: "analysis_normalized";
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

function deriveFaceLayout(analysis: PhotoAnalysis): FaceLayoutPlan {
  const hints = analysis.renderHints;
  const eyeRow: FaceLayoutPlan["eyeRow"] =
    analysis.fallbackFeatures.glasses !== "none"
      ? 4
      : hints.bangsLength === "eye"
      ? 5
      : hints.faceShape === "round" || hints.faceShape === "square"
        ? 3
        : 4;
  const leftEyeXs = hints.eyeSpacing === "wide" ? [0, 1] : hints.eyeSpacing === "close" ? [2] : [1, 2];
  const rightEyeXs = hints.eyeSpacing === "wide" ? [6, 7] : hints.eyeSpacing === "close" ? [5] : [5, 6];
  const eyeWidth: FaceLayoutPlan["eyeWidth"] = hints.eyeSize === "large" ? 3 : hints.eyeSize === "small" ? 1 : 2;
  const browRow = Math.max(1, Math.min(4, eyeRow - (hints.eyeSize === "large" ? 2 : 1))) as FaceLayoutPlan["browRow"];
  const mouthRow: FaceLayoutPlan["mouthRow"] = hints.faceShape === "round" || hints.faceShape === "square" ? 5 : 6;
  const mouthWidth: FaceLayoutPlan["mouthWidth"] = hints.mouthShape === "wide" ? 4 : hints.mouthShape === "full" ? 3 : 2;
  const hairlineDepth: FaceLayoutPlan["hairlineDepth"] =
    hints.bangs === "none" || hints.bangsLength === "none"
      ? 0
      : hints.bangsLength === "eye"
        ? 3
        : hints.bangsLength === "brow"
          ? 2
          : 1;
  const exposedFaceWidth: FaceLayoutPlan["exposedFaceWidth"] =
    hints.sideHairShape === "face_framing" || hints.earExposure === "covered"
      ? 5
      : hints.earExposure === "partial" || hints.hairVolume === "full"
        ? 6
        : hints.faceShape === "round" || hints.faceShape === "square"
          ? 8
          : 7;
  const glassesMask: Array<{ x: number; y: number }> = [];
  if (analysis.fallbackFeatures.glasses !== "none") {
    for (const x of [...leftEyeXs, ...rightEyeXs]) glassesMask.push({ x, y: eyeRow });
    if (analysis.fallbackFeatures.glasses === "round" || hints.eyeSize === "large") {
      for (const x of [...leftEyeXs, ...rightEyeXs]) glassesMask.push({ x, y: Math.min(7, eyeRow + 1) });
    }
    glassesMask.push({ x: 3, y: eyeRow }, { x: 4, y: eyeRow });
  }
  const faceConfidence = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "face")
    .map((feature) => feature.confidence);
  const fringeConfidence = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "hair" && /fringe|bang|hairline|forehead/i.test(feature.feature))
    .map((feature) => feature.confidence);
  const uncertainAxes: FaceLayoutPlan["uncertainAxes"] = [];
  if (faceConfidence.length === 0 || faceConfidence.some((confidence) => confidence !== "high")) {
    uncertainAxes.push("eye_row", "mouth_row");
  }
  if (hairlineDepth > 0 && (fringeConfidence.length === 0 || fringeConfidence.some((confidence) => confidence !== "high"))) {
    uncertainAxes.push("hairline_depth");
  }
  return {
    eyeRow,
    leftEyeXs,
    rightEyeXs,
    eyeWidth,
    browRow,
    mouthRow,
    mouthWidth,
    hairlineDepth,
    fringeOpening: hints.fringeOpening,
    exposedFaceWidth,
    glassesMask,
    uncertainAxes,
  };
}

function facePixelPlan(
  analysis: PhotoAnalysis,
  layout = deriveFaceLayout(analysis),
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

  const eyePairs = [layout.leftEyeXs, layout.rightEyeXs];
  eyePairs.forEach((xs, index) => {
    const cluster = index === 0 ? "left_eye" : "right_eye";
    const ordered = index === 0 ? [...xs] : [...xs].reverse();
    const extension = index === 0 ? Math.max(...ordered) + 1 : Math.min(...ordered) - 1;
    const eyeXs = layout.eyeWidth === 1 ? [ordered[0]] : layout.eyeWidth === 3 ? [...ordered, extension] : ordered;
    eyeXs.forEach((x, position) => {
      const tiltOffset = position === 0 ? (hints.eyeTilt === "upturned" ? -1 : hints.eyeTilt === "downturned" ? 1 : 0) : 0;
      pushPixel(pixels, x, layout.eyeRow + tiltOffset, hints.eyeShape === "round" && position === 0 ? "sclera" : "iris", cluster);
      pushPixel(pixels, x, layout.browRow, "brow", cluster);
    });
  });
  // glassesMask is declarative layout evidence. The renderer applies it on
  // the outer layer so frames do not overwrite the base-layer irises.
  pushPixel(pixels, hints.noseShape === "prominent" ? 3 : 4, Math.min(6, layout.eyeRow + 1), "nose_shadow", "nose");
  const mouthStart = Math.floor((8 - layout.mouthWidth) / 2);
  for (let x = mouthStart; x < mouthStart + layout.mouthWidth; x++) {
    pushPixel(
      pixels,
      x,
      layout.mouthRow,
      hints.mouthOpening === "closed" ? "lip" : hints.mouthOpening === "teeth_visible" ? "teeth" : "mouth_shadow",
      "mouth",
    );
  }

  if (layout.hairlineDepth > 0) {
    const row = layout.hairlineDepth;
    const opening = hints.fringeOpening === "center"
      ? new Set([3, 4])
      : hints.fringeOpening === "left"
        ? new Set([1, 2])
        : hints.fringeOpening === "right"
          ? new Set([5, 6])
          : new Set<number>();
    for (let x = 0; x < 8; x++) {
      if (!opening.has(x)) pushPixel(pixels, x, row, x % 3 === 0 ? "hair_shadow" : "hair_mid", "fringe");
    }
  }
  const sideMargin = Math.floor((8 - layout.exposedFaceWidth) / 2);
  for (let y = 1; y < layout.eyeRow; y++) {
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
    ],
    layout,
    variantId,
    source: "analysis_normalized",
  };
}

export function buildFacePixelPlanVariants(
  analysis: PhotoAnalysis,
  maximum = 3,
): FacePixelPlan[] {
  const primaryLayout = deriveFaceLayout(analysis);
  const variants = [facePixelPlan(analysis, primaryLayout, "primary")];
  if (maximum <= 1) return variants;
  if (primaryLayout.uncertainAxes.includes("eye_row")) {
    const eyeRow = (primaryLayout.eyeRow === 3 ? 4 : primaryLayout.eyeRow === 5 ? 4 : 3) as FaceLayoutPlan["eyeRow"];
    variants.push(facePixelPlan(analysis, {
      ...primaryLayout,
      eyeRow,
      browRow: Math.max(1, eyeRow - 1) as FaceLayoutPlan["browRow"],
      glassesMask: primaryLayout.glassesMask.map((point) => ({ ...point, y: point.y + (eyeRow - primaryLayout.eyeRow) })),
    }, "eye_row_alt"));
  }
  if (variants.length < maximum && (primaryLayout.uncertainAxes.includes("mouth_row") || primaryLayout.uncertainAxes.includes("hairline_depth"))) {
    variants.push(facePixelPlan(analysis, {
      ...primaryLayout,
      mouthRow: (primaryLayout.mouthRow === 5 ? 6 : 5) as FaceLayoutPlan["mouthRow"],
      hairlineDepth: primaryLayout.hairlineDepth === 0 ? 0 : (primaryLayout.hairlineDepth === 3 ? 2 : primaryLayout.hairlineDepth + 1) as FaceLayoutPlan["hairlineDepth"],
    }, "mouth_or_hairline_alt"));
  }
  return variants.slice(0, Math.max(1, Math.min(3, maximum)));
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
