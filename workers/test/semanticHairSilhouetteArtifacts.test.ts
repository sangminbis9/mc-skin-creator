import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const RUN = process.env.RUN_SEMANTIC_HAIR_ARTIFACTS === "1";
const ROOT = resolve("evaluation-artifacts/semantic-hair-silhouette-20260914-v5");
const COMPARISON = resolve(ROOT, "comparison");
const CASES = [
  "short-hair-red-shirt",
  "long-straight-hair",
  "wavy-open-blazer",
  "glasses-monochrome",
  "headscarf-color-blocks",
] as const;
const VIEWS = ["front", "front_left_three_quarter", "front_right_three_quarter", "back"] as const;

type Stored = {
  analysis: {
    observed: { hair: string };
    renderHints: Record<string, unknown>;
  };
  plan: {
    facePixelPlan: unknown;
    outfitPlan: unknown;
    hairPlan: {
      template: string;
      lengthClass: string;
      texture: string;
      fringe: string;
      part: string;
      headMask: {
        source: string;
        endpointRows: { left: number; right: number };
        widthByRow: { left: number[]; right: number[]; back: number[] };
        earExposure: { left: number; right: number };
        semanticSilhouette?: unknown;
      };
    };
    headIdentityPlan: {
      ownership: {
        execution: string;
        cells: Array<{
          face: "front" | "top" | "left" | "right" | "back";
          layer: "base" | "outer";
          x: number;
          y: number;
          owner: string;
        }>;
      };
    };
  };
};

type Metrics = {
  productionAccepted: boolean;
  diff: { head: number; torso: number; arms: number; legs: number; outer: number; patternOnly: number };
  craft: { overlayVerticalSeamMismatches: number; overlayHorizontalSeamMismatches: number };
  apiUsage: { geminiGeometry: number; absolute: number; pairwise: number; interactions: number };
};

function blank(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([226, 232, 240, 255], offset);
  return { width, height, rgba };
}

function paste(target: RawImage, source: RawImage, x: number, y: number, size: number) {
  const ratio = Math.min(size / source.width, size / source.height);
  const scaled = scaleNearestNeighbor(source, Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
  const offsetX = x + Math.floor((size - scaled.width) / 2);
  const offsetY = y + Math.floor((size - scaled.height) / 2);
  for (let row = 0; row < scaled.height; row++) {
    for (let column = 0; column < scaled.width; column++) {
      const sourceOffset = (row * scaled.width + column) * 4;
      const targetOffset = ((offsetY + row) * target.width + offsetX + column) * 4;
      target.rgba.set(scaled.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
}

function planSummary(stored: Stored) {
  const { hairPlan } = stored.plan;
  return {
    template: hairPlan.template,
    lengthClass: hairPlan.lengthClass,
    texture: hairPlan.texture,
    fringe: hairPlan.fringe,
    part: hairPlan.part,
    maskSource: hairPlan.headMask.source,
    ownershipExecution: stored.plan.headIdentityPlan.ownership.execution,
    semanticSilhouette: hairPlan.headMask.semanticSilhouette ?? null,
  };
}

function opaque(atlas: RawImage, layer: "base" | "outer", face: "front" | "top" | "left" | "right" | "back", x: number, y: number) {
  const rect = CLASSIC_LAYOUT.head[layer === "base" ? "base" : "overlay"][face];
  return atlas.rgba[((rect.y + y) * 64 + rect.x + x) * 4 + 3] >= 128;
}

function bodyContinuationRows(stored: Stored) {
  const length = stored.analysis.renderHints.overallHairLength as string;
  const rows = ({ cropped: 0, ear: 0, jaw: 0, shoulder: 4, chest: 8, waist: 12, hip: 12 } as Record<string, number>)[length] ?? 0;
  return Math.max(rows, stored.analysis.renderHints.sideHairLength === "shoulder" ? 4 : 0);
}

function silhouetteSummary(stored: Stored, atlas: RawImage) {
  const mask = stored.plan.hairPlan.headMask;
  const outerOpaqueByRow = Object.fromEntries((["left", "right", "back"] as const).map((face) => [
    face,
    Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => Number(opaque(atlas, "outer", face, x, y))).reduce((sum, value) => sum + value, 0)),
  ]));
  const hairOwnedOpaqueByRow = Object.fromEntries((["left", "right", "back"] as const).map((face) => [
    face,
    Array.from({ length: 8 }, (_, y) => new Set(stored.plan.headIdentityPlan.ownership.cells
      .filter((cell) => cell.face === face && cell.y === y && cell.owner.startsWith("hair") && opaque(atlas, cell.layer, face, cell.x, cell.y))
      .map((cell) => cell.x)).size),
  ]));
  const frontVisibleWidthByRow = Array.from({ length: 8 }, (_, y) =>
    Array.from({ length: 8 }, (_, x) => Number(!opaque(atlas, "outer", "front", x, y))).reduce((sum, value) => sum + value, 0));
  const earVisibility = Object.fromEntries((["left", "right"] as const).map((face) => {
    let visible = 0;
    let samples = 0;
    for (let y = Math.max(0, mask.endpointRows[face] - 1); y < 8; y++) for (let x = 2; x < 6; x++) {
      samples++;
      if (!opaque(atlas, "outer", face, x, y)) visible++;
    }
    return [face, visible / Math.max(1, samples)];
  }));
  const occludedIdentityLandmarks = stored.plan.facePixelPlan && typeof stored.plan.facePixelPlan === "object" && "pixels" in stored.plan.facePixelPlan
    ? (stored.plan.facePixelPlan as { pixels: Array<{ x: number; y: number; cluster: string }> }).pixels
      .filter((pixel) => ["left_eye", "right_eye", "mouth"].includes(pixel.cluster) && opaque(atlas, "outer", "front", pixel.x, pixel.y)).length
    : null;
  return {
    endpointRows: mask.endpointRows,
    widthByRow: mask.widthByRow,
    earExposure: mask.earExposure,
    bodyContinuationRows: bodyContinuationRows(stored),
    actualAtlas: { outerOpaqueByRow, hairOwnedOpaqueByRow, frontVisibleWidthByRow, earVisibility, occludedIdentityLandmarks },
  };
}

function rgbaDifference(before: RawImage, after: RawImage) {
  let changedPixels = 0;
  for (let pixel = 0; pixel < before.width * before.height; pixel++) {
    const offset = pixel * 4;
    if ([0, 1, 2, 3].some((channel) => before.rgba[offset + channel] !== after.rgba[offset + channel])) changedPixels++;
  }
  return changedPixels;
}

function faceLandmarkDifference(before: RawImage, after: RawImage, stored: Stored) {
  if (!stored.plan.facePixelPlan || typeof stored.plan.facePixelPlan !== "object" || !("pixels" in stored.plan.facePixelPlan)) return null;
  const face = CLASSIC_LAYOUT.head.base.front;
  const changed: Array<{ x: number; y: number; cluster: string }> = [];
  for (const pixel of (stored.plan.facePixelPlan as { pixels: Array<{ x: number; y: number; cluster: string }> }).pixels.filter((item) => item.cluster !== "fringe")) {
    const offset = ((face.y + pixel.y) * 64 + face.x + pixel.x) * 4;
    if ([0, 1, 2, 3].some((channel) => before.rgba[offset + channel] !== after.rgba[offset + channel])) changed.push(pixel);
  }
  return changed;
}

function widthDistance(left: Stored, right: Stored) {
  const a = left.plan.hairPlan.headMask;
  const b = right.plan.hairPlan.headMask;
  const sum = (first: number[], second: number[]) => first.reduce((total, value, index) => total + Math.abs(value - second[index]), 0);
  return {
    sideRowsL1: sum(a.widthByRow.left, b.widthByRow.left) + sum(a.widthByRow.right, b.widthByRow.right),
    backRowsL1: sum(a.widthByRow.back, b.widthByRow.back),
    endpointRowsL1: Math.abs(a.endpointRows.left - b.endpointRows.left) + Math.abs(a.endpointRows.right - b.endpointRows.right),
  };
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe.skipIf(!RUN)("semantic hair silhouette comparison artifacts", () => {
  it("writes a new five-case source/before/after comparison without network calls", async () => {
    await expect(access(resolve(COMPARISON, "summary.json"))).rejects.toThrow();
    await mkdir(COMPARISON, { recursive: true });
    const tile = 128;
    const sheet = blank(tile * 9, tile * CASES.length);
    const cases: Record<string, unknown> = {};
    const storedPairs = new Map<string, { before: Stored; after: Stored }>();

    for (const [row, id] of CASES.entries()) {
      const beforeDirectory = resolve(ROOT, "before", id);
      const afterDirectory = resolve(ROOT, "after", id);
      const [source, beforeAtlas, afterAtlas, before, after, beforeMetrics, afterMetrics] = await Promise.all([
        decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "head-crop.png")))),
        decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "atlas.png")))),
        decodePng(new Uint8Array(await readFile(resolve(afterDirectory, "atlas.png")))),
        json<Stored>(resolve(beforeDirectory, "analysis-and-plan.json")),
        json<Stored>(resolve(afterDirectory, "analysis-and-plan.json")),
        json<Metrics>(resolve(beforeDirectory, "metrics.json")),
        json<Metrics>(resolve(afterDirectory, "metrics.json")),
      ]);
      storedPairs.set(id, { before, after });
      const beforeViews = renderSkinViews(beforeAtlas);
      const afterViews = renderSkinViews(afterAtlas);
      paste(sheet, source, 0, row * tile, tile);
      VIEWS.forEach((name, index) => {
        const beforeView = beforeViews.find((view) => view.name === name);
        const afterView = afterViews.find((view) => view.name === name);
        if (!beforeView || !afterView) throw new Error(`${id}: missing ${name}`);
        paste(sheet, extractRenderedHeadView(beforeView, tile), (index * 2 + 1) * tile, row * tile, tile);
        paste(sheet, extractRenderedHeadView(afterView, tile), (index * 2 + 2) * tile, row * tile, tile);
      });

      const hints = after.analysis.renderHints;
      const faceSignatureEqual = JSON.stringify(before.plan.facePixelPlan) === JSON.stringify(after.plan.facePixelPlan);
      const outfitPlanEqual = JSON.stringify(before.plan.outfitPlan) === JSON.stringify(after.plan.outfitPlan);
      const totalChangedPixels = rgbaDifference(beforeAtlas, afterAtlas);
      const changedFaceLandmarks = faceLandmarkDifference(beforeAtlas, afterAtlas, after);
      const bodyDiff = afterMetrics.diff.torso + afterMetrics.diff.arms + afterMetrics.diff.legs;
      expect(faceSignatureEqual, `${id}: FacePixelPlan`).toBe(true);
      expect(outfitPlanEqual, `${id}: OutfitPlan`).toBe(true);
      expect(bodyDiff, `${id}: body pixels`).toBe(0);
      expect(changedFaceLandmarks, `${id}: face landmark atlas pixels`).toEqual([]);
      expect(afterMetrics.productionAccepted, `${id}: craft acceptance`).toBe(true);
      expect(Object.values(afterMetrics.apiUsage).every((count) => count === 0), `${id}: API usage`).toBe(true);

      cases[id] = {
        sourceHairCues: {
          observedHair: after.analysis.observed.hair,
          hairTexture: hints.hairTexture,
          hairVolume: hints.hairVolume,
          hairSilhouette: hints.hairSilhouette,
          hairBackShape: hints.hairBackShape,
          overallHairLength: hints.overallHairLength,
          sideHairLength: hints.sideHairLength,
          sideHairShape: hints.sideHairShape,
          sideHairAsymmetry: hints.sideHairAsymmetry,
          earExposure: hints.earExposure,
          hairPart: hints.hairPart,
        },
        beforePlan: planSummary(before),
        afterPlan: planSummary(after),
        beforeSilhouette: silhouetteSummary(before, beforeAtlas),
        afterSilhouette: silhouetteSummary(after, afterAtlas),
        atlasDiff: { totalChangedPixels, ...afterMetrics.diff, bodyDiff, faceLandmarkPixelDiff: changedFaceLandmarks?.length ?? null },
        faceSignatureEqual,
        outfitPlanEqual,
        craft: {
          beforeAccepted: beforeMetrics.productionAccepted,
          afterAccepted: afterMetrics.productionAccepted,
          beforeVerticalSeams: beforeMetrics.craft.overlayVerticalSeamMismatches,
          afterVerticalSeams: afterMetrics.craft.overlayVerticalSeamMismatches,
          beforeHorizontalSeams: beforeMetrics.craft.overlayHorizontalSeamMismatches,
          afterHorizontalSeams: afterMetrics.craft.overlayHorizontalSeamMismatches,
        },
      };
    }

    const straight = storedPairs.get("long-straight-hair")!;
    const wavy = storedPairs.get("wavy-open-blazer")!;
    const straightVsWavy = {
      before: widthDistance(straight.before, wavy.before),
      after: widthDistance(straight.after, wavy.after),
    };
    expect(straightVsWavy.before.sideRowsL1).toBe(0);
    expect(straightVsWavy.before.backRowsL1).toBe(0);
    expect(straightVsWavy.after.sideRowsL1).toBeGreaterThan(0);
    expect(straightVsWavy.after.backRowsL1).toBeGreaterThan(0);
    expect((cases["glasses-monochrome"] as { atlasDiff: { totalChangedPixels: number } }).atlasDiff.totalChangedPixels).toBe(0);
    expect((cases["headscarf-color-blocks"] as { atlasDiff: { totalChangedPixels: number } }).atlasDiff.totalChangedPixels).toBe(0);

    await Promise.all([
      writeFile(resolve(COMPARISON, "contact-sheet.png"), await encodePng(sheet)),
      writeFile(resolve(COMPARISON, "summary.json"), JSON.stringify({
        apiCalls: 0,
        columns: ["source", "before_front", "after_front", "before_front_left", "after_front_left", "before_front_right", "after_front_right", "before_back", "after_back"],
        rows: CASES,
        cases,
        straightVsWavy,
      }, null, 2)),
    ]);
  });
});
