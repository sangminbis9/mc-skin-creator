/** Opt-in, offline before/after evidence for deterministic mouth topology. */
import { describe, expect, it } from "vitest";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelInstruction, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { createFacePlanAtlasCandidate, DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const MODE = process.env.RUN_MOUTH_TOPOLOGY_ARTIFACTS;
const INPUT = resolve("evaluation-artifacts/head-structure-iteration-final");
const ANNOTATIONS = resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const EYE_BASELINE = resolve("evaluation-artifacts/eye-topology-20260913/after");
const BROW_BASELINE = resolve("evaluation-artifacts/brow-topology-20260913-v2/after");
const ROOT = resolve("evaluation-artifacts/mouth-topology-20260913");
const BEFORE = resolve(ROOT, "before");
const AFTER = resolve(ROOT, "after");
const COMPARISON = resolve(ROOT, "comparison");

interface StoredP5Check { feature: string; targetRegions: string[] }
interface Annotation {
  id: string;
  face: string;
  features?: { expression?: string };
  hints?: { mouthShape?: string; mouthOpening?: string; lipFullness?: string; lipColor?: string };
}
interface Candidate {
  id: string;
  geometry: IdentityGeometryAnalysis;
  analysis: PhotoAnalysis;
  annotation: Annotation;
  normalizedWidth: number;
  normalizedMouthRow: number;
  sourceFace: RawImage;
}

function category(feature: string, regions: string[]): IdentityFeatureCategory {
  const text = `${feature} ${regions.join(" ")}`.toLowerCase();
  if (/glass|frame|spectacle|scarf|accessor/.test(text)) return "accessory";
  if (/hair|fringe|bang|curl|silhouette/.test(text)) return "hair";
  if (/shirt|torso|outfit|collar|sweater/.test(text)) return "outfit";
  return "face";
}

function sourceMouth(annotation: Annotation) {
  const face = annotation.face.toLowerCase();
  const explicitOpening = annotation.hints?.mouthOpening;
  const mouthOpenness = explicitOpening === "teeth_visible" || /teeth|toothy/.test(face)
    ? "teeth" as const
    : explicitOpening === "slightly_open" || /open mouth/.test(face)
      ? "open" as const
      : /closed/.test(face) ? "closed" as const : "unknown" as const;
  const expression = annotation.features?.expression === "smile" || /smil|grin/.test(face)
    ? "smile" as const
    : /mouth outside source/.test(face) ? "unknown" as const : "neutral" as const;
  const shape = annotation.hints?.mouthShape;
  const mouthWidth = shape === "small" ? "narrow" as const : shape === "wide" ? "wide" as const : "unknown" as const;
  return { mouthWidth, mouthOpenness, expression };
}

function analysisFor(geometry: IdentityGeometryAnalysis, annotation: Annotation, checks: StoredP5Check[]): PhotoAnalysis {
  const base = makeAnalysis();
  const source = sourceMouth(annotation);
  const features = checks.map((check) => ({
    feature: check.feature,
    category: category(check.feature, check.targetRegions),
    priority: 5 as const,
    confidence: "high" as const,
    evidence: "Stored source-analysis cue",
    targetRegions: check.targetRegions,
  }));
  const cueText = `${annotation.face}; ${features.map((feature) => feature.feature).join(", ")}`;
  const mouthShape: PhotoAnalysis["renderHints"]["mouthShape"] = annotation.hints?.mouthShape === "wide"
    || geometry.mouth.width / Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft) >= 0.45
    ? "wide"
    : annotation.hints?.mouthShape === "full" ? "full" : annotation.hints?.mouthShape === "thin" ? "thin" : "small";
  const mouthOpening: PhotoAnalysis["renderHints"]["mouthOpening"] = source.mouthOpenness === "teeth"
    ? "teeth_visible"
    : source.mouthOpenness === "open" ? "slightly_open" : "closed";
  return makeAnalysis({
    identityGeometry: geometry,
    faceMeasurementEvidence: {
      referenceImageIndex: 0,
      cues: {
        eyeSpacing: { value: "unknown", provenance: "unknown", confidence: 0 },
        eyeOpenness: { value: "unknown", provenance: "unknown", confidence: 0 },
        eyeFootprint: { value: "unknown", provenance: "unknown", confidence: 0 },
        browEyeDistance: { value: "unknown", provenance: "unknown", confidence: 0 },
        browSlope: { value: "unknown", provenance: "unknown", confidence: 0 },
        mouthWidth: { value: source.mouthWidth, provenance: source.mouthWidth === "unknown" ? "unknown" : "observed_categorical", confidence: source.mouthWidth === "unknown" ? 0 : 0.9 },
        mouthOpenness: { value: source.mouthOpenness, provenance: source.mouthOpenness === "unknown" ? "unknown" : "observed_categorical", confidence: source.mouthOpenness === "unknown" ? 0 : 0.9 },
        expression: { value: source.expression, provenance: source.expression === "unknown" ? "unknown" : "observed_categorical", confidence: source.expression === "unknown" ? 0 : 0.9 },
      },
    },
    canonicalIdentity: { overallImpression: cueText, mustPreserve: features.map((feature) => feature.feature), features },
    observed: { ...base.observed, face: annotation.face, accessories: geometry.glasses ? "measured glasses" : "no glasses" },
    fallbackFeatures: { ...base.fallbackFeatures, expression: source.expression === "smile" ? "smile" : "neutral", glasses: geometry.glasses ? "round" : "none" },
    renderHints: {
      ...base.renderHints,
      eyeShape: geometry.eyes.openness >= 0.68 ? "round" : geometry.eyes.openness <= 0.34 ? "narrow" : "almond",
      eyeSize: Math.max(geometry.eyes.leftWidth, geometry.eyes.rightWidth) >= 0.16 ? "large" : "average",
      mouthShape,
      mouthOpening,
      lipFullness: annotation.hints?.lipFullness === "full" ? "full" : annotation.hints?.lipFullness === "thin" ? "thin" : "average",
      lipColor: annotation.hints?.lipColor === "rose" ? "rose" : annotation.hints?.lipColor === "red" ? "red" : annotation.hints?.lipColor === "berry" ? "berry" : annotation.hints?.lipColor === "brown" ? "brown" : annotation.hints?.lipColor === "coral" ? "coral" : "natural",
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
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) copyPixel(atlas, image, rect.x + x, rect.y + y, x * scale + dx, y * scale + dy);
  }
  return image;
}

function contact(source: RawImage, rows: Array<[RawImage, RawImage]>): RawImage {
  const cellWidth = Math.max(source.width, ...rows.flat().map((image) => image.width));
  const heights = [source.height, ...rows.map(([before, after]) => Math.max(before.height, after.height))];
  const totalHeight = heights.reduce((sum, value) => sum + value, 0);
  const image: RawImage = { width: cellWidth * 3, height: totalHeight, rgba: new Uint8Array(cellWidth * 3 * totalHeight * 4) };
  const paste = (item: RawImage, xOffset: number, yOffset: number) => {
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) copyPixel(item, image, x, y, xOffset + x, yOffset + y);
  };
  paste(source, 0, 0);
  let top = heights[0];
  rows.forEach(([before, after], index) => {
    paste(before, cellWidth, top);
    paste(after, cellWidth * 2, top);
    top += heights[index + 1];
  });
  return image;
}

function rgbaAt(atlas: RawImage, rect: Rect, x: number, y: number): number[] {
  const at = ((rect.y + y) * atlas.width + rect.x + x) * 4;
  return [...atlas.rgba.subarray(at, at + 4)];
}

function rgbAt(atlas: RawImage, x: number, y: number): [number, number, number] {
  const offset = (y * atlas.width + x) * 4;
  return [atlas.rgba[offset], atlas.rgba[offset + 1], atlas.rgba[offset + 2]];
}

function mostCommonColor(atlas: RawImage, points: Array<{ x: number; y: number }>): [number, number, number] {
  const counts = new Map<string, { color: [number, number, number]; count: number }>();
  for (const point of points) {
    const color = rgbAt(atlas, point.x, point.y);
    const key = color.join(",");
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { color, count: 1 });
  }
  return [...counts.values()].sort((first, second) => second.count - first.count)[0]?.color ?? [180, 135, 110];
}

function atlasColors(atlas: RawImage, plan: FacePixelPlan) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const occupied = new Set(plan.pixels.filter((pixel) => pixel.cluster !== "complexion").map((pixel) => `${pixel.x},${pixel.y}`));
  const skinPoints: Array<{ x: number; y: number }> = [];
  for (let y = 2; y < 8; y++) for (let x = 0; x < 8; x++) if (!occupied.has(`${x},${y}`)) skinPoints.push({ x: face.x + x, y: face.y + y });
  const hairPoint = plan.pixels.find((pixel) => pixel.cluster === "fringe") ?? plan.pixels.find((pixel) => pixel.role === "brow");
  return {
    skin: mostCommonColor(atlas, skinPoints),
    hair: hairPoint ? rgbAt(atlas, face.x + hairPoint.x, face.y + hairPoint.y) : [52, 42, 36] as [number, number, number],
  };
}

function styleFor(candidate: Candidate, plan: FacePixelPlan, colors: ReturnType<typeof atlasColors>): FaceStyle {
  const hex = (color: [number, number, number]) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return {
    ...DEFAULT_FACE_STYLE,
    eyeColor: hex(colors.hair), hairColor: hex(colors.hair), skinTone: hex(colors.skin),
    glasses: candidate.geometry.glasses ? "round" : "none",
    eyebrowThickness: plan.layout.browThickness === "strong" ? "thick" : "normal",
    expression: sourceMouth(candidate.annotation).expression === "smile" ? "smile" : "neutral",
    mouthShape: candidate.analysis.renderHints.mouthShape,
    mouthOpening: candidate.analysis.renderHints.mouthOpening,
    lipFullness: candidate.analysis.renderHints.lipFullness,
    lipColor: candidate.analysis.renderHints.lipColor,
  };
}

function connectedComponents(items: FacePixelInstruction[]): number {
  const pending = new Set(items.map((item) => `${item.x},${item.y}`));
  let count = 0;
  while (pending.size > 0) {
    count++;
    const first = pending.values().next().value as string;
    const stack = [first];
    pending.delete(first);
    while (stack.length) {
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const key = `${x + dx},${y + dy}`;
        if (pending.delete(key)) stack.push(key);
      }
    }
  }
  return count;
}

function mouthMetrics(plan: FacePixelPlan, atlas: RawImage) {
  const items = plan.pixels.filter((pixel) => pixel.cluster === "mouth").sort((a, b) => a.y - b.y || a.x - b.x);
  const xs = items.map((item) => item.x);
  const ys = items.map((item) => item.y);
  const leftX = Math.min(...xs);
  const rightX = Math.max(...xs);
  const leftY = Math.min(...items.filter((item) => item.x === leftX).map((item) => item.y));
  const rightY = Math.min(...items.filter((item) => item.x === rightX).map((item) => item.y));
  const roleCount = (role: FacePixelInstruction["role"]) => items.filter((item) => item.role === role).length;
  return {
    layout: {
      mouthRow: plan.layout.mouthRow,
      mouthWidth: plan.layout.mouthWidth,
      mouthCenterX: plan.layout.mouthCenterX,
      mouthCornerOffsets: plan.layout.mouthCornerOffsets,
      mouthOpening: plan.layout.mouthOpening,
      mouthTopology: plan.layout.mouthTopology,
      geometryMouthUsed: plan.layout.geometryUsage.mouth,
      geometryMouthProvenance: plan.layout.geometryProvenance.mouth,
      geometryTargetRow: plan.layout.geometryTarget.mouthRow,
    },
    pixels: items.map((pixel) => ({
      x: pixel.x, y: pixel.y, role: pixel.role,
      baseRgba: rgbaAt(atlas, CLASSIC_LAYOUT.head.base.front, pixel.x, pixel.y),
      overlayAlpha: rgbaAt(atlas, CLASSIC_LAYOUT.head.overlay.front, pixel.x, pixel.y)[3],
    })),
    xSpan: Math.max(...xs) - Math.min(...xs) + 1,
    ySpan: Math.max(...ys) - Math.min(...ys) + 1,
    centerRow: plan.layout.mouthRow,
    leftCornerY: leftY,
    rightCornerY: rightY,
    centerY: plan.layout.mouthRow,
    cornerMinusCenter: [leftY - plan.layout.mouthRow, rightY - plan.layout.mouthRow],
    teethPixelCount: roleCount("teeth"),
    darkInnerMouthPixelCount: roleCount("mouth_shadow"),
    lipPixelCount: roleCount("lip"),
    connectedComponents: connectedComponents(items),
    overlayOverlap: items.filter((pixel) => rgbaAt(atlas, CLASSIC_LAYOUT.head.overlay.front, pixel.x, pixel.y)[3] > 0).length,
  };
}

function featureSignature(plan: FacePixelPlan, roles: FacePixelInstruction["role"][]) {
  return plan.pixels.filter((pixel) => roles.includes(pixel.role)).map(({ x, y, role, cluster }) => ({ x, y, role, cluster }));
}

function changedPixels(before: RawImage, after: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan) {
  const head = new Set<number>();
  for (const layer of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const rect of Object.values(layer)) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) head.add(y * 64 + x);
  }
  const region = (roles: FacePixelInstruction["role"][], cluster?: FacePixelInstruction["cluster"]) => new Set([...beforePlan.pixels, ...afterPlan.pixels]
    .filter((pixel) => roles.includes(pixel.role) && (!cluster || pixel.cluster === cluster))
    .map((pixel) => (CLASSIC_LAYOUT.head.base.front.y + pixel.y) * 64 + CLASSIC_LAYOUT.head.base.front.x + pixel.x));
  const mouth = region(["lip", "teeth", "mouth_shadow"], "mouth");
  const eye = region(["iris", "sclera"]);
  const brow = region(["brow"]);
  let headDiff = 0, bodyDiff = 0, mouthRegionDiff = 0, eyeRegionDiff = 0, browRegionDiff = 0;
  for (let index = 0; index < 64 * 64; index++) {
    const at = index * 4;
    if (before.rgba.subarray(at, at + 4).every((value, channel) => value === after.rgba[at + channel])) continue;
    if (head.has(index)) headDiff++; else bodyDiff++;
    if (mouth.has(index)) mouthRegionDiff++;
    if (eye.has(index)) eyeRegionDiff++;
    if (brow.has(index)) browRegionDiff++;
  }
  return { headDiff, bodyDiff, mouthRegionDiff, eyeRegionDiff, browRegionDiff };
}

function keepOnlyMouthDelta(baseline: RawImage, candidate: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan): RawImage {
  const face = CLASSIC_LAYOUT.head.base.front;
  const union = new Set([...beforePlan.pixels, ...afterPlan.pixels].filter((pixel) => pixel.cluster === "mouth").map((pixel) => `${pixel.x},${pixel.y}`));
  const allowed = new Set([...union].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return (face.y + y) * 64 + face.x + x;
  }));
  for (let index = 0; index < 64 * 64; index++) {
    if (allowed.has(index)) continue;
    const at = index * 4;
    candidate.rgba.set(baseline.rgba.subarray(at, at + 4), at);
  }
  return candidate;
}

async function currentBaseline(id: string): Promise<RawImage> {
  const brow = resolve(BROW_BASELINE, id, "atlas.png");
  try {
    await access(brow);
    return decodePng(new Uint8Array(await readFile(brow)));
  } catch {
    return decodePng(new Uint8Array(await readFile(resolve(EYE_BASELINE, id, "10-final-skin.png"))));
  }
}

async function candidates(): Promise<Candidate[]> {
  const annotations = new Map((JSON.parse(await readFile(ANNOTATIONS, "utf8")) as Annotation[]).map((item) => [item.id, item]));
  const directories = await readdir(INPUT, { withFileTypes: true });
  const result: Candidate[] = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const folder = resolve(INPUT, directory.name);
    const annotation = annotations.get(directory.name);
    if (!annotation) continue;
    try {
      const [metrics, critique, sourceBytes] = await Promise.all([
        readFile(resolve(folder, "metrics.json"), "utf8").then(JSON.parse) as Promise<{ sourceGeometryAfter: Record<string, unknown> }>,
        readFile(resolve(folder, "critique.json"), "utf8").then(JSON.parse) as Promise<{ after?: { critique?: { p5IdentityChecks?: StoredP5Check[] } } }>,
        readFile(resolve(folder, "01-source-face.png")),
      ]);
      const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter);
      if (!geometry || geometry.confidence.mouth < 0.75) continue;
      const faceWidth = Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft);
      const faceHeight = Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY);
      result.push({
        id: directory.name,
        geometry,
        annotation,
        analysis: analysisFor(geometry, annotation, critique.after?.critique?.p5IdentityChecks ?? []),
        normalizedWidth: geometry.mouth.width / faceWidth * 8,
        normalizedMouthRow: 2 + (geometry.mouth.centerY - geometry.face.foreheadY) / faceHeight * 4,
        sourceFace: await decodePng(new Uint8Array(sourceBytes)),
      });
    } catch {
      // Non-case folders are not candidates.
    }
  }
  return result;
}

function select(items: Candidate[]): Array<Candidate & { selection: string }> {
  const source = (item: Candidate) => sourceMouth(item.annotation);
  const strongestSmile = [...items].filter((item) => source(item).expression === "smile")
    .sort((a, b) => Number(source(b).mouthOpenness === "teeth") - Number(source(a).mouthOpenness === "teeth") || b.normalizedWidth - a.normalizedWidth || a.id.localeCompare(b.id))[0];
  const compactNeutral = [...items].filter((item) => item !== strongestSmile && source(item).expression === "neutral" && source(item).mouthOpenness === "closed")
    .sort((a, b) => a.normalizedWidth - b.normalizedWidth || a.id.localeCompare(b.id))[0];
  const priorTopologySentinel = [...items].filter((item) => item !== strongestSmile && item !== compactNeutral && source(item).expression === "smile")
    .sort((a, b) => Math.abs(b.geometry.brows.tilt) - Math.abs(a.geometry.brows.tilt) || b.normalizedWidth - a.normalizedWidth || a.id.localeCompare(b.id))[0];
  return [
    { ...strongestSmile, selection: "strongest_source_smile_then_teeth_then_width" },
    { ...compactNeutral, selection: "smallest_measured_width_among_source_neutral_closed" },
    { ...priorTopologySentinel, selection: "remaining_source_smile_with_strongest_measured_brow_topology" },
  ];
}

async function saveViewSet(directory: string, source: RawImage, rendered: { plan: FacePixelPlan; atlas: RawImage }) {
  const views = renderSkinViews(rendered.atlas);
  const head = (name: Parameters<typeof extractRenderedHeadView>[0]["name"]) => extractRenderedHeadView(views.find((view) => view.name === name)!);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "source-face.png"), await encodePng(source)),
    writeFile(resolve(directory, "atlas.png"), await encodePng(rendered.atlas)),
    writeFile(resolve(directory, "visible-face-8x8.png"), await encodePng(visibleFront(rendered.atlas))),
    writeFile(resolve(directory, "front.png"), await encodePng(head("front"))),
    writeFile(resolve(directory, "front-left.png"), await encodePng(head("front_left_three_quarter"))),
    writeFile(resolve(directory, "front-right.png"), await encodePng(head("front_right_three_quarter"))),
  ]);
}

describe.skipIf(!MODE)("mouth topology comparison artifacts", () => {
  it("selects source-measured mouth contrasts and preserves eye and brow topology", async () => {
    const inventory = await candidates();
    const selected = select(inventory);
    expect(new Set(selected.map((item) => item.id)).size).toBe(3);
    const output = MODE === "before" ? BEFORE : AFTER;
    const summary: Record<string, unknown> = {};
    let improved = 0;
    for (const item of selected) {
      const facePlan = buildIdentityPixelPlans(item.analysis).facePixelPlan;
      const beforeStored = MODE === "before" ? undefined : await readFile(resolve(BEFORE, item.id, "metrics.json"), "utf8").then(JSON.parse) as {
        topology: ReturnType<typeof mouthMetrics>; eyeSignature: unknown; browSignature: unknown; plan: FacePixelPlan;
      };
      const baselineAtlas = MODE === "before" ? await currentBaseline(item.id) : await decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "atlas.png"))));
      const rendered = {
        plan: facePlan,
        atlas: beforeStored
          ? keepOnlyMouthDelta(baselineAtlas, createFacePlanAtlasCandidate(baselineAtlas, facePlan, styleFor(item, facePlan, atlasColors(baselineAtlas, beforeStored.plan)), beforeStored.plan), beforeStored.plan, facePlan)
          : baselineAtlas,
      };
      const directory = resolve(output, item.id);
      await saveViewSet(directory, item.sourceFace, rendered);
      const measured = sourceMouth(item.annotation);
      const sourceMeasurement = {
        ...measured,
        mouthShape: item.analysis.renderHints.mouthShape,
        lipFullness: item.analysis.renderHints.lipFullness,
        lipColor: item.analysis.renderHints.lipColor,
        calibratedMouthY: item.geometry.mouth.centerY,
        calibratedLeftCornerY: item.geometry.mouth.leftCornerY,
        calibratedRightCornerY: item.geometry.mouth.rightCornerY,
        normalizedMouthRow: item.normalizedMouthRow,
        normalizedWidth: item.normalizedWidth,
        confidence: item.geometry.confidence.mouth,
        provenance: "calibrated_geometry",
      };
      const current = {
        selection: item.selection,
        sourceMeasurement,
        topology: mouthMetrics(facePlan, rendered.atlas),
        eyeSignature: featureSignature(facePlan, ["iris", "sclera"]),
        browSignature: featureSignature(facePlan, ["brow"]),
        plan: facePlan,
      };
      summary[item.id] = current;
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(current, null, 2));
      if (MODE !== "before") {
        const [beforeFace, beforeFront, beforeLeft, beforeRight] = await Promise.all([
          decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "visible-face-8x8.png")))),
          decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "front.png")))),
          decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "front-left.png")))),
          decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "front-right.png")))),
        ]);
        const beforeAtlas = baselineAtlas;
        expect(current.eyeSignature, `${item.id}: eye topology`).toEqual(beforeStored!.eyeSignature);
        expect(current.browSignature, `${item.id}: brow topology`).toEqual(beforeStored!.browSignature);
        expect(facePlan.layout.mouthRow, `${item.id}: geometry Y anchor`).toBe(beforeStored!.plan.layout.mouthRow);
        const atlasDiff = changedPixels(beforeAtlas, rendered.atlas, beforeStored!.plan, facePlan);
        expect(atlasDiff.bodyDiff, `${item.id}: body diff`).toBe(0);
        expect(atlasDiff.eyeRegionDiff, `${item.id}: eye diff`).toBe(0);
        expect(atlasDiff.browRegionDiff, `${item.id}: brow diff`).toBe(0);
        const comparisonDirectory = resolve(COMPARISON, item.id);
        await mkdir(comparisonDirectory, { recursive: true });
        const [afterFace, afterFront, afterLeft, afterRight] = await Promise.all([
          decodePng(new Uint8Array(await readFile(resolve(directory, "visible-face-8x8.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front-left.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front-right.png")))),
        ]);
        await writeFile(resolve(comparisonDirectory, "contact-sheet.png"), await encodePng(contact(item.sourceFace, [[beforeFace, afterFace], [beforeFront, afterFront], [beforeLeft, afterLeft], [beforeRight, afterRight]])));
        const topologyChanged = JSON.stringify(beforeStored!.topology.pixels.map(({ x, y, role }) => ({ x, y, role }))) !== JSON.stringify(current.topology.pixels.map(({ x, y, role }) => ({ x, y, role })));
        const sourceConstructionImproved = measured.expression === "smile" && (topologyChanged || atlasDiff.mouthRegionDiff > 0);
        if (sourceConstructionImproved) improved++;
        const compared = { selection: item.selection, sourceMeasurement, before: beforeStored!.topology, after: current.topology, eyeSignatureEqual: true, browSignatureEqual: true, atlasDiff, topologyChanged, sourceConstructionImproved };
        summary[item.id] = compared;
        await writeFile(resolve(comparisonDirectory, "metrics.json"), JSON.stringify(compared, null, 2));
      }
    }
    const vertical = [...inventory].sort((a, b) => a.normalizedMouthRow - b.normalizedMouthRow || a.id.localeCompare(b.id));
    const metadata = {
      apiCalls: 0,
      mode: MODE,
      selectionRule: "source smile/teeth/width + source neutral/closed minimum width + remaining smile with strongest measured brow topology; no fixture-id branch",
      calibratedVerticalExtremes: {
        highest: { id: vertical[0].id, normalizedMouthRow: vertical[0].normalizedMouthRow },
        lowest: { id: vertical.at(-1)!.id, normalizedMouthRow: vertical.at(-1)!.normalizedMouthRow },
      },
      cases: summary,
      ...(MODE === "before" ? {} : { improvedCases: improved }),
    };
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "summary.json"), JSON.stringify(metadata, null, 2));
    if (MODE !== "before") {
      expect(improved).toBeGreaterThanOrEqual(2);
      await mkdir(COMPARISON, { recursive: true });
      await writeFile(resolve(COMPARISON, "summary.json"), JSON.stringify(metadata, null, 2));
    }
  });
});
