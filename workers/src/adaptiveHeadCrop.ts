import type { PixelRenderHints, PortraitRegion } from "./analysis";
import type { NormalizedBox } from "./identityGeometry";

export interface CropDirections {
  top: boolean;
  left: boolean;
  right: boolean;
  bottom: boolean;
}

export interface CropMargins {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface HeadCropRisk {
  topRisk: number;
  leftRisk: number;
  rightRisk: number;
  bottomRisk: number;
}

export interface HeadCropCoverage {
  crown: number;
  leftHair: number;
  rightHair: number;
  temples: number;
  ears: number;
  chin: number;
}

export interface IdentityCropQuality {
  faceResolutionAdequate: boolean;
  headCoverageAdequate: boolean;
  sourceClippingKnown: boolean;
  sourceClipping: CropDirections;
  cropClipping: CropDirections;
  usableForFaceGeometry: boolean;
  usableForHairGeometry: boolean;
  warnings: string[];
}

export interface HeadCropBoundaryAdjustments {
  translatedX: number;
  translatedY: number;
  shrunkWidth: number;
  shrunkHeight: number;
  subjectLimited: boolean;
}

export interface AdaptiveHeadCropPlan {
  cropBox: NormalizedBox;
  desiredBox: NormalizedBox;
  originalHeadBox: NormalizedBox;
  margins: CropMargins;
  requestedMargins: CropMargins;
  anchor: { x: number; y: number };
  risk: HeadCropRisk;
  quality: IdentityCropQuality;
  diagnostics: {
    expandedTop: boolean;
    expandedLeft: boolean;
    expandedRight: boolean;
    expandedBottom: boolean;
    sourceBoundaryLimited: boolean;
    estimatedCoverage: number;
    coverage: HeadCropCoverage;
    headOccupancyRatio: number;
    aspectRatioAdjusted: boolean;
    sourceBoundaryAdjustments: HeadCropBoundaryAdjustments;
  };
}

export interface AdaptiveHeadCropContext {
  hairVolume?: PixelRenderHints["hairVolume"];
  hairTexture?: PixelRenderHints["hairTexture"];
  overallHairLength?: PixelRenderHints["overallHairLength"];
  sideHairAsymmetry?: PixelRenderHints["sideHairAsymmetry"];
  headCovering?: boolean;
}

export interface SourceDimensions {
  width: number;
  height: number;
}

const SOURCE_BOUNDS: NormalizedBox = { left: 0, top: 0, right: 1, bottom: 1 };
const EPSILON = 1e-6;

function width(box: NormalizedBox): number {
  return box.right - box.left;
}

function height(box: NormalizedBox): number {
  return box.bottom - box.top;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizedBox(value: unknown): value is NormalizedBox {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  const values = [box.left, box.top, box.right, box.bottom];
  if (!values.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) return false;
  const [left, top, right, bottom] = values as number[];
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right - left >= 0.01 && bottom - top >= 0.01;
}

function contains(outer: NormalizedBox, inner: NormalizedBox, tolerance = 0): boolean {
  return inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance &&
    inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
}

function expand(box: NormalizedBox, margins: CropMargins): NormalizedBox {
  const boxWidth = width(box);
  const boxHeight = height(box);
  return {
    left: box.left - boxWidth * margins.left,
    top: box.top - boxHeight * margins.top,
    right: box.right + boxWidth * margins.right,
    bottom: box.bottom + boxHeight * margins.bottom,
  };
}

function expandSubjectLimit(subject: NormalizedBox): NormalizedBox {
  const paddingX = width(subject) * 0.025;
  const paddingY = height(subject) * 0.025;
  return {
    left: clamp01(subject.left - paddingX),
    top: clamp01(subject.top - paddingY),
    right: clamp01(subject.right + paddingX),
    bottom: clamp01(subject.bottom + paddingY),
  };
}

function expandAspectRatio(
  box: NormalizedBox,
  source: SourceDimensions,
): { box: NormalizedBox; adjusted: boolean } {
  const pixelWidth = width(box) * source.width;
  const pixelHeight = height(box) * source.height;
  if (pixelWidth <= 0 || pixelHeight <= 0) return { box, adjusted: false };
  const aspect = pixelWidth / pixelHeight;
  // Gemini accepts non-square images. Correct only extreme crops and only by
  // adding context; never remove a part of the localized head to hit a ratio.
  if (aspect >= 0.8 && aspect <= 1.25) return { box, adjusted: false };

  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  let desiredWidth = width(box);
  let desiredHeight = height(box);
  if (aspect < 0.8) desiredWidth = (pixelHeight * 0.8) / source.width;
  else desiredHeight = (pixelWidth / 1.25) / source.height;
  return {
    box: {
      left: centerX - desiredWidth / 2,
      top: centerY - desiredHeight / 2,
      right: centerX + desiredWidth / 2,
      bottom: centerY + desiredHeight / 2,
    },
    adjusted: true,
  };
}

function fitPreservingSize(
  box: NormalizedBox,
  limit: NormalizedBox,
): { box: NormalizedBox; translatedX: number; translatedY: number; shrunkWidth: number; shrunkHeight: number } {
  const originalWidth = width(box);
  const originalHeight = height(box);
  const limitWidth = width(limit);
  const limitHeight = height(limit);
  const fittedWidth = Math.min(originalWidth, limitWidth);
  const fittedHeight = Math.min(originalHeight, limitHeight);
  let left = box.left;
  let top = box.top;

  if (left < limit.left) left = limit.left;
  if (left + fittedWidth > limit.right) left = limit.right - fittedWidth;
  if (top < limit.top) top = limit.top;
  if (top + fittedHeight > limit.bottom) top = limit.bottom - fittedHeight;
  const fitted = { left, top, right: left + fittedWidth, bottom: top + fittedHeight };
  return {
    box: fitted,
    translatedX: left - box.left,
    translatedY: top - box.top,
    shrunkWidth: originalWidth - fittedWidth,
    shrunkHeight: originalHeight - fittedHeight,
  };
}

function directionalMargins(context: AdaptiveHeadCropContext): CropMargins {
  const margins: CropMargins = { top: 0.2, left: 0.15, right: 0.15, bottom: 0.22 };
  if (context.hairVolume === "full") {
    margins.top += 0.08;
    margins.left += 0.11;
    margins.right += 0.11;
  }
  if (context.hairTexture === "curly" || context.hairTexture === "coily") {
    margins.top += 0.05;
    margins.left += 0.07;
    margins.right += 0.07;
    margins.bottom += 0.05;
  }
  if (["jaw", "shoulder", "chest", "waist", "hip"].includes(context.overallHairLength ?? "")) {
    margins.left += 0.04;
    margins.right += 0.04;
    margins.bottom += context.overallHairLength === "jaw" ? 0.09 : 0.16;
  }
  if (context.headCovering) {
    margins.top += 0.08;
    margins.left += 0.07;
    margins.right += 0.07;
    margins.bottom += 0.04;
  }
  if (context.sideHairAsymmetry === "left") {
    margins.left += 0.05;
    margins.right += 0.01;
  } else if (context.sideHairAsymmetry === "right") {
    margins.right += 0.05;
    margins.left += 0.01;
  }
  return margins;
}

function actualMargins(head: NormalizedBox, crop: NormalizedBox): CropMargins {
  return {
    top: Math.max(0, head.top - crop.top),
    left: Math.max(0, head.left - crop.left),
    right: Math.max(0, crop.right - head.right),
    bottom: Math.max(0, crop.bottom - head.bottom),
  };
}

function marginRisk(actual: number, requested: number): number {
  if (requested <= EPSILON) return 0;
  return clamp01(1 - actual / requested);
}

function directionFlags(value = false): CropDirections {
  return { top: value, left: value, right: value, bottom: value };
}

function sourceClipping(head: NormalizedBox): CropDirections {
  // This denotes likely loss in the source frame, not merely sparse context.
  // Wider edge-proximity uncertainty remains available through `risk`.
  const edgeX = Math.max(0.003, width(head) * 0.005);
  const edgeY = Math.max(0.003, height(head) * 0.005);
  return {
    top: head.top <= edgeY,
    left: head.left <= edgeX,
    right: 1 - head.right <= edgeX,
    bottom: 1 - head.bottom <= edgeY,
  };
}

function pixelArea(box: NormalizedBox, source: SourceDimensions): number {
  return Math.max(0, width(box) * source.width) * Math.max(0, height(box) * source.height);
}

function normalizedArea(box: NormalizedBox): number {
  return Math.max(0, width(box)) * Math.max(0, height(box));
}

function featureCoverage(feature: NormalizedBox, crop: NormalizedBox): number {
  const intersection: NormalizedBox = {
    left: Math.max(feature.left, crop.left),
    top: Math.max(feature.top, crop.top),
    right: Math.min(feature.right, crop.right),
    bottom: Math.min(feature.bottom, crop.bottom),
  };
  return clamp01(normalizedArea(intersection) / Math.max(EPSILON, normalizedArea(feature)));
}

function coverageByIdentityRegion(region: PortraitRegion, crop: NormalizedBox): HeadCropCoverage {
  const head = region.headBox;
  const face = region.faceBox;
  const headWidth = width(head);
  const headHeight = height(head);
  const faceHeight = height(face);
  const leftTemple = { left: head.left, top: head.top + headHeight * 0.22, right: face.left, bottom: head.top + headHeight * 0.62 };
  const rightTemple = { left: face.right, top: head.top + headHeight * 0.22, right: head.right, bottom: head.top + headHeight * 0.62 };
  const leftEar = { left: head.left, top: head.top + headHeight * 0.45, right: face.left, bottom: head.top + headHeight * 0.82 };
  const rightEar = { left: face.right, top: head.top + headHeight * 0.45, right: head.right, bottom: head.top + headHeight * 0.82 };
  return {
    crown: featureCoverage({ left: head.left, top: head.top, right: head.right, bottom: head.top + headHeight * 0.15 }, crop),
    leftHair: featureCoverage({ left: head.left, top: head.top, right: head.left + headWidth * 0.2, bottom: head.bottom }, crop),
    rightHair: featureCoverage({ left: head.right - headWidth * 0.2, top: head.top, right: head.right, bottom: head.bottom }, crop),
    temples: (featureCoverage(leftTemple, crop) + featureCoverage(rightTemple, crop)) / 2,
    ears: (featureCoverage(leftEar, crop) + featureCoverage(rightEar, crop)) / 2,
    chin: featureCoverage({ left: face.left, top: face.bottom - faceHeight * 0.14, right: face.right, bottom: face.bottom }, crop),
  };
}

function contextWarnings(
  source: CropDirections,
  crop: CropDirections,
  occupancy: number,
  faceResolutionAdequate: boolean,
): string[] {
  const warnings: string[] = [];
  for (const direction of ["top", "left", "right", "bottom"] as const) {
    if (source[direction]) warnings.push(`source_${direction}_clipped`);
    else if (crop[direction]) warnings.push(`crop_${direction}_clipping_risk`);
  }
  if (occupancy < 0.2) warnings.push("head_occupancy_low");
  if (!faceResolutionAdequate) warnings.push("face_resolution_low");
  return warnings;
}

/**
 * Create the wide-head crop from the already selected portrait subject. The
 * head box is the primary evidence; semantic hair fields only alter safety
 * margins and never localize a different person.
 */
export function planAdaptiveHeadCrop(
  source: SourceDimensions,
  region: PortraitRegion,
  context: AdaptiveHeadCropContext = {},
): AdaptiveHeadCropPlan {
  const requestedRatios = directionalMargins(context);
  const requestedMargins = {
    top: height(region.headBox) * requestedRatios.top,
    left: width(region.headBox) * requestedRatios.left,
    right: width(region.headBox) * requestedRatios.right,
    bottom: height(region.headBox) * requestedRatios.bottom,
  };
  const subjectLimit = expandSubjectLimit(region.subjectBox);
  const uncorrectedDesired = expand(region.headBox, requestedRatios);
  const aspect = expandAspectRatio(uncorrectedDesired, source);
  const desiredBox = aspect.box;
  const sourceFit = fitPreservingSize(desiredBox, SOURCE_BOUNDS);
  const subjectFit = fitPreservingSize(sourceFit.box, subjectLimit);
  const cropBox = subjectFit.box;
  const margins = actualMargins(region.headBox, cropBox);
  const risk = {
    topRisk: marginRisk(margins.top, requestedMargins.top),
    leftRisk: marginRisk(margins.left, requestedMargins.left),
    rightRisk: marginRisk(margins.right, requestedMargins.right),
    bottomRisk: marginRisk(margins.bottom, requestedMargins.bottom),
  };
  const sourceFlags = sourceClipping(region.headBox);
  const cropEdgeX = Math.max(0.003, width(region.headBox) * 0.015);
  const cropEdgeY = Math.max(0.003, height(region.headBox) * 0.015);
  const cropFlags: CropDirections = {
    top: !sourceFlags.top && margins.top <= cropEdgeY,
    left: !sourceFlags.left && margins.left <= cropEdgeX,
    right: !sourceFlags.right && margins.right <= cropEdgeX,
    bottom: !sourceFlags.bottom && margins.bottom <= cropEdgeY,
  };
  const occupancy = pixelArea(region.headBox, source) / Math.max(1, pixelArea(cropBox, source));
  const coverage = coverageByIdentityRegion(region, cropBox);
  const estimatedCoverage = Object.values(coverage).reduce((sum, value) => sum + value, 0) /
    Object.values(coverage).length;
  const facePixels = {
    width: width(region.faceBox) * source.width,
    height: height(region.faceBox) * source.height,
  };
  const faceResolutionAdequate = facePixels.width >= 36 && facePixels.height >= 44;
  const headCoverageAdequate = !Object.values(cropFlags).some(Boolean) && estimatedCoverage >= 0.98 && occupancy >= 0.2;
  const warnings = contextWarnings(sourceFlags, cropFlags, occupancy, faceResolutionAdequate);
  const sourceBoundaryLimited = Math.abs(sourceFit.translatedX) > EPSILON || Math.abs(sourceFit.translatedY) > EPSILON ||
    sourceFit.shrunkWidth > EPSILON || sourceFit.shrunkHeight > EPSILON;
  return {
    cropBox,
    desiredBox,
    originalHeadBox: region.headBox,
    margins,
    requestedMargins,
    anchor: {
      x: (region.headBox.left + region.headBox.right) / 2,
      y: (region.headBox.top + region.headBox.bottom) / 2,
    },
    risk,
    quality: {
      faceResolutionAdequate,
      headCoverageAdequate,
      sourceClippingKnown: true,
      sourceClipping: sourceFlags,
      cropClipping: cropFlags,
      usableForFaceGeometry: faceResolutionAdequate,
      usableForHairGeometry: headCoverageAdequate || Object.values(sourceFlags).some(Boolean),
      warnings,
    },
    diagnostics: {
      expandedTop: cropBox.top < region.headBox.top,
      expandedLeft: cropBox.left < region.headBox.left,
      expandedRight: cropBox.right > region.headBox.right,
      expandedBottom: cropBox.bottom > region.headBox.bottom,
      sourceBoundaryLimited,
      estimatedCoverage,
      coverage,
      headOccupancyRatio: occupancy,
      aspectRatioAdjusted: aspect.adjusted,
      sourceBoundaryAdjustments: {
        translatedX: sourceFit.translatedX + subjectFit.translatedX,
        translatedY: sourceFit.translatedY + subjectFit.translatedY,
        shrunkWidth: sourceFit.shrunkWidth + subjectFit.shrunkWidth,
        shrunkHeight: sourceFit.shrunkHeight + subjectFit.shrunkHeight,
        subjectLimited: subjectFit.shrunkWidth > EPSILON || subjectFit.shrunkHeight > EPSILON ||
          Math.abs(subjectFit.translatedX) > EPSILON || Math.abs(subjectFit.translatedY) > EPSILON,
      },
    },
  };
}

export function conservativeFaceHeadFallback(value: unknown): PortraitRegion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PortraitRegion>;
  if (typeof candidate.confidence !== "number" || candidate.confidence < 0.6 ||
      !normalizedBox(candidate.subjectBox) || !normalizedBox(candidate.faceBox) ||
      !contains(candidate.subjectBox, candidate.faceBox, 0.08)) return null;
  const face = candidate.faceBox;
  const estimated = expand(face, { top: 0.62, left: 0.42, right: 0.42, bottom: 0.36 });
  const subjectLimit = expandSubjectLimit(candidate.subjectBox);
  const fitted = fitPreservingSize(estimated, subjectLimit).box;
  if (!contains(fitted, face, 0.005)) return null;
  return {
    subjectBox: candidate.subjectBox,
    faceBox: face,
    headBox: fitted,
    confidence: Math.min(candidate.confidence, 0.69),
  };
}

export function emptyCropDirections(): CropDirections {
  return directionFlags(false);
}
