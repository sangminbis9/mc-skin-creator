import { describe, expect, it } from "vitest";
import {
  findHairQuantizationCollisions,
  meaningfulHairDifferenceAxes,
  measureHairInformationFlow,
  measureHairSilhouetteSignature,
} from "../src/hairSilhouetteFidelity";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function geometryCase(
  id: string,
  texture: "straight" | "curly",
  sideVolumeLeft: number,
  sideVolumeRight: number,
  endpointLeft = 0.68,
  endpointRight = 0.68,
) {
  const base = makeAnalysis();
  const geometry = makeIdentityGeometry();
  const analysis = makeAnalysis({
    identityGeometry: makeIdentityGeometry({
      headSilhouette: {
        ...geometry.headSilhouette,
        sideVolumeLeft,
        sideVolumeRight,
        hairEndpointLeftY: endpointLeft,
        hairEndpointRightY: endpointRight,
      },
    }),
    observed: { ...base.observed, hair: texture === "curly" ? "large connected curly lobes" : `short measured hair ${id}` },
    renderHints: {
      ...base.renderHints,
      hairTexture: texture,
      overallHairLength: texture === "curly" ? "shoulder" : "ear",
      sideHairLength: texture === "curly" ? "shoulder" : "short",
    },
  });
  return { id, analysis, plans: buildIdentityPixelPlans(analysis) };
}

describe("source to plan to atlas hair information", () => {
  it("preserves sub-pixel side-volume differences within the same texture category", () => {
    const narrow = geometryCase("narrow", "straight", 0.31, 0.34);
    const broad = geometryCase("broad", "straight", 0.42, 0.45);
    const narrowSignature = measureHairSilhouetteSignature(narrow.plans.hairPlan, narrow.plans.facePixelPlan);
    const broadSignature = measureHairSilhouetteSignature(broad.plans.hairPlan, broad.plans.facePixelPlan);
    expect(meaningfulHairDifferenceAxes(narrowSignature, broadSignature)).toContain("side_silhouette");
    expect(findHairQuantizationCollisions([
      { id: narrow.id, plan: narrow.plans.hairPlan, facePlan: narrow.plans.facePixelPlan },
      { id: broad.id, plan: broad.plans.hairPlan, facePlan: broad.plans.facePixelPlan },
    ])).toEqual([]);
  });

  it("reports true quantization collisions instead of silently treating them as diversity", () => {
    const first = geometryCase("first", "straight", 0.31, 0.34);
    const duplicate = geometryCase("duplicate", "straight", 0.31, 0.34);
    const collisions = findHairQuantizationCollisions([
      { id: first.id, plan: first.plans.hairPlan, facePlan: first.plans.facePixelPlan },
      { id: duplicate.id, plan: duplicate.plans.hairPlan, facePlan: duplicate.plans.facePixelPlan },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ texture: "straight", ids: ["first", "duplicate"] });
  });

  it("measures bounded source-to-plan retention across identity-sensitive axes", () => {
    const sample = geometryCase("measured", "straight", 0.62, 0.48, 0.76, 0.64);
    const flow = measureHairInformationFlow(sample.analysis, sample.plans.hairPlan, sample.plans.facePixelPlan);
    expect(flow.sourceToPlanRetention).toBeGreaterThanOrEqual(0);
    expect(flow.sourceToPlanRetention).toBeLessThanOrEqual(1);
    expect(flow.planToAtlasRetention).toBeNull();
    expect(Object.keys(flow.errors)).toEqual([
      "crown",
      "sideExtent",
      "part",
      "fringe",
      "earExposure",
      "groupStructure",
      "asymmetry",
    ]);
  });

  it("uses four source-positioned connected major lobes for curly hair", () => {
    const curly = geometryCase("curly", "curly", 0.82, 0.61, 0.9, 0.82);
    const lobes = curly.plans.hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe");
    expect(lobes.map((group) => group.id).sort()).toEqual([
      "curl-lobe-crown",
      "curl-lobe-left",
      "curl-lobe-lower",
      "curl-lobe-right",
    ]);
    expect(lobes.every((group) => group.points.length >= 2)).toBe(true);
    expect(new Set(lobes.map((group) => group.points[0].face))).toEqual(new Set(["top", "left", "right", "back"]));
  });

  it("keeps glasses, head-covering face window, and long-hair continuity as regression sentinels", () => {
    const glasses = geometryCase("glasses", "straight", 0.48, 0.5).plans;
    expect(glasses.facePixelPlan.glassesPlan.topology).not.toBe("none");
    expect(glasses.facePixelPlan.glassesPlan.lensOpenings).toHaveLength(2);

    const base = makeAnalysis();
    const geometry = makeIdentityGeometry();
    const headscarf = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry({
        headSilhouette: {
          ...geometry.headSilhouette,
          covering: {
            leftContourByRow: [0.08, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2],
            rightContourByRow: [0.92, 0.92, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8],
          },
        },
      }),
      observed: { ...base.observed, hair: "hair covered by a fitted headscarf" },
      fallbackFeatures: { ...base.fallbackFeatures, hat: "headscarf" },
    }));
    expect(headscarf.hairPlan.headMask.faces.front.length).toBeGreaterThan(0);
    expect(headscarf.hairPlan.headMask.faces.front.length).toBeLessThan(64);

    const long = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry(),
      renderHints: { ...base.renderHints, overallHairLength: "waist", sideHairLength: "shoulder" },
    }));
    expect(long.hairPlan.continuousFaces).toEqual(expect.arrayContaining(["head.back", "body.back", "body.left", "body.right"]));
  });
});
