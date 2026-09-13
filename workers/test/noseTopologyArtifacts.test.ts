/** Opt-in, offline before/after evidence for deterministic nose topology. */
import { describe, expect, it } from "vitest";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PhotoAnalysis } from "../src/analysis";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelInstruction, type FacePixelPlan, type HairPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { createFacePlanAtlasCandidate, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";

const MODE = process.env.RUN_NOSE_TOPOLOGY_ARTIFACTS;
const INPUT = resolve("evaluation-artifacts/head-structure-iteration-final");
const ANALYSIS_ROOT = resolve("evaluation-artifacts/generalization-20260905/after");
const MOUTH_BASELINE = resolve("evaluation-artifacts/mouth-topology-20260913/after");
const BROW_BASELINE = resolve("evaluation-artifacts/brow-topology-20260913-v2/after");
const EYE_BASELINE = resolve("evaluation-artifacts/eye-topology-20260913/after");
const ROOT = resolve("evaluation-artifacts/nose-topology-20260913");
const BEFORE = resolve(ROOT, "before");
const AFTER = resolve(ROOT, "after");
const COMPARISON = resolve(ROOT, "comparison");

interface Candidate {
  id: string;
  geometry: IdentityGeometryAnalysis;
  analysis: PhotoAnalysis;
  style: FaceStyle;
  normalizedNoseRow: number;
  sourceFace: RawImage;
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

function colorDistance(first: number[], second: number[]): number {
  return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
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
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const key = `${x + dx},${y + dy}`;
        if (pending.delete(key)) stack.push(key);
      }
    }
  }
  return count;
}

function featureSignature(plan: FacePixelPlan, cluster: FacePixelInstruction["cluster"]): string[] {
  return plan.pixels.filter((pixel) => pixel.cluster === cluster).map(({ x, y, role }) => `${x},${y}:${role}`).sort();
}

function noseMetrics(plan: FacePixelPlan, atlas: RawImage) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const items = plan.pixels.filter((pixel) => pixel.cluster === "nose").sort((a, b) => a.y - b.y || a.x - b.x);
  const landmark = new Set(plan.pixels.filter((pixel) => pixel.cluster !== "complexion" && pixel.cluster !== "fringe").map((pixel) => `${pixel.x},${pixel.y}`));
  const localContrasts = items.map((pixel) => {
    const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => ({ x: pixel.x + dx, y: pixel.y + dy }))
      .filter((point) => point.x >= 0 && point.x < 8 && point.y >= 0 && point.y < 8 && !landmark.has(`${point.x},${point.y}`));
    const local = [0, 1, 2].map((channel) => neighbours.reduce((sum, point) => sum + rgbaAt(atlas, face, point.x, point.y)[channel], 0) / Math.max(1, neighbours.length));
    return colorDistance(rgbaAt(atlas, face, pixel.x, pixel.y), local);
  });
  const distanceTo = (cluster: FacePixelInstruction["cluster"] | "eyes") => {
    const others = cluster === "eyes"
      ? plan.pixels.filter((pixel) => pixel.cluster === "left_eye" || pixel.cluster === "right_eye")
      : plan.pixels.filter((pixel) => pixel.cluster === cluster);
    return items.length && others.length ? Math.min(...items.flatMap((nose) => others.map((other) => Math.abs(nose.x - other.x) + Math.abs(nose.y - other.y)))) : null;
  };
  const xs = items.map((item) => item.x);
  const ys = items.map((item) => item.y);
  return {
    layout: {
      noseX: plan.layout.noseX,
      noseY: plan.layout.noseY,
      noseStrength: plan.layout.noseStrength,
      noseShapeTopology: (plan.layout as FacePixelPlan["layout"] & { noseShapeTopology?: string }).noseShapeTopology ?? "legacy_single_pixel",
      geometryNoseUsed: plan.layout.geometryUsage.nose,
      geometryNoseProvenance: plan.layout.geometryProvenance.nose,
    },
    pixels: items.map((pixel) => ({ x: pixel.x, y: pixel.y, role: pixel.role, baseRgba: rgbaAt(atlas, face, pixel.x, pixel.y), overlayAlpha: rgbaAt(atlas, overlay, pixel.x, pixel.y)[3] })),
    centerX: items.length ? xs.reduce((sum, value) => sum + value, 0) / items.length : null,
    topY: items.length ? Math.min(...ys) : null,
    bottomY: items.length ? Math.max(...ys) : null,
    verticalSpan: items.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0,
    horizontalSpan: items.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0,
    connectedComponents: connectedComponents(items),
    meanLocalContrast: localContrasts.length ? localContrasts.reduce((sum, value) => sum + value, 0) / localContrasts.length : 0,
    distanceToEyes: distanceTo("eyes"),
    distanceToMouth: distanceTo("mouth"),
    glassesOverlap: items.filter((pixel) => rgbaAt(atlas, overlay, pixel.x, pixel.y)[3] > 0).length,
  };
}

function regionKeys(plans: FacePixelPlan[], cluster: FacePixelInstruction["cluster"]): Set<number> {
  const face = CLASSIC_LAYOUT.head.base.front;
  return new Set(plans.flatMap((plan) => plan.pixels.filter((pixel) => pixel.cluster === cluster).map((pixel) => (face.y + pixel.y) * 64 + face.x + pixel.x)));
}

function changedPixels(before: RawImage, after: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan) {
  const head = new Set<number>();
  for (const layer of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const rect of Object.values(layer)) for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) head.add(y * 64 + x);
  const nose = regionKeys([beforePlan, afterPlan], "nose");
  const eye = new Set([...regionKeys([beforePlan, afterPlan], "left_eye"), ...regionKeys([beforePlan, afterPlan], "right_eye")]);
  const brow = new Set([...beforePlan.pixels, ...afterPlan.pixels].filter((pixel) => pixel.role === "brow").map((pixel) => (CLASSIC_LAYOUT.head.base.front.y + pixel.y) * 64 + CLASSIC_LAYOUT.head.base.front.x + pixel.x));
  const mouth = regionKeys([beforePlan, afterPlan], "mouth");
  const hair = regionKeys([beforePlan, afterPlan], "fringe");
  let headDiff = 0, bodyDiff = 0, noseRegionDiff = 0, eyeRegionDiff = 0, browRegionDiff = 0, mouthRegionDiff = 0, hairRegionDiff = 0;
  for (let index = 0; index < 64 * 64; index++) {
    const at = index * 4;
    if (before.rgba.subarray(at, at + 4).every((value, channel) => value === after.rgba[at + channel])) continue;
    if (head.has(index)) headDiff++; else bodyDiff++;
    if (nose.has(index)) noseRegionDiff++;
    if (eye.has(index)) eyeRegionDiff++;
    if (brow.has(index)) browRegionDiff++;
    if (mouth.has(index)) mouthRegionDiff++;
    if (hair.has(index)) hairRegionDiff++;
  }
  return { headDiff, bodyDiff, noseRegionDiff, eyeRegionDiff, browRegionDiff, mouthRegionDiff, hairRegionDiff };
}

function keepOnlyNoseDelta(baseline: RawImage, candidate: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan): RawImage {
  const allowed = regionKeys([beforePlan, afterPlan], "nose");
  for (let index = 0; index < 64 * 64; index++) {
    if (allowed.has(index)) continue;
    const at = index * 4;
    candidate.rgba.set(baseline.rgba.subarray(at, at + 4), at);
  }
  return candidate;
}

async function firstExisting(paths: string[]): Promise<string> {
  for (const path of paths) try { await access(path); return path; } catch { /* try the next frozen baseline */ }
  throw new Error(`No frozen baseline found: ${paths.join(", ")}`);
}

async function currentBaseline(id: string): Promise<RawImage> {
  const path = await firstExisting([
    resolve(MOUTH_BASELINE, id, "atlas.png"),
    resolve(BROW_BASELINE, id, "atlas.png"),
    resolve(EYE_BASELINE, id, "10-final-skin.png"),
  ]);
  return decodePng(new Uint8Array(await readFile(path)));
}

async function candidates(): Promise<Candidate[]> {
  const directories = await readdir(INPUT, { withFileTypes: true });
  const result: Candidate[] = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    try {
      const [metrics, stored, sourceBytes] = await Promise.all([
        readFile(resolve(INPUT, directory.name, "metrics.json"), "utf8").then(JSON.parse) as Promise<{ sourceGeometryAfter: Record<string, unknown> }>,
        readFile(resolve(ANALYSIS_ROOT, directory.name, "analysis-and-plan.json"), "utf8").then(JSON.parse) as Promise<{ analysis: PhotoAnalysis; style: FaceStyle }>,
        readFile(resolve(INPUT, directory.name, "01-source-face.png")),
      ]);
      const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter);
      if (!geometry || geometry.confidence.nose < 0.75) continue;
      const faceHeight = Math.max(0.12, geometry.face.chinY - geometry.face.foreheadY);
      result.push({
        id: directory.name,
        geometry,
        analysis: { ...stored.analysis, identityGeometry: geometry },
        style: stored.style,
        normalizedNoseRow: 2 + (geometry.nose.contrastY - geometry.face.foreheadY) / faceHeight * 4,
        sourceFace: await decodePng(new Uint8Array(sourceBytes)),
      });
    } catch {
      // Non-case folders and incomplete evidence are not candidates.
    }
  }
  return result;
}

function select(items: Candidate[]): Array<Candidate & { selection: string }> {
  const ordered = [...items].sort((a, b) => a.normalizedNoseRow - b.normalizedNoseRow || a.id.localeCompare(b.id));
  const highest = ordered[0];
  const lowest = ordered.at(-1)!;
  const sentinel = [...items].filter((item) => item !== highest && item !== lowest)
    .sort((a, b) => Number(b.geometry.mouth.opening === "teeth") - Number(a.geometry.mouth.opening === "teeth") || b.geometry.nose.visibleStrength - a.geometry.nose.visibleStrength || a.id.localeCompare(b.id))[0];
  return [
    { ...highest, selection: "highest_confident_calibrated_nose_position" },
    { ...lowest, selection: "lowest_confident_calibrated_nose_position" },
    { ...sentinel, selection: "mouth_topology_sentinel_then_nose_strength" },
  ];
}

async function saveViewSet(directory: string, source: RawImage, atlas: RawImage): Promise<void> {
  const views = renderSkinViews(atlas);
  const head = (name: Parameters<typeof extractRenderedHeadView>[0]["name"]) => extractRenderedHeadView(views.find((view) => view.name === name)!);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "source-face.png"), await encodePng(source)),
    writeFile(resolve(directory, "atlas.png"), await encodePng(atlas)),
    writeFile(resolve(directory, "visible-face-8x8.png"), await encodePng(visibleFront(atlas))),
    writeFile(resolve(directory, "front.png"), await encodePng(head("front"))),
    writeFile(resolve(directory, "front-left.png"), await encodePng(head("front_left_three_quarter"))),
    writeFile(resolve(directory, "front-right.png"), await encodePng(head("front_right_three_quarter"))),
  ]);
}

function signatures(plan: FacePixelPlan, hairPlan: HairPlan) {
  return {
    eyes: [...featureSignature(plan, "left_eye"), ...featureSignature(plan, "right_eye")],
    brows: plan.pixels.filter((pixel) => pixel.role === "brow").map(({ x, y, role }) => `${x},${y}:${role}`).sort(),
    mouth: featureSignature(plan, "mouth"),
    hair: JSON.stringify({ fringe: featureSignature(plan, "fringe"), hairPlan }),
  };
}

describe.skipIf(!MODE)("nose topology comparison artifacts", () => {
  it("selects calibrated nose-position extremes and preserves eyes, brows, mouth, and hair", async () => {
    const inventory = await candidates();
    const selected = select(inventory);
    expect(new Set(selected.map((item) => item.id)).size).toBe(3);
    const output = MODE === "before" ? BEFORE : AFTER;
    const summary: Record<string, unknown> = {};
    let improved = 0;
    for (const item of selected) {
      const plans = buildIdentityPixelPlans(item.analysis);
      const facePlan = plans.facePixelPlan;
      const prior = MODE === "before" ? undefined : await readFile(resolve(BEFORE, item.id, "metrics.json"), "utf8").then(JSON.parse) as { topology: ReturnType<typeof noseMetrics>; signatures: ReturnType<typeof signatures>; plan: FacePixelPlan };
      const baseline = MODE === "before" ? await currentBaseline(item.id) : await decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "atlas.png"))));
      const atlas = prior
        ? keepOnlyNoseDelta(baseline, createFacePlanAtlasCandidate(baseline, facePlan, item.style, prior.plan), prior.plan, facePlan)
        : baseline;
      const directory = resolve(output, item.id);
      await saveViewSet(directory, item.sourceFace, atlas);
      const sourceMeasurement = {
        noseShape: item.analysis.renderHints.noseShape,
        centerX: item.geometry.nose.centerX,
        contrastY: item.geometry.nose.contrastY,
        leftRightBias: item.geometry.nose.leftRightBias,
        visibleStrength: item.geometry.nose.visibleStrength,
        normalizedNoseRow: item.normalizedNoseRow,
        confidence: item.geometry.confidence.nose,
        provenance: item.geometry.diagnostics.provenance.nose ?? "observed_geometry",
      };
      const current = { selection: item.selection, sourceMeasurement, topology: noseMetrics(facePlan, atlas), signatures: signatures(facePlan, plans.hairPlan), plan: facePlan };
      summary[item.id] = current;
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(current, null, 2));
      if (prior) {
        expect(current.signatures, `${item.id}: frozen face/hair signatures`).toEqual(prior.signatures);
        const atlasDiff = changedPixels(baseline, atlas, prior.plan, facePlan);
        expect(atlasDiff.bodyDiff, `${item.id}: body diff`).toBe(0);
        expect(atlasDiff.eyeRegionDiff, `${item.id}: eye diff`).toBe(0);
        expect(atlasDiff.browRegionDiff, `${item.id}: brow diff`).toBe(0);
        expect(atlasDiff.mouthRegionDiff, `${item.id}: mouth diff`).toBe(0);
        expect(atlasDiff.hairRegionDiff, `${item.id}: hair diff`).toBe(0);
        const topologyChanged = JSON.stringify(prior.topology.pixels.map(({ x, y, role }) => ({ x, y, role }))) !== JSON.stringify(current.topology.pixels.map(({ x, y, role }) => ({ x, y, role })));
        const sourceConstructionImproved = topologyChanged && current.topology.connectedComponents <= 1 && current.topology.pixels.length <= 3;
        if (sourceConstructionImproved) improved++;
        const compared = { selection: item.selection, sourceMeasurement, before: prior.topology, after: current.topology, eyeSignatureEqual: true, browSignatureEqual: true, mouthSignatureEqual: true, hairSignatureEqual: true, atlasDiff, topologyChanged, sourceConstructionImproved };
        summary[item.id] = compared;
        const comparisonDirectory = resolve(COMPARISON, item.id);
        await mkdir(comparisonDirectory, { recursive: true });
        const names = ["visible-face-8x8.png", "front.png", "front-left.png", "front-right.png"];
        const pairs = await Promise.all(names.map(async (name) => [
          await decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, name)))),
          await decodePng(new Uint8Array(await readFile(resolve(AFTER, item.id, name)))),
        ] as [RawImage, RawImage]));
        await writeFile(resolve(comparisonDirectory, "contact-sheet.png"), await encodePng(contact(item.sourceFace, pairs)));
        await writeFile(resolve(comparisonDirectory, "metrics.json"), JSON.stringify(compared, null, 2));
      }
    }
    const ordered = [...inventory].sort((a, b) => a.normalizedNoseRow - b.normalizedNoseRow || a.id.localeCompare(b.id));
    const metadata = {
      apiCalls: 0,
      mode: MODE,
      selectionRule: "confident calibrated nose vertical extremes + mouth-topology sentinel; no fixture-id branch",
      calibratedVerticalExtremes: { highest: { id: ordered[0].id, normalizedNoseRow: ordered[0].normalizedNoseRow }, lowest: { id: ordered.at(-1)!.id, normalizedNoseRow: ordered.at(-1)!.normalizedNoseRow } },
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
