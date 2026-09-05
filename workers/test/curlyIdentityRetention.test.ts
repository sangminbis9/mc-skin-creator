import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import {
  curlySilhouetteSignature,
  findCurlySilhouetteCollisions,
  measureCurlyIdentityRetention,
} from "../src/curlyIdentityRetention";
import type { IdentityGeometryAnalysis, MajorHairVolumePeak } from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import type { RawImage } from "../src/png";
import { applyHeadIdentityPlan, applyHeadMaskPlan, reconcileOverlaySeams, type FaceStyle } from "../src/skinPack";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const STYLE: FaceStyle = {
  eyeColor: "#526d78", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile",
  facialHair: "none", glasses: "none", hairstyle: "curly", hat: "none", bangs: "none",
  bangsLength: "none", hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled",
  hairPart: "left", sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: "none", earExposure: "partial",
};

function peak(region: MajorHairVolumePeak["region"], protrusion: number, verticalCenter: number, verticalExtent: number): MajorHairVolumePeak {
  return { region, protrusion, verticalCenter, verticalExtent, evidence: "observed", confidence: 0.9 };
}

function curlyAnalysis(
  id: string,
  peaks: MajorHairVolumePeak[],
  silhouette: Partial<IdentityGeometryAnalysis["headSilhouette"]> = {},
  crown: Partial<IdentityGeometryAnalysis["crown"]> = {},
): PhotoAnalysis {
  const base = makeAnalysis();
  const geometry = makeIdentityGeometry({
    majorVolumePeaks: peaks,
    crown: { ...makeIdentityGeometry().crown, ...crown },
    headSilhouette: { ...makeIdentityGeometry().headSilhouette, ...silhouette },
  });
  return makeAnalysis({
    identityGeometry: geometry,
    observed: { ...base.observed, hair: `${id} source-derived curly silhouette` },
    canonicalIdentity: {
      ...base.canonicalIdentity,
      overallImpression: `${id} curly silhouette`,
      mustPreserve: [`${id} major curly masses`, ...base.canonicalIdentity.mustPreserve],
      features: [{ feature: `${id} major curly masses`, category: "hair", priority: 5, confidence: "high", evidence: "visible source contour", targetRegions: ["head.front", "head.side", "head.back", "head.top", "head.overlay"] }, ...base.canonicalIdentity.features],
    },
    renderHints: {
      ...base.renderHints,
      bangs: "none", bangsLength: "none", fringeOpening: "none", hairTexture: "curly", hairVolume: "full",
      hairSilhouette: "tousled", hairBackShape: "rounded", overallHairLength: "jaw", hairPart: "left",
      sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: silhouette.sideVolumeLeft === silhouette.sideVolumeRight ? "none" : (silhouette.sideVolumeLeft ?? 0.6) > (silhouette.sideVolumeRight ?? 0.6) ? "left" : "right",
      earExposure: "partial",
    },
    fallbackFeatures: { ...base.fallbackFeatures, hairstyle: "curly" },
    identityPrompt: `${id}: preserve measured crown, side, lower masses and endpoint heights`,
  });
}

const VARIANTS = [
  curlyAnalysis("three-mass-left-heavy", [peak("crown_left", 0.9, 0.12, 0.28), peak("side_left", 0.95, 0.34, 0.54), peak("side_right", 0.42, 0.3, 0.28)], { sideVolumeLeft: 0.94, sideVolumeRight: 0.42, hairEndpointLeftY: 0.68, hairEndpointRightY: 0.48 }, { leftY: 0.08, centerY: 0.04, rightY: 0.14, apexX: 0.28 }),
  curlyAnalysis("four-mass-right-heavy", [peak("crown_right", 0.92, 0.11, 0.3), peak("side_left", 0.4, 0.3, 0.28), peak("side_right", 0.96, 0.4, 0.58), peak("lower_right", 0.86, 0.62, 0.34)], { sideVolumeLeft: 0.4, sideVolumeRight: 0.96, hairEndpointLeftY: 0.46, hairEndpointRightY: 0.76 }, { leftY: 0.15, centerY: 0.05, rightY: 0.08, apexX: 0.72 }),
  curlyAnalysis("five-mass-low-wide", [peak("crown_left", 0.56, 0.18, 0.2), peak("side_left", 0.8, 0.46, 0.44), peak("side_right", 0.78, 0.45, 0.42), peak("lower_left", 0.88, 0.66, 0.38), peak("lower_right", 0.82, 0.62, 0.34)], { sideVolumeLeft: 0.82, sideVolumeRight: 0.79, hairEndpointLeftY: 0.82, hairEndpointRightY: 0.76 }),
  curlyAnalysis("top-heavy", [peak("crown_left", 0.98, 0.1, 0.38), peak("crown_right", 0.88, 0.14, 0.32), peak("side_left", 0.44, 0.35, 0.25), peak("side_right", 0.42, 0.36, 0.24)], { sideVolumeLeft: 0.44, sideVolumeRight: 0.42, hairEndpointLeftY: 0.5, hairEndpointRightY: 0.49 }, { leftY: 0.02, centerY: 0.01, rightY: 0.06, apexX: 0.42 }),
  curlyAnalysis("strong-lower-left", [peak("crown_left", 0.6, 0.14, 0.24), peak("side_left", 0.7, 0.36, 0.34), peak("side_right", 0.66, 0.35, 0.32), peak("lower_left", 0.98, 0.7, 0.42)], { sideVolumeLeft: 0.84, sideVolumeRight: 0.66, hairEndpointLeftY: 0.88, hairEndpointRightY: 0.58 }),
  curlyAnalysis("near-symmetric", [peak("crown_left", 0.72, 0.14, 0.26), peak("crown_right", 0.71, 0.14, 0.26), peak("side_left", 0.7, 0.4, 0.4), peak("side_right", 0.7, 0.4, 0.4)], { sideVolumeLeft: 0.7, sideVolumeRight: 0.7, hairEndpointLeftY: 0.64, hairEndpointRightY: 0.64 }, { leftY: 0.07, centerY: 0.04, rightY: 0.07, apexX: 0.5 }),
];

function blankAtlas(): RawImage {
  return { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
}

function connected(points: Array<{ x: number; y: number }>): boolean {
  if (points.length < 2) return true;
  const keys = new Set(points.map((point) => `${point.x},${point.y}`));
  const visited = new Set<string>();
  const queue = [points[0]];
  while (queue.length) {
    const current = queue.shift()!;
    const key = `${current.x},${current.y}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const next = `${current.x + dx},${current.y + dy}`;
      if ((dx !== 0 || dy !== 0) && keys.has(next) && !visited.has(next)) queue.push({ x: current.x + dx, y: current.y + dy });
    }
  }
  return visited.size === keys.size;
}

function layerSignature(atlas: RawImage, layer: "base" | "overlay"): string {
  const values: number[] = [];
  for (const face of ["front", "top", "left", "right", "back"] as const) {
    const rect = CLASSIC_LAYOUT.head[layer][face];
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const offset = ((rect.y + y) * atlas.width + rect.x + x) * 4;
      values.push(...atlas.rgba.subarray(offset, offset + 4));
    }
  }
  return JSON.stringify(values);
}

describe("source-derived curly silhouette retention", () => {
  it("keeps 3/4/5 and directional source variants distinct without generic convergence", () => {
    const samples = VARIANTS.map((analysis, index) => ({ id: String(index), plan: buildIdentityPixelPlans(analysis).hairPlan }));
    expect(samples.slice(0, 3).map(({ plan }) => plan.structure.curlySilhouette?.sourcePeakCount)).toEqual([3, 4, 5]);
    expect(samples.slice(0, 3).map(({ plan }) => plan.structure.curlySilhouette?.masses.length)).toEqual([3, 4, 5]);
    expect(new Set(samples.map(({ plan }) => JSON.stringify(curlySilhouetteSignature(plan)))).size).toBe(VARIANTS.length);
    expect(findCurlySilhouetteCollisions(samples)).toEqual([]);
  });

  it("preserves protrusion, vertical extent, endpoint mass, and left/right asymmetry", () => {
    const left = buildIdentityPixelPlans(VARIANTS[0]);
    const right = buildIdentityPixelPlans(VARIANTS[1]);
    const leftMass = left.hairPlan.structure.curlySilhouette!.masses.find((mass) => mass.region === "side_left")!;
    const rightMass = right.hairPlan.structure.curlySilhouette!.masses.find((mass) => mass.region === "side_right")!;
    expect(leftMass.width).toBeGreaterThan(left.hairPlan.structure.curlySilhouette!.masses.find((mass) => mass.region === "side_right")!.width);
    expect(rightMass.spanRows).toBeGreaterThanOrEqual(3);
    expect(left.hairPlan.headMask.endpointRows.left).toBeGreaterThan(left.hairPlan.headMask.endpointRows.right);
    const terminal = leftMass.outerPoints.filter((point) => point.face === "left" && point.y === left.hairPlan.headMask.endpointRows.left);
    expect(terminal.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves the real curly 4/3 endpoint boundary as neighboring mass rows", () => {
    const analysis = curlyAnalysis("endpoint-boundary", [
      peak("side_left", 0.94, 0.34, 0.54), peak("side_right", 0.72, 0.28, 0.42),
      peak("lower_left", 0.82, 0.55, 0.32), peak("lower_right", 0.58, 0.48, 0.28),
    ], { sideVolumeLeft: 0.96, sideVolumeRight: 0.72, hairEndpointLeftY: 0.62, hairEndpointRightY: 0.54 });
    const plan = buildIdentityPixelPlans(analysis).hairPlan;
    expect(plan.headMask.endpointRows).toEqual({ left: 4, right: 3 });
    const leftTerminal = plan.structure.curlySilhouette!.masses.flatMap((mass) => mass.outerPoints)
      .filter((point) => point.face === "left" && point.y === 4);
    const rightTerminal = plan.structure.curlySilhouette!.masses.flatMap((mass) => mass.outerPoints)
      .filter((point) => point.face === "right" && point.y === 3);
    expect(leftTerminal.length).toBeGreaterThanOrEqual(2);
    expect(rightTerminal.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps every per-face major footprint connected and the outer shell selective", () => {
    for (const analysis of VARIANTS) {
      const plan = buildIdentityPixelPlans(analysis).hairPlan;
      for (const mass of plan.structure.curlySilhouette!.masses) for (const face of ["front", "top", "left", "right", "back"] as const) {
        const points = mass.outerPoints.filter((point) => point.face === face);
        expect(connected(points)).toBe(true);
      }
      const occupancy = Object.values(plan.headMask.faces).flat().length;
      expect(occupancy).toBeLessThan(180);
      expect(plan.structure.majorSilhouetteGroupIds.length).toBe(plan.structure.curlySilhouette!.masses.length);
      expect(plan.structure.textureGroupIds.some((id) => id.startsWith("curl-lobe"))).toBe(false);
    }
  });

  it("merges only quantized duplicate peaks and keeps both provenance records", () => {
    const duplicate = curlyAnalysis("duplicate", [peak("side_left", 0.82, 0.42, 0.4), peak("side_left", 0.9, 0.43, 0.44), peak("side_right", 0.6, 0.4, 0.34)]);
    const plan = buildIdentityPixelPlans(duplicate).hairPlan;
    expect(plan.structure.curlySilhouette!.sourcePeakCount).toBe(3);
    expect(plan.structure.curlySilhouette!.masses.length).toBe(2);
    const merged = plan.structure.curlySilhouette!.masses.find((mass) => mass.region === "side_left")!;
    expect(merged.sourceEvidence).toHaveLength(2);
    expect(merged.protrusion).toBe(0.9);
  });

  it("retains planned source pixels in the atlas with continuous physical seams", () => {
    const analysis = VARIANTS[2];
    const plans = buildIdentityPixelPlans(analysis);
    const atlas = blankAtlas();
    applyHeadMaskPlan(atlas, plans.hairPlan, [184, 152, 94], [184, 152, 94], STYLE, plans.facePixelPlan);
    applyHeadIdentityPlan(atlas, plans.headIdentityPlan, plans.hairPlan, [184, 152, 94], [208, 154, 130], STYLE, false);
    reconcileOverlaySeams(atlas, STYLE, [184, 152, 94]);
    const retention = measureCurlyIdentityRetention(analysis, plans.hairPlan, plans.facePixelPlan, atlas);
    expect(retention.peakCountRetention).toBe(1);
    expect(retention.protrusionRetention).toBe(1);
    expect(retention.atlas.retainedSourceOuterPixels).toBe(retention.atlas.expectedSourceOuterPixels);
    expect(retention.frontSideContinuity).toBe(1);
    expect(retention.sideBackContinuity).toBe(1);
  });

  it("keeps source variants distinct in both base-only identity and selective outer depth", () => {
    const rendered = VARIANTS.map((analysis) => {
      const plans = buildIdentityPixelPlans(analysis);
      const atlas = blankAtlas();
      applyHeadMaskPlan(atlas, plans.hairPlan, [184, 152, 94], [184, 152, 94], STYLE, plans.facePixelPlan);
      applyHeadIdentityPlan(atlas, plans.headIdentityPlan, plans.hairPlan, [184, 152, 94], [208, 154, 130], STYLE, false);
      reconcileOverlaySeams(atlas, STYLE, [184, 152, 94]);
      return { base: layerSignature(atlas, "base"), outer: layerSignature(atlas, "overlay") };
    });
    expect(new Set(rendered.map((item) => item.base)).size).toBe(VARIANTS.length);
    expect(new Set(rendered.map((item) => item.outer)).size).toBe(VARIANTS.length);
  });
});
