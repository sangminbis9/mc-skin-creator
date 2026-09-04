import type { PhotoAnalysis } from "./analysis";
import type { FacePixelPlan, HairPlan, HeadMaskFace } from "./identityPlans";
import type { RawImage } from "./png";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "./uvLayout";

export interface HairSilhouetteSignature {
  texture: HairPlan["texture"];
  crownRow: number;
  fringeDepthByColumn: number[];
  sideWidthsLeft: number[];
  sideWidthsRight: number[];
  sideWidthsBack: number[];
  partColumn: number | null;
  endpointLeft: number;
  endpointRight: number;
  earExposureLeft: number;
  earExposureRight: number;
  majorGroupCount: number;
  asymmetry: number;
}

export interface HairInformationFlow {
  sourceToPlanRetention: number;
  planToAtlasRetention: number | null;
  errors: {
    crown: number;
    sideExtent: number;
    part: number;
    fringe: number;
    earExposure: number;
    groupStructure: number;
    asymmetry: number;
  };
  signature: HairSilhouetteSignature;
}

export interface HeadIdentityRetention {
  source: {
    texture: HairPlan["texture"];
    saliencePrimary: HairPlan["salience"]["primary"];
  };
  geometry: PhotoAnalysis["identityGeometry"];
  quantizedPlan: HairSilhouetteSignature;
  renderedAtlas: {
    expectedOuterPixels: number;
    retainedOuterPixels: number | null;
    actualOuterPixels: number | null;
    planToAtlasFidelity: number | null;
    outerOccupancyByFace: Record<HeadMaskFace, number> | null;
  };
  metrics: {
    crownRetention: number;
    fringeRetention: number;
    templeRetention: number;
    sideVolumeRetention: number;
    partRetention: number;
    earExposureRetention: number;
    asymmetryRetention: number;
    textureGroupRetention: number;
    fringePeakRetention: number;
    templeRecessionRetention: number;
    crownContourRetention: number;
    faceWindowRetention: number;
    eyeToHairDistanceRetention: number;
    faceWidthRetention: number;
    majorVolumePeakRetention: number;
  };
  stageRetention: {
    sourceToGeometry: number;
    geometryToPlan: number;
    planToAtlas: number | null;
  };
  largestLossStage: "source_analysis_to_geometry" | "identity_geometry_to_quantized_plan" | "quantized_plan_to_rendered_atlas" | "none";
}

export interface HeadPixelDifference {
  changedHeadPixels: number;
  changedBasePixels: number;
  changedOuterPixels: number;
  silhouetteChangedPixels: number;
  hairlineChangedPixels: number;
  faceWindowChangedPixels: number;
  textureOnlyChangedPixels: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function minimumMaskRow(plan: HairPlan): number {
  const points = Object.values(plan.headMask.faces).flat();
  return points.length === 0 ? 0 : Math.min(...points.map((point) => point.y));
}

export function measureHairSilhouetteSignature(
  plan: HairPlan,
  facePlan: FacePixelPlan,
): HairSilhouetteSignature {
  const majorKinds = plan.texture === "curly"
    ? new Set(["curl_lobe"])
    : plan.texture === "coily"
      ? new Set(["coily_cluster"])
      : new Set(["side_lock", "crown_flow", "fringe"]);
  const majorGroups = plan.structure.groups.filter((group) => majorKinds.has(group.kind));
  const majorGroupCount = plan.texture === "curly" || plan.texture === "coily"
    ? majorGroups.length
    : Number(majorGroups.some((group) => group.kind === "fringe")) +
      majorGroups.filter((group) => group.kind === "side_lock").length +
      majorGroups.filter((group) => group.kind === "crown_flow").length;
  const pairedRows = plan.headMask.widthByRow.left.map((left, index) =>
    Math.abs(left - plan.headMask.widthByRow.right[index]) / 8,
  );
  return {
    texture: plan.texture,
    crownRow: minimumMaskRow(plan),
    fringeDepthByColumn: [...facePlan.layout.hairlineDepthByColumn],
    sideWidthsLeft: [...plan.headMask.widthByRow.left],
    sideWidthsRight: [...plan.headMask.widthByRow.right],
    sideWidthsBack: [...plan.headMask.widthByRow.back],
    partColumn: plan.headMask.partColumn,
    endpointLeft: plan.headMask.endpointRows.left,
    endpointRight: plan.headMask.endpointRows.right,
    earExposureLeft: plan.headMask.earExposure.left,
    earExposureRight: plan.headMask.earExposure.right,
    majorGroupCount,
    asymmetry: mean(pairedRows),
  };
}

function expectedMajorGroups(analysis: PhotoAnalysis): number {
  if (analysis.renderHints.hairTexture === "curly") {
    const measured = analysis.identityGeometry?.majorVolumePeaks.filter((peak) => peak.evidence !== "unknown" && peak.confidence >= 0.55) ?? [];
    if (measured.length > 0) return measured.length;
    const silhouette = analysis.identityGeometry?.headSilhouette;
    if (!silhouette) return 4;
    return 4 + Number(silhouette.hairEndpointLeftY * 7 >= 5 && silhouette.sideVolumeLeft >= 0.55) + Number(silhouette.hairEndpointRightY * 7 >= 5 && silhouette.sideVolumeRight >= 0.55);
  }
  if (analysis.renderHints.hairTexture === "coily") return 4;
  const sideLocks = analysis.renderHints.sideHairLength === "none" || analysis.renderHints.sideHairLength === "short" ? 0 : 2;
  return 2 + sideLocks + (analysis.renderHints.bangs === "none" ? 0 : 1);
}

function clampRetention(error: number): number {
  return Math.max(0, Math.min(1, 1 - error));
}

function outerOccupancy(atlas: RawImage): Record<HeadMaskFace, number> {
  return Object.fromEntries((Object.keys(CLASSIC_LAYOUT.head.overlay) as Array<keyof typeof CLASSIC_LAYOUT.head.overlay>)
    .filter((face): face is HeadMaskFace => ["front", "top", "left", "right", "back"].includes(face))
    .map((face) => {
      const rect = CLASSIC_LAYOUT.head.overlay[face];
      let opaque = 0;
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        if (atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3] >= 128) opaque++;
      }
      return [face, opaque / (rect.w * rect.h)];
    })) as Record<HeadMaskFace, number>;
}

/** Diagnose where source hair identity is lost; this is not an evaluator score. */
export function measureHeadIdentityRetention(
  analysis: PhotoAnalysis,
  plan: HairPlan,
  facePlan: FacePixelPlan,
  atlas?: RawImage,
): HeadIdentityRetention {
  const flow = measureHairInformationFlow(analysis, plan, facePlan, atlas);
  const geometry = analysis.identityGeometry;
  const silhouette = geometry?.headSilhouette;
  const sourceSideVolumeError = silhouette ? mean([
    Math.abs(mean(plan.headMask.widthByRow.left) / 5 - silhouette.sideVolumeLeft),
    Math.abs(mean(plan.headMask.widthByRow.right) / 5 - silhouette.sideVolumeRight),
  ]) : 1;
  const templeRows = plan.structure.fringe.templeTransitionPoints;
  const expectedTempleRows = silhouette ? [
    Math.min(plan.headMask.endpointRows.left, 2 + Math.round((1 - silhouette.earExposureLeft) * 3)),
    Math.min(plan.headMask.endpointRows.right, 2 + Math.round((1 - silhouette.earExposureRight) * 3)),
  ] : [];
  const templeError = expectedTempleRows.length === 2 && templeRows.length === 2
    ? mean(expectedTempleRows.map((expected, index) => Math.abs(expected - templeRows[index].y) / 7))
    : silhouette ? 1 : 0.5;
  const expectedGroups = expectedMajorGroups(analysis);
  const actualGroups = flow.signature.majorGroupCount;
  const textureGroupError = Math.min(1, Math.abs(expectedGroups - actualGroups) / Math.max(1, expectedGroups));
  const layout = facePlan.layout;
  const peakError = geometry && geometry.fringe.peaks.length > 0
    ? mean(geometry.fringe.peaks.map((peak) => {
        const nearest = layout.fringePeaks.reduce<{ column: number; row: number; prominence: number } | null>((best, candidate) => !best || Math.abs(candidate.column / 7 - peak.x) < Math.abs(best.column / 7 - peak.x) ? candidate : best, null);
        return nearest ? mean([Math.abs(nearest.column / 7 - peak.x), Math.abs(nearest.row / 3 - peak.depthY)]) : 1;
      }).concat(Math.abs(geometry.fringe.peaks.length - layout.fringePeaks.length) / 3))
    : geometry?.fringe.visible ? 1 : 0;
  const templeRecessionError = geometry ? mean([
    Math.abs(layout.templeGeometry.leftRecession / 3 - geometry.temple.leftRecession),
    Math.abs(layout.templeGeometry.rightRecession / 3 - geometry.temple.rightRecession),
    Math.abs(layout.templeGeometry.leftStartRow / 7 - geometry.temple.leftStartY),
    Math.abs(layout.templeGeometry.rightStartRow / 7 - geometry.temple.rightStartY),
  ]) : 1;
  const crownContourError = geometry ? mean([
    Math.abs(layout.crownGeometry.leftRow / 7 - geometry.crown.leftY),
    Math.abs(layout.crownGeometry.centerRow / 7 - geometry.crown.centerY),
    Math.abs(layout.crownGeometry.rightRow / 7 - geometry.crown.rightY),
    Math.abs(layout.crownGeometry.apexColumn / 7 - geometry.crown.apexX),
  ]) : 1;
  const faceWindowError = geometry ? mean([
    Math.abs(layout.faceWindow.foreheadRows / 4 - geometry.faceWindow.foreheadHeight),
    Math.abs(layout.faceWindow.leftTempleWidth / 3 - geometry.faceWindow.leftTempleWidth),
    Math.abs(layout.faceWindow.rightTempleWidth / 3 - geometry.faceWindow.rightTempleWidth),
    Math.abs(layout.faceWindow.leftEarExposure - geometry.faceWindow.leftEarExposure),
    Math.abs(layout.faceWindow.rightEarExposure - geometry.faceWindow.rightEarExposure),
  ]) : 1;
  const eyeToHairError = geometry ? mean([
    Math.abs(layout.faceWindow.leftEyeToHairRows / 7 - geometry.faceWindow.leftEyeToHairDistance),
    Math.abs(layout.faceWindow.rightEyeToHairRows / 7 - geometry.faceWindow.rightEyeToHairDistance),
  ]) : 1;
  const faceWidthError = geometry ? mean([
    Math.abs(layout.faceWindow.visibleWidthAtEyes / 8 - geometry.faceWindow.visibleFaceWidthAtEyes),
    Math.abs(layout.faceWindow.visibleWidthAtCheeks / 8 - geometry.faceWindow.visibleFaceWidthAtCheeks),
    Math.abs(layout.faceShape.upperWidth / 8 - geometry.faceShape.upperWidth),
    Math.abs(layout.faceShape.jawWidth / 8 - geometry.faceShape.jawWidth),
  ]) : 1;
  const volumePeakError = geometry && geometry.majorVolumePeaks.length > 0
    ? mean(geometry.majorVolumePeaks.map((peak) => {
        const quantized = layout.majorVolumePeaks.find((candidate) => candidate.region === peak.region);
        return quantized ? mean([
          Math.abs(quantized.row / 7 - peak.verticalCenter),
          Math.abs((quantized.height - 1) / 3 - peak.verticalExtent),
          Math.abs(quantized.protrusion - peak.protrusion),
        ]) : 1;
      }))
    : geometry ? 0 : 1;
  const metrics = {
    crownRetention: clampRetention(flow.errors.crown),
    fringeRetention: clampRetention(flow.errors.fringe),
    templeRetention: clampRetention(templeError),
    sideVolumeRetention: clampRetention(sourceSideVolumeError),
    partRetention: clampRetention(flow.errors.part),
    earExposureRetention: clampRetention(flow.errors.earExposure),
    asymmetryRetention: clampRetention(flow.errors.asymmetry),
    textureGroupRetention: clampRetention(textureGroupError),
    fringePeakRetention: clampRetention(peakError),
    templeRecessionRetention: clampRetention(templeRecessionError),
    crownContourRetention: clampRetention(crownContourError),
    faceWindowRetention: clampRetention(faceWindowError),
    eyeToHairDistanceRetention: clampRetention(eyeToHairError),
    faceWidthRetention: clampRetention(faceWidthError),
    majorVolumePeakRetention: clampRetention(volumePeakError),
  };
  const evidenceWeight = (value: "observed" | "inferred" | "unknown") => value === "observed" ? 1 : value === "inferred" ? 0.7 : 0;
  const geometryConfidence = geometry ? mean([
    geometry.fringe.confidence * evidenceWeight(geometry.fringe.evidence),
    geometry.temple.confidence * mean([evidenceWeight(geometry.temple.leftEvidence), evidenceWeight(geometry.temple.rightEvidence)]),
    geometry.crown.confidence * evidenceWeight(geometry.crown.evidence),
    geometry.faceWindow.confidence * mean([evidenceWeight(geometry.faceWindow.leftEvidence), evidenceWeight(geometry.faceWindow.rightEvidence)]),
    geometry.faceShape.confidence * evidenceWeight(geometry.faceShape.evidence),
    ...geometry.majorVolumePeaks.map((peak) => peak.confidence * evidenceWeight(peak.evidence)),
  ]) : 0;
  const planRetention = mean(Object.values(metrics));
  const atlasStats = atlas ? atlasMaskStats(atlas, plan) : null;
  const atlasRetention = atlasStats?.fidelity ?? 1;
  const geometryLoss = 1 - geometryConfidence;
  const planLoss = 1 - planRetention;
  const atlasLoss = 1 - atlasRetention;
  const maximumLoss = Math.max(geometryLoss, planLoss, atlasLoss);
  const largestLossStage = maximumLoss <= 0.04
    ? "none"
    : maximumLoss === geometryLoss
      ? "source_analysis_to_geometry"
      : maximumLoss === planLoss
        ? "identity_geometry_to_quantized_plan"
        : "quantized_plan_to_rendered_atlas";
  return {
    source: { texture: plan.texture, saliencePrimary: [...plan.salience.primary] },
    geometry,
    quantizedPlan: flow.signature,
    renderedAtlas: {
      expectedOuterPixels: atlasStats?.expected ?? new Set([
        ...Object.entries(plan.headMask.faces).flatMap(([face, points]) => points.map((point) => `${face}:${point.x},${point.y}`)),
        ...plan.structure.groups.flatMap((group) => group.points.filter((point) => point.layer === "outer").map((point) => `${point.face}:${point.x},${point.y}`)),
      ]).size,
      retainedOuterPixels: atlasStats?.retained ?? null,
      actualOuterPixels: atlasStats?.actual ?? null,
      planToAtlasFidelity: atlasStats?.fidelity ?? null,
      outerOccupancyByFace: atlas ? outerOccupancy(atlas) : null,
    },
    metrics,
    stageRetention: { sourceToGeometry: geometryConfidence, geometryToPlan: planRetention, planToAtlas: atlasStats?.fidelity ?? null },
    largestLossStage,
  };
}

function pixelChanged(first: RawImage, second: RawImage, x: number, y: number): boolean {
  const offset = (y * ATLAS_SIZE + x) * 4;
  return first.rgba[offset] !== second.rgba[offset] || first.rgba[offset + 1] !== second.rgba[offset + 1] || first.rgba[offset + 2] !== second.rgba[offset + 2] || first.rgba[offset + 3] !== second.rgba[offset + 3];
}

export function measureHeadPixelDifference(before: RawImage, after: RawImage, facePlan?: FacePixelPlan): HeadPixelDifference {
  const result: HeadPixelDifference = {
    changedHeadPixels: 0,
    changedBasePixels: 0,
    changedOuterPixels: 0,
    silhouetteChangedPixels: 0,
    hairlineChangedPixels: 0,
    faceWindowChangedPixels: 0,
    textureOnlyChangedPixels: 0,
  };
  for (const layer of ["base", "overlay"] as const) {
    const faces = CLASSIC_LAYOUT.head[layer];
    for (const [face, rect] of Object.entries(faces)) {
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const atlasX = rect.x + x;
        const atlasY = rect.y + y;
        if (!pixelChanged(before, after, atlasX, atlasY)) continue;
        result.changedHeadPixels++;
        if (layer === "base") result.changedBasePixels++;
        else result.changedOuterPixels++;
        const offset = (atlasY * ATLAS_SIZE + atlasX) * 4;
        const alphaChanged = before.rgba[offset + 3] !== after.rgba[offset + 3];
        if (layer === "overlay" && alphaChanged) result.silhouetteChangedPixels++;
        if (face === "front" && y <= 4) result.hairlineChangedPixels++;
        if (layer === "base" && face === "front" && facePlan) {
          const window = facePlan.layout.faceWindow;
          const visibleWidth = y <= facePlan.layout.eyeRow
            ? window.visibleWidthAtEyes
            : window.visibleWidthAtCheeks;
          const left = Math.floor((8 - visibleWidth) / 2);
          if (y >= window.foreheadRows && x >= left && x < left + visibleWidth) {
            result.faceWindowChangedPixels++;
          }
        }
        if (!alphaChanged) result.textureOnlyChangedPixels++;
      }
    }
  }
  return result;
}

function atlasMaskStats(atlas: RawImage, plan: HairPlan): { expected: number; retained: number; actual: number; fidelity: number } {
  const expectedKeys = new Set<string>();
  // A semantic fallback mask describes the coarse renderer template, not a
  // source-measured geometry contract. Only require exact mask occupancy when
  // the identity geometry path owns it; reliable structure points are always
  // part of the source-to-atlas contract.
  if (plan.headMask.source === "identity_geometry") {
    for (const face of Object.keys(plan.headMask.faces) as HeadMaskFace[]) {
      for (const point of plan.headMask.faces[face]) expectedKeys.add(`${face}:${point.x},${point.y}`);
    }
  }
  for (const group of plan.structure.groups) for (const point of group.points) {
    if (point.layer === "outer") expectedKeys.add(`${point.face}:${point.x},${point.y}`);
  }
  let retained = 0;
  let actual = 0;
  for (const face of Object.keys(plan.headMask.faces) as HeadMaskFace[]) {
    const rect = CLASSIC_LAYOUT.head.overlay[face];
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const alpha = atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3];
      if (alpha < 128) continue;
      actual++;
      if (expectedKeys.has(`${face}:${x},${y}`)) retained++;
    }
  }
  const recall = expectedKeys.size === 0 ? 1 : retained / expectedKeys.size;
  return {
    expected: expectedKeys.size,
    retained,
    actual,
    fidelity: recall,
  };
}

function atlasMaskRetention(atlas: RawImage, plan: HairPlan): number {
  return atlasMaskStats(atlas, plan).fidelity;
}

export function measureHairInformationFlow(
  analysis: PhotoAnalysis,
  plan: HairPlan,
  facePlan: FacePixelPlan,
  atlas?: RawImage,
): HairInformationFlow {
  const signature = measureHairSilhouetteSignature(plan, facePlan);
  const geometry = analysis.identityGeometry?.headSilhouette;
  if (!geometry) {
    return {
      sourceToPlanRetention: 0,
      planToAtlasRetention: atlas ? atlasMaskRetention(atlas, plan) : null,
      errors: { crown: 1, sideExtent: 1, part: 1, fringe: 1, earExposure: 1, groupStructure: 1, asymmetry: 1 },
      signature,
    };
  }
  const crown = Math.abs(signature.crownRow - geometry.crownTopY * 7) / 7;
  const sideExtent = mean([
    Math.abs(signature.endpointLeft / 7 - geometry.hairEndpointLeftY),
    Math.abs(signature.endpointRight / 7 - geometry.hairEndpointRightY),
    Math.abs(mean(signature.sideWidthsLeft) / 5 - geometry.sideVolumeLeft),
    Math.abs(mean(signature.sideWidthsRight) / 5 - geometry.sideVolumeRight),
  ].map((value) => Math.min(1, value)));
  const part = geometry.partCenterX === null
    ? signature.partColumn === null ? 0 : 1
    : signature.partColumn === null ? 1 : Math.abs(signature.partColumn / 7 - geometry.partCenterX);
  const fringe = mean(signature.fringeDepthByColumn.map((depth, index) =>
    Math.min(1, Math.abs(depth / 3 - analysis.identityGeometry!.hairline.depthByColumn[index])),
  ));
  const earExposure = mean([
    Math.abs(signature.earExposureLeft - geometry.earExposureLeft),
    Math.abs(signature.earExposureRight - geometry.earExposureRight),
  ]);
  const groupStructure = Math.min(1, Math.abs(signature.majorGroupCount - expectedMajorGroups(analysis)) / 4);
  const sourceAsymmetry = Math.abs(geometry.sideVolumeLeft - geometry.sideVolumeRight);
  const asymmetry = Math.min(1, Math.abs(signature.asymmetry - sourceAsymmetry));
  const errors = { crown, sideExtent, part, fringe, earExposure, groupStructure, asymmetry };
  const weightedError =
    crown * 0.12 +
    sideExtent * 0.24 +
    part * 0.13 +
    fringe * 0.2 +
    earExposure * 0.1 +
    groupStructure * 0.13 +
    asymmetry * 0.08;
  return {
    sourceToPlanRetention: Math.max(0, 1 - weightedError),
    planToAtlasRetention: atlas ? atlasMaskRetention(atlas, plan) : null,
    errors,
    signature,
  };
}

function signatureKey(signature: HairSilhouetteSignature): string {
  return JSON.stringify({
    crown: signature.crownRow,
    fringe: signature.fringeDepthByColumn,
    left: signature.sideWidthsLeft,
    right: signature.sideWidthsRight,
    back: signature.sideWidthsBack,
    part: signature.partColumn,
    endpoints: [signature.endpointLeft, signature.endpointRight],
    groups: signature.majorGroupCount,
  });
}

export function findHairQuantizationCollisions(
  samples: Array<{ id: string; plan: HairPlan; facePlan: FacePixelPlan }>,
): Array<{ texture: HairPlan["texture"]; ids: string[]; signature: string }> {
  const buckets = new Map<string, { texture: HairPlan["texture"]; ids: string[]; signature: string }>();
  for (const sample of samples) {
    const measured = measureHairSilhouetteSignature(sample.plan, sample.facePlan);
    const signature = signatureKey(measured);
    const key = `${sample.plan.texture}:${signature}`;
    const bucket = buckets.get(key) ?? { texture: sample.plan.texture, ids: [], signature };
    bucket.ids.push(sample.id);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].filter((bucket) => bucket.ids.length > 1);
}

export function meaningfulHairDifferenceAxes(
  first: HairSilhouetteSignature,
  second: HairSilhouetteSignature,
): string[] {
  const axes: string[] = [];
  if (first.crownRow !== second.crownRow) axes.push("crown");
  if (JSON.stringify(first.fringeDepthByColumn) !== JSON.stringify(second.fringeDepthByColumn)) axes.push("fringe_profile");
  if (JSON.stringify(first.sideWidthsLeft) !== JSON.stringify(second.sideWidthsLeft) || JSON.stringify(first.sideWidthsRight) !== JSON.stringify(second.sideWidthsRight)) axes.push("side_silhouette");
  if (first.partColumn !== second.partColumn) axes.push("part");
  if (first.endpointLeft !== second.endpointLeft || first.endpointRight !== second.endpointRight) axes.push("endpoint");
  if (first.majorGroupCount !== second.majorGroupCount) axes.push("group_structure");
  return axes;
}
