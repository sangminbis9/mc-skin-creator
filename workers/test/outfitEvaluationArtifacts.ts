import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";

function clone(image: RawImage): RawImage {
  return { ...image, rgba: image.rgba.slice() };
}

function clear(atlas: RawImage, rect: Rect): void {
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const index = ((rect.y + y) * atlas.width + rect.x + x) * 4;
    atlas.rgba.fill(0, index, index + 4);
  }
}

const BODY_PARTS = ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const;

export function buildBodyLayerDiagnostic(atlas: RawImage, mode: "base" | "outer" | "combined", scale = 6): RawImage {
  const result = clone(atlas);
  for (const rect of [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)]) clear(result, rect);
  for (const part of BODY_PARTS) {
    if (mode === "base") for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) clear(result, rect);
    if (mode === "outer") for (const rect of Object.values(CLASSIC_LAYOUT[part].base)) clear(result, rect);
  }
  return scaleNearestNeighbor(result, result.width * scale, result.height * scale);
}

export function buildOutfitPlanVisualization(plan: OutfitPlan, scale = 6): RawImage {
  const atlas: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  applyOutfitPlan(atlas, plan, "#d39e80");
  return buildBodyLayerDiagnostic(atlas, "combined", scale);
}

export function cropSourceOutfit(source: RawImage): RawImage {
  const y0 = Math.floor(source.height * 0.52);
  const height = Math.max(1, source.height - y0);
  const rgba = new Uint8Array(source.width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y + y0) * source.width) * 4;
    rgba.set(source.rgba.subarray(start, start + source.width * 4), y * source.width * 4);
  }
  return { width: source.width, height, rgba };
}

export function buildOutfitColorBlockDiagnostic(atlas: RawImage, plan: OutfitPlan, scale = 6): RawImage {
  const result = clone(atlas);
  for (const part of BODY_PARTS) for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) clear(result, rect);
  const allowed = new Set([plan.upper.baseColor.toLowerCase(), plan.upper.accentColor.toLowerCase(), plan.lower.baseColor.toLowerCase(), plan.lower.shoeColor.toLowerCase()]);
  for (const part of BODY_PARTS) for (const rect of Object.values(CLASSIC_LAYOUT[part].base)) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const index = ((rect.y + y) * result.width + rect.x + x) * 4;
    const luminance = (result.rgba[index] + result.rgba[index + 1] + result.rgba[index + 2]) / 3;
    const level = Math.round(luminance / 48) * 48;
    result.rgba.set([level, level, level, 255], index);
  }
  void allowed;
  return scaleNearestNeighbor(result, result.width * scale, result.height * scale);
}

export function buildOutfitPatternDiagnostic(atlas: RawImage, plan: OutfitPlan, scale = 6): RawImage {
  const result: RawImage = { width: atlas.width, height: atlas.height, rgba: new Uint8Array(atlas.rgba.length) };
  for (const part of BODY_PARTS) for (const layer of ["base", "overlay"] as const) for (const rect of Object.values(CLASSIC_LAYOUT[part][layer])) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const source = ((rect.y + y) * atlas.width + rect.x + x) * 4;
    if (atlas.rgba[source + 3] === 0) continue;
    const patternRow = plan.upper.pattern.kind === "horizontal_stripe" && y >= 2 && y < plan.lower.waistRow && (y - 2) % plan.upper.pattern.frequency === 0;
    const patternColumn = plan.upper.pattern.kind === "vertical_stripe" && x >= 1 && (x - 1) % plan.upper.pattern.frequency === 0;
    const accessory = layer === "overlay" && plan.accessories.length > 0;
    const color = patternRow || patternColumn ? [255, 196, 48, 255] : accessory ? [76, 222, 255, 255] : [42, 45, 52, 255];
    result.rgba.set(color, source);
  }
  return scaleNearestNeighbor(result, result.width * scale, result.height * scale);
}

export function buildBodySeamDiagnostic(atlas: RawImage, scale = 12): RawImage {
  const pairs = [
    [CLASSIC_LAYOUT.body.base.front, 0, CLASSIC_LAYOUT.body.base.right, CLASSIC_LAYOUT.body.base.right.w - 1],
    [CLASSIC_LAYOUT.body.base.front, CLASSIC_LAYOUT.body.base.front.w - 1, CLASSIC_LAYOUT.body.base.left, 0],
    [CLASSIC_LAYOUT.body.base.right, 0, CLASSIC_LAYOUT.body.base.back, CLASSIC_LAYOUT.body.base.back.w - 1],
    [CLASSIC_LAYOUT.body.base.left, CLASSIC_LAYOUT.body.base.left.w - 1, CLASSIC_LAYOUT.body.base.back, 0],
  ] as const;
  const width = 24 * scale;
  const height = pairs.length * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) rgba.set([28, 31, 38, 255], pixel * 4);
  pairs.forEach(([first, firstX, second, secondX], pairIndex) => {
    for (let y = 0; y < 12; y++) {
      const firstOffset = ((first.y + y) * atlas.width + first.x + firstX) * 4;
      const secondOffset = ((second.y + y) * atlas.width + second.x + secondX) * 4;
      const distance = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(atlas.rgba[firstOffset + channel] - atlas.rgba[secondOffset + channel]), 0);
      const color = distance <= 120 ? [72, 220, 126, 255] : [255, 78, 92, 255];
      for (let side = 0; side < 2; side++) for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) {
        const x = (y * 2 + side) * scale + px;
        const imageY = pairIndex * scale + py;
        rgba.set(color, (imageY * width + x) * 4);
      }
    }
  });
  return { width, height, rgba };
}

export function buildBodyPixelDiff(before: RawImage, after: RawImage, scale = 6): RawImage {
  const result: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  for (let pixel = 0; pixel < 64 * 64; pixel++) result.rgba.set([24, 27, 32, 255], pixel * 4);
  for (const part of BODY_PARTS) for (const layer of ["base", "overlay"] as const) for (const rect of Object.values(CLASSIC_LAYOUT[part][layer])) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const index = ((rect.y + y) * 64 + rect.x + x) * 4;
    if (![0, 1, 2, 3].some((channel) => before.rgba[index + channel] !== after.rgba[index + channel])) continue;
    const alphaChanged = before.rgba[index + 3] !== after.rgba[index + 3];
    result.rgba.set(alphaChanged ? [244, 76, 184, 255] : [64, 214, 246, 255], index);
  }
  return scaleNearestNeighbor(result, 64 * scale, 64 * scale);
}

export function buildSixViewMontage(atlas: RawImage): RawImage {
  const views = renderSkinViews(atlas);
  const cellWidth = views[0].image.width;
  const cellHeight = views[0].image.height;
  const rgba = new Uint8Array(cellWidth * 3 * cellHeight * 2 * 4);
  views.forEach((view, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    for (let y = 0; y < cellHeight; y++) {
      const read = y * cellWidth * 4;
      const write = ((row * cellHeight + y) * cellWidth * 3 + column * cellWidth) * 4;
      rgba.set(view.image.rgba.subarray(read, read + cellWidth * 4), write);
    }
  });
  return { width: cellWidth * 3, height: cellHeight * 2, rgba };
}

export interface OutfitArtifactSet {
  source: RawImage;
  before: RawImage;
  after: RawImage;
  plan: OutfitPlan;
  metrics: Record<string, unknown>;
}

export async function writeOutfitEvaluationArtifacts(outputRoot: string, caseId: string, artifacts: OutfitArtifactSet): Promise<string> {
  if (!outputRoot.trim()) throw new Error("An explicit output root is required");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(caseId)) throw new Error("Invalid case id");
  const directory = resolve(outputRoot, caseId);
  await mkdir(directory, { recursive: true });
  const base = buildBodyLayerDiagnostic(artifacts.after, "base");
  const outer = buildBodyLayerDiagnostic(artifacts.after, "outer");
  const combined = buildBodyLayerDiagnostic(artifacts.after, "combined");
  const images: Array<[string, RawImage]> = [
    ["01-source-reference.png", artifacts.source],
    ["02-source-outfit-crop.png", cropSourceOutfit(artifacts.source)],
    ["03-outfit-plan.png", buildOutfitPlanVisualization(artifacts.plan)],
    ["04-before-body-flat-uv.png", buildBodyLayerDiagnostic(artifacts.before, "combined")],
    ["05-after-body-flat-uv.png", combined],
    ["06-base-only.png", base],
    ["07-outer-only.png", outer],
    ["08-combined.png", combined],
    ["09-color-block-diagnostic.png", buildOutfitColorBlockDiagnostic(artifacts.after, artifacts.plan)],
    ["10-pattern-diagnostic.png", buildOutfitPatternDiagnostic(artifacts.after, artifacts.plan)],
    ["11-seam-diagnostic.png", buildBodySeamDiagnostic(artifacts.after)],
    ["12-pixel-diff.png", buildBodyPixelDiff(artifacts.before, artifacts.after)],
    ["13-six-view.png", buildSixViewMontage(artifacts.after)],
    ["14-final-skin.png", artifacts.after],
  ];
  await Promise.all(images.map(([name, image]) => encodePng(image).then((bytes) => writeFile(join(directory, name), bytes))));
  const views = renderSkinViews(artifacts.after);
  await Promise.all(views.map((view) => encodePng(view.image).then((bytes) => writeFile(join(directory, `view-${view.name}.png`), bytes))));
  await Promise.all([
    writeFile(join(directory, "outfit-plan.json"), JSON.stringify(artifacts.plan, null, 2), "utf8"),
    writeFile(join(directory, "metrics.json"), JSON.stringify(artifacts.metrics, null, 2), "utf8"),
  ]);
  return directory;
}
