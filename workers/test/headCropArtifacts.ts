import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { NormalizedBox } from "../src/identityGeometry";
import { encodePng, type RawImage } from "../src/png";

export interface CropArtifactSet {
  originalSource: RawImage;
  originalHeadBox: RawImage;
  desiredAdaptiveBox: RawImage;
  finalHeadCrop: RawImage;
  headCropCoverageOverlay: RawImage;
  sourceVsCropClipping: RawImage;
  geometryOverlay: RawImage;
  quantizedPlan: RawImage;
  finalHead: RawImage;
  sixView: RawImage;
  metrics: Record<string, unknown>;
}

function copy(image: RawImage): RawImage {
  return { ...image, rgba: image.rgba.slice() };
}

function setPixel(image: RawImage, x: number, y: number, color: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  image.rgba.set(color, (y * image.width + x) * 4);
}

function pixelEdges(image: RawImage, box: NormalizedBox): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.max(0, Math.min(image.width - 1, Math.round(box.left * (image.width - 1)))),
    top: Math.max(0, Math.min(image.height - 1, Math.round(box.top * (image.height - 1)))),
    right: Math.max(0, Math.min(image.width - 1, Math.round(box.right * (image.width - 1)))),
    bottom: Math.max(0, Math.min(image.height - 1, Math.round(box.bottom * (image.height - 1)))),
  };
}

export function drawNormalizedBox(
  image: RawImage,
  box: NormalizedBox,
  color: readonly [number, number, number, number],
  thickness = 3,
): RawImage {
  const result = copy(image);
  const edges = pixelEdges(result, box);
  for (let offset = 0; offset < thickness; offset++) {
    for (let x = edges.left; x <= edges.right; x++) {
      setPixel(result, x, edges.top + offset, color);
      setPixel(result, x, edges.bottom - offset, color);
    }
    for (let y = edges.top; y <= edges.bottom; y++) {
      setPixel(result, edges.left + offset, y, color);
      setPixel(result, edges.right - offset, y, color);
    }
  }
  return result;
}

export function drawNormalizedBoxes(
  image: RawImage,
  boxes: ReadonlyArray<{ box: NormalizedBox; color: readonly [number, number, number, number] }>,
): RawImage {
  return boxes.reduce((result, item) => drawNormalizedBox(result, item.box, item.color), copy(image));
}

export function cropNormalized(image: RawImage, box: NormalizedBox): RawImage {
  const edges = pixelEdges(image, box);
  const width = Math.max(1, edges.right - edges.left + 1);
  const height = Math.max(1, edges.bottom - edges.top + 1);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((edges.top + y) * image.width + edges.left) * 4;
    rgba.set(image.rgba.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

function area(box: NormalizedBox): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
}

export function boxCoverage(feature: NormalizedBox, crop: NormalizedBox): number {
  const intersection = {
    left: Math.max(feature.left, crop.left),
    top: Math.max(feature.top, crop.top),
    right: Math.min(feature.right, crop.right),
    bottom: Math.min(feature.bottom, crop.bottom),
  };
  return area(intersection) / Math.max(Number.EPSILON, area(feature));
}

export async function writeHeadCropEvaluationArtifacts(
  root: string,
  caseId: string,
  artifacts: CropArtifactSet,
): Promise<string> {
  if (!root.trim()) throw new Error("An explicit head-crop artifact root is required");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(caseId)) throw new Error(`Invalid head-crop artifact case id: ${caseId}`);
  const output = resolve(root, caseId);
  const resolvedRoot = resolve(root);
  if (output !== resolvedRoot && !output.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Artifact path escaped output root");
  await mkdir(output, { recursive: true });
  const images: Array<[string, RawImage]> = [
    ["01-original-source.png", artifacts.originalSource],
    ["02-original-head-box.png", artifacts.originalHeadBox],
    ["03-desired-adaptive-box.png", artifacts.desiredAdaptiveBox],
    ["04-final-head-crop.png", artifacts.finalHeadCrop],
    ["05-head-crop-coverage-overlay.png", artifacts.headCropCoverageOverlay],
    ["06-source-vs-crop-clipping.png", artifacts.sourceVsCropClipping],
    ["07-geometry-overlay.png", artifacts.geometryOverlay],
    ["08-quantized-plan.png", artifacts.quantizedPlan],
    ["09-final-head.png", artifacts.finalHead],
    ["10-six-view.png", artifacts.sixView],
  ];
  await Promise.all([
    ...images.map(async ([name, image]) => writeFile(join(output, name), await encodePng(image))),
    writeFile(join(output, "metrics.json"), `${JSON.stringify(artifacts.metrics, null, 2)}\n`, "utf8"),
  ]);
  return output;
}
