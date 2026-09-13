/** Opt-in, offline before/after evidence for calibrated cheek/jaw topology. */
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

const MODE = process.env.RUN_FACE_CONTOUR_ARTIFACTS;
const INPUT = resolve("evaluation-artifacts/head-structure-iteration-final");
const GEOMETRY_ROOT = resolve("evaluation-artifacts/face-measurement-live-20260908/stored-five-regression-final");
const ANALYSIS_ROOT = resolve("evaluation-artifacts/generalization-20260905/after");
const NOSE_BASELINE = resolve("evaluation-artifacts/nose-topology-20260913/after");
const MOUTH_BASELINE = resolve("evaluation-artifacts/mouth-topology-20260913/after");
const BROW_BASELINE = resolve("evaluation-artifacts/brow-topology-20260913-v2/after");
const EYE_BASELINE = resolve("evaluation-artifacts/eye-topology-20260913/after");
const ROOT = resolve("evaluation-artifacts/face-contour-20260913");
const BEFORE = resolve(ROOT, "before");
const AFTER = resolve(ROOT, "after");
const COMPARISON = resolve(ROOT, "comparison");

interface Candidate {
  id: string;
  geometry: IdentityGeometryAnalysis;
  analysis: PhotoAnalysis;
  style: FaceStyle;
  plan: ReturnType<typeof buildIdentityPixelPlans>;
  sourceFace: RawImage;
  cheekWidth: number;
  jawWidth: number;
  taperRatio: number;
  complexity: number;
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

function contourPixels(plan: FacePixelPlan): FacePixelInstruction[] {
  return plan.pixels.filter((pixel) => pixel.cluster === "complexion").sort((a, b) => a.y - b.y || a.x - b.x);
}

function rowMetric(plan: FacePixelPlan, atlas: RawImage, row: number) {
  const base = CLASSIC_LAYOUT.head.base.front;
  const outer = CLASSIC_LAYOUT.head.overlay.front;
  const contours = new Set(contourPixels(plan).filter((pixel) => pixel.y === row).map((pixel) => pixel.x));
  const rgba = Array.from({ length: 8 }, (_, x) => rgbaAt(atlas, base, x, row));
  return {
    row,
    rgba,
    contourXs: [...contours].sort((a, b) => a - b),
    lowerFaceLeftBoundaryX: contours.size ? Math.min(...contours) + 1 : 0,
    lowerFaceRightBoundaryX: contours.size ? Math.max(...contours) - 1 : 7,
    readableCenterWidth: contours.size ? Math.max(2, Math.max(...contours) - Math.min(...contours) - 1) : 8,
    overlayAlpha: Array.from({ length: 8 }, (_, x) => rgbaAt(atlas, outer, x, row)[3]),
  };
}

function contourMetrics(plan: FacePixelPlan, atlas: RawImage) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const pixels = contourPixels(plan);
  return {
    source: plan.source,
    geometryUsed: plan.layout.geometryUsage.faceShape,
    geometryProvenance: plan.layout.geometryProvenance.faceShape,
    quantized: plan.layout.faceShape,
    faceBoundaryBudget: plan.salience.pixelBudget.faceBoundary,
    cells: pixels.map((pixel) => ({
      x: pixel.x,
      y: pixel.y,
      role: pixel.role,
      baseRgba: rgbaAt(atlas, face, pixel.x, pixel.y),
      overlayAlpha: rgbaAt(atlas, overlay, pixel.x, pixel.y)[3],
    })),
    cheekRow: rowMetric(plan, atlas, 5),
    jawRow: rowMetric(plan, atlas, 6),
    chinRow: rowMetric(plan, atlas, 7),
    connectedComponents: complexionComponents(atlas),
  };
}

function complexionComponents(atlas: RawImage): number {
  const face = CLASSIC_LAYOUT.head.base.front;
  const pending = new Set<string>();
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (rgbaAt(atlas, face, x, y)[3] === 255) pending.add(`${x},${y}`);
  let components = 0;
  while (pending.size) {
    components++;
    const first = pending.values().next().value as string;
    pending.delete(first);
    const stack = [first];
    while (stack.length) {
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const key = `${x + dx},${y + dy}`;
        if (pending.delete(key)) stack.push(key);
      }
    }
  }
  return components;
}

function clusterSignature(plan: FacePixelPlan, cluster: FacePixelInstruction["cluster"]): string[] {
  return plan.pixels.filter((pixel) => pixel.cluster === cluster).map(({ x, y, role }) => `${x},${y}:${role}`).sort();
}

function signatures(plan: FacePixelPlan, hairPlan: HairPlan) {
  const hairTopology = {
    ...hairPlan,
    structure: {
      ...hairPlan.structure,
      geometryProvenance: {
        ...hairPlan.structure.geometryProvenance,
        // Face-shape provenance is expected to change in this iteration, but it
        // is metadata only and does not participate in executable hair topology.
        faceShape: "semantic_fallback" as const,
      },
    },
  };
  return {
    eyes: [...clusterSignature(plan, "left_eye"), ...clusterSignature(plan, "right_eye")],
    brows: plan.pixels.filter((pixel) => pixel.role === "brow").map(({ x, y, role }) => `${x},${y}:${role}`).sort(),
    mouth: clusterSignature(plan, "mouth"),
    nose: clusterSignature(plan, "nose"),
    hair: JSON.stringify({ fringe: clusterSignature(plan, "fringe"), hairPlan: hairTopology }),
  };
}

function regionKeys(plans: FacePixelPlan[], cluster: FacePixelInstruction["cluster"]): Set<number> {
  const face = CLASSIC_LAYOUT.head.base.front;
  return new Set(plans.flatMap((plan) => plan.pixels.filter((pixel) => pixel.cluster === cluster).map((pixel) => (face.y + pixel.y) * 64 + face.x + pixel.x)));
}

function changedPixels(before: RawImage, after: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const head = new Set<number>();
  for (const layer of [CLASSIC_LAYOUT.head.base, CLASSIC_LAYOUT.head.overlay]) for (const rect of Object.values(layer)) for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) head.add(y * 64 + x);
  const contour = new Set([...beforePlan.pixels, ...afterPlan.pixels].filter((pixel) => pixel.cluster === "complexion").map((pixel) => (face.y + pixel.y) * 64 + face.x + pixel.x));
  const eyes = new Set([...regionKeys([beforePlan, afterPlan], "left_eye"), ...regionKeys([beforePlan, afterPlan], "right_eye")]);
  const brows = new Set([...beforePlan.pixels, ...afterPlan.pixels].filter((pixel) => pixel.role === "brow").map((pixel) => (face.y + pixel.y) * 64 + face.x + pixel.x));
  const mouth = regionKeys([beforePlan, afterPlan], "mouth");
  const nose = regionKeys([beforePlan, afterPlan], "nose");
  const hair = regionKeys([beforePlan, afterPlan], "fringe");
  const result = { headDiff: 0, bodyDiff: 0, contourRegionDiff: 0, eyeRegionDiff: 0, browRegionDiff: 0, mouthRegionDiff: 0, noseRegionDiff: 0, hairRegionDiff: 0, outsideContourDiff: 0 };
  for (let index = 0; index < 64 * 64; index++) {
    const at = index * 4;
    if (before.rgba.subarray(at, at + 4).every((value, channel) => value === after.rgba[at + channel])) continue;
    if (head.has(index)) result.headDiff++; else result.bodyDiff++;
    if (contour.has(index)) result.contourRegionDiff++; else result.outsideContourDiff++;
    if (eyes.has(index)) result.eyeRegionDiff++;
    if (brows.has(index)) result.browRegionDiff++;
    if (mouth.has(index)) result.mouthRegionDiff++;
    if (nose.has(index)) result.noseRegionDiff++;
    if (hair.has(index)) result.hairRegionDiff++;
  }
  return result;
}

function keepOnlyContourDelta(baseline: RawImage, candidate: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan): RawImage {
  const allowed = regionKeys([beforePlan, afterPlan], "complexion");
  for (let index = 0; index < 64 * 64; index++) {
    if (allowed.has(index)) continue;
    const at = index * 4;
    candidate.rgba.set(baseline.rgba.subarray(at, at + 4), at);
  }
  return candidate;
}

async function firstExisting(paths: string[]): Promise<string> {
  for (const path of paths) try { await access(path); return path; } catch { /* preserve latest available frozen baseline */ }
  throw new Error(`No frozen baseline found: ${paths.join(", ")}`);
}

async function currentBaseline(id: string): Promise<RawImage> {
  const path = await firstExisting([
    resolve(NOSE_BASELINE, id, "atlas.png"),
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
        readFile(resolve(GEOMETRY_ROOT, directory.name, "metrics.json"), "utf8").then(JSON.parse) as Promise<{ sourceGeometry: Record<string, unknown> }>,
        readFile(resolve(ANALYSIS_ROOT, directory.name, "analysis-and-plan.json"), "utf8").then(JSON.parse) as Promise<{ analysis: PhotoAnalysis; style: FaceStyle }>,
        readFile(resolve(INPUT, directory.name, "01-source-face.png")),
      ]);
      const parsedGeometry = parseIdentityGeometry(metrics.sourceGeometry);
      const storedGeometry = stored.analysis.identityGeometry;
      const hasStoredDerivedFaceShape = storedGeometry?.diagnostics.derivedMeasurements.includes("faceShape") ?? false;
      const geometry = parsedGeometry && hasStoredDerivedFaceShape
        ? {
            ...parsedGeometry,
            diagnostics: {
              ...parsedGeometry.diagnostics,
              derivedMeasurements: [...new Set([...parsedGeometry.diagnostics.derivedMeasurements, "faceShape"])],
              provenance: {
                ...parsedGeometry.diagnostics.provenance,
                faceShape: "derived_geometry" as const,
              },
            },
          }
        : parsedGeometry;
      if (!geometry || geometry.faceShape.confidence < 0.55) continue;
      const analysis = { ...stored.analysis, identityGeometry: geometry };
      const plan = buildIdentityPixelPlans(analysis);
      const complexity = plan.facePixelPlan.glassesPlan.framePixels.length * 3
        + Number(plan.headIdentityPlan.ownership?.covering) * 20
        + plan.hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe").length * 2
        + plan.facePixelPlan.pixels.filter((pixel) => pixel.cluster !== "complexion" && pixel.cluster !== "fringe").length;
      result.push({
        id: directory.name,
        geometry,
        analysis,
        style: stored.style,
        plan,
        sourceFace: await decodePng(new Uint8Array(sourceBytes)),
        cheekWidth: geometry.faceShape.cheekWidth,
        jawWidth: geometry.faceShape.jawWidth,
        taperRatio: geometry.faceShape.jawWidth / geometry.faceShape.cheekWidth,
        complexity,
      });
    } catch (error) {
      throw new Error(`${directory.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function select(items: Candidate[]): Array<Candidate & { selection: string }> {
  const broad = [...items].sort((a, b) => (b.cheekWidth + b.jawWidth) - (a.cheekWidth + a.jawWidth) || a.id.localeCompare(b.id))[0];
  const tapered = [...items].filter((item) => item !== broad).sort((a, b) => Number(a.taperRatio.toFixed(3)) - Number(b.taperRatio.toFixed(3)) || a.jawWidth - b.jawWidth || a.id.localeCompare(b.id))[0];
  const sentinel = [...items].filter((item) => item !== broad && item !== tapered).sort((a, b) => b.complexity - a.complexity || a.id.localeCompare(b.id))[0];
  return [
    { ...broad, selection: "maximum_calibrated_cheek_plus_jaw_width" },
    { ...tapered, selection: "minimum_jaw_to_cheek_ratio_then_jaw_width" },
    { ...sentinel, selection: "maximum_existing_head_and_face_topology_complexity" },
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

describe.skipIf(!MODE)("calibrated face contour comparison artifacts", () => {
  it("selects width/taper extremes and preserves every existing identity topology", async () => {
    const inventory = await candidates();
    const selected = select(inventory);
    expect(new Set(selected.map((item) => item.id)).size).toBe(3);
    const output = MODE === "before" ? BEFORE : AFTER;
    const summary: Record<string, unknown> = {};
    let improved = 0;
    for (const item of selected) {
      const facePlan = item.plan.facePixelPlan;
      const prior = MODE === "before" ? undefined : await readFile(resolve(BEFORE, item.id, "metrics.json"), "utf8").then(JSON.parse) as { contour: ReturnType<typeof contourMetrics>; signatures: ReturnType<typeof signatures>; plan: FacePixelPlan };
      const baseline = MODE === "before" ? await currentBaseline(item.id) : await decodePng(new Uint8Array(await readFile(resolve(BEFORE, item.id, "atlas.png"))));
      const atlas = prior
        ? keepOnlyContourDelta(baseline, createFacePlanAtlasCandidate(baseline, facePlan, item.style, prior.plan), prior.plan, facePlan)
        : baseline;
      const directory = resolve(output, item.id);
      await saveViewSet(directory, item.sourceFace, atlas);
      const sourceGeometry = {
        faceShape: item.analysis.renderHints.faceShape,
        jawShape: item.analysis.renderHints.jawShape,
        cheekWidth: item.cheekWidth,
        jawWidth: item.jawWidth,
        taperRatio: item.taperRatio,
        chinWidth: null,
        chinPosition: null,
        faceWindowWidthAtCheeks: item.geometry.faceWindow.visibleFaceWidthAtCheeks,
        confidence: item.geometry.faceShape.confidence,
        evidence: item.geometry.faceShape.evidence,
        provenance: item.plan.facePixelPlan.layout.geometryProvenance.faceShape,
      };
      const current = { selection: item.selection, sourceGeometry, contour: contourMetrics(facePlan, atlas), signatures: signatures(facePlan, item.plan.hairPlan), plan: facePlan };
      summary[item.id] = current;
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(current, null, 2));
      if (prior) {
        expect(current.signatures, `${item.id}: frozen face/hair signatures`).toEqual(prior.signatures);
        const atlasDiff = changedPixels(baseline, atlas, prior.plan, facePlan);
        expect(atlasDiff.bodyDiff, `${item.id}: body diff`).toBe(0);
        expect(atlasDiff.outsideContourDiff, `${item.id}: outside contour diff`).toBe(0);
        expect(atlasDiff.eyeRegionDiff, `${item.id}: eye diff`).toBe(0);
        expect(atlasDiff.browRegionDiff, `${item.id}: brow diff`).toBe(0);
        expect(atlasDiff.mouthRegionDiff, `${item.id}: mouth diff`).toBe(0);
        expect(atlasDiff.noseRegionDiff, `${item.id}: nose diff`).toBe(0);
        expect(atlasDiff.hairRegionDiff, `${item.id}: hair diff`).toBe(0);
        expect(current.contour.cells.length, `${item.id}: contour budget`).toBeLessThanOrEqual(6);
        expect(current.contour.cells.every((cell) => cell.baseRgba[3] === 255), `${item.id}: no transparent face cutting`).toBe(true);
        const topologyChanged = JSON.stringify(prior.contour.cells.map(({ x, y, role }) => ({ x, y, role }))) !== JSON.stringify(current.contour.cells.map(({ x, y, role }) => ({ x, y, role })));
        if (topologyChanged && atlasDiff.contourRegionDiff > 0) improved++;
        const compared = {
          selection: item.selection,
          sourceGeometry,
          before: prior.contour,
          after: current.contour,
          eyeSignatureEqual: true,
          browSignatureEqual: true,
          mouthSignatureEqual: true,
          noseSignatureEqual: true,
          hairSignatureEqual: true,
          atlasDiff,
          topologyChanged,
          sourceSpecificContourImproved: topologyChanged && atlasDiff.contourRegionDiff > 0,
        };
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
    const metadata = {
      apiCalls: 0,
      mode: MODE,
      selectionRule: "maximum cheek+jaw width; minimum jaw/cheek ratio; then maximum existing head/face topology complexity; no fixture-id branch",
      inventory: inventory.map((item) => ({ id: item.id, cheekWidth: item.cheekWidth, jawWidth: item.jawWidth, taperRatio: item.taperRatio, confidence: item.geometry.faceShape.confidence, provenance: item.plan.facePixelPlan.layout.geometryProvenance.faceShape, complexity: item.complexity })),
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
