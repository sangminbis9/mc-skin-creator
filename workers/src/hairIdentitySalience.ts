import type { PhotoAnalysis } from "./analysis";

export type HairIdentityAxis =
  | "fringe_shape"
  | "temple_exposure"
  | "ear_exposure"
  | "crown_volume"
  | "side_volume"
  | "part_position"
  | "crown_asymmetry"
  | "endpoint_height"
  | "curl_lobes"
  | "internal_texture";

export interface HairIdentitySalienceCue {
  axis: HairIdentityAxis;
  score: number;
  evidence: string;
}

/** Source-conditioned ordering for spending the small 8x8 head pixel budget. */
export interface HairIdentitySaliencePlan {
  source: "identity_geometry" | "semantic_analysis";
  cues: HairIdentitySalienceCue[];
  primary: HairIdentityAxis[];
  secondary: HairIdentityAxis[];
  tertiary: HairIdentityAxis[];
  pixelBudget: {
    silhouette: number;
    fringe: number;
    faceWindow: number;
    internalTexture: number;
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function spread(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

export function hairSalienceScore(plan: HairIdentitySaliencePlan, axis: HairIdentityAxis): number {
  return plan.cues.find((cue) => cue.axis === axis)?.score ?? 0;
}

export function buildHairIdentitySaliencePlan(analysis: PhotoAnalysis): HairIdentitySaliencePlan {
  const geometry = analysis.identityGeometry;
  const silhouette = geometry?.headSilhouette;
  const hairline = geometry?.hairline;
  const hairPriority = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "hair" || feature.category === "silhouette")
    .reduce((maximum, feature) => Math.max(maximum, feature.priority / 5), 0.35);
  const textureStrength = analysis.renderHints.hairTexture === "coily"
    ? 1
    : analysis.renderHints.hairTexture === "curly"
      ? 0.92
      : analysis.renderHints.hairTexture === "wavy"
        ? 0.58
        : 0.22;
  const measuredFringe = geometry?.fringe.evidence === "observed" && geometry.fringe.confidence >= 0.55
    ? geometry.fringe
    : null;
  const hasFringe = measuredFringe ? measuredFringe.visible : analysis.renderHints.bangs !== "none" && analysis.renderHints.bangsLength !== "none";
  const semanticFringeStrength = !hasFringe
    ? 0
    : analysis.renderHints.bangsLength === "eye"
      ? 1
      : analysis.renderHints.bangsLength === "brow"
        ? 0.82
        : 0.56;
  const fringeVariation = measuredFringe?.peaks.length
    ? Math.max(spread(hairline?.depthByColumn ?? []), ...measuredFringe.peaks.map((peak) => peak.prominence))
    : hairline ? spread(hairline.depthByColumn) : analysis.renderHints.fringeEdge === "blunt" ? 0.18 : 0.45;
  const fringeAsymmetry = measuredFringe
    ? measuredFringe.direction === "left_swept" || measuredFringe.direction === "right_swept" ? 0.7 : measuredFringe.direction === "split" ? 0.4 : Math.abs(hairline?.asymmetry ?? 0)
    : hairline ? Math.abs(hairline.asymmetry) : analysis.renderHints.bangs === "side" ? 0.65 : 0;
  const meanDepth = hairline ? mean(hairline.depthByColumn) : semanticFringeStrength * 0.55;
  const sideAsymmetry = silhouette
    ? mean([
        Math.abs(silhouette.sideVolumeLeft - silhouette.sideVolumeRight),
        Math.abs(silhouette.hairEndpointLeftY - silhouette.hairEndpointRightY),
        Math.abs((silhouette.earExposureLeft - silhouette.earExposureRight) * 0.8),
      ])
    : analysis.renderHints.sideHairAsymmetry === "none" ? 0 : 0.62;
  const measuredTempleAsymmetry = geometry && geometry.temple.confidence >= 0.55 &&
    geometry.temple.leftEvidence === "observed" && geometry.temple.rightEvidence === "observed"
    ? Math.abs(geometry.temple.asymmetry)
    : 0;
  const sideVolume = silhouette
    ? mean([silhouette.sideVolumeLeft, silhouette.sideVolumeRight])
    : analysis.renderHints.hairVolume === "full" ? 0.85 : analysis.renderHints.hairVolume === "flat" ? 0.2 : 0.5;
  const earDistinctiveness = silhouette
    ? mean([
        Math.abs(silhouette.earExposureLeft - 0.5) * 2,
        Math.abs(silhouette.earExposureRight - 0.5) * 2,
        Math.abs(silhouette.earExposureLeft - silhouette.earExposureRight),
      ])
    : analysis.renderHints.earExposure === "partial" ? 0.45 : 0.72;
  const crownContourVariation = silhouette
    ? mean([
        spread(silhouette.leftContourByRow.slice(0, 5)),
        spread(silhouette.rightContourByRow.slice(0, 5)),
      ])
    : textureStrength * 0.5;
  const measuredCrown = geometry?.crown.evidence === "observed" && geometry.crown.confidence >= 0.55 ? geometry.crown : null;
  const crownHeight = measuredCrown
    ? 1 - mean([measuredCrown.leftY, measuredCrown.centerY, measuredCrown.rightY])
    : silhouette ? 1 - silhouette.crownTopY : analysis.renderHints.hairVolume === "full" ? 0.88 : 0.55;
  const crownAsymmetry = measuredCrown ? Math.max(Math.abs(measuredCrown.asymmetry), spread([measuredCrown.leftY, measuredCrown.centerY, measuredCrown.rightY])) : sideAsymmetry;
  const measuredVolumeStrength = geometry?.majorVolumePeaks.length
    ? mean(geometry.majorVolumePeaks.filter((peak) => peak.evidence === "observed" && peak.confidence >= 0.55).map((peak) => peak.protrusion))
    : 0;
  const hasPart = silhouette?.partCenterX !== null || analysis.renderHints.hairPart !== "none";
  const partOffset = silhouette?.partCenterX === null || silhouette?.partCenterX === undefined
    ? analysis.renderHints.hairPart === "center" ? 0.25 : hasPart ? 0.65 : 0
    : Math.abs(silhouette.partCenterX - 0.5) * 2;
  const endpointDistinctiveness = silhouette
    ? Math.max(
        Math.abs(mean([silhouette.hairEndpointLeftY, silhouette.hairEndpointRightY]) - 0.5) * 1.5,
        Math.abs(silhouette.hairEndpointLeftY - silhouette.hairEndpointRightY),
      )
    : ["chest", "waist", "hip"].includes(analysis.renderHints.overallHairLength) ? 0.9 : 0.45;

  const entries: Array<[HairIdentityAxis, number, string]> = [
    ["fringe_shape", hasFringe ? 0.3 + semanticFringeStrength * 0.35 + meanDepth * 0.2 + Math.max(fringeVariation, fringeAsymmetry) * 0.15 : 0.04, "measured depth/edge/opening and semantic fringe class"],
    ["temple_exposure", clamp01(0.28 + earDistinctiveness * 0.3 + Math.max(sideAsymmetry, measuredTempleAsymmetry) * 0.42), "measured recession, start height and left-right transition"],
    ["ear_exposure", clamp01(0.18 + earDistinctiveness * 0.62 + sideAsymmetry * 0.2), "distance from neutral ear exposure"],
    ["crown_volume", clamp01(0.25 + crownHeight * 0.3 + Math.max(sideVolume, measuredVolumeStrength) * 0.27 + crownContourVariation * 0.18), "left/center/right crown height, apex and width"],
    ["side_volume", clamp01(0.2 + Math.max(sideVolume, measuredVolumeStrength) * 0.5 + sideAsymmetry * 0.3), "measured major volume peaks and imbalance"],
    ["part_position", hasPart ? clamp01(0.48 + partOffset * 0.42 + fringeAsymmetry * 0.1) : 0.08, "visible root part and its offset from centre"],
    ["crown_asymmetry", clamp01(0.12 + crownAsymmetry * 0.56 + fringeAsymmetry * 0.2 + crownContourVariation * 0.12), "measured left/center/right crown imbalance"],
    ["endpoint_height", clamp01(0.24 + endpointDistinctiveness * 0.66 + sideAsymmetry * 0.1), "lowest substantial left/right hair endpoints"],
    ["curl_lobes", clamp01(textureStrength * (0.5 + sideVolume * 0.25 + crownContourVariation * 0.15 + sideAsymmetry * 0.1)), "texture class plus measured contour peaks and side mass"],
    ["internal_texture", clamp01(0.12 + textureStrength * 0.55 + crownContourVariation * 0.12), "directional texture after silhouette allocation"],
  ];
  const cues = entries
    .map(([axis, rawScore, evidence]) => ({ axis, score: Number(clamp01(rawScore * (0.72 + hairPriority * 0.28)).toFixed(4)), evidence }))
    .sort((first, second) => second.score - first.score || first.axis.localeCompare(second.axis));
  const primaryCutoff = Math.max(2, cues.filter((cue) => cue.score >= cues[0].score - 0.08).length);
  const primary = cues.slice(0, Math.min(3, primaryCutoff)).map((cue) => cue.axis);
  const secondary = cues.slice(primary.length, primary.length + 4).map((cue) => cue.axis);
  const tertiary = cues.slice(primary.length + secondary.length).map((cue) => cue.axis);
  const score = (axis: HairIdentityAxis) => cues.find((cue) => cue.axis === axis)?.score ?? 0;
  const silhouetteScore = mean([score("crown_volume"), score("side_volume"), score("crown_asymmetry"), score("endpoint_height")]);
  const faceWindowScore = mean([score("temple_exposure"), score("ear_exposure"), score("part_position")]);
  return {
    source: geometry ? "identity_geometry" : "semantic_analysis",
    cues,
    primary,
    secondary,
    tertiary,
    pixelBudget: {
      silhouette: Math.round(8 + silhouetteScore * 12),
      fringe: hasFringe ? Math.round(3 + score("fringe_shape") * 8) : 0,
      faceWindow: Math.round(3 + faceWindowScore * 6),
      internalTexture: Math.round(2 + score("internal_texture") * 7),
    },
  };
}
