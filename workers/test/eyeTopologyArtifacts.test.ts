/** Opt-in, offline before/after evidence for deterministic eye topology. */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelInstruction, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_EYE_TOPOLOGY_ARTIFACTS === "1";
const INPUT = resolve("evaluation-artifacts/head-structure-iteration-final");
const BEFORE = resolve("evaluation-artifacts/eye-topology-20260913/before");
const AFTER = resolve("evaluation-artifacts/eye-topology-20260913/after");
const OUTPUT = resolve("evaluation-artifacts/eye-topology-20260913/comparison");

interface StoredP5Check { feature: string; targetRegions: string[] }

function category(feature: string, regions: string[]): IdentityFeatureCategory {
  const text = `${feature} ${regions.join(" ")}`.toLowerCase();
  if (/glass|frame|spectacle|scarf|accessor/.test(text)) return "accessory";
  if (/hair|fringe|bang|curl|silhouette/.test(text)) return "hair";
  if (/shirt|torso|outfit|collar|sweater/.test(text)) return "outfit";
  return "face";
}

function analysisFor(geometry: IdentityGeometryAnalysis, checks: StoredP5Check[]): PhotoAnalysis {
  const base = makeAnalysis();
  const features = checks.map((check) => ({
    feature: check.feature, category: category(check.feature, check.targetRegions),
    priority: 5 as const, confidence: "high" as const,
    evidence: "Stored source-analysis cue", targetRegions: check.targetRegions,
  }));
  const cueText = features.map((feature) => feature.feature).join(", ");
  return makeAnalysis({
    identityGeometry: geometry,
    canonicalIdentity: { overallImpression: cueText, mustPreserve: features.map((feature) => feature.feature), features },
    observed: { ...base.observed, accessories: geometry.glasses ? "measured glasses" : "no glasses" },
    fallbackFeatures: { ...base.fallbackFeatures, glasses: geometry.glasses ? "round" : "none" },
    renderHints: {
      ...base.renderHints,
      eyeShape: geometry.eyes.openness >= 0.68 ? "round" : geometry.eyes.openness <= 0.34 ? "narrow" : "almond",
      eyeSize: Math.max(geometry.eyes.leftWidth, geometry.eyes.rightWidth) >= 0.16 ? "large" : "average",
      mouthShape: geometry.mouth.width / Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft) >= 0.45 ? "wide" : "average",
      mouthOpening: geometry.mouth.opening === "teeth" ? "teeth_visible" : geometry.mouth.opening === "open" ? "slightly_open" : "closed",
    },
    identityPrompt: cueText,
    negativePrompt: geometry.glasses ? base.negativePrompt : "no glasses",
  });
}

function copyPixel(source: RawImage, target: RawImage, sx: number, sy: number, tx: number, ty: number): void {
  const from = (sy * source.width + sx) * 4;
  const to = (ty * target.width + tx) * 4;
  target.rgba.set(source.rgba.subarray(from, from + 4), to);
}

function visibleFront(atlas: RawImage, scale = 16): RawImage {
  const base = CLASSIC_LAYOUT.head.base.front;
  const outer = CLASSIC_LAYOUT.head.overlay.front;
  const image: RawImage = { width: 8 * scale, height: 8 * scale, rgba: new Uint8Array(8 * scale * 8 * scale * 4) };
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const outerAt = ((outer.y + y) * atlas.width + outer.x + x) * 4;
    const rect = atlas.rgba[outerAt + 3] > 0 ? outer : base;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      copyPixel(atlas, image, rect.x + x, rect.y + y, x * scale + dx, y * scale + dy);
    }
  }
  return image;
}

function contact(rows: Array<[RawImage, RawImage]>): RawImage {
  const cellWidth = Math.max(...rows.flat().map((image) => image.width));
  const heights = rows.map(([left, right]) => Math.max(left.height, right.height));
  const image: RawImage = { width: cellWidth * 2, height: heights.reduce((sum, value) => sum + value, 0), rgba: new Uint8Array(cellWidth * 2 * heights.reduce((sum, value) => sum + value, 0) * 4) };
  let top = 0;
  rows.forEach(([left, right], index) => {
    for (const [source, xOffset] of [[left, 0], [right, cellWidth]] as const) {
      for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) copyPixel(source, image, x, y, xOffset + x, top + y);
    }
    top += heights[index];
  });
  return image;
}

function oldEyeCells(plan: FacePixelPlan, cluster: "left_eye" | "right_eye"): FacePixelInstruction[] {
  const xs = cluster === "left_eye" ? [...plan.layout.leftEyeXs] : [...plan.layout.rightEyeXs].reverse();
  const row = cluster === "left_eye" ? plan.layout.leftEyeRow : plan.layout.rightEyeRow;
  const open = plan.layout.eyeTopology === "open_iris_sclera";
  // The legacy renderer implicitly converted the outer cell of a multi-cell
  // eye to its mid/sclera palette even when the old plan still called it iris.
  const cells = xs.map((x, position) => ({ x, y: row + (position === 0 ? plan.layout.eyeTiltOffset : 0), role: xs.length > 1 && position === 0 ? "sclera" as const : "iris" as const, cluster }));
  if (open) cells.push({ x: xs.at(-1)!, y: Math.min(7, row + 1), role: "iris", cluster });
  return cells;
}

function rgbaAt(atlas: RawImage, rect: Rect, x: number, y: number): number[] {
  const at = ((rect.y + y) * atlas.width + rect.x + x) * 4;
  return [...atlas.rgba.subarray(at, at + 4)];
}

function eyeMetrics(plan: FacePixelPlan, atlas: RawImage, cells: FacePixelInstruction[]) {
  const left = cells.filter((cell) => cell.cluster === "left_eye");
  const right = cells.filter((cell) => cell.cluster === "right_eye");
  const columns = (items: FacePixelInstruction[]) => [...new Set(items.map((item) => item.x))].sort((a, b) => a - b);
  const leftColumns = columns(left), rightColumns = columns(right);
  const leftIrisColumns = columns(left.filter((item) => item.role === "iris"));
  const rightIrisColumns = columns(right.filter((item) => item.role === "iris"));
  return {
    spacingTopology: plan.layout.eyeSpacingTopology,
    footprintTopology: plan.layout.eyeFootprintTopology,
    openness: plan.layout.eyeOpenness,
    leftEyeColumns: leftColumns,
    rightEyeColumns: rightColumns,
    interEyeGap: Math.min(...rightColumns) - Math.max(...leftColumns) - 1,
    perceivedIrisGap: Math.min(...rightIrisColumns) - Math.max(...leftIrisColumns) - 1,
    perEyeWidth: [leftColumns.length, rightColumns.length],
    perEyeHeight: [new Set(left.map((item) => item.y)).size, new Set(right.map((item) => item.y)).size],
    irisPixels: cells.filter((cell) => cell.role === "iris").length,
    darkPixelCount: cells.filter((cell) => cell.role === "iris").length,
    scleraPixels: cells.filter((cell) => cell.role === "sclera").length,
    overlayOverlap: cells.filter((cell) => rgbaAt(atlas, CLASSIC_LAYOUT.head.overlay.front, cell.x, cell.y)[3] > 0).length,
    pixels: cells.map((cell) => ({ x: cell.x, y: cell.y, role: cell.role, baseRgba: rgbaAt(atlas, CLASSIC_LAYOUT.head.base.front, cell.x, cell.y), overlayAlpha: rgbaAt(atlas, CLASSIC_LAYOUT.head.overlay.front, cell.x, cell.y)[3] })),
  };
}

function changedPixels(before: RawImage, after: RawImage) {
  const head = new Set<number>();
  for (const layer of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const rect of Object.values(layer)) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) head.add(y * 64 + x);
  }
  let headDiff = 0, bodyDiff = 0;
  for (let index = 0; index < 64 * 64; index++) {
    const at = index * 4;
    if (before.rgba.subarray(at, at + 4).every((value, channel) => value === after.rgba[at + channel])) continue;
    if (head.has(index)) headDiff++; else bodyDiff++;
  }
  return { headDiff, bodyDiff };
}

describe.skipIf(!RUN)("eye topology comparison artifacts", () => {
  it("selects source-measured contrasts and records head-only before/after evidence", async () => {
    const ids = (await readFile(resolve(AFTER, "summary.json"), "utf8").then(JSON.parse) as { cases: Record<string, unknown> });
    const candidates = await Promise.all(Object.keys(ids.cases).map(async (id) => {
      const metrics = JSON.parse(await readFile(resolve(INPUT, id, "metrics.json"), "utf8")) as { sourceGeometryAfter: Record<string, unknown> };
      const critique = JSON.parse(await readFile(resolve(INPUT, id, "critique.json"), "utf8")) as { after?: { critique?: { p5IdentityChecks?: StoredP5Check[] } } };
      const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter);
      if (!geometry) throw new Error(`${id}: invalid geometry`);
      const plan = buildIdentityPixelPlans(analysisFor(geometry, critique.after?.critique?.p5IdentityChecks ?? [])).facePixelPlan;
      const faceWidth = geometry.face.visibleRight - geometry.face.visibleLeft;
      return { id, geometry, plan, spacing: (geometry.eyes.rightCenterX - geometry.eyes.leftCenterX) / faceWidth * 7, footprint: (geometry.eyes.leftWidth + geometry.eyes.rightWidth) / 2 / faceWidth * 8 };
    }));
    const noGlasses = candidates.filter((item) => !item.geometry.glasses);
    const selected = [
      [...noGlasses].sort((a, b) => a.spacing - b.spacing || a.footprint - b.footprint)[0],
      [...noGlasses].sort((a, b) => b.footprint - a.footprint || b.spacing - a.spacing)[0],
      candidates.find((item) => item.geometry.glasses),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    expect(new Set(selected.map((item) => item.id)).size).toBe(3);
    const summary: Record<string, unknown> = {};
    await mkdir(OUTPUT, { recursive: true });
    for (const item of selected) {
      const [beforeAtlas, afterAtlas, source, beforeFront, afterFront, beforeLeft, afterLeft, beforeRight, afterRight] = await Promise.all([
        decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "10-final-skin.png")))),
        decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, "10-final-skin.png")))),
        decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, "01-source-face.png")))),
        decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "12-after-front.png")))),
        decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, "12-after-front.png")))),
        decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "14-after-front-left.png")))),
        decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, "14-after-front-left.png")))),
        decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "16-after-front-right.png")))),
        decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, "16-after-front-right.png")))),
      ]);
      const afterCells = item.plan.pixels.filter((pixel) => (pixel.cluster === "left_eye" || pixel.cluster === "right_eye") && (pixel.role === "iris" || pixel.role === "sclera"));
      const beforeCells = [...oldEyeCells(item.plan, "left_eye"), ...oldEyeCells(item.plan, "right_eye")];
      const directory = resolve(OUTPUT, item.id);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(resolve(directory, "source-face.png"), await encodePng(source)),
        writeFile(resolve(directory, "before-visible-face-8x8.png"), await encodePng(visibleFront(beforeAtlas))),
        writeFile(resolve(directory, "after-visible-face-8x8.png"), await encodePng(visibleFront(afterAtlas))),
        writeFile(resolve(directory, "contact-sheet.png"), await encodePng(contact([[visibleFront(beforeAtlas), visibleFront(afterAtlas)], [beforeFront, afterFront], [beforeLeft, afterLeft], [beforeRight, afterRight]]))),
      ]);
      const result = {
        selection: item.geometry.glasses ? "glasses_sentinel" : item === selected[0] ? "minimum_measured_spacing_and_footprint" : "maximum_non_glasses_footprint",
        sourceMeasurement: { normalizedSpacing: item.spacing, normalizedFootprint: item.footprint, openness: item.geometry.eyes.openness, confidence: item.geometry.confidence.eyes },
        before: eyeMetrics(item.plan, beforeAtlas, beforeCells),
        after: eyeMetrics(item.plan, afterAtlas, afterCells),
        atlasDiff: changedPixels(beforeAtlas, afterAtlas),
      };
      expect(result.atlasDiff.bodyDiff).toBe(0);
      summary[item.id] = result;
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(result, null, 2), "utf8");
    }
    await writeFile(resolve(OUTPUT, "summary.json"), JSON.stringify({ apiCalls: 0, selectionRule: "extreme accepted continuous eye geometry plus measured-glasses sentinel; no fixture-id branch", cases: summary }, null, 2), "utf8");
  });
});
