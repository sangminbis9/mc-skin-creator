import type { PhotoAnalysis } from "./analysis";
import type { CurlyMassRegion, FacePixelPlan, HairPlan, HeadMaskFace } from "./identityPlans";
import type { RawImage } from "./png";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "./uvLayout";

export interface CurlyMassSignature {
  id: string;
  regions: CurlyMassRegion[];
  centerRow: number;
  spanRows: number;
  width: number;
  protrusion: number;
  outerPixelsByFace: Partial<Record<HeadMaskFace, number>>;
}

export interface CurlySilhouetteSignature {
  masses: CurlyMassSignature[];
  crownProfile: { leftRow: number; centerRow: number; rightRow: number; apexColumn: number };
  crownOuterPixels: number;
  endpoints: { left: number; right: number };
  occupancyByFace: Record<HeadMaskFace, number>;
}

export interface CurlyIdentityRetention {
  source: NonNullable<PhotoAnalysis["identityGeometry"]>["majorVolumePeaks"];
  geometry: FacePixelPlan["layout"]["majorVolumePeaks"];
  plan: CurlySilhouetteSignature;
  atlas: {
    expectedSourceOuterPixels: number;
    retainedSourceOuterPixels: number | null;
    actualOuterPixels: number | null;
    identityBearingOuterPixels: number;
    decorativeOuterPixels: number | null;
  };
  crownMassRetention: number;
  sideMassRetention: number;
  lowerMassRetention: number;
  endpointRetention: number;
  asymmetryRetention: number;
  peakCountRetention: number;
  peakPositionRetention: number;
  protrusionRetention: number;
  verticalExtentRetention: number;
  frontSideContinuity: number;
  sideBackContinuity: number;
  largestLossStage: "geometry_to_quantization" | "quantization_to_plan" | "plan_to_atlas" | "retained";
}

export interface CurlyPixelDifference {
  changedHeadPixels: number;
  crownSilhouette: number;
  leftSilhouette: number;
  rightSilhouette: number;
  lowerSilhouette: number;
  backSilhouette: number;
  outerDepth: number;
  textureOnly: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function retention(error: number): number {
  return Math.max(0, Math.min(1, 1 - error));
}

function pointKey(face: HeadMaskFace, x: number, y: number): string {
  return `${face}:${x},${y}`;
}

function alpha(atlas: RawImage, face: HeadMaskFace, x: number, y: number): number {
  const rect = CLASSIC_LAYOUT.head.overlay[face];
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3];
}

function seamRetention(plan: HairPlan, atlas: RawImage | undefined, seams: Array<[HeadMaskFace, number, HeadMaskFace, number]>): number {
  const occupied = (face: HeadMaskFace, x: number, y: number) => atlas
    ? alpha(atlas, face, x, y) >= 128
    : plan.headMask.faces[face].some((point) => point.x === x && point.y === y);
  const samples: number[] = [];
  for (const [firstFace, firstX, secondFace, secondX] of seams) for (let y = 0; y < 8; y++) {
    const first = occupied(firstFace, firstX, y);
    const second = occupied(secondFace, secondX, y);
    if (!first && !second) continue;
    samples.push(first === second ? 1 : 0);
  }
  return samples.length === 0 ? 1 : mean(samples);
}

export function curlySilhouetteSignature(plan: HairPlan): CurlySilhouetteSignature {
  const curly = plan.structure.curlySilhouette;
  return {
    masses: (curly?.masses ?? []).map((mass) => ({
    id: mass.id,
    regions: [...mass.sourceRegions],
    centerRow: mass.centerRow,
    spanRows: mass.spanRows,
    width: mass.width,
    protrusion: mass.protrusion,
    outerPixelsByFace: Object.fromEntries((["front", "top", "left", "right", "back"] as const)
      .map((face) => [face, mass.outerPoints.filter((point) => point.face === face).length])
      .filter(([, count]) => Number(count) > 0)),
    })),
    crownProfile: curly?.crownProfile ?? { leftRow: 0, centerRow: 0, rightRow: 0, apexColumn: 3 },
    crownOuterPixels: curly?.crownOuterPoints.length ?? 0,
    endpoints: { ...plan.headMask.endpointRows },
    occupancyByFace: Object.fromEntries((["front", "top", "left", "right", "back"] as const)
      .map((face) => [face, plan.headMask.faces[face].length])) as Record<HeadMaskFace, number>,
  };
}

export function measureCurlyIdentityRetention(
  analysis: PhotoAnalysis,
  plan: HairPlan,
  facePlan: FacePixelPlan,
  atlas?: RawImage,
): CurlyIdentityRetention {
  const source = analysis.identityGeometry?.majorVolumePeaks ?? [];
  const geometry = facePlan.layout.majorVolumePeaks;
  const masses = plan.structure.curlySilhouette?.masses ?? [];
  const signature = curlySilhouetteSignature(plan);
  const protectedOuter = new Set([
    ...facePlan.glassesPlan.framePixels.map((point) => pointKey(point.face, point.x, point.y)),
    ...facePlan.glassesPlan.sideArms.map((point) => pointKey(point.face, point.x, point.y)),
    ...facePlan.glassesPlan.lensOpenings.map((point) => pointKey("front", point.x, point.y)),
  ]);
  const expectedKeys = new Set((plan.structure.curlySilhouette
    ? (Object.entries(plan.headMask.faces) as Array<[HeadMaskFace, Array<{ x: number; y: number }>]>)
      .flatMap(([face, points]) => points.map((point) => pointKey(face, point.x, point.y)))
    : masses.flatMap((mass) => mass.outerPoints.map((point) => pointKey(point.face, point.x, point.y))))
    .filter((key) => !protectedOuter.has(key)));
  let retained = 0;
  let actual = 0;
  if (atlas) for (const face of ["front", "top", "left", "right", "back"] as const) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    if (alpha(atlas, face, x, y) < 128) continue;
    actual++;
    if (expectedKeys.has(pointKey(face, x, y))) retained++;
  }
  const matched = source.map((peak) => ({
    source: peak,
    quantized: geometry.find((candidate) => candidate.region === peak.region),
    mass: masses.find((candidate) => candidate.sourceRegions.includes(peak.region)),
  }));
  const peakPositionRetention = retention(mean(matched.map(({ source: peak, mass }) => mass ? Math.abs(mass.centerRow / 7 - peak.verticalCenter) : 1)));
  const protrusionRetention = retention(mean(matched.map(({ source: peak, mass }) => mass ? Math.abs(mass.protrusion - peak.protrusion) : 1)));
  const verticalExtentRetention = retention(mean(matched.map(({ source: peak, mass }) => mass ? Math.abs((mass.spanRows - 1) / 3 - peak.verticalExtent) : 1)));
  const regionRetention = (prefix: "crown" | "side" | "lower") => {
    const relevant = matched.filter(({ source: peak }) => peak.region.startsWith(prefix));
    return relevant.length === 0 ? 1 : retention(mean(relevant.map(({ mass }) => mass ? 0 : 1)));
  };
  const silhouette = analysis.identityGeometry?.headSilhouette;
  const endpointRetention = silhouette ? retention(mean([
    Math.abs(plan.headMask.endpointRows.left / 7 - silhouette.hairEndpointLeftY),
    Math.abs(plan.headMask.endpointRows.right / 7 - silhouette.hairEndpointRightY),
  ])) : 0;
  const sideProtrusion = (side: "left" | "right") => Math.max(0, ...masses.filter((mass) => mass.region.endsWith(side)).map((mass) => mass.protrusion));
  const sourceSideProtrusion = (side: "left" | "right") => Math.max(0, ...source.filter((peak) => peak.region.endsWith(side)).map((peak) => peak.protrusion));
  const asymmetryRetention = retention(Math.abs(
    (sideProtrusion("left") - sideProtrusion("right")) - (sourceSideProtrusion("left") - sourceSideProtrusion("right")),
  ));
  const peakCountRetention = retention(Math.abs(source.length - masses.length) / Math.max(1, source.length));
  const frontSideContinuity = seamRetention(plan, atlas, [["front", 7, "left", 0], ["front", 0, "right", 7]]);
  const sideBackContinuity = seamRetention(plan, atlas, [["left", 7, "back", 0], ["right", 0, "back", 7]]);
  const geometryRetention = retention(mean(matched.map(({ quantized }) => quantized ? 0 : 1)));
  const planRetention = mean([peakCountRetention, peakPositionRetention, protrusionRetention, verticalExtentRetention, asymmetryRetention]);
  const atlasRetention = atlas ? retained / Math.max(1, expectedKeys.size) : 1;
  const losses = [1 - geometryRetention, 1 - planRetention, 1 - atlasRetention];
  const largest = Math.max(...losses);
  return {
    source,
    geometry,
    plan: signature,
    atlas: {
      expectedSourceOuterPixels: expectedKeys.size,
      retainedSourceOuterPixels: atlas ? retained : null,
      actualOuterPixels: atlas ? actual : null,
      identityBearingOuterPixels: expectedKeys.size,
      decorativeOuterPixels: atlas ? Math.max(0, actual - retained) : null,
    },
    crownMassRetention: regionRetention("crown"),
    sideMassRetention: regionRetention("side"),
    lowerMassRetention: regionRetention("lower"),
    endpointRetention,
    asymmetryRetention,
    peakCountRetention,
    peakPositionRetention,
    protrusionRetention,
    verticalExtentRetention,
    frontSideContinuity,
    sideBackContinuity,
    largestLossStage: largest <= 0.04 ? "retained" : largest === losses[0]
      ? "geometry_to_quantization" : largest === losses[1] ? "quantization_to_plan" : "plan_to_atlas",
  };
}

export function findCurlySilhouetteCollisions(samples: Array<{ id: string; plan: HairPlan }>): Array<{ ids: string[]; signature: string }> {
  const buckets = new Map<string, string[]>();
  for (const sample of samples) {
    const signature = JSON.stringify(curlySilhouetteSignature(sample.plan));
    buckets.set(signature, [...(buckets.get(signature) ?? []), sample.id]);
  }
  return [...buckets.entries()].filter(([, ids]) => ids.length > 1).map(([signature, ids]) => ({ ids, signature }));
}

function pixelChanged(first: RawImage, second: RawImage, x: number, y: number): { changed: boolean; alpha: boolean } {
  const offset = (y * ATLAS_SIZE + x) * 4;
  const changed = first.rgba[offset] !== second.rgba[offset] || first.rgba[offset + 1] !== second.rgba[offset + 1] || first.rgba[offset + 2] !== second.rgba[offset + 2] || first.rgba[offset + 3] !== second.rgba[offset + 3];
  return { changed, alpha: first.rgba[offset + 3] !== second.rgba[offset + 3] };
}

export function measureCurlyPixelDifference(before: RawImage, after: RawImage): CurlyPixelDifference {
  const result: CurlyPixelDifference = { changedHeadPixels: 0, crownSilhouette: 0, leftSilhouette: 0, rightSilhouette: 0, lowerSilhouette: 0, backSilhouette: 0, outerDepth: 0, textureOnly: 0 };
  for (const layer of ["base", "overlay"] as const) for (const [face, rect] of Object.entries(CLASSIC_LAYOUT.head[layer]) as Array<[HeadMaskFace | "bottom", { x: number; y: number; w: number; h: number }]>) {
    if (face === "bottom") continue;
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const difference = pixelChanged(before, after, rect.x + x, rect.y + y);
      if (!difference.changed) continue;
      result.changedHeadPixels++;
      if (!difference.alpha) result.textureOnly++;
      if (layer !== "overlay" || !difference.alpha) continue;
      result.outerDepth++;
      if (face === "top" || (face === "front" && y <= 1)) result.crownSilhouette++;
      if (face === "left") result.leftSilhouette++;
      if (face === "right") result.rightSilhouette++;
      if ((face === "left" || face === "right" || face === "back") && y >= 4) result.lowerSilhouette++;
      if (face === "back") result.backSilhouette++;
    }
  }
  return result;
}
