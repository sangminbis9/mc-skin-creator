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
  const majorGroupCount = plan.structure.groups.filter((group) => majorKinds.has(group.kind)).length;
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
  if (analysis.renderHints.hairTexture === "curly") return 4;
  if (analysis.renderHints.hairTexture === "coily") return 4;
  const sideLocks = analysis.renderHints.sideHairLength === "none" || analysis.renderHints.sideHairLength === "short" ? 0 : 2;
  return 2 + sideLocks + (analysis.renderHints.bangs === "none" ? 0 : 1);
}

function atlasMaskRetention(atlas: RawImage, plan: HairPlan): number {
  let expected = 0;
  let present = 0;
  for (const face of Object.keys(plan.headMask.faces) as HeadMaskFace[]) {
    const rect = CLASSIC_LAYOUT.head.overlay[face];
    for (const point of plan.headMask.faces[face]) {
      expected++;
      const alpha = atlas.rgba[((rect.y + point.y) * ATLAS_SIZE + rect.x + point.x) * 4 + 3];
      if (alpha >= 128) present++;
    }
  }
  return expected === 0 ? 1 : present / expected;
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
