/**
 * Evaluation-only identity stage exporter.
 *
 * This module lives under test/ so it is never imported into the Worker
 * bundle. Callers must provide an explicit output directory. Full source
 * photographs and credentials are intentionally not accepted by the API.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FacePixelPlan, HairPlan } from "../src/identityPlans";
import type { IdentityGeometryAnalysis } from "../src/identityGeometry";
import { encodePng, type RawImage } from "../src/png";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";

export interface IdentityEvaluationArtifacts {
  sourceFace: RawImage;
  sourceHead?: RawImage;
  geometryOverlay?: RawImage;
  sourceHeadGeometryOverlay?: RawImage;
  sourceFaceGeometryOverlay?: RawImage;
  sourceToGridOverlay?: RawImage;
  fringeGeometryOverlay?: RawImage;
  templeGeometryOverlay?: RawImage;
  crownContourOverlay?: RawImage;
  majorVolumeOverlay?: RawImage;
  faceWindowOverlay?: RawImage;
  quantizedHeadPlan?: RawImage;
  sixView?: RawImage;
  generatedSheetFace?: RawImage;
  packedHeadBefore?: RawImage;
  facePixelPlan: FacePixelPlan;
  oldFacePixelPlan?: FacePixelPlan;
  candidateA?: RawImage;
  candidateB?: RawImage;
  candidateC?: RawImage;
  baseHeadOnly?: RawImage;
  outerHeadOnly?: RawImage;
  baseOuterHead?: RawImage;
  finalHeadFront: RawImage;
  finalHeadFrontLeft?: RawImage;
  finalHeadLeft: RawImage;
  finalHeadFrontRight?: RawImage;
  finalHeadRight: RawImage;
  finalHeadTop?: RawImage;
  finalHeadBack?: RawImage;
  beforeAfterHeadMontage?: RawImage;
  beforeHeadFront?: RawImage;
  beforeHeadFrontLeft?: RawImage;
  beforeHeadFrontRight?: RawImage;
  facePixelDiff?: RawImage;
  finalSkin: RawImage;
  critique: unknown;
  metrics: Record<string, unknown>;
}

function put(image: RawImage, x: number, y: number, color: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  image.rgba.set(color, (y * image.width + x) * 4);
}

function drawLine(image: RawImage, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
  const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step++) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    for (let offset = -1; offset <= 1; offset++) put(image, x + offset, y, color);
  }
}

function drawDot(image: RawImage, normalizedX: number, normalizedY: number, color: readonly [number, number, number, number], radius = 4): void {
  const centerX = Math.round(normalizedX * (image.width - 1));
  const centerY = Math.round(normalizedY * (image.height - 1));
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy <= radius * radius) put(image, centerX + dx, centerY + dy, color);
  }
}

function copy(image: RawImage): RawImage {
  return { ...image, rgba: image.rgba.slice() };
}

const EVIDENCE_COLORS = {
  observed: [72, 235, 118, 255],
  inferred: [255, 196, 30, 255],
  unknown: [255, 74, 92, 255],
} as const;

/** Overlay the normalized source contour and hairline samples for visual QA. */
export function buildGeometryOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = { ...sourceHead, rgba: sourceHead.rgba.slice() };
  const silhouette = geometry.headSilhouette;
  const left = silhouette.covering?.leftContourByRow ?? silhouette.leftContourByRow;
  const right = silhouette.covering?.rightContourByRow ?? silhouette.rightContourByRow;
  const contourTop = silhouette.crownTopY;
  const contourBottom = Math.max(silhouette.hairEndpointLeftY, silhouette.hairEndpointRightY);
  for (let row = 0; row < 7; row++) {
    const y0 = Math.round((contourTop + (contourBottom - contourTop) * row / 7) * (result.height - 1));
    const y1 = Math.round((contourTop + (contourBottom - contourTop) * (row + 1) / 7) * (result.height - 1));
    drawLine(result, Math.round(left[row] * (result.width - 1)), y0, Math.round(left[row + 1] * (result.width - 1)), y1, [0, 238, 255, 255]);
    drawLine(result, Math.round(right[row] * (result.width - 1)), y0, Math.round(right[row + 1] * (result.width - 1)), y1, [0, 238, 255, 255]);
  }
  const hairlineLeft = left[3];
  const hairlineRight = right[3];
  for (let column = 0; column < 8; column++) {
    const xNormalized = hairlineLeft + (hairlineRight - hairlineLeft) * ((column + 0.5) / 8);
    const x = Math.round(xNormalized * (result.width - 1));
    const y = Math.round((silhouette.crownTopY + 0.08 + geometry.hairline.depthByColumn[column] * 0.36) * (result.height - 1));
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) put(result, x + dx, y + dy, [255, 72, 92, 255]);
  }
  return result;
}

export function buildFringeGeometryOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceHead);
  for (const peak of geometry.fringe.peaks) drawDot(result, peak.x, peak.depthY, EVIDENCE_COLORS[geometry.fringe.evidence], 5);
  if (geometry.fringe.openingCenterX !== null && geometry.fringe.openingWidth !== null) {
    const left = geometry.fringe.openingCenterX - geometry.fringe.openingWidth / 2;
    const right = geometry.fringe.openingCenterX + geometry.fringe.openingWidth / 2;
    const y = Math.round(geometry.face.foreheadY * (result.height - 1));
    drawLine(result, Math.round(left * (result.width - 1)), y, Math.round(right * (result.width - 1)), y, [255, 220, 40, 255]);
  }
  return result;
}

export function buildTempleGeometryOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceHead);
  const headCenterX = (geometry.headSilhouette.leftContourByRow[4] + geometry.headSilhouette.rightContourByRow[4]) / 2;
  const eyeWindowLeft = headCenterX - geometry.faceWindow.visibleFaceWidthAtEyes / 2;
  const eyeWindowRight = headCenterX + geometry.faceWindow.visibleFaceWidthAtEyes / 2;
  const leftX = eyeWindowLeft;
  const rightX = eyeWindowRight;
  const leftColor = EVIDENCE_COLORS[geometry.temple.leftEvidence];
  const rightColor = EVIDENCE_COLORS[geometry.temple.rightEvidence];
  drawDot(result, Math.max(0, leftX), geometry.temple.leftStartY, leftColor, 5);
  drawDot(result, Math.min(1, rightX), geometry.temple.rightStartY, rightColor, 5);
  drawLine(result, Math.round(leftX * (result.width - 1)), Math.round(geometry.temple.leftStartY * (result.height - 1)), Math.round(leftX * (result.width - 1)), Math.round(0.5 * (result.height - 1)), leftColor);
  drawLine(result, Math.round(leftX * (result.width - 1)), Math.round(geometry.temple.leftStartY * (result.height - 1)), Math.round((leftX + geometry.temple.leftRecession * 0.08) * (result.width - 1)), Math.round(geometry.temple.leftStartY * (result.height - 1)), leftColor);
  drawLine(result, Math.round(rightX * (result.width - 1)), Math.round(geometry.temple.rightStartY * (result.height - 1)), Math.round(rightX * (result.width - 1)), Math.round(0.5 * (result.height - 1)), rightColor);
  drawLine(result, Math.round(rightX * (result.width - 1)), Math.round(geometry.temple.rightStartY * (result.height - 1)), Math.round((rightX - geometry.temple.rightRecession * 0.08) * (result.width - 1)), Math.round(geometry.temple.rightStartY * (result.height - 1)), rightColor);
  return result;
}

export function buildCrownContourOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceHead);
  const points = [
    { x: Math.max(0, geometry.crown.apexX - geometry.crown.leftWidth / 2), y: geometry.crown.leftY },
    { x: geometry.crown.apexX, y: geometry.crown.centerY },
    { x: Math.min(1, geometry.crown.apexX + geometry.crown.rightWidth / 2), y: geometry.crown.rightY },
  ];
  for (let index = 0; index < points.length - 1; index++) drawLine(result, Math.round(points[index].x * (result.width - 1)), Math.round(points[index].y * (result.height - 1)), Math.round(points[index + 1].x * (result.width - 1)), Math.round(points[index + 1].y * (result.height - 1)), [255, 196, 30, 255]);
  const crownEvidence = [geometry.crown.leftEvidence, geometry.crown.centerEvidence, geometry.crown.rightEvidence] as const;
  for (let index = 0; index < points.length; index++) drawDot(result, points[index].x, points[index].y, EVIDENCE_COLORS[crownEvidence[index]], 4);
  for (const peak of geometry.majorVolumePeaks) {
    const row = Math.max(0, Math.min(7, Math.round(peak.verticalCenter * 7)));
    const x = peak.region.endsWith("left")
      ? geometry.headSilhouette.leftContourByRow[row]
      : geometry.headSilhouette.rightContourByRow[row];
    drawDot(result, x, peak.verticalCenter, [112, 255, 110, 255], Math.max(3, Math.round(peak.protrusion * 7)));
  }
  return result;
}

export function buildMajorVolumeGeometryOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceHead);
  for (const peak of geometry.majorVolumePeaks) {
    const row = Math.max(0, Math.min(7, Math.round(peak.verticalCenter * 7)));
    const x = peak.region.endsWith("left")
      ? geometry.headSilhouette.leftContourByRow[row]
      : geometry.headSilhouette.rightContourByRow[row];
    drawDot(result, x, peak.verticalCenter, EVIDENCE_COLORS[peak.evidence], Math.max(3, Math.round(peak.protrusion * 7)));
  }
  return result;
}

export function buildFaceWindowOverlay(sourceHead: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceHead);
  const headCenterX = (geometry.headSilhouette.leftContourByRow[4] + geometry.headSilhouette.rightContourByRow[4]) / 2;
  const centerX = headCenterX + geometry.faceShape.leftRightAsymmetry * 0.04;
  const drawWidth = (y: number, width: number, color: readonly [number, number, number, number]) => {
    const left = centerX - width / 2;
    const right = centerX + width / 2;
    drawLine(result, Math.round(left * (result.width - 1)), Math.round(y * (result.height - 1)), Math.round(right * (result.width - 1)), Math.round(y * (result.height - 1)), color);
  };
  const eyeRow = Math.min(0.72, Math.max(0.38, geometry.faceWindow.foreheadHeight + 0.16));
  const cheekRow = Math.min(0.88, eyeRow + 0.2);
  const leftColor = EVIDENCE_COLORS[geometry.faceWindow.leftEvidence];
  const rightColor = EVIDENCE_COLORS[geometry.faceWindow.rightEvidence];
  drawWidth(eyeRow, geometry.faceWindow.visibleFaceWidthAtEyes, leftColor);
  drawWidth(cheekRow, geometry.faceWindow.visibleFaceWidthAtCheeks, rightColor);
  const leftEyeX = centerX - geometry.faceWindow.visibleFaceWidthAtEyes * 0.22;
  const rightEyeX = centerX + geometry.faceWindow.visibleFaceWidthAtEyes * 0.22;
  drawLine(result, Math.round(leftEyeX * (result.width - 1)), Math.round((eyeRow - geometry.faceWindow.leftEyeToHairDistance) * (result.height - 1)), Math.round(leftEyeX * (result.width - 1)), Math.round(eyeRow * (result.height - 1)), [255, 220, 40, 255]);
  drawLine(result, Math.round(rightEyeX * (result.width - 1)), Math.round((eyeRow - geometry.faceWindow.rightEyeToHairDistance) * (result.height - 1)), Math.round(rightEyeX * (result.width - 1)), Math.round(eyeRow * (result.height - 1)), [255, 220, 40, 255]);
  return result;
}

export function buildFaceGeometryOverlay(sourceFace: RawImage, geometry: IdentityGeometryAnalysis): RawImage {
  const result = copy(sourceFace);
  const centerX = (geometry.face.visibleLeft + geometry.face.visibleRight) / 2 + geometry.faceShape.leftRightAsymmetry * 0.08;
  const rows = [
    { y: geometry.face.foreheadY, width: geometry.faceShape.upperWidth },
    { y: (geometry.face.foreheadY + geometry.face.chinY) * 0.55, width: geometry.faceShape.cheekWidth },
    { y: geometry.face.chinY, width: geometry.faceShape.jawWidth },
  ];
  for (const row of rows) drawLine(result, Math.round((centerX - row.width / 2) * (result.width - 1)), Math.round(row.y * (result.height - 1)), Math.round((centerX + row.width / 2) * (result.width - 1)), Math.round(row.y * (result.height - 1)), [60, 240, 255, 255]);
  drawDot(result, geometry.eyes.leftCenterX, geometry.eyes.leftCenterY, [255, 220, 40, 255]);
  drawDot(result, geometry.eyes.rightCenterX, geometry.eyes.rightCenterY, [255, 220, 40, 255]);
  return result;
}

/** Shows continuous landmarks and their chosen 8x8 cells in one source crop. */
export function buildSourceToFaceGridOverlay(sourceFace: RawImage, geometry: IdentityGeometryAnalysis, plan: FacePixelPlan): RawImage {
  const result = copy(sourceFace);
  const left = geometry.face.visibleLeft * (result.width - 1);
  const right = geometry.face.visibleRight * (result.width - 1);
  const top = geometry.face.foreheadY * (result.height - 1);
  const bottom = geometry.face.chinY * (result.height - 1);
  for (let cell = 0; cell <= 8; cell++) {
    const x = Math.round(left + (right - left) * cell / 8);
    const y = Math.round(top + (bottom - top) * cell / 8);
    drawLine(result, x, Math.round(top), x, Math.round(bottom), [68, 184, 255, 255]);
    drawLine(result, Math.round(left), y, Math.round(right), y, [68, 184, 255, 255]);
  }
  const cellCenter = (x: number, y: number) => ({
    x: (left + (right - left) * ((x + 0.5) / 8)) / Math.max(1, result.width - 1),
    y: (top + (bottom - top) * ((y + 0.5) / 8)) / Math.max(1, result.height - 1),
  });
  for (const pixel of plan.pixels.filter((item) => item.cluster !== "fringe" && item.cluster !== "complexion")) {
    const point = cellCenter(pixel.x, pixel.y);
    drawDot(result, point.x, point.y, ROLE_COLORS[pixel.role], 3);
  }
  drawDot(result, geometry.eyes.leftCenterX, geometry.eyes.leftCenterY, [255, 226, 32, 255], 5);
  drawDot(result, geometry.eyes.rightCenterX, geometry.eyes.rightCenterY, [255, 226, 32, 255], 5);
  drawDot(result, geometry.mouth.centerX, geometry.mouth.centerY, [255, 72, 112, 255], 5);
  return result;
}

export function buildBeforeAfterHeadMontage(before: RawImage, after: RawImage): RawImage {
  const width = before.width + after.width;
  const height = Math.max(before.height, after.height);
  const rgba = new Uint8Array(width * height * 4);
  for (const [image, xOffset] of [[before, 0], [after, before.width]] as const) {
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const source = (y * image.width + x) * 4;
      rgba.set(image.rgba.subarray(source, source + 4), (y * width + xOffset + x) * 4);
    }
  }
  return { width, height, rgba };
}

/** Evaluation-only top view composed directly from the base and outer UV faces. */
export function buildHeadTopDiagnosticView(atlas: RawImage, scale = 12): RawImage {
  const base = CLASSIC_LAYOUT.head.base.top;
  const outer = CLASSIC_LAYOUT.head.overlay.top;
  const rgba = new Uint8Array(base.w * scale * base.h * scale * 4);
  for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
    const baseOffset = ((base.y + y) * atlas.width + base.x + x) * 4;
    const outerOffset = ((outer.y + y) * atlas.width + outer.x + x) * 4;
    const source = atlas.rgba[outerOffset + 3] > 0 ? outerOffset : baseOffset;
    for (let py = y * scale; py < (y + 1) * scale; py++) for (let px = x * scale; px < (x + 1) * scale; px++) {
      rgba.set(atlas.rgba.subarray(source, source + 4), (py * base.w * scale + px) * 4);
    }
  }
  return { width: base.w * scale, height: base.h * scale, rgba };
}

function clearRects(atlas: RawImage, rects: Rect[]): RawImage {
  const copy = { ...atlas, rgba: new Uint8Array(atlas.rgba) };
  for (const rect of rects) for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    copy.rgba.fill(0, (y * copy.width + x) * 4, (y * copy.width + x) * 4 + 4);
  }
  return copy;
}

/** Pixel-perfect diagnostic renders for base/outer cooperation. */
export function buildHeadLayerDiagnosticViews(atlas: RawImage): Pick<IdentityEvaluationArtifacts, "baseHeadOnly" | "outerHeadOnly" | "baseOuterHead"> {
  const front = (candidate: RawImage) => extractRenderedHeadView(renderSkinViews(candidate)[0]);
  return {
    baseHeadOnly: front(clearRects(atlas, Object.values(CLASSIC_LAYOUT.head.overlay))),
    outerHeadOnly: front(clearRects(atlas, Object.values(CLASSIC_LAYOUT.head.base))),
    baseOuterHead: front(atlas),
  };
}

const ROLE_COLORS: Record<FacePixelPlan["pixels"][number]["role"], [number, number, number, number]> = {
  skin_light: [239, 190, 158, 255],
  skin_mid: [211, 154, 116, 255],
  skin_shadow: [153, 99, 75, 255],
  hair_light: [92, 72, 58, 255],
  hair_mid: [55, 42, 35, 255],
  hair_shadow: [28, 21, 18, 255],
  brow: [35, 27, 23, 255],
  glasses: [190, 196, 202, 255],
  iris: [52, 75, 83, 255],
  sclera: [231, 225, 211, 255],
  nose_shadow: [156, 104, 83, 255],
  lip: [157, 78, 89, 255],
  teeth: [236, 229, 210, 255],
  mouth_shadow: [75, 37, 42, 255],
};

export function renderFacePixelPlan(plan: FacePixelPlan, scale = 24): RawImage {
  const width = 8 * scale;
  const height = 8 * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (const pixel of plan.pixels) {
    const color = ROLE_COLORS[pixel.role];
    for (let y = pixel.y * scale; y < (pixel.y + 1) * scale; y++) {
      for (let x = pixel.x * scale; x < (pixel.x + 1) * scale; x++) {
        rgba.set(color, (y * width + x) * 4);
      }
    }
  }
  return { width, height, rgba };
}

export function renderFacePixelDifference(before: FacePixelPlan, after: FacePixelPlan, scale = 24): RawImage {
  const width = 8 * scale;
  const height = 8 * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) rgba.set([25, 27, 32, 255], pixel * 4);
  const keyed = (plan: FacePixelPlan) => new Map(plan.pixels
    .filter((pixel) => pixel.cluster !== "fringe")
    .map((pixel) => [`${pixel.x},${pixel.y}`, pixel]));
  const first = keyed(before);
  const second = keyed(after);
  for (const key of new Set([...first.keys(), ...second.keys()])) {
    const oldPixel = first.get(key);
    const newPixel = second.get(key);
    if (oldPixel?.role === newPixel?.role && oldPixel?.cluster === newPixel?.cluster) continue;
    const [x, y] = key.split(",").map(Number);
    const reference = newPixel ?? oldPixel!;
    const color = reference.role === "brow"
      ? [255, 196, 48, 255] as const
      : reference.cluster === "left_eye" || reference.cluster === "right_eye"
        ? [64, 210, 255, 255] as const
        : reference.cluster === "mouth"
          ? [255, 86, 132, 255] as const
          : reference.cluster === "complexion" || reference.cluster === "fringe"
            ? [126, 235, 112, 255] as const
            : [184, 136, 255, 255] as const;
    for (let py = y * scale; py < (y + 1) * scale; py++) for (let px = x * scale; px < (x + 1) * scale; px++) {
      rgba.set(color, (py * width + px) * 4);
    }
  }
  return { width, height, rgba };
}

/** Five-face pixel map showing exactly which measured geometry survived quantization. */
export function renderQuantizedHeadPlan(plan: HairPlan, facePlan: FacePixelPlan, scale = 16): RawImage {
  const faces = ["front", "top", "left", "right", "back"] as const;
  const width = faces.length * 8 * scale;
  const height = 8 * scale;
  const rgba = new Uint8Array(width * height * 4);
  const fillCell = (faceIndex: number, x: number, y: number, color: readonly [number, number, number, number]) => {
    for (let py = y * scale; py < (y + 1) * scale; py++) {
      for (let px = (faceIndex * 8 + x) * scale; px < (faceIndex * 8 + x + 1) * scale; px++) {
        rgba.set(color, (py * width + px) * 4);
      }
    }
  };
  faces.forEach((_face, faceIndex) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) fillCell(faceIndex, x, y, [28, 31, 38, 255]);
  });
  faces.forEach((face, faceIndex) => {
    for (const point of plan.headMask.faces[face]) {
      fillCell(faceIndex, point.x, point.y, point.role === "covering" ? [135, 92, 174, 255] : [74, 92, 112, 255]);
    }
    for (const group of plan.structure.groups) for (const point of group.points) if (point.face === face) {
      const color = point.role === "tip"
        ? [255, 80, 96, 255] as const
        : point.role === "light" || point.role === "part_light"
          ? [255, 208, 72, 255] as const
          : [90, 220, 255, 255] as const;
      fillCell(faceIndex, point.x, point.y, color);
    }
  });
  for (const pixel of facePlan.pixels) fillCell(0, pixel.x, pixel.y, ROLE_COLORS[pixel.role]);
  return { width, height, rgba };
}

export async function writeIdentityEvaluationArtifacts(
  outputRoot: string,
  caseId: string,
  artifacts: IdentityEvaluationArtifacts,
): Promise<string> {
  if (!outputRoot.trim()) throw new Error("An explicit evaluation artifact root is required");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(caseId)) throw new Error("Invalid evaluation case id");
  const caseDirectory = resolve(outputRoot, caseId);
  await mkdir(caseDirectory, { recursive: true });
  const images: Array<[string, RawImage | undefined]> = [
    ["01-source-face.png", artifacts.sourceFace],
    ["01b-source-head.png", artifacts.sourceHead],
    ["01c-geometry-overlay.png", artifacts.geometryOverlay],
    ["01d-source-head-geometry-overlay.png", artifacts.sourceHeadGeometryOverlay],
    ["01e-source-face-geometry-overlay.png", artifacts.sourceFaceGeometryOverlay],
    ["01j-source-to-grid-overlay.png", artifacts.sourceToGridOverlay],
    ["01f-fringe-geometry-overlay.png", artifacts.fringeGeometryOverlay],
    ["01g-temple-geometry-overlay.png", artifacts.templeGeometryOverlay],
    ["01h-crown-contour-overlay.png", artifacts.crownContourOverlay],
    ["01h2-major-volume-overlay.png", artifacts.majorVolumeOverlay],
    ["01i-face-window-overlay.png", artifacts.faceWindowOverlay],
    ["02-generated-sheet-face.png", artifacts.generatedSheetFace],
    ["03-packed-head-before-identity.png", artifacts.packedHeadBefore],
    ["04a-old-face-pixel-plan.png", artifacts.oldFacePixelPlan ? renderFacePixelPlan(artifacts.oldFacePixelPlan) : undefined],
    ["04-face-pixel-plan.png", renderFacePixelPlan(artifacts.facePixelPlan)],
    ["04c-face-pixel-diff.png", artifacts.facePixelDiff],
    ["04b-quantized-head-plan.png", artifacts.quantizedHeadPlan],
    ["05-candidate-a.png", artifacts.candidateA],
    ["06-candidate-b.png", artifacts.candidateB],
    ["06b-candidate-c.png", artifacts.candidateC],
    ["06c-base-head-only.png", artifacts.baseHeadOnly],
    ["06d-outer-head-only.png", artifacts.outerHeadOnly],
    ["06e-base-plus-outer-head.png", artifacts.baseOuterHead],
    ["07-final-head-front.png", artifacts.finalHeadFront],
    ["07b-final-head-front-left.png", artifacts.finalHeadFrontLeft],
    ["08-final-head-left.png", artifacts.finalHeadLeft],
    ["08b-final-head-front-right.png", artifacts.finalHeadFrontRight],
    ["09-final-head-right.png", artifacts.finalHeadRight],
    ["09b-final-head-top.png", artifacts.finalHeadTop],
    ["09c-final-head-back.png", artifacts.finalHeadBack],
    ["09d-before-after-head-montage.png", artifacts.beforeAfterHeadMontage],
    ["11-before-front.png", artifacts.beforeHeadFront],
    ["12-after-front.png", artifacts.finalHeadFront],
    ["13-before-front-left.png", artifacts.beforeHeadFrontLeft],
    ["14-after-front-left.png", artifacts.finalHeadFrontLeft],
    ["15-before-front-right.png", artifacts.beforeHeadFrontRight],
    ["16-after-front-right.png", artifacts.finalHeadFrontRight],
    ["09e-six-view.png", artifacts.sixView],
    ["10-final-skin.png", artifacts.finalSkin],
    ["source-head.png", artifacts.sourceHead],
    ["source-head-geometry-overlay.png", artifacts.sourceHeadGeometryOverlay ?? artifacts.geometryOverlay],
    ["fringe-overlay.png", artifacts.fringeGeometryOverlay],
    ["temple-overlay.png", artifacts.templeGeometryOverlay],
    ["crown-overlay.png", artifacts.crownContourOverlay],
    ["major-volume-overlay.png", artifacts.majorVolumeOverlay],
    ["face-window-overlay.png", artifacts.faceWindowOverlay],
    ["quantized-plan.png", artifacts.quantizedHeadPlan],
    ["final-head.png", artifacts.finalHeadFront],
    ["six-view.png", artifacts.sixView],
  ];
  await Promise.all(images.flatMap(([name, image]) => image ? [encodePng(image).then((bytes) => writeFile(join(caseDirectory, name), bytes))] : []));
  await Promise.all([
    writeFile(join(caseDirectory, "critique.json"), JSON.stringify(artifacts.critique, null, 2), "utf8"),
    writeFile(join(caseDirectory, "metrics.json"), JSON.stringify(artifacts.metrics, null, 2), "utf8"),
  ]);
  return caseDirectory;
}
