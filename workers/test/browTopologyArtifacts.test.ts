/** Opt-in, offline before/after evidence for deterministic brow topology. */
import { describe, expect, it } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelInstruction, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { createFacePlanAtlasCandidate, DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const MODE = process.env.RUN_BROW_TOPOLOGY_ARTIFACTS;
const INPUT = resolve("evaluation-artifacts/head-structure-iteration-final");
const EYE_BASELINE = resolve("evaluation-artifacts/eye-topology-20260913/after");
const ROOT = resolve("evaluation-artifacts/brow-topology-20260913-v2");
const BEFORE = resolve(ROOT, "before");
const AFTER = resolve(ROOT, "after");
const COMPARISON = resolve(ROOT, "comparison");

interface StoredP5Check { feature: string; targetRegions: string[] }
interface Candidate {
  id: string;
  geometry: IdentityGeometryAnalysis;
  analysis: PhotoAnalysis;
  meanGap: number;
  slopeMagnitude: number;
  sourceFace: RawImage;
}

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
    feature: check.feature,
    category: category(check.feature, check.targetRegions),
    priority: 5 as const,
    confidence: "high" as const,
    evidence: "Stored source-analysis cue",
    targetRegions: check.targetRegions,
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

function contact(source: RawImage, rows: Array<[RawImage, RawImage]>): RawImage {
  const cellWidth = Math.max(source.width, ...rows.flat().map((image) => image.width));
  const heights = [source.height, ...rows.map(([before, after]) => Math.max(before.height, after.height))];
  const image: RawImage = { width: cellWidth * 3, height: heights.reduce((sum, value) => sum + value, 0), rgba: new Uint8Array(cellWidth * 3 * heights.reduce((sum, value) => sum + value, 0) * 4) };
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
    eyeColor: hex(colors.hair),
    hairColor: hex(colors.hair),
    skinTone: hex(colors.skin),
    glasses: candidate.geometry.glasses ? "round" : "none",
    eyebrowThickness: plan.layout.browThickness === "strong" ? "thick" : "normal",
    expression: candidate.geometry.mouth.opening === "closed" ? "neutral" : "smile",
  };
}

function cells(plan: FacePixelPlan, role: FacePixelInstruction["role"], cluster: "left_eye" | "right_eye") {
  return plan.pixels.filter((pixel) => pixel.role === role && pixel.cluster === cluster);
}

function endpointRows(items: FacePixelInstruction[], side: "left" | "right") {
  const outerX = side === "left" ? Math.min(...items.map((item) => item.x)) : Math.max(...items.map((item) => item.x));
  const innerX = side === "left" ? Math.max(...items.map((item) => item.x)) : Math.min(...items.map((item) => item.x));
  const rowAt = (x: number) => Math.min(...items.filter((item) => item.x === x).map((item) => item.y));
  return { outerY: rowAt(outerX), innerY: rowAt(innerX), innerMinusOuter: rowAt(innerX) - rowAt(outerX) };
}

function topologyMetrics(plan: FacePixelPlan, atlas: RawImage) {
  const side = (cluster: "left_eye" | "right_eye", name: "left" | "right") => {
    const brows = cells(plan, "brow", cluster);
    const eyes = plan.pixels.filter((pixel) => pixel.cluster === cluster && (pixel.role === "iris" || pixel.role === "sclera"));
    const browXs = [...new Set(brows.map((pixel) => pixel.x))].sort((a, b) => a - b);
    return {
      browPixels: brows.map((pixel) => ({ x: pixel.x, y: pixel.y, role: pixel.role, baseRgba: rgbaAt(atlas, CLASSIC_LAYOUT.head.base.front, pixel.x, pixel.y), overlayAlpha: rgbaAt(atlas, CLASSIC_LAYOUT.head.overlay.front, pixel.x, pixel.y)[3] })),
      eyePixels: eyes.map((pixel) => ({ x: pixel.x, y: pixel.y, role: pixel.role })),
      minimumVerticalRowDistance: Math.min(...eyes.map((eye) => eye.y)) - Math.max(...brows.map((brow) => brow.y)),
      horizontalSpan: browXs.length === 0 ? 0 : Math.max(...browXs) - Math.min(...browXs) + 1,
      endpoints: endpointRows(brows, name),
      connectedComponents: connectedComponents(brows),
    };
  };
  return {
    layout: {
      leftBrowRow: plan.layout.leftBrowRow,
      rightBrowRow: plan.layout.rightBrowRow,
      browTiltOffset: plan.layout.browTiltOffset,
      browThickness: plan.layout.browThickness,
      browDistanceTopology: plan.layout.browDistanceTopology,
      browSlopeTopology: plan.layout.browSlopeTopology,
    },
    left: side("left_eye", "left"),
    right: side("right_eye", "right"),
  };
}

function connectedComponents(items: FacePixelInstruction[]): number {
  const pending = new Set(items.map((item) => `${item.x},${item.y}`));
  let count = 0;
  while (pending.size > 0) {
    count++;
    const stack = [pending.values().next().value as string];
    pending.delete(stack[0]);
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

function changedPixels(before: RawImage, after: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan) {
  const head = new Set<number>();
  for (const layer of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const rect of Object.values(layer)) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) head.add(y * 64 + x);
  }
  const region = (roles: FacePixelInstruction["role"][]) => new Set([...beforePlan.pixels, ...afterPlan.pixels]
    .filter((pixel) => roles.includes(pixel.role))
    .map((pixel) => (CLASSIC_LAYOUT.head.base.front.y + pixel.y) * 64 + CLASSIC_LAYOUT.head.base.front.x + pixel.x));
  const brow = region(["brow"]);
  const eye = region(["iris", "sclera"]);
  let headDiff = 0, bodyDiff = 0, browRegionDiff = 0, eyeRegionDiff = 0;
  for (let index = 0; index < 64 * 64; index++) {
    const at = index * 4;
    if (before.rgba.subarray(at, at + 4).every((value, channel) => value === after.rgba[at + channel])) continue;
    if (head.has(index)) headDiff++; else bodyDiff++;
    if (brow.has(index)) browRegionDiff++;
    if (eye.has(index)) eyeRegionDiff++;
  }
  return { headDiff, bodyDiff, browRegionDiff, eyeRegionDiff };
}

function keepOnlyBrowDelta(
  baseline: RawImage,
  candidate: RawImage,
  beforePlan: FacePixelPlan,
  afterPlan: FacePixelPlan,
): RawImage {
  const face = CLASSIC_LAYOUT.head.base.front;
  const before = new Set(beforePlan.pixels.filter((pixel) => pixel.role === "brow").map((pixel) => `${pixel.x},${pixel.y}`));
  const after = new Set(afterPlan.pixels.filter((pixel) => pixel.role === "brow").map((pixel) => `${pixel.x},${pixel.y}`));
  const changed = new Set([...before, ...after].filter((key) => before.has(key) !== after.has(key)));
  const allowed = new Set([...changed].map((key) => {
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

function eyeSignature(plan: FacePixelPlan) {
  return plan.pixels
    .filter((pixel) => (pixel.cluster === "left_eye" || pixel.cluster === "right_eye") && (pixel.role === "iris" || pixel.role === "sclera"))
    .map(({ x, y, role, cluster }) => ({ x, y, role, cluster }));
}

async function candidates(): Promise<Candidate[]> {
  const directories = await readdir(INPUT, { withFileTypes: true });
  const result: Candidate[] = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const folder = resolve(INPUT, directory.name);
    try {
      const [metrics, critique, sourceBytes] = await Promise.all([
        readFile(resolve(folder, "metrics.json"), "utf8").then(JSON.parse) as Promise<{ sourceGeometryAfter: Record<string, unknown> }>,
        readFile(resolve(folder, "critique.json"), "utf8").then(JSON.parse) as Promise<{ after?: { critique?: { p5IdentityChecks?: StoredP5Check[] } } }>,
        readFile(resolve(folder, "01-source-face.png")),
      ]);
      const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter);
      if (!geometry || geometry.confidence.brows < 0.75) continue;
      const faceHeight = Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY);
      const leftGap = (geometry.eyes.leftCenterY - geometry.brows.leftY) / faceHeight * 4;
      const rightGap = (geometry.eyes.rightCenterY - geometry.brows.rightY) / faceHeight * 4;
      result.push({ id: directory.name, geometry, analysis: analysisFor(geometry, critique.after?.critique?.p5IdentityChecks ?? []), meanGap: (leftGap + rightGap) / 2, slopeMagnitude: Math.abs(geometry.brows.tilt), sourceFace: await decodePng(new Uint8Array(sourceBytes)) });
    } catch {
      // Non-case folders are not candidates.
    }
  }
  return result;
}

function select(items: Candidate[]): Array<Candidate & { selection: string }> {
  const noGlasses = items.filter((item) => !item.geometry.glasses);
  const closest = [...noGlasses].sort((a, b) => a.meanGap - b.meanGap || a.id.localeCompare(b.id))[0];
  const renderedSlope = (item: Candidate) => {
    const plan = buildIdentityPixelPlans(item.analysis).facePixelPlan;
    const magnitudes = (["left_eye", "right_eye"] as const).map((cluster) => {
      const brow = cells(plan, "brow", cluster);
      return Math.abs(endpointRows(brow, cluster === "left_eye" ? "left" : "right").innerMinusOuter);
    });
    return Math.max(...magnitudes);
  };
  const strongestSlope = [...noGlasses].filter((item) => item !== closest)
    // Equal source slopes prefer the case whose current pixels lose more of
    // that slope. This remains evidence-driven and avoids choosing a case
    // that is already rendered correctly merely because of its identifier.
    .sort((a, b) => b.slopeMagnitude - a.slopeMagnitude || renderedSlope(a) - renderedSlope(b) || b.meanGap - a.meanGap || a.id.localeCompare(b.id))[0];
  const glasses = [...items].filter((item) => item.geometry.glasses)
    .sort((a, b) => b.meanGap - a.meanGap || a.id.localeCompare(b.id))[0];
  return [
    { ...closest, selection: "minimum_measured_brow_eye_gap" },
    { ...strongestSlope, selection: "maximum_non_glasses_brow_slope" },
    { ...glasses, selection: "measured_glasses_and_maximum_gap_sentinel" },
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

describe.skipIf(!MODE)("brow topology comparison artifacts", () => {
  it("selects source-measured brow contrasts and preserves the existing eye topology", async () => {
    const selected = select(await candidates());
    expect(new Set(selected.map((item) => item.id)).size).toBe(3);
    const output = MODE === "before" ? BEFORE : AFTER;
    const summary: Record<string, unknown> = {};
    for (const item of selected) {
      const baselineAtlas = await decodePng(new Uint8Array(await readFile(resolve(EYE_BASELINE, item.id, "10-final-skin.png"))));
      const facePlan = buildIdentityPixelPlans(item.analysis).facePixelPlan;
      const beforeStored = MODE === "before"
        ? undefined
        : await readFile(resolve(BEFORE, item.id, "metrics.json"), "utf8").then(JSON.parse) as { topology: unknown; eyeSignature: unknown; plan: FacePixelPlan };
      const rendered = {
        plan: facePlan,
        atlas: beforeStored
          ? keepOnlyBrowDelta(
              baselineAtlas,
              createFacePlanAtlasCandidate(baselineAtlas, facePlan, styleFor(item, facePlan, atlasColors(baselineAtlas, beforeStored.plan)), beforeStored.plan),
              beforeStored.plan,
              facePlan,
            )
          : baselineAtlas,
      };
      const directory = resolve(output, item.id);
      await saveViewSet(directory, item.sourceFace, rendered);
      const sourceMeasurement = {
        normalizedBrowEyeGap: item.meanGap,
        browTilt: item.geometry.brows.tilt,
        leftY: item.geometry.brows.leftY,
        rightY: item.geometry.brows.rightY,
        confidence: item.geometry.confidence.brows,
        provenance: "calibrated_geometry",
        eyebrowShape: item.analysis.renderHints.eyebrowShape,
      };
      const current = { selection: item.selection, sourceMeasurement, topology: topologyMetrics(facePlan, rendered.atlas), eyeSignature: eyeSignature(facePlan), plan: facePlan };
      summary[item.id] = current;
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(current, null, 2));
      if (MODE !== "before") {
        const beforeDirectory = resolve(BEFORE, item.id);
        const [beforeAtlas, beforeFace, beforeFront, beforeLeft, beforeRight] = await Promise.all([
          decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "atlas.png")))),
          decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "visible-face-8x8.png")))),
          decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "front.png")))),
          decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "front-left.png")))),
          decodePng(new Uint8Array(await readFile(resolve(beforeDirectory, "front-right.png")))),
        ]);
        expect(current.eyeSignature, `${item.id}: eye topology`).toEqual(beforeStored!.eyeSignature);
        const atlasDiff = changedPixels(beforeAtlas, rendered.atlas, beforeStored!.plan, facePlan);
        expect(atlasDiff.bodyDiff, `${item.id}: body diff`).toBe(0);
        expect(atlasDiff.eyeRegionDiff, `${item.id}: eye diff`).toBe(0);
        const comparisonDirectory = resolve(COMPARISON, item.id);
        await mkdir(comparisonDirectory, { recursive: true });
        const [afterFace, afterFront, afterLeft, afterRight] = await Promise.all([
          decodePng(new Uint8Array(await readFile(resolve(directory, "visible-face-8x8.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front-left.png")))),
          decodePng(new Uint8Array(await readFile(resolve(directory, "front-right.png")))),
        ]);
        await writeFile(resolve(comparisonDirectory, "contact-sheet.png"), await encodePng(contact(item.sourceFace, [[beforeFace, afterFace], [beforeFront, afterFront], [beforeLeft, afterLeft], [beforeRight, afterRight]])));
        const compared = { selection: item.selection, sourceMeasurement, before: beforeStored!.topology, after: current.topology, eyeSignatureEqual: true, atlasDiff };
        summary[item.id] = compared;
        await writeFile(resolve(comparisonDirectory, "metrics.json"), JSON.stringify(compared, null, 2));
      }
    }
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "summary.json"), JSON.stringify({ apiCalls: 0, mode: MODE, selectionRule: "minimum accepted gap + strongest remaining non-glasses slope + measured-glasses maximum-gap sentinel; no fixture-id branch", cases: summary }, null, 2));
    if (MODE !== "before") {
      await mkdir(COMPARISON, { recursive: true });
      await writeFile(resolve(COMPARISON, "summary.json"), JSON.stringify({ apiCalls: 0, cases: summary }, null, 2));
    }
  });
});
