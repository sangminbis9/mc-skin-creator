/** Opt-in, network-free role-aware facial contrast evidence. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { facialColorDistance, type FacialRgb } from "../src/facialContrast";
import { buildProceduralFallbackAtlas } from "../src/generate";
import type { FacePaletteRole, FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { buildSkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const RUN = process.env.RUN_FACIAL_CONTRAST_ARTIFACTS === "1";
const ROOT = resolve(process.env.FACIAL_CONTRAST_ARTIFACT_ROOT ?? "evaluation-artifacts/facial-contrast-topology-preserving-20260915");
const CASES = ["long-straight-hair", "wavy-open-blazer", "headscarf-color-blocks", "short-hair-red-shirt", "glasses-monochrome"] as const;
const ROLES: FacePaletteRole[] = ["brow", "iris", "sclera", "nose_bridge", "nose_tip", "nose_shadow", "lip", "mouth_shadow", "teeth"];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const key = (x: number, y: number) => `${x},${y}`;
const luminance = (color: FacialRgb) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
const rgbAt = (image: RawImage, x: number, y: number): FacialRgb => {
  const at = (y * image.width + x) * 4;
  return [image.rgba[at], image.rgba[at + 1], image.rgba[at + 2]];
};
const meanColor = (colors: FacialRgb[]): FacialRgb => colors.length === 0 ? [0, 0, 0] : [0, 1, 2].map((channel) => Math.round(colors.reduce((sum, color) => sum + color[channel], 0) / colors.length)) as FacialRgb;
const mean = (values: number[]) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function compositeFace(atlas: RawImage, scale = 16): RawImage {
  const base = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const rgba = new Uint8Array(8 * scale * 8 * scale * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const baseAt = ((base.y + y) * atlas.width + base.x + x) * 4;
    const overlayAt = ((overlay.y + y) * atlas.width + overlay.x + x) * 4;
    const sourceAt = atlas.rgba[overlayAt + 3] === 0 ? baseAt : overlayAt;
    for (let py = y * scale; py < (y + 1) * scale; py++) for (let px = x * scale; px < (x + 1) * scale; px++) {
      rgba.set(atlas.rgba.subarray(sourceAt, sourceAt + 4), (py * 8 * scale + px) * 4);
    }
  }
  return { width: 8 * scale, height: 8 * scale, rgba };
}

function cropSecondary(face: RawImage): RawImage {
  const y0 = Math.floor(face.height / 8);
  const y1 = face.height;
  const rgba = new Uint8Array(face.width * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) rgba.set(face.rgba.subarray(y * face.width * 4, (y + 1) * face.width * 4), (y - y0) * face.width * 4);
  return { width: face.width, height: y1 - y0, rgba };
}

function canvas(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < rgba.length; at += 4) rgba.set([226, 232, 238, 255], at);
  return { width, height, rgba };
}

function paste(output: RawImage, source: RawImage, x: number, y: number, width: number, height: number): void {
  const ratio = Math.min(width / source.width, height / source.height);
  const resized = scaleNearestNeighbor(source, Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
  const left = x + Math.floor((width - resized.width) / 2);
  const top = y + Math.floor((height - resized.height) / 2);
  for (let py = 0; py < resized.height; py++) for (let px = 0; px < resized.width; px++) {
    const read = (py * resized.width + px) * 4;
    output.rgba.set(resized.rgba.subarray(read, read + 4), ((top + py) * output.width + left + px) * 4);
  }
}

function frontCellMap(atlas: RawImage, outputSize: number): number[][] {
  const marked: RawImage = { ...atlas, rgba: atlas.rgba.slice() };
  const face = CLASSIC_LAYOUT.head.base.front;
  const markers: FacialRgb[] = [];
  for (let cell = 0; cell < 64; cell++) {
    const marker: FacialRgb = [9 + cell * 3, 211 - cell * 2, 37 + cell];
    markers.push(marker);
    const x = cell % 8;
    const y = Math.floor(cell / 8);
    marked.rgba.set([...marker, 255], ((face.y + y) * marked.width + face.x + x) * 4);
  }
  const preview = extractRenderedHeadView(renderSkinViews(marked).find((view) => view.name === "front")!, outputSize);
  return markers.map((marker) => {
    const indices: number[] = [];
    for (let index = 0; index < preview.width * preview.height; index++) {
      const at = index * 4;
      if (preview.rgba[at] === marker[0] && preview.rgba[at + 1] === marker[1] && preview.rgba[at + 2] === marker[2]) indices.push(index);
    }
    return indices;
  });
}

function roleMetrics(atlas: RawImage, plan: FacePixelPlan, outputSize?: number) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const landmarkKeys = new Set(plan.pixels.filter((pixel) => !["complexion", "fringe"].includes(pixel.cluster)).map((pixel) => key(pixel.x, pixel.y)));
  const rendered = outputSize === undefined ? undefined : extractRenderedHeadView(renderSkinViews(atlas).find((view) => view.name === "front")!, outputSize);
  const mapping = outputSize === undefined ? undefined : frontCellMap(atlas, outputSize);
  const result: Partial<Record<FacePaletteRole, unknown>> = {};
  for (const role of ROLES) {
    const samples = plan.pixels.filter((pixel) => pixel.role === role).flatMap((pixel) => {
      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
      const neighborCells = neighbors.map(([dx, dy]) => ({ x: pixel.x + dx, y: pixel.y + dy }))
        .filter((point) => point.x >= 0 && point.x < 8 && point.y >= 0 && point.y < 8 && !landmarkKeys.has(key(point.x, point.y)));
      if (!rendered || !mapping) {
        if (neighborCells.length === 0) return [];
        const foreground = rgbAt(atlas, face.x + pixel.x, face.y + pixel.y);
        const background = meanColor(neighborCells.map((point) => rgbAt(atlas, face.x + point.x, face.y + point.y)));
        return [{ foreground, background, colorDistance: facialColorDistance(foreground, background), luminanceDifference: Math.abs(luminance(foreground) - luminance(background)) }];
      }
      const foregroundIndices = mapping[pixel.y * 8 + pixel.x];
      const backgroundIndices = neighborCells.flatMap((point) => mapping[point.y * 8 + point.x]);
      if (foregroundIndices.length === 0 || backgroundIndices.length === 0) return [];
      const foreground = meanColor(foregroundIndices.map((index) => rgbAt(rendered, index % rendered.width, Math.floor(index / rendered.width))));
      const background = meanColor(backgroundIndices.map((index) => rgbAt(rendered, index % rendered.width, Math.floor(index / rendered.width))));
      return [{ foreground, background, colorDistance: facialColorDistance(foreground, background), luminanceDifference: Math.abs(luminance(foreground) - luminance(background)) }];
    });
    if (samples.length > 0) result[role] = {
      cells: samples.length,
      foregroundRgb: meanColor(samples.map((sample) => sample.foreground)),
      localSkinRgb: meanColor(samples.map((sample) => sample.background)),
      colorDistance: mean(samples.map((sample) => sample.colorDistance)),
      minimumColorDistance: Math.min(...samples.map((sample) => sample.colorDistance)),
      maximumColorDistance: Math.max(...samples.map((sample) => sample.colorDistance)),
      landmarkLuminance: mean(samples.map((sample) => luminance(sample.foreground))),
      localSkinLuminance: mean(samples.map((sample) => luminance(sample.background))),
      luminanceDifference: mean(samples.map((sample) => sample.luminanceDifference)),
      minimumLuminanceDifference: Math.min(...samples.map((sample) => sample.luminanceDifference)),
      maximumLuminanceDifference: Math.max(...samples.map((sample) => sample.luminanceDifference)),
    };
  }
  return result;
}

function atlasDiff(before: RawImage, after: RawImage, plan: FacePixelPlan) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const roleAt = new Map(plan.pixels.map((pixel) => [key(face.x + pixel.x, face.y + pixel.y), pixel.role]));
  let rgbDiff = 0;
  let alphaDiff = 0;
  let outsideFaceRgbDiff = 0;
  let faceBottomSeamRgbDiff = 0;
  let outsideHeadRgbDiff = 0;
  const changedByRole: Record<string, number> = {};
  const changedCoordinates: Array<{ x: number; y: number; role: FacePaletteRole | "face_bottom_seam" | "unplanned"; before: number[]; after: number[] }> = [];
  const inRect = (x: number, y: number, rect: { x: number; y: number; w: number; h: number }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
  const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
  for (let pixel = 0; pixel < before.width * before.height; pixel++) {
    const at = pixel * 4;
    const x = pixel % before.width;
    const y = Math.floor(pixel / before.width);
    const rgbChanged = (before.rgba[at + 3] !== 0 || after.rgba[at + 3] !== 0)
      && [0, 1, 2].some((channel) => before.rgba[at + channel] !== after.rgba[at + channel]);
    if (before.rgba[at + 3] !== after.rgba[at + 3]) alphaDiff++;
    if (!rgbChanged) continue;
    rgbDiff++;
    if (x < face.x || x >= face.x + face.w || y < face.y || y >= face.y + face.h) outsideFaceRgbDiff++;
    if (!headRects.some((rect) => inRect(x, y, rect))) outsideHeadRgbDiff++;
    const bottomSeam = inRect(x, y, CLASSIC_LAYOUT.head.base.bottom);
    if (bottomSeam) faceBottomSeamRgbDiff++;
    const role = roleAt.get(key(x, y)) ?? (bottomSeam ? "face_bottom_seam" : "unplanned");
    changedCoordinates.push({ x, y, role, before: [...before.rgba.subarray(at, at + 4)], after: [...after.rgba.subarray(at, at + 4)] });
    changedByRole[role] = (changedByRole[role] ?? 0) + 1;
  }
  return { coordinateDiff: 0, roleDiff: 0, alphaDiff, rgbDiff, outsideFaceRgbDiff, faceBottomSeamRgbDiff, outsideHeadRgbDiff, changedByRole, changedCoordinates };
}

describe.skipIf(!RUN)("role-aware facial contrast artifacts", () => {
  it("changes only planned RGB while preserving five frozen topologies", async () => {
    const sheet = canvas(1120, CASES.length * 180);
    const cases: Record<string, unknown> = {};
    for (const [row, id] of CASES.entries()) {
      const beforeDirectory = resolve(ROOT, "before", id);
      const stored = JSON.parse(await readFile(resolve(beforeDirectory, "analysis-and-plan.json"), "utf8")) as {
        normalized: PhotoAnalysis;
        features: Parameters<typeof buildProceduralFallbackAtlas>[0];
        style: FaceStyle;
        plan: ReturnType<typeof buildSkinPlan>;
      };
      const before = await decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "atlas.png"))));
      const source = await decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "head-crop.png"))));
      const plan = buildSkinPlan(structuredClone(stored.normalized));
      expect(plan).toEqual(stored.plan);
      const after = buildProceduralFallbackAtlas(stored.features, stored.style, plan);
      expect(after).not.toBeNull();
      const rendered = after!;
      const diff = atlasDiff(before, rendered, plan.facePixelPlan);
      expect(diff.alphaDiff, id).toBe(0);
      expect(diff.outsideHeadRgbDiff, `${id}: ${JSON.stringify(diff.changedCoordinates)}`).toBe(0);
      expect(Object.keys(diff.changedByRole).every((role) => ["brow", "lip", "mouth_shadow", "face_bottom_seam"].includes(role)), id).toBe(true);
      const beforeViews = renderSkinViews(before);
      const afterViews = renderSkinViews(rendered);
      const view = (views: ReturnType<typeof renderSkinViews>, name: "front" | "front_left_three_quarter", size = 96) => extractRenderedHeadView(views.find((item) => item.name === name)!, size);
      const beforeFlat = compositeFace(before);
      const afterFlat = compositeFace(rendered);
      const panels = [source, beforeFlat, afterFlat, view(beforeViews, "front"), view(afterViews, "front"), view(beforeViews, "front_left_three_quarter"), view(afterViews, "front_left_three_quarter")];
      panels.forEach((panel, column) => paste(sheet, panel, column * 160, row * 180, 160, 180));
      const directory = resolve(ROOT, "contrast-review", id);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(resolve(directory, "before-flat.png"), await encodePng(beforeFlat)),
        writeFile(resolve(directory, "after-flat.png"), await encodePng(afterFlat)),
        writeFile(resolve(directory, "before-front.png"), await encodePng(view(beforeViews, "front"))),
        writeFile(resolve(directory, "after-front.png"), await encodePng(view(afterViews, "front"))),
        writeFile(resolve(directory, "before-front-left.png"), await encodePng(view(beforeViews, "front_left_three_quarter"))),
        writeFile(resolve(directory, "after-front-left.png"), await encodePng(view(afterViews, "front_left_three_quarter"))),
        writeFile(resolve(directory, "secondary-landmarks-before.png"), await encodePng(cropSecondary(beforeFlat))),
        writeFile(resolve(directory, "secondary-landmarks-after.png"), await encodePng(cropSecondary(afterFlat))),
        writeFile(resolve(directory, "after-atlas.png"), await encodePng(rendered)),
      ]);
      const metrics = {
        caseId: id,
        planHash: { before: hash(JSON.stringify(stored.plan)), after: hash(JSON.stringify(plan)), equal: true },
        atlasHash: { before: hash(before.rgba), after: hash(rendered.rgba) },
        diff,
        atlas: { before: roleMetrics(before, plan.facePixelPlan), after: roleMetrics(rendered, plan.facePixelPlan) },
        renderedFront96: { before: roleMetrics(before, plan.facePixelPlan, 96), after: roleMetrics(rendered, plan.facePixelPlan, 96) },
        downscaledFront32: { before: roleMetrics(before, plan.facePixelPlan, 32), after: roleMetrics(rendered, plan.facePixelPlan, 32) },
        apiUsage: { gemini: 0, gemma: 0, evaluator: 0, network: 0 },
      };
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(metrics, null, 2));
      cases[id] = metrics;
    }
    const readContrast = (id: typeof CASES[number], stage: "atlas" | "renderedFront96" | "downscaledFront32", role: FacePaletteRole, phase: "before" | "after", metric: "colorDistance" | "minimumColorDistance" = "colorDistance") => {
      const record = cases[id] as Record<string, Record<string, Partial<Record<FacePaletteRole, { colorDistance: number; minimumColorDistance: number }>>>>;
      return record[stage][phase][role]?.[metric] ?? 0;
    };
    for (const id of ["long-straight-hair", "wavy-open-blazer"] as const) {
      expect(readContrast(id, "downscaledFront32", "lip", "after", "minimumColorDistance"), id)
        .toBeGreaterThan(readContrast(id, "downscaledFront32", "lip", "before", "minimumColorDistance"));
    }
    for (const id of CASES) {
      expect(readContrast(id, "atlas", "iris", "after"), id).toBe(readContrast(id, "atlas", "iris", "before"));
      expect(readContrast(id, "atlas", "nose_tip", "after"), id).toBe(readContrast(id, "atlas", "nose_tip", "before"));
      expect(readContrast(id, "atlas", "teeth", "after"), id).toBe(readContrast(id, "atlas", "teeth", "before"));
    }
    await mkdir(resolve(ROOT, "contrast-review"), { recursive: true });
    await writeFile(resolve(ROOT, "contrast-review", "contact-sheet.png"), await encodePng(sheet));
    await writeFile(resolve(ROOT, "contrast-review", "summary.json"), JSON.stringify({ cases, columns: ["source", "before enlarged 8x8", "after enlarged 8x8", "before front", "after front", "before front-left", "after front-left"], apiUsage: { gemini: 0, gemma: 0, evaluator: 0, network: 0 } }, null, 2));
  }, 120000);
});
