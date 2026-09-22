import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const RUN = process.env.RUN_HEAD_ACCESSORY_ARTIFACTS === "1";
const ROOT = resolve("evaluation-artifacts/head-accessory-topology-20260915-v2");
const COMPARISON = resolve(ROOT, "comparison");
const CASES = ["glasses-monochrome", "headscarf-color-blocks", "long-straight-hair", "wavy-open-blazer"] as const;
const VIEWS = ["front", "front_left_three_quarter", "front_right_three_quarter", "back"] as const;

type Stored = { analysis: PhotoAnalysis; style: FaceStyle; plan: SkinPlan };
type Metrics = {
  productionAccepted: boolean;
  diff: { head: number; torso: number; arms: number; legs: number; outer: number; patternOnly: number };
  craft: { overlayVerticalSeamMismatches: number; overlayHorizontalSeamMismatches: number };
  apiUsage: Record<string, number>;
};
type FramePoint = SkinPlan["facePixelPlan"]["glassesPlan"]["framePixels"][number];

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
  for (let row = 0; row < scaled.height; row++) for (let column = 0; column < scaled.width; column++) {
    const sourceOffset = (row * scaled.width + column) * 4;
    if (!scaled.rgba[sourceOffset + 3]) continue;
    target.rgba.set(scaled.rgba.subarray(sourceOffset, sourceOffset + 4), ((offsetY + row) * target.width + offsetX + column) * 4);
  }
}

function crop(atlas: RawImage, rect: { x: number; y: number; w: number; h: number }): RawImage {
  const out: RawImage = { width: rect.w, height: rect.h, rgba: new Uint8Array(rect.w * rect.h * 4) };
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const source = ((rect.y + y) * atlas.width + rect.x + x) * 4;
    out.rgba.set(atlas.rgba.subarray(source, source + 4), (y * rect.w + x) * 4);
  }
  return out;
}

function changedPixels(before: RawImage, after: RawImage) {
  let count = 0;
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    if ([0, 1, 2, 3].some((channel) => before.rgba[offset + channel] !== after.rgba[offset + channel])) count++;
  }
  return count;
}

function alpha(atlas: RawImage, face: "front" | "left" | "right", x: number, y: number) {
  const rect = CLASSIC_LAYOUT.head.overlay[face];
  return atlas.rgba[((rect.y + y) * 64 + rect.x + x) * 4 + 3];
}

function frameComponents(points: FramePoint[]) {
  const keys = new Set(points.filter((point) => point.face === "front").map((point) => `${point.x},${point.y}`));
  let count = 0;
  while (keys.size) {
    count++;
    const queue = [keys.values().next().value as string];
    while (queue.length) {
      const key = queue.pop()!;
      if (!keys.delete(key)) continue;
      const [x, y] = key.split(",").map(Number);
      // Pixel-art diagonal rim steps are visually connected at preview scale.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const adjacent = `${x + dx},${y + dy}`;
        if (keys.has(adjacent)) queue.push(adjacent);
      }
    }
  }
  return count;
}

function lensMetrics(plan: SkinPlan["facePixelPlan"]["glassesPlan"], side: "left" | "right") {
  const selected = plan.framePixels.filter((point) => point.face === "front" && (side === "left" ? point.x <= 3 : point.x >= 4));
  const xs = selected.map((point) => point.x), ys = selected.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const at = (x: number, y: number) => selected.some((point) => point.x === x && point.y === y);
  const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]] as const;
  return {
    bbox: { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    openingPixels: plan.lensOpenings.filter((point) => side === "left" ? point.x <= 3 : point.x >= 4).length,
    rimOccupancy: {
      top: selected.filter((point) => point.y === minY).length,
      bottom: selected.filter((point) => point.y === maxY).length,
      outer: selected.filter((point) => point.x === (side === "left" ? minX : maxX)).length,
      inner: selected.filter((point) => point.x === (side === "left" ? maxX : minX)).length,
    },
    circularityProxy: 1 - corners.filter(([x, y]) => at(x, y)).length / 4,
  };
}

function eyeSignature(plan: SkinPlan) {
  return plan.facePixelPlan.pixels.filter((pixel) => ["left_eye", "right_eye"].includes(pixel.cluster));
}

function faceSignature(plan: SkinPlan) {
  return plan.facePixelPlan.pixels.filter((pixel) => pixel.cluster !== "fringe");
}

function glassesSummary(stored: Stored, atlas: RawImage) {
  const plan = stored.plan.facePixelPlan.glassesPlan;
  const eyes = eyeSignature(stored.plan);
  return {
    topology: plan.topology,
    framePixels: plan.framePixels.length,
    lensOpeningPixels: plan.lensOpenings.length,
    bridgePixels: plan.framePixels.filter((point) => point.role === "bridge").length,
    sideArmPixels: plan.sideArms.length,
    frontFrameConnectedComponents: frameComponents(plan.framePixels),
    lensOpeningSeparation: Math.abs(
      plan.lensOpenings.filter((point) => point.x >= 4).reduce((sum, point) => sum + point.x, 0) / Math.max(1, plan.lensOpenings.filter((point) => point.x >= 4).length)
      - plan.lensOpenings.filter((point) => point.x <= 3).reduce((sum, point) => sum + point.x, 0) / Math.max(1, plan.lensOpenings.filter((point) => point.x <= 3).length),
    ),
    lenses: { left: lensMetrics(plan, "left"), right: lensMetrics(plan, "right") },
    frontOverlayAlpha: Array.from({ length: 64 }, (_, index) => Number(alpha(atlas, "front", index % 8, Math.floor(index / 8)) > 0)).reduce((sum, value) => sum + value, 0),
    visibleEyePixels: eyes.filter((point) => alpha(atlas, "front", point.x, point.y) === 0).length,
  };
}

function coveringSummary(stored: Stored) {
  const mask = stored.plan.hairPlan.headMask;
  const occupied = (face: "front" | "left" | "right" | "back", y: number) => new Set(mask.faces[face].filter((point) => point.y === y).map((point) => point.x)).size;
  const ownership = stored.plan.headIdentityPlan.ownership?.cells ?? [];
  const outerByRow = (face: "front" | "left" | "right" | "back") => Array.from({ length: 8 }, (_, y) =>
    new Set(ownership.filter((cell) => cell.layer === "outer" && cell.face === face && cell.y === y && cell.owner === "covering").map((cell) => cell.x)).size);
  return {
    topology: mask.coveringTopology ?? null,
    frontOpeningWidthByRow: Array.from({ length: 8 }, (_, y) => 8 - occupied("front", y)),
    maskOccupancyByRow: Object.fromEntries((["left", "right", "back"] as const).map((face) => [face, Array.from({ length: 8 }, (_, y) => occupied(face, y))])),
    ownedOuterCoveringByRow: Object.fromEntries((["front", "left", "right", "back"] as const).map((face) => [face, outerByRow(face)])),
    coveringCells: ownership.filter((cell) => cell.owner === "covering").length,
    hairCells: ownership.filter((cell) => cell.owner.startsWith("hair")).length,
    pattern: stored.style.headCoveringPattern ?? "plain",
    accentSide: stored.style.headCoveringAccentSide ?? "none",
  };
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe.skipIf(!RUN)("head accessory topology comparison artifacts", () => {
  it("writes a source/before/after comparison with zero network/provider calls", async () => {
    await expect(access(resolve(COMPARISON, "summary.json"))).rejects.toThrow();
    await mkdir(COMPARISON, { recursive: true });
    const tile = 128;
    const sheet = blank(tile * 11, tile * CASES.length);
    const cases: Record<string, unknown> = {};
    for (const [row, id] of CASES.entries()) {
      const beforeDir = resolve(ROOT, "before", id), afterDir = resolve(ROOT, "after", id);
      const [source, beforeAtlas, afterAtlas, before, after, beforeMetrics, afterMetrics] = await Promise.all([
        decodePng(new Uint8Array(await readFile(resolve(beforeDir, "head-crop.png")))),
        decodePng(new Uint8Array(await readFile(resolve(beforeDir, "atlas.png")))),
        decodePng(new Uint8Array(await readFile(resolve(afterDir, "atlas.png")))),
        json<Stored>(resolve(beforeDir, "analysis-and-plan.json")),
        json<Stored>(resolve(afterDir, "analysis-and-plan.json")),
        json<Metrics>(resolve(beforeDir, "metrics.json")),
        json<Metrics>(resolve(afterDir, "metrics.json")),
      ]);
      paste(sheet, source, 0, row * tile, tile);
      paste(sheet, crop(beforeAtlas, CLASSIC_LAYOUT.head.overlay.front), tile, row * tile, tile);
      paste(sheet, crop(afterAtlas, CLASSIC_LAYOUT.head.overlay.front), tile * 2, row * tile, tile);
      const beforeViews = renderSkinViews(beforeAtlas), afterViews = renderSkinViews(afterAtlas);
      VIEWS.forEach((name, index) => {
        const b = beforeViews.find((view) => view.name === name), a = afterViews.find((view) => view.name === name);
        if (!b || !a) throw new Error(`${id}: missing ${name}`);
        paste(sheet, extractRenderedHeadView(b, tile), tile * (3 + index * 2), row * tile, tile);
        paste(sheet, extractRenderedHeadView(a, tile), tile * (4 + index * 2), row * tile, tile);
      });
      const faceSignatureEqual = JSON.stringify(faceSignature(before.plan)) === JSON.stringify(faceSignature(after.plan));
      const eyeSignatureEqual = JSON.stringify(eyeSignature(before.plan)) === JSON.stringify(eyeSignature(after.plan));
      const outfitPlanEqual = JSON.stringify(before.plan.outfitPlan) === JSON.stringify(after.plan.outfitPlan);
      const hairPlanEqual = JSON.stringify(before.plan.hairPlan) === JSON.stringify(after.plan.hairPlan);
      const totalAtlasDiff = changedPixels(beforeAtlas, afterAtlas);
      const bodyDiff = afterMetrics.diff.torso + afterMetrics.diff.arms + afterMetrics.diff.legs + afterMetrics.diff.outer + afterMetrics.diff.patternOnly;
      expect(afterMetrics.productionAccepted, `${id}: craft`).toBe(true);
      expect(Object.values(afterMetrics.apiUsage).every((value) => value === 0), `${id}: API`).toBe(true);
      expect(faceSignatureEqual, `${id}: face signature`).toBe(true);
      expect(outfitPlanEqual, `${id}: outfit`).toBe(true);
      expect(bodyDiff, `${id}: body`).toBe(0);
      const common = {
        sourceAccessoryCues: { observedHair: after.analysis.observed.hair, observedAccessories: after.analysis.observed.accessories },
        atlasDiff: { total: totalAtlasDiff, ...afterMetrics.diff, body: bodyDiff },
        faceSignatureEqual,
        eyeSignatureEqual,
        outfitPlanEqual,
        seams: {
          before: { vertical: beforeMetrics.craft.overlayVerticalSeamMismatches, horizontal: beforeMetrics.craft.overlayHorizontalSeamMismatches },
          after: { vertical: afterMetrics.craft.overlayVerticalSeamMismatches, horizontal: afterMetrics.craft.overlayHorizontalSeamMismatches },
        },
      };
      if (id === "glasses-monochrome") {
        const b = glassesSummary(before, beforeAtlas), a = glassesSummary(after, afterAtlas);
        expect(a.topology).toBe("oversized");
        expect(a.lenses.left.bbox).toMatchObject({ width: 3, height: 4 });
        expect(a.lenses.right.bbox).toMatchObject({ width: 3, height: 4 });
        expect(a.visibleEyePixels).toBe(b.visibleEyePixels);
        expect(a.frontFrameConnectedComponents).toBe(1);
        cases[id] = { ...common, beforeGlassesPlan: b, afterGlassesPlan: a };
      } else if (id === "headscarf-color-blocks") {
        const b = coveringSummary(before), a = coveringSummary(after);
        expect(a.topology).toMatchObject({ fit: "fitted_headscarf", provenance: "observed_categorical" });
        expect(a.hairCells).toBe(0);
        expect(a.frontOpeningWidthByRow).not.toEqual(b.frontOpeningWidthByRow);
        cases[id] = {
          ...common,
          sourceCoveringCues: { pattern: after.style.headCoveringPattern ?? "plain", accentSide: after.style.headCoveringAccentSide ?? "none" },
          beforeMask: b,
          afterMask: a,
          frontOpeningProfileDistance: a.frontOpeningWidthByRow.reduce((sum, value, index) => sum + Math.abs(value - b.frontOpeningWidthByRow[index]), 0),
        };
      } else {
        expect(hairPlanEqual, `${id}: semantic hair sentinel`).toBe(true);
        expect(totalAtlasDiff, `${id}: atlas sentinel`).toBe(0);
        cases[id] = { ...common, hairPlanEqual };
      }
    }
    await writeFile(resolve(COMPARISON, "summary.json"), JSON.stringify({
      cases,
      apiCalls: 0,
      columnOrder: ["source", "before_flat", "after_flat", "before_front", "after_front", "before_front_left", "after_front_left", "before_front_right", "after_front_right", "before_back", "after_back"],
    }, null, 2));
    await writeFile(resolve(COMPARISON, "contact-sheet.png"), await encodePng(sheet));
  });
});
