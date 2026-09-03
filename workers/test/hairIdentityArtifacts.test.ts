/**
 * Opt-in, offline renderer artifact generation for source-to-pixel QA.
 * No model or evaluator API is called by this file.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PhotoAnalysis } from "../src/analysis";
import { measureHeadIdentityRetention, measureHeadPixelDifference } from "../src/hairSilhouetteFidelity";
import { applyCropVisibility, parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, type RawImage } from "../src/png";
import { applyHeadIdentityPlan, applyHeadMaskPlan, reconcileBaseHorizontalSeams, reconcileOverlaySeams, type FaceStyle } from "../src/skinPack";
import { measureAtlasCraft, validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { buildHeadViewMontage, extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import {
  buildBeforeAfterHeadMontage,
  buildCrownContourOverlay,
  buildFaceGeometryOverlay,
  buildFaceWindowOverlay,
  buildFringeGeometryOverlay,
  buildGeometryOverlay,
  buildHeadLayerDiagnosticViews,
  buildHeadTopDiagnosticView,
  buildTempleGeometryOverlay,
  renderQuantizedHeadPlan,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_HAIR_IDENTITY_ARTIFACTS === "1";
const GEOMETRY_INPUT_ROOT = resolve("evaluation-artifacts/head-structure-iteration-final");
const PREVIOUS_ROOT = resolve("evaluation-artifacts/hair-identity-retention-20260903");
const OUTPUT_ROOT = resolve(process.env.HAIR_IDENTITY_ARTIFACT_DIR ?? "evaluation-artifacts/head-geometry-20260903");

interface ArtifactCase {
  id: "short-hair-red-shirt" | "curly-hair";
  hairColor: [number, number, number];
  skinColor: [number, number, number];
  analysis: (geometry: IdentityGeometryAnalysis) => PhotoAnalysis;
  measuredGeometry: (geometry: IdentityGeometryAnalysis) => IdentityGeometryAnalysis;
  style: FaceStyle;
}

function identityFeatures(hair: string): PhotoAnalysis["canonicalIdentity"] {
  return {
    overallImpression: hair,
    mustPreserve: [hair, "visible face window and source expression"],
    features: [
      { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: "clearly visible in the source head crop", targetRegions: ["head.front", "head.top", "head.side", "head.back", "head.overlay"] },
      { feature: "visible face window", category: "face", priority: 4, confidence: "high", evidence: "forehead, temples and cheeks remain visible", targetRegions: ["head.front", "head.side"] },
    ],
  };
}

const CASES: ArtifactCase[] = [
  {
    id: "short-hair-red-shirt",
    hairColor: [28, 24, 22],
    skinColor: [174, 111, 77],
    analysis: (identityGeometry) => {
      const base = makeAnalysis();
      return makeAnalysis({
        identityGeometry,
        observed: { ...base.observed, hair: "short black hair with a side-swept staggered fringe, open temples and visible ears", accessories: "no glasses", clothing: "bright red short-sleeved shirt", colorPalette: ["black", "warm brown", "bright red"] },
        canonicalIdentity: identityFeatures("short side-swept black fringe with asymmetric crown and exposed temples"),
        renderHints: { ...base.renderHints, bangs: "side", bangsLength: "brow", bangsDensity: "balanced", fringeEdge: "staggered", fringeOpening: "none", hairTexture: "straight", hairVolume: "flat", hairSilhouette: "swept", hairBackShape: "tapered", overallHairLength: "ear", hairPart: "right", sideHairLength: "short", sideHairShape: "tapered", sideHairAsymmetry: "left", earExposure: "visible", garmentTexture: "plain", outerLayer: "none" },
        fallbackFeatures: { ...base.fallbackFeatures, glasses: "none", hairColor: "black", hairstyle: "short", topType: "tshirt", topColor: "red", sleeveLength: "short" },
        identityPrompt: "Short black hair swept across the forehead with a staggered lower edge, an uneven crown, exposed temples and ears.",
        negativePrompt: "no glasses, no hat, no long hair",
      });
    },
    measuredGeometry: (geometry) => applyCropVisibility({
      ...geometry,
      hairline: { depthByColumn: [0.16, 0.24, 0.42, 0.68, 0.55, 0.32, 0.2, 0.12], foreheadOpeningLeft: 0.08, foreheadOpeningRight: 0.08, asymmetry: -0.34 },
      fringe: { visible: true, peaks: [{ x: 0.43, depthY: 0.48, prominence: 0.82 }, { x: 0.56, depthY: 0.38, prominence: 0.48 }], direction: "left_swept", openingCenterX: null, openingWidth: null, leftTempleTransitionY: 0.43, rightTempleTransitionY: 0.36, evidence: "observed", confidence: 0.9 },
      temple: { leftRecession: 0.7, rightRecession: 0.58, leftStartY: 0.36, rightStartY: 0.32, asymmetry: 0.12, leftEvidence: "observed", rightEvidence: "observed", confidence: 0.86 },
      crown: { leftY: 0.2, centerY: 0.15, rightY: 0.19, leftWidth: 0.22, rightWidth: 0.24, apexX: 0.49, asymmetry: 0.16, evidence: "observed", confidence: 0.86 },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.42, verticalCenter: 0.21, verticalExtent: 0.2, evidence: "observed", confidence: 0.84 },
        { region: "side_left", protrusion: 0.34, verticalCenter: 0.36, verticalExtent: 0.28, evidence: "observed", confidence: 0.82 },
        { region: "side_right", protrusion: 0.25, verticalCenter: 0.34, verticalExtent: 0.24, evidence: "observed", confidence: 0.82 },
      ],
      faceWindow: { foreheadHeight: 0.31, leftTempleWidth: 0.74, rightTempleWidth: 0.66, visibleFaceWidthAtEyes: 0.36, visibleFaceWidthAtCheeks: 0.42, leftEyeToHairDistance: 0.2, rightEyeToHairDistance: 0.18, leftEarExposure: 0.88, rightEarExposure: 0.78, leftEvidence: "observed", rightEvidence: "observed", confidence: 0.86 },
      faceShape: { upperWidth: 0.58, cheekWidth: 0.64, jawWidth: 0.48, verticalLength: 0.72, leftRightAsymmetry: 0.04, evidence: "observed", confidence: 0.82 },
      headSilhouette: { ...geometry.headSilhouette, crownTopY: 0.15, leftContourByRow: [0.42, 0.38, 0.37, 0.38, 0.4, 0.42, 0.44, 0.46], rightContourByRow: [0.58, 0.67, 0.72, 0.73, 0.72, 0.7, 0.68, 0.65], sideVolumeLeft: 0.4, sideVolumeRight: 0.3, partCenterX: 0.52, hairEndpointLeftY: 0.49, hairEndpointRightY: 0.45, foreheadExposure: 0.34, earExposureLeft: 0.88, earExposureRight: 0.78, confidence: 0.86 },
    }, { crownClipped: false, leftHairClipped: false, rightHairClipped: false, chinClipped: false, leftEarClipped: false, rightEarClipped: false }),
    style: { eyeColor: "#3a2418", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile", facialHair: "none", glasses: "none", hairstyle: "short", hat: "none", bangs: "side", bangsLength: "brow", bangsDensity: "balanced", fringeEdge: "staggered", fringeOpening: "none", hairTexture: "straight", hairVolume: "flat", hairSilhouette: "swept", hairPart: "right", sideHairLength: "short", sideHairShape: "tapered", sideHairAsymmetry: "left", earExposure: "visible" },
  },
  {
    id: "curly-hair",
    hairColor: [194, 170, 108],
    skinColor: [211, 158, 137],
    analysis: (identityGeometry) => {
      const base = makeAnalysis();
      return makeAnalysis({
        identityGeometry,
        observed: { ...base.observed, hair: "voluminous jaw-length blonde curls with a larger left crown and lower left curl mass", accessories: "no glasses", clothing: "light gray cable-knit sweater", colorPalette: ["blonde", "light gray", "warm pink"] },
        canonicalIdentity: identityFeatures("voluminous blonde curl silhouette with a larger left crown and asymmetric lower curl mass"),
        renderHints: { ...base.renderHints, bangs: "none", bangsLength: "none", bangsDensity: "sparse", fringeEdge: "wispy", fringeOpening: "none", hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled", hairBackShape: "rounded", overallHairLength: "jaw", hairPart: "left", sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: "left", earExposure: "covered", garmentTexture: "knit", outerLayer: "heavy" },
        fallbackFeatures: { ...base.fallbackFeatures, glasses: "none", hairColor: "blonde", hairstyle: "curly", topType: "sweater", topColor: "gray" },
        identityPrompt: "Full blonde curls form a wide asymmetric crown, a larger viewer-left side mass and compact jaw-level endpoints.",
        negativePrompt: "no glasses, no straight hair, no shoulder-length hair",
      });
    },
    measuredGeometry: (geometry) => applyCropVisibility({
      ...geometry,
      hairline: { depthByColumn: [0.48, 0.42, 0.24, 0.12, 0.08, 0.12, 0.2, 0.32], foreheadOpeningLeft: 0.28, foreheadOpeningRight: 0.5, asymmetry: -0.28 },
      fringe: { visible: true, peaks: [{ x: 0.2, depthY: 0.35, prominence: 0.62 }], direction: "irregular", openingCenterX: 0.4, openingWidth: 0.22, leftTempleTransitionY: 0.44, rightTempleTransitionY: 0.38, evidence: "observed", confidence: 0.8 },
      temple: { leftRecession: 0.18, rightRecession: 0.3, leftStartY: 0.38, rightStartY: 0.34, asymmetry: -0.12, leftEvidence: "observed", rightEvidence: "observed", confidence: 0.8 },
      crown: { leftY: 0.03, centerY: 0.04, rightY: 0.1, leftWidth: 0.92, rightWidth: 0.7, apexX: 0.22, asymmetry: -0.36, evidence: "observed", confidence: 0.8 },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.96, verticalCenter: 0.12, verticalExtent: 0.26, evidence: "observed", confidence: 0.78 },
        { region: "side_left", protrusion: 0.94, verticalCenter: 0.34, verticalExtent: 0.54, evidence: "observed", confidence: 0.78 },
        { region: "side_right", protrusion: 0.72, verticalCenter: 0.28, verticalExtent: 0.42, evidence: "observed", confidence: 0.84 },
        { region: "lower_left", protrusion: 0.82, verticalCenter: 0.55, verticalExtent: 0.32, evidence: "observed", confidence: 0.78 },
        { region: "lower_right", protrusion: 0.58, verticalCenter: 0.48, verticalExtent: 0.28, evidence: "observed", confidence: 0.82 },
      ],
      faceWindow: { foreheadHeight: 0.36, leftTempleWidth: 0.22, rightTempleWidth: 0.38, visibleFaceWidthAtEyes: 0.46, visibleFaceWidthAtCheeks: 0.5, leftEyeToHairDistance: 0.16, rightEyeToHairDistance: 0.22, leftEarExposure: 0.04, rightEarExposure: 0.08, leftEvidence: "observed", rightEvidence: "observed", confidence: 0.8 },
      faceShape: { upperWidth: 0.58, cheekWidth: 0.64, jawWidth: 0.48, verticalLength: 0.7, leftRightAsymmetry: -0.08, evidence: "observed", confidence: 0.78 },
      headSilhouette: { ...geometry.headSilhouette, crownTopY: 0.02, leftContourByRow: [0.04, 0.02, 0.02, 0.04, 0.08, 0.12, 0.16, 0.2], rightContourByRow: [0.48, 0.53, 0.55, 0.56, 0.55, 0.52, 0.48, 0.44], sideVolumeLeft: 0.96, sideVolumeRight: 0.72, partCenterX: 0.3, hairEndpointLeftY: 0.62, hairEndpointRightY: 0.54, foreheadExposure: 0.48, earExposureLeft: 0.04, earExposureRight: 0.08, confidence: 0.8 },
    }, { crownClipped: true, leftHairClipped: true, rightHairClipped: false, chinClipped: false, leftEarClipped: true, rightEarClipped: false }),
    style: { eyeColor: "#567a82", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile", facialHair: "none", glasses: "none", hairstyle: "curly", hat: "none", bangs: "none", bangsLength: "none", bangsDensity: "sparse", fringeEdge: "wispy", fringeOpening: "none", hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled", hairPart: "left", sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: "left", earExposure: "covered" },
  },
];

async function png(path: string): Promise<RawImage> {
  return decodePng(new Uint8Array(await readFile(path)));
}

describe.skipIf(!RUN)("offline hair identity evaluation artifacts", () => {
  for (const sample of CASES) it(sample.id, async () => {
    const geometryInput = resolve(GEOMETRY_INPUT_ROOT, sample.id);
    const previousInput = resolve(PREVIOUS_ROOT, sample.id);
    const storedMetrics = JSON.parse(await readFile(resolve(geometryInput, "metrics.json"), "utf8")) as {
      sourceGeometryAfter: Record<string, unknown>;
      newFacePixelPlan: FacePixelPlan;
      beforeScores: { identityScore: number; faceHairScore: number };
    };
    const sourceFace = await png(resolve(previousInput, "01-source-face.png"));
    const sourceHead = await png(resolve(previousInput, "01b-source-head.png"));
    const beforeAtlas = await png(resolve(previousInput, "10-final-skin.png"));
    const legacyGeometry = parseIdentityGeometry(storedMetrics.sourceGeometryAfter);
    expect(legacyGeometry).not.toBeNull();
    const measuredGeometry = sample.measuredGeometry(legacyGeometry!);
    const beforeAnalysis = sample.analysis(legacyGeometry!);
    const beforePlans = buildIdentityPixelPlans(beforeAnalysis);
    const analysis = sample.analysis(measuredGeometry);
    const plans = buildIdentityPixelPlans(analysis);
    const afterAtlas: RawImage = { ...beforeAtlas, rgba: beforeAtlas.rgba.slice() };
    applyHeadMaskPlan(afterAtlas, plans.hairPlan, sample.hairColor, sample.hairColor, sample.style, plans.facePixelPlan);
    applyHeadIdentityPlan(afterAtlas, plans.headIdentityPlan, plans.hairPlan, sample.hairColor, sample.skinColor, sample.style, true);
    reconcileBaseHorizontalSeams(afterAtlas);
    reconcileOverlaySeams(afterAtlas, sample.style, sample.hairColor);
    const beforeViews = renderSkinViews(beforeAtlas);
    const afterViews = renderSkinViews(afterAtlas);
    const head = (name: Parameters<typeof extractRenderedHeadView>[0]["name"]) => extractRenderedHeadView(afterViews.find((view) => view.name === name)!);
    const beforeFront = extractRenderedHeadView(beforeViews.find((view) => view.name === "front")!);
    const afterFront = head("front");
    const beforeRetention = measureHeadIdentityRetention(beforeAnalysis, beforePlans.hairPlan, beforePlans.facePixelPlan, beforeAtlas);
    const afterRetention = measureHeadIdentityRetention(analysis, plans.hairPlan, plans.facePixelPlan, afterAtlas);
    const craft = validateAtlasCraft(afterAtlas, sample.style, plans.facePixelPlan, plans.hairPlan);
    const metrics = {
      case: sample.id,
      evaluatorCalls: { absolute: 0, pairwise: 0 },
      previousBenchmark: storedMetrics.beforeScores,
      afterScores: "not measured",
      geometrySource: "offline source-image measurement fixture; no model or evaluator API call",
      sourceGeometryBefore: legacyGeometry,
      sourceGeometryAfter: measuredGeometry,
      geometryUsage: plans.facePixelPlan.layout.geometryUsage,
      quantizedGeometry: {
        fringePeaks: plans.facePixelPlan.layout.fringePeaks,
        temple: plans.facePixelPlan.layout.templeGeometry,
        crown: plans.facePixelPlan.layout.crownGeometry,
        majorVolumePeaks: plans.facePixelPlan.layout.majorVolumePeaks,
        faceWindow: plans.facePixelPlan.layout.faceWindow,
        faceShape: plans.facePixelPlan.layout.faceShape,
      },
      salience: plans.hairPlan.salience,
      fringeProfile: plans.hairPlan.structure.fringe,
      headMask: plans.hairPlan.headMask,
      curlLobes: plans.hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe").map((group) => ({ id: group.id, sourceAnchor: group.sourceAnchor, points: group.points })),
      retention: { before: beforeRetention, after: afterRetention },
      pixelDifference: measureHeadPixelDifference(beforeAtlas, afterAtlas),
      craft: { validation: craft, metrics: measureAtlasCraft(afterAtlas), finalAtlasValid: validateFinalAtlas(afterAtlas).ok },
    };
    await writeIdentityEvaluationArtifacts(OUTPUT_ROOT, sample.id, {
      sourceFace,
      sourceHead,
      geometryOverlay: buildGeometryOverlay(sourceHead, legacyGeometry!),
      sourceHeadGeometryOverlay: buildGeometryOverlay(sourceHead, measuredGeometry),
      sourceFaceGeometryOverlay: buildFaceGeometryOverlay(sourceFace, measuredGeometry),
      fringeGeometryOverlay: buildFringeGeometryOverlay(sourceHead, measuredGeometry),
      templeGeometryOverlay: buildTempleGeometryOverlay(sourceHead, measuredGeometry),
      crownContourOverlay: buildCrownContourOverlay(sourceHead, measuredGeometry),
      faceWindowOverlay: buildFaceWindowOverlay(sourceHead, measuredGeometry),
      quantizedHeadPlan: renderQuantizedHeadPlan(plans.hairPlan, plans.facePixelPlan),
      sixView: buildHeadViewMontage(afterViews),
      packedHeadBefore: beforeFront,
      facePixelPlan: plans.facePixelPlan,
      oldFacePixelPlan: storedMetrics.newFacePixelPlan,
      candidateA: buildHeadViewMontage(beforeViews),
      candidateB: buildHeadViewMontage(afterViews),
      ...buildHeadLayerDiagnosticViews(afterAtlas),
      finalHeadFront: afterFront,
      finalHeadFrontLeft: head("front_left_three_quarter"),
      finalHeadLeft: head("left"),
      finalHeadFrontRight: head("front_right_three_quarter"),
      finalHeadRight: head("right"),
      finalHeadTop: buildHeadTopDiagnosticView(afterAtlas),
      finalHeadBack: head("back"),
      beforeAfterHeadMontage: buildBeforeAfterHeadMontage(beforeFront, afterFront),
      finalSkin: afterAtlas,
      critique: { absoluteEvaluation: "not run", reason: "offline source-retention and visual inspection precede optional bounded live evaluation" },
      metrics,
    });
    expect(validateFinalAtlas(afterAtlas).ok).toBe(true);
    expect(metrics.pixelDifference.changedHeadPixels).toBeGreaterThan(0);
    if (plans.hairPlan.headMask.source === "identity_geometry") {
      expect(metrics.pixelDifference.silhouetteChangedPixels).toBeGreaterThan(0);
    }
    expect(afterRetention.stageRetention.planToAtlas).toBeGreaterThanOrEqual(0.8);
  });
});
