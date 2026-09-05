/** Opt-in offline artifact suite for deterministic curly source variants. */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PhotoAnalysis } from "../src/analysis";
import { findCurlySilhouetteCollisions, measureCurlyIdentityRetention, measureCurlyPixelDifference } from "../src/curlyIdentityRetention";
import type { IdentityGeometryAnalysis, MajorHairVolumePeak } from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { decodePng, type RawImage } from "../src/png";
import { applyHeadIdentityPlan, applyHeadMaskPlan, reconcileBaseHorizontalSeams, reconcileOverlaySeams, type FaceStyle } from "../src/skinPack";
import { buildHeadViewMontage, extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import {
  buildBeforeAfterHeadMontage,
  buildBinaryHeadSilhouette,
  buildHeadLayerDiagnosticViews,
  buildHeadPixelDiff,
  buildHeadSeamDiagnostic,
  buildHeadTopDiagnosticView,
  buildMajorVolumeGeometryOverlay,
  buildPreviewSizeHead,
  renderQuantizedHeadPlan,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const RUN = process.env.RUN_CURLY_RENDERER_ARTIFACTS === "1";
const OUTPUT_ROOT = resolve(process.env.CURLY_RENDERER_ARTIFACT_DIR ?? "evaluation-artifacts/curly-renderer-20260905/synthetic");
const BEFORE_ATLAS = resolve("evaluation-artifacts/hair-identity-retention-20260903/curly-hair/10-final-skin.png");
const HAIR: [number, number, number] = [194, 170, 108];
const SKIN: [number, number, number] = [211, 158, 137];
const STYLE: FaceStyle = { eyeColor: "#567a82", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile", facialHair: "none", glasses: "none", hairstyle: "curly", hat: "none", bangs: "none", bangsLength: "none", hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled", hairPart: "left", sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: "none", earExposure: "partial" };

function peak(region: MajorHairVolumePeak["region"], protrusion: number, verticalCenter: number, verticalExtent: number): MajorHairVolumePeak {
  return { region, protrusion, verticalCenter, verticalExtent, evidence: "observed", confidence: 0.9 };
}

function variant(id: string, peaks: MajorHairVolumePeak[], silhouette: Partial<IdentityGeometryAnalysis["headSilhouette"]>, crown: Partial<IdentityGeometryAnalysis["crown"]> = {}): { id: string; analysis: PhotoAnalysis } {
  const base = makeAnalysis();
  const geometry = makeIdentityGeometry();
  return {
    id,
    analysis: makeAnalysis({
      identityGeometry: makeIdentityGeometry({ majorVolumePeaks: peaks, headSilhouette: { ...geometry.headSilhouette, ...silhouette }, crown: { ...geometry.crown, ...crown } }),
      observed: { ...base.observed, hair: `${id} source-derived curly geometry` },
      renderHints: { ...base.renderHints, bangs: "none", bangsLength: "none", hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled", overallHairLength: "jaw", sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: (silhouette.sideVolumeLeft ?? 0.6) > (silhouette.sideVolumeRight ?? 0.6) ? "left" : (silhouette.sideVolumeRight ?? 0.6) > (silhouette.sideVolumeLeft ?? 0.6) ? "right" : "none" },
      fallbackFeatures: { ...base.fallbackFeatures, hairstyle: "curly" },
      identityPrompt: `${id}: preserve the measured major masses and terminal rows`,
    }),
  };
}

const CASES = [
  variant("left-heavy-3", [peak("crown_left", .94, .12, .3), peak("side_left", .96, .36, .54), peak("side_right", .42, .3, .26)], { sideVolumeLeft: .94, sideVolumeRight: .42, hairEndpointLeftY: .72, hairEndpointRightY: .48 }, { leftY: .03, centerY: .06, rightY: .14, apexX: .24 }),
  variant("right-heavy-4", [peak("crown_right", .92, .12, .3), peak("side_left", .4, .3, .26), peak("side_right", .96, .42, .56), peak("lower_right", .88, .64, .36)], { sideVolumeLeft: .4, sideVolumeRight: .96, hairEndpointLeftY: .46, hairEndpointRightY: .8 }, { leftY: .14, centerY: .05, rightY: .03, apexX: .74 }),
  variant("high-crown-4", [peak("crown_left", .98, .1, .38), peak("crown_right", .9, .13, .34), peak("side_left", .46, .34, .26), peak("side_right", .44, .35, .24)], { sideVolumeLeft: .46, sideVolumeRight: .44, hairEndpointLeftY: .52, hairEndpointRightY: .5 }, { leftY: .01, centerY: .01, rightY: .05, apexX: .42 }),
  variant("low-wide-5", [peak("crown_left", .56, .18, .2), peak("side_left", .82, .46, .44), peak("side_right", .8, .45, .42), peak("lower_left", .9, .68, .4), peak("lower_right", .84, .64, .36)], { sideVolumeLeft: .84, sideVolumeRight: .8, hairEndpointLeftY: .84, hairEndpointRightY: .78 }),
  variant("lower-left-4", [peak("crown_left", .62, .15, .24), peak("side_left", .72, .36, .34), peak("side_right", .66, .35, .32), peak("lower_left", .98, .72, .44)], { sideVolumeLeft: .86, sideVolumeRight: .66, hairEndpointLeftY: .9, hairEndpointRightY: .58 }),
  variant("symmetric-4", [peak("crown_left", .72, .14, .26), peak("crown_right", .72, .14, .26), peak("side_left", .7, .4, .4), peak("side_right", .7, .4, .4)], { sideVolumeLeft: .7, sideVolumeRight: .7, hairEndpointLeftY: .64, hairEndpointRightY: .64 }, { leftY: .07, centerY: .04, rightY: .07, apexX: .5 }),
];

function blankSource(): RawImage {
  const rgba = new Uint8Array(256 * 256 * 4);
  for (let pixel = 0; pixel < 256 * 256; pixel++) rgba.set([232, 235, 240, 255], pixel * 4);
  return { width: 256, height: 256, rgba };
}

describe.skipIf(!RUN)("offline curly renderer artifacts", () => {
  it("writes distinct source-conditioned silhouettes", async () => {
    const beforeAtlas = await decodePng(new Uint8Array(await readFile(BEFORE_ATLAS)));
    const plans = CASES.map((sample) => ({ ...sample, plans: buildIdentityPixelPlans(sample.analysis) }));
    expect(findCurlySilhouetteCollisions(plans.map((sample) => ({ id: sample.id, plan: sample.plans.hairPlan })))).toEqual([]);
    for (const sample of plans) {
      const afterAtlas: RawImage = { ...beforeAtlas, rgba: beforeAtlas.rgba.slice() };
      applyHeadMaskPlan(afterAtlas, sample.plans.hairPlan, HAIR, HAIR, STYLE, sample.plans.facePixelPlan);
      applyHeadIdentityPlan(afterAtlas, sample.plans.headIdentityPlan, sample.plans.hairPlan, HAIR, SKIN, STYLE, false);
      reconcileBaseHorizontalSeams(afterAtlas);
      reconcileOverlaySeams(afterAtlas, STYLE, HAIR);
      const beforeViews = renderSkinViews(beforeAtlas);
      const afterViews = renderSkinViews(afterAtlas);
      const head = (name: Parameters<typeof extractRenderedHeadView>[0]["name"]) => extractRenderedHeadView(afterViews.find((view) => view.name === name)!);
      const beforeLayers = buildHeadLayerDiagnosticViews(beforeAtlas);
      const afterLayers = buildHeadLayerDiagnosticViews(afterAtlas);
      const geometry = sample.analysis.identityGeometry!;
      const retention = measureCurlyIdentityRetention(sample.analysis, sample.plans.hairPlan, sample.plans.facePixelPlan, afterAtlas);
      const difference = measureCurlyPixelDifference(beforeAtlas, afterAtlas);
      await writeIdentityEvaluationArtifacts(OUTPUT_ROOT, sample.id, {
        sourceFace: blankSource(),
        sourceHead: blankSource(),
        sourceHeadGeometryOverlay: buildMajorVolumeGeometryOverlay(blankSource(), geometry),
        majorVolumeOverlay: buildMajorVolumeGeometryOverlay(blankSource(), geometry),
        quantizedHeadPlan: renderQuantizedHeadPlan(sample.plans.hairPlan, sample.plans.facePixelPlan),
        candidateA: buildHeadViewMontage(beforeViews),
        candidateB: buildHeadViewMontage(afterViews),
        beforeSilhouette: buildBinaryHeadSilhouette(beforeAtlas),
        afterSilhouette: buildBinaryHeadSilhouette(afterAtlas),
        beforeBaseHeadOnly: beforeLayers.baseHeadOnly,
        beforeOuterHeadOnly: beforeLayers.outerHeadOnly,
        beforeBaseOuterHead: beforeLayers.baseOuterHead,
        ...afterLayers,
        sixView: buildHeadViewMontage(afterViews),
        finalHeadFront: head("front"), finalHeadFrontLeft: head("front_left_three_quarter"), finalHeadLeft: head("left"),
        finalHeadFrontRight: head("front_right_three_quarter"), finalHeadRight: head("right"), finalHeadTop: buildHeadTopDiagnosticView(afterAtlas), finalHeadBack: head("back"),
        beforeAfterHeadMontage: buildBeforeAfterHeadMontage(extractRenderedHeadView(beforeViews.find((view) => view.name === "front")!), head("front")),
        uvSeamDiagnostic: buildHeadSeamDiagnostic(afterAtlas),
        headPixelDiff: buildHeadPixelDiff(beforeAtlas, afterAtlas),
        previewSize: buildPreviewSizeHead(afterAtlas),
        facePixelPlan: sample.plans.facePixelPlan,
        finalSkin: afterAtlas,
        critique: { evaluation: "not run", reason: "offline deterministic renderer artifact" },
        metrics: { case: sample.id, apiCalls: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 }, sourceGeometry: geometry, curlyIdentityRetention: retention, curlyPixelDifference: difference },
      });
      expect(difference.outerDepth).toBeGreaterThan(0);
      expect(retention.frontSideContinuity).toBe(1);
      expect(retention.sideBackContinuity).toBe(1);
    }
  }, 60_000);
});
