import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildHairIdentitySaliencePlan } from "../src/hairIdentitySalience";
import { measureHeadIdentityRetention, measureHeadPixelDifference } from "../src/hairSilhouetteFidelity";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { quantizeHairlineProfile } from "../src/identityQuantization";
import type { RawImage } from "../src/png";
import { applyHeadIdentityPlan, applyHeadMaskPlan, type FaceStyle } from "../src/skinPack";
import { ATLAS_SIZE } from "../src/uvLayout";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function analysisWith(
  texture: PhotoAnalysis["renderHints"]["hairTexture"],
  geometry: ReturnType<typeof makeIdentityGeometry>,
  renderHints: Partial<PhotoAnalysis["renderHints"]> = {},
): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    identityGeometry: geometry,
    fallbackFeatures: { ...base.fallbackFeatures, hairstyle: texture === "curly" ? "curly" : texture === "coily" ? "afro" : "short" },
    observed: { ...base.observed, hair: `${texture} source-measured hair` },
    renderHints: { ...base.renderHints, hairTexture: texture, ...renderHints },
  });
}

function blankAtlas(): RawImage {
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4) };
}

const style: FaceStyle = {
  eyeColor: "#332211",
  glassesColor: "#777777",
  eyebrowThickness: "normal",
  expression: "smile",
  facialHair: "none",
  glasses: "none",
  hairstyle: "short",
  hat: "none",
};

describe("source-conditioned hair identity allocation", () => {
  it("changes primary pixel-budget cues with source geometry instead of using one priority table", () => {
    const fringeGeometry = makeIdentityGeometry({
      hairline: { depthByColumn: [0.18, 0.3, 0.55, 0.78, 0.7, 0.36, 0.2, 0.12], foreheadOpeningLeft: 0.08, foreheadOpeningRight: 0.08, asymmetry: 0.68 },
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.3, sideVolumeRight: 0.28, earExposureLeft: 0.82, earExposureRight: 0.78 },
    });
    const curlGeometry = makeIdentityGeometry({
      hairline: { depthByColumn: [0.08, 0.1, 0.12, 0.1, 0.1, 0.12, 0.1, 0.08], foreheadOpeningLeft: 0.42, foreheadOpeningRight: 0.58, asymmetry: 0.02 },
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.92, sideVolumeRight: 0.7, hairEndpointLeftY: 0.9, hairEndpointRightY: 0.82 },
    });
    const fringe = buildHairIdentitySaliencePlan(analysisWith("straight", fringeGeometry, { bangs: "side", bangsLength: "eye", fringeOpening: "none", hairPart: "right" }));
    const curls = buildHairIdentitySaliencePlan(analysisWith("curly", curlGeometry, { bangs: "none", bangsLength: "none", fringeOpening: "none", hairVolume: "full", overallHairLength: "jaw", sideHairLength: "jaw" }));
    expect(fringe.primary).toContain("fringe_shape");
    expect(curls.primary).toContain("curl_lobes");
    expect(curls.cues.find((cue) => cue.axis === "side_volume")!.score).toBeGreaterThan(curls.cues.find((cue) => cue.axis === "fringe_shape")!.score);
    expect(fringe.primary).not.toEqual(curls.primary);
    expect(fringe.pixelBudget.fringe).toBeGreaterThan(curls.pixelBudget.fringe);
    expect(curls.pixelBudget.silhouette).toBeGreaterThan(fringe.pixelBudget.silhouette);
  });

  it("uses accumulated high-salience residual to separate colliding fringe depths deterministically", () => {
    const base = makeAnalysis();
    const shallow = makeAnalysis({ renderHints: { ...base.renderHints, bangs: "side", bangsLength: "brow", fringeOpening: "none" } });
    const deep = makeAnalysis({ renderHints: { ...base.renderHints, bangs: "side", bangsLength: "brow", fringeOpening: "none" } });
    const first = quantizeHairlineProfile(shallow, Array(8).fill(0.29));
    const second = quantizeHairlineProfile(deep, Array(8).fill(0.41));
    expect(first).not.toEqual(second);
    expect(second.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(first.reduce((sum, value) => sum + value, 0));
    expect(quantizeHairlineProfile(deep, Array(8).fill(0.41))).toEqual(second);
  });

  it("keeps explicit fringe openings and makes temple/ear exposure affect real structure", () => {
    const baseGeometry = makeIdentityGeometry();
    const exposed = buildIdentityPixelPlans(analysisWith("straight", makeIdentityGeometry({
      headSilhouette: { ...baseGeometry.headSilhouette, earExposureLeft: 0.9, earExposureRight: 0.85, hairEndpointLeftY: 0.7, hairEndpointRightY: 0.7 },
      temple: { ...baseGeometry.temple, leftRecession: 0.82, rightRecession: 0.76, leftStartY: 0.18, rightStartY: 0.2 },
    }), { fringeOpening: "center", sideHairLength: "short" }));
    const covered = buildIdentityPixelPlans(analysisWith("straight", makeIdentityGeometry({
      headSilhouette: { ...baseGeometry.headSilhouette, earExposureLeft: 0.05, earExposureRight: 0.1, hairEndpointLeftY: 0.7, hairEndpointRightY: 0.7 },
      temple: { ...baseGeometry.temple, leftRecession: 0.08, rightRecession: 0.12, leftStartY: 0.64, rightStartY: 0.62 },
    }), { fringeOpening: "center", sideHairLength: "short" }));
    expect(exposed.hairPlan.structure.fringe.openingColumns).toEqual([3, 4]);
    expect(exposed.hairPlan.structure.fringe.tipPoints.every((point) => point.x !== 3 && point.x !== 4)).toBe(true);
    const exposedTemples = exposed.hairPlan.structure.fringe.templeTransitionPoints.map((point) => point.y);
    const coveredTemples = covered.hairPlan.structure.fringe.templeTransitionPoints.map((point) => point.y);
    expect(Math.max(...exposedTemples)).toBeLessThan(Math.max(...coveredTemples));
  });

  it("breaks the generic short cap with measured base fringe, sparse outer tips and side foundation", () => {
    const geometry = makeIdentityGeometry({
      hairline: { depthByColumn: [0.2, 0.32, 0.62, 0.76, 0.58, 0.35, 0.18, 0.1], foreheadOpeningLeft: 0.08, foreheadOpeningRight: 0.08, asymmetry: 0.58 },
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.5, sideVolumeRight: 0.3, earExposureLeft: 0.55, earExposureRight: 0.78, hairEndpointLeftY: 0.58, hairEndpointRightY: 0.5 },
    });
    const plan = buildIdentityPixelPlans(analysisWith("straight", geometry, { bangs: "side", bangsLength: "brow", fringeOpening: "none", hairPart: "right", sideHairAsymmetry: "left", overallHairLength: "ear", sideHairLength: "short" }));
    const fringe = plan.hairPlan.structure;
    expect(fringe.groups.some((group) => group.id.startsWith("fringe-base-") && group.points.every((point) => point.layer === "base"))).toBe(true);
    expect(fringe.fringe.tipPoints.length).toBeGreaterThanOrEqual(2);
    expect(fringe.fringe.tipPoints.length).toBeLessThanOrEqual(4);
    expect(fringe.groups.some((group) => group.id === "foundation-left")).toBe(true);
    expect(plan.hairPlan.headMask.widthByRow.left).not.toEqual(plan.hairPlan.headMask.widthByRow.right);
  });

  it("derives curly lobe dimensions and count from each source contour", () => {
    const compactGeometry = makeIdentityGeometry({
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.45, sideVolumeRight: 0.43, hairEndpointLeftY: 0.58, hairEndpointRightY: 0.58 },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.46, verticalCenter: 0.18, verticalExtent: 0.2, evidence: "observed", confidence: 0.9 },
        { region: "side_right", protrusion: 0.43, verticalCenter: 0.44, verticalExtent: 0.3, evidence: "observed", confidence: 0.9 },
      ],
    });
    const fullGeometry = makeIdentityGeometry({
      headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.92, sideVolumeRight: 0.62, hairEndpointLeftY: 0.92, hairEndpointRightY: 0.78 },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.92, verticalCenter: 0.14, verticalExtent: 0.34, evidence: "observed", confidence: 0.9 },
        { region: "side_left", protrusion: 0.9, verticalCenter: 0.42, verticalExtent: 0.54, evidence: "observed", confidence: 0.9 },
        { region: "side_right", protrusion: 0.62, verticalCenter: 0.48, verticalExtent: 0.4, evidence: "observed", confidence: 0.9 },
        { region: "lower_left", protrusion: 0.78, verticalCenter: 0.78, verticalExtent: 0.38, evidence: "observed", confidence: 0.9 },
      ],
    });
    const compact = buildIdentityPixelPlans(analysisWith("curly", compactGeometry, { bangs: "none", bangsLength: "none", overallHairLength: "jaw", sideHairLength: "jaw", hairVolume: "normal" })).hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe");
    const full = buildIdentityPixelPlans(analysisWith("curly", fullGeometry, { bangs: "none", bangsLength: "none", overallHairLength: "jaw", sideHairLength: "jaw", hairVolume: "full" })).hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe");
    expect(full.length).toBeGreaterThan(compact.length);
    expect(full.map((group) => group.sourceAnchor)).not.toEqual(compact.map((group) => group.sourceAnchor));
    expect(full.find((group) => group.id === "curl-lobe-side-left")!.sourceAnchor!.protrusion).toBeGreaterThan(full.find((group) => group.id === "curl-lobe-side-right")!.sourceAnchor!.protrusion);
  });

  it("reports stage retention, outer occupancy and geometry-vs-texture pixel differences", () => {
    const analysis = analysisWith("curly", makeIdentityGeometry(), { overallHairLength: "jaw", sideHairLength: "jaw", bangs: "none", bangsLength: "none" });
    const plans = buildIdentityPixelPlans(analysis);
    const before = blankAtlas();
    const after: RawImage = { ...before, rgba: before.rgba.slice() };
    applyHeadMaskPlan(after, plans.hairPlan, [90, 65, 42], [50, 80, 120], style, plans.facePixelPlan);
    applyHeadIdentityPlan(after, plans.headIdentityPlan, plans.hairPlan, [90, 65, 42], [210, 160, 135], style, false);
    const retention = measureHeadIdentityRetention(analysis, plans.hairPlan, plans.facePixelPlan, after);
    const difference = measureHeadPixelDifference(before, after);
    expect(Object.values(retention.metrics).every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(retention.renderedAtlas.outerOccupancyByFace).not.toBeNull();
    expect(difference.changedHeadPixels).toBeGreaterThan(0);
    expect(difference.changedBasePixels).toBeGreaterThan(0);
    expect(difference.changedOuterPixels).toBeGreaterThan(0);
    expect(difference.silhouetteChangedPixels).toBeGreaterThan(0);
  });
});
