/**
 * Opt-in live regression over openly licensed real photographs.
 *
 * Run with RUN_LIVE_GEMINI_EVAL=1 and GEMINI_API_KEY set. Photos are fetched
 * into memory from Wikimedia Commons and are never written to the repository.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPhotoAnalysis, runPortraitDetailAnalysis } from "../src/analysis";
import {
  applyFocusedPortraitDetail,
  buildFaceStyle,
  buildProceduralFallbackAtlas,
  createIdentityCrops,
  createHeuristicIdentityCrops,
  createUpperBodyDetailCrop,
  fallbackFeaturesToHex,
  generateSkin,
  normalizeAnalysisForRendering,
  postprocessGeneratedSheet,
  refineFeatureColorsFromAnalysis,
} from "../src/generate";
import { createFacePlanAtlasCandidate } from "../src/skinPack";
import {
  buildFacePixelPlanVariants,
  compareFacePlans,
  measureFacePlanConvergence,
  type FacePixelPlan,
} from "../src/identityPlans";
import { runIdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { measureHeadCandidateStructure, runHeadPairwiseComparison, shouldAcceptIdentityCorrection } from "../src/headIdentity";
import { findHairQuantizationCollisions, measureHairInformationFlow } from "../src/hairSilhouetteFidelity";
import { decodeImage, decodePng, encodePng, type RawImage } from "../src/png";
import { runSkinCritique } from "../src/skinCritique";
import { measureAtlasCraft, validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import {
  buildHeadViewMontage,
  buildSkinViewMontage,
  extractRenderedHeadView,
  renderSkinViews,
} from "../src/skinRender";
import {
  ResilientImageProvider,
  type SkinGenerationProvider,
  type SkinGenerationRequest,
  type SkinGenerationResult,
} from "../src/skinProvider";
import type { Env } from "../src/types";
import { buildHeadLayerDiagnosticViews, writeIdentityEvaluationArtifacts } from "./evaluationArtifacts";

const LIVE = process.env.RUN_LIVE_GEMINI_EVAL === "1";
const FULL_LIVE = process.env.RUN_LIVE_GEMINI_FULL === "1";
const PROCEDURAL_QA = process.env.RUN_LIVE_GEMINI_PROCEDURAL_QA === "1";
const MULTI_PHOTO_QA = process.env.RUN_LIVE_GEMINI_MULTI_PHOTO_QA === "1";
const IDENTITY_STAGE_QA = process.env.RUN_LIVE_GEMINI_IDENTITY_STAGE_QA === "1";
const PROCEDURAL_IDENTITY_QA = process.env.RUN_LIVE_GEMINI_PROCEDURAL_IDENTITY_QA === "1";
const LIVE_DEBUG = process.env.LIVE_GEMINI_DEBUG === "1";
const LIVE_ARTIFACT_DIR = process.env.LIVE_GEMINI_ARTIFACT_DIR;
const LIVE_VISION_MODEL =
  process.env.LIVE_GEMINI_VISION_MODEL?.trim() || "gemini-3.6-flash";
const LIVE_FALLBACK_MODEL =
  process.env.LIVE_GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.1-flash-lite";
const LIVE_STRUCTURED_TIMEOUT_MS =
  process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS?.trim() || "45000";
const LIVE_IMAGE_TIMEOUT_MS =
  process.env.LIVE_GEMINI_IMAGE_TIMEOUT_MS?.trim() || "120000";
const PROCEDURAL_QA_CASE_FILTER =
  process.env.LIVE_GEMINI_PROCEDURAL_CASES ?? "headscarf-color-blocks";
const IDENTITY_STAGE_CASE_FILTER =
  process.env.LIVE_GEMINI_IDENTITY_CASES ?? "short-hair-red-shirt,glasses-monochrome,curly-hair,headscarf-color-blocks,long-straight-hair";

export const REAL_PHOTO_CASES = [
  {
    id: "long-straight-hair",
    file: "Portrait of a young long-haired woman.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Portrait_of_a_young_long-haired_woman.jpg",
    license: "CC BY 2.0",
    expectedCue: /long|chest|waist|shoulder/i,
  },
  {
    id: "short-hair-red-shirt",
    file: "Smiling Lao woman with short hair and red shirt.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Smiling_Lao_woman_with_short_hair_and_red_shirt.jpg",
    license: "CC BY-SA 4.0",
    expectedCue: /short|cropped|ear|red/i,
  },
  {
    id: "curly-hair",
    file: "Smiling senior woman with curly hair portrait.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Smiling_senior_woman_with_curly_hair_portrait.jpg",
    license: "CC BY 2.0",
    expectedCue: /curly|curl|wavy|volume/i,
  },
  {
    id: "headscarf-color-blocks",
    file: "ASC Leiden - van de Bruinhorst Collection - Somaliland 2019 - 4470 - A portrait of Nasiim Mohomed Ali Aar, author of the novel Between Love, Past and Destiny, with a blue and pink headscarf in Xarunta Dhaqanka ee Hargeysa.jpg",
    page: "https://commons.wikimedia.org/wiki/File:ASC_Leiden_-_van_de_Bruinhorst_Collection_-_Somaliland_2019_-_4470_-_A_portrait_of_Nasiim_Mohomed_Ali_Aar,_author_of_the_novel_Between_Love,_Past_and_Destiny,_with_a_blue_and_pink_headscarf_in_Xarunta_Dhaqanka_ee_Hargeysa.jpg",
    license: "CC BY-SA 4.0",
    expectedCue: /scarf|headscarf|blue|pink/i,
  },
  {
    id: "glasses-monochrome",
    file: "Black and white self-portrait with coke bottle glasses.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Black_and_white_self-portrait_with_coke_bottle_glasses.jpg",
    license: "CC BY-SA 2.0",
    expectedCue: /glass|frame|spectacle/i,
  },
  {
    id: "short-hair-formal",
    file: "Neil Patrick Harris (9449178210) (cropped portrait).jpg",
    page: "https://commons.wikimedia.org/wiki/File:Neil_Patrick_Harris_(9449178210)_(cropped_portrait).jpg",
    license: "CC BY 2.0",
    expectedCue: /short|cropped|swept|formal|jacket|shirt/i,
  },
] as const;

const MULTI_PHOTO_CASE = {
  id: "portrait-plus-full-body",
  portraitFile: "Smiling Bill Parsons portrait - White Studio (cropped).jpg",
  portraitPage:
    "https://commons.wikimedia.org/wiki/File:Smiling_Bill_Parsons_portrait_-_White_Studio_(cropped).jpg",
  fullBodyFile: "Smiling Bill Parsons full-length portrait.jpg",
  fullBodyPage:
    "https://commons.wikimedia.org/wiki/File:Smiling_Bill_Parsons_full-length_portrait.jpg",
  license: "Public domain (published 1918)",
} as const;

const PROCEDURAL_QA_CASES =
  PROCEDURAL_QA_CASE_FILTER.trim().toLowerCase() === "all"
    ? [...REAL_PHOTO_CASES]
    : REAL_PHOTO_CASES.filter((photo) =>
        PROCEDURAL_QA_CASE_FILTER.split(",")
          .map((id) => id.trim())
          .includes(photo.id),
      );

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function fetchCommonsPhoto(file: string): Promise<string> {
  const url = `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(file)}?width=896`;
  const response = await fetch(url, {
    headers: { "User-Agent": "mc-skin-creator-regression/1.0" },
  });
  if (!response.ok) throw new Error(`Commons HTTP ${response.status}`);
  const mime =
    response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

class RecordingImageProvider implements SkinGenerationProvider {
  readonly calls: Array<{ request: SkinGenerationRequest; result: SkinGenerationResult }> = [];

  constructor(private readonly delegate: SkinGenerationProvider) {}

  async generate(request: SkinGenerationRequest): Promise<SkinGenerationResult> {
    const result = await this.delegate.generate(request);
    this.calls.push({ request, result });
    return result;
  }
}

function pngDataUrl(image: RawImage): Promise<string> {
  return encodePng(image).then((bytes) => `data:image/png;base64,${bytesToBase64(bytes)}`);
}

function cropGeneratedSheetFace(sheet: RawImage, mode: "front_view" | "four_view"): RawImage {
  const slotWidth = Math.floor(sheet.width / (mode === "four_view" ? 4 : 2));
  const cropWidth = Math.max(32, Math.floor(slotWidth * 0.72));
  const cropHeight = Math.max(32, Math.floor(sheet.height * 0.42));
  const startX = Math.max(0, Math.floor((slotWidth - cropWidth) / 2));
  const startY = 0;
  const rgba = new Uint8Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const sourceStart = ((startY + y) * sheet.width + startX) * 4;
    rgba.set(sheet.rgba.subarray(sourceStart, sourceStart + cropWidth * 4), y * cropWidth * 4);
  }
  return { width: cropWidth, height: cropHeight, rgba };
}

function parseDiagnostic(value: string | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

describe.skipIf(!PROCEDURAL_IDENTITY_QA)("live procedural head candidate before/after", () => {
  it("uses one analysis and bounded A/B ranking per diverse public CC portrait", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    if (!LIVE_ARTIFACT_DIR) throw new Error("LIVE_GEMINI_ARTIFACT_DIR is required for procedural identity QA");
    const selectedCases = REAL_PHOTO_CASES.filter((photo) =>
      IDENTITY_STAGE_CASE_FILTER.split(",").map((id) => id.trim()).includes(photo.id),
    );
    const summaries: Record<string, unknown>[] = [];
    const semanticPlans: FacePixelPlan[] = [];
    const geometryPlans: FacePixelPlan[] = [];
    const hairSamples: Array<{
      id: string;
      plan: ReturnType<typeof buildSkinPlan>["hairPlan"];
      facePlan: FacePixelPlan;
    }> = [];
    for (const source of selectedCases) {
      const dataUrl = await fetchCommonsPhoto(source.file);
      const env = {
        GEMINI_API_KEY: key,
        VISION_MODEL: LIVE_VISION_MODEL,
        VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
        GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
      } as Env;
      const analysisResult = await runPhotoAnalysis(env, dataUrl);
      expect(analysisResult.ok, analysisResult.ok ? undefined : analysisResult.detail).toBe(true);
      if (!analysisResult.ok) continue;
      let analysis = analysisResult.analysis;
      const heuristicCrops = await createHeuristicIdentityCrops(dataUrl);
      const crops = await createIdentityCrops(dataUrl, analysis.sourceSelection.portraitRegion);
      expect(crops, `${source.id}: focused crops missing`).toBeTruthy();
      expect(heuristicCrops, `${source.id}: heuristic control crops missing`).toBeTruthy();
      if (!crops || !heuristicCrops) continue;
      const faceCropDataUrl = crops.faceDataUrl;
      const headCropDataUrl = crops.headDataUrl;
      const detailResult = await runPortraitDetailAnalysis(env, headCropDataUrl);
      if (detailResult.ok) analysis = applyFocusedPortraitDetail(analysis, detailResult.detail);
      const oldGeometryResult = await runIdentityGeometryAnalysis(env, heuristicCrops.faceDataUrl, heuristicCrops.headDataUrl, analysis);
      expect(oldGeometryResult.ok, oldGeometryResult.ok ? undefined : oldGeometryResult.detail).toBe(true);
      if (!oldGeometryResult.ok) continue;
      const oldRenderAnalysis = normalizeAnalysisForRendering({ ...analysis, identityGeometry: oldGeometryResult.geometry });
      const oldSkinPlan = buildSkinPlan(oldRenderAnalysis);
      const geometryResult = await runIdentityGeometryAnalysis(env, faceCropDataUrl, headCropDataUrl, analysis);
      expect(geometryResult.ok, geometryResult.ok ? undefined : geometryResult.detail).toBe(true);
      if (!geometryResult.ok) continue;
      analysis = { ...analysis, identityGeometry: geometryResult.geometry };
      const renderAnalysis = normalizeAnalysisForRendering(analysis);
      const skinPlan = buildSkinPlan(renderAnalysis);
      hairSamples.push({ id: source.id, plan: skinPlan.hairPlan, facePlan: skinPlan.facePixelPlan });
      semanticPlans.push(oldSkinPlan.facePixelPlan);
      geometryPlans.push(skinPlan.facePixelPlan);
      const features = refineFeatureColorsFromAnalysis(
        renderAnalysis,
        fallbackFeaturesToHex(renderAnalysis.fallbackFeatures, renderAnalysis.renderHints.skinUndertone),
      );
      const faceStyle = buildFaceStyle(renderAnalysis, features);
      const baseline = buildProceduralFallbackAtlas(features, faceStyle, skinPlan);
      expect(baseline, `${source.id}: baseline renderer failed`).toBeTruthy();
      if (!baseline) continue;
      const oldPlanned = createFacePlanAtlasCandidate(baseline, oldSkinPlan.facePixelPlan, faceStyle, skinPlan.facePixelPlan);
      const planned = createFacePlanAtlasCandidate(baseline, skinPlan.facePixelPlan, faceStyle, skinPlan.facePixelPlan);
      const topologyVariant = buildFacePixelPlanVariants(renderAnalysis, 3)
        .find((variant) => variant.layout.mouthTopology !== skinPlan.facePixelPlan.layout.mouthTopology);
      const topologyAtlas = topologyVariant ? createFacePlanAtlasCandidate(baseline, topologyVariant, faceStyle, skinPlan.facePixelPlan) : undefined;
      const plannedStructurallyValid = validateFinalAtlas(planned).ok;
      const plannedCraftValidation = validateAtlasCraft(planned, faceStyle, skinPlan.facePixelPlan, skinPlan.hairPlan);
      const plannedCraftValid = plannedCraftValidation.ok;
      const oldViews = renderSkinViews(oldPlanned);
      const plannedViews = renderSkinViews(planned);
      const pairwise = await runHeadPairwiseComparison(
        env,
        renderAnalysis,
        faceCropDataUrl,
        await pngDataUrl(buildHeadViewMontage(oldViews)),
        await pngDataUrl(buildHeadViewMontage(plannedViews)),
        "candidate_selection",
        headCropDataUrl,
        measureHeadCandidateStructure(oldPlanned, oldSkinPlan.facePixelPlan, oldSkinPlan.hairPlan),
        measureHeadCandidateStructure(planned, skinPlan.facePixelPlan, skinPlan.hairPlan),
      );
      const topologyCraft = topologyAtlas && topologyVariant
        ? validateAtlasCraft(topologyAtlas, faceStyle, topologyVariant, skinPlan.hairPlan)
        : null;
      const topologyPairwise = topologyAtlas && topologyVariant && topologyCraft?.ok
        ? await runHeadPairwiseComparison(
            env,
            renderAnalysis,
            faceCropDataUrl,
            await pngDataUrl(buildHeadViewMontage(plannedViews)),
            await pngDataUrl(buildHeadViewMontage(renderSkinViews(topologyAtlas))),
            "candidate_selection",
            headCropDataUrl,
            measureHeadCandidateStructure(planned, skinPlan.facePixelPlan, skinPlan.hairPlan),
            measureHeadCandidateStructure(topologyAtlas, topologyVariant, skinPlan.hairPlan),
          )
        : null;
      const selectedPlanned = plannedStructurallyValid && plannedCraftValid && pairwise.ok && shouldAcceptIdentityCorrection(pairwise.review);
      const afterAtlas = selectedPlanned ? planned : oldPlanned;
      const beforeCritique = await runSkinCritique(
        env,
        renderAnalysis,
        [dataUrl],
        await pngDataUrl(buildSkinViewMontage(oldViews)),
        oldSkinPlan,
        oldPlanned,
        faceCropDataUrl,
      );
      const afterCritique = await runSkinCritique(
        env,
        renderAnalysis,
        [dataUrl],
        await pngDataUrl(buildSkinViewMontage(plannedViews)),
        skinPlan,
        planned,
        faceCropDataUrl,
      );
      const afterViews = selectedPlanned ? plannedViews : oldViews;
      const sourceFace = await decodeImage(Uint8Array.from(atob(faceCropDataUrl.split(",")[1]), (value) => value.charCodeAt(0)));
      const sourceHead = await decodeImage(Uint8Array.from(atob(headCropDataUrl.split(",")[1]), (value) => value.charCodeAt(0)));
      const original = await decodeImage(Uint8Array.from(atob(dataUrl.split(",")[1]), (value) => value.charCodeAt(0)));
      const metrics = {
        case: source.id,
        license: source.license,
        sourcePage: source.page,
        generationProvider: "deterministic_renderer",
        originalInputDimensions: { width: original.width, height: original.height },
        cropComparison: {
          before: heuristicCrops.diagnostics,
          after: crops.diagnostics,
          subjectAwareActivated: crops.diagnostics.cropMode === "subject_aware",
        },
        faceCropDimensions: crops.diagnostics.face,
        headCropDimensions: crops.diagnostics.head,
        sourceGeometryBefore: oldGeometryResult.geometry,
        sourceGeometryAfter: geometryResult.geometry,
        oldFacePixelPlan: oldSkinPlan.facePixelPlan,
        newFacePixelPlan: skinPlan.facePixelPlan,
        sourceP5Contract: skinPlan.facePixelPlan.renderContract,
        topology: {
          old: { mouth: oldSkinPlan.facePixelPlan.layout.mouthTopology, eyes: oldSkinPlan.facePixelPlan.layout.eyeTopology },
          next: { mouth: skinPlan.facePixelPlan.layout.mouthTopology, eyes: skinPlan.facePixelPlan.layout.eyeTopology },
        },
        headMaskSummary: {
          template: skinPlan.hairPlan.template,
          source: skinPlan.hairPlan.headMask.source,
          coverageByFace: Object.fromEntries(Object.entries(skinPlan.hairPlan.headMask.faces).map(([face, points]) => [face, points.length])),
          endpointRows: skinPlan.hairPlan.headMask.endpointRows,
          partColumn: skinPlan.hairPlan.headMask.partColumn,
          earExposure: skinPlan.hairPlan.headMask.earExposure,
        },
        hairInformationFlow: measureHairInformationFlow(
          renderAnalysis,
          skinPlan.hairPlan,
          skinPlan.facePixelPlan,
          planned,
        ),
        deterministicQuantization: {
          old: oldSkinPlan.facePixelPlan.candidateCost,
          next: skinPlan.facePixelPlan.candidateCost,
        },
        planDifference: compareFacePlans(oldSkinPlan.facePixelPlan, skinPlan.facePixelPlan),
        candidateSelected: selectedPlanned ? "geometry-face-plan-primary" : "semantic-face-plan-primary",
        pairwise: pairwise.ok ? pairwise.review : { failed: true, detail: pairwise.detail },
        topologyAlternative: topologyVariant ? {
          facePixelPlan: topologyVariant,
          craft: topologyCraft,
          pairwise: topologyPairwise ? topologyPairwise.ok ? topologyPairwise.review : { failed: true, detail: topologyPairwise.detail } : null,
        } : null,
        identityDimensionResults: pairwise.ok ? pairwise.review.identityDimensions : null,
        largestLossStage: selectedPlanned ? "categorical_analysis_to_face_plan" : "normalized_geometry_to_8x8_head",
        beforeScores: beforeCritique.ok ? beforeCritique.critique : null,
        afterScores: afterCritique.ok ? afterCritique.critique : null,
        p5FinalStatus: afterCritique.ok ? afterCritique.critique.p5IdentityChecks : null,
        beforeCraft: measureAtlasCraft(oldPlanned),
        afterCraft: measureAtlasCraft(afterAtlas),
        craftStatus: {
          before: "valid",
          planned: plannedCraftValid && plannedStructurallyValid ? "valid" : "rejected",
          plannedProblems: [...plannedCraftValidation.problems, ...(plannedStructurallyValid ? [] : ["final atlas validation failed"])],
        },
        correctionAccepted: false,
        strictThresholds: { identity: 88, faceHair: 85, outfit: 78, consistency: 82, layer: 70, p5HardGate: true },
      };
      const front = extractRenderedHeadView(afterViews.find((view) => view.name === "front")!);
      const left = extractRenderedHeadView(afterViews.find((view) => view.name === "front_left_three_quarter")!);
      const right = extractRenderedHeadView(afterViews.find((view) => view.name === "front_right_three_quarter")!);
      await writeIdentityEvaluationArtifacts(LIVE_ARTIFACT_DIR, source.id, {
        sourceFace,
        sourceHead,
        packedHeadBefore: extractRenderedHeadView(oldViews[0]),
        facePixelPlan: skinPlan.facePixelPlan,
        oldFacePixelPlan: oldSkinPlan.facePixelPlan,
        candidateA: buildHeadViewMontage(oldViews),
        candidateB: buildHeadViewMontage(plannedViews),
        candidateC: topologyAtlas ? buildHeadViewMontage(renderSkinViews(topologyAtlas)) : undefined,
        ...buildHeadLayerDiagnosticViews(afterAtlas),
        finalHeadFront: front,
        finalHeadLeft: left,
        finalHeadRight: right,
        finalSkin: afterAtlas,
        critique: { before: beforeCritique, after: afterCritique },
        metrics,
      });
      summaries.push(metrics);
    }
    await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
    await writeFile(join(LIVE_ARTIFACT_DIR, "procedural-identity-summary.json"), JSON.stringify({
      cases: summaries,
      planConvergence: {
        semanticFallback: measureFacePlanConvergence(semanticPlans),
        normalizedGeometry: measureFacePlanConvergence(geometryPlans),
      },
      hairQuantizationCollisions: findHairQuantizationCollisions(hairSamples),
    }, null, 2), "utf8");
    expect(summaries).toHaveLength(selectedCases.length);
  }, 900_000);
});

describe.skipIf(!IDENTITY_STAGE_QA)("live bounded identity-stage diagnosis", () => {
  it("compares generated and deterministic heads across diverse public CC portraits", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    if (!LIVE_ARTIFACT_DIR) throw new Error("LIVE_GEMINI_ARTIFACT_DIR is required for identity-stage QA");
    const selectedCases = REAL_PHOTO_CASES.filter((photo) =>
      IDENTITY_STAGE_CASE_FILTER.split(",").map((id) => id.trim()).includes(photo.id),
    );
    if (selectedCases.length === 0) throw new Error("No identity-stage cases selected");
    const summaries: Record<string, unknown>[] = [];

    for (const source of selectedCases) {
      const dataUrl = await fetchCommonsPhoto(source.file);
      const diagnostics = new Map<string, string>();
      const env = {
        GEMINI_API_KEY: key,
        VISION_MODEL: LIVE_VISION_MODEL,
        VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
        GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
        GEMINI_IMAGE_TIMEOUT_MS: LIVE_IMAGE_TIMEOUT_MS,
        GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
        GEMINI_IMAGE_QUALITY_MODEL: "gemini-3.1-flash-image",
        IMAGE_GENERATION_ENABLED: "true",
        IMAGE_GEN_STRATEGY: "four_view",
        IMAGE_MODEL_TIER: "quality",
        IMAGE_CRITIQUE_ENABLED: "true",
        HEAD_CANDIDATE_SELECTION_ENABLED: "true",
        WORKERS_IMAGE_FALLBACK_ENABLED: "false",
        MCSKIN_KV: {
          put: async (name: string, value: string) => { diagnostics.set(name, value); },
        } as unknown as KVNamespace,
      } as Env;
      const provider = new RecordingImageProvider(new ResilientImageProvider(env));
      const generation = await generateSkin(env, dataUrl, provider);
      const successful = provider.calls.find((call) => call.result.ok);
      const recorded = successful ?? provider.calls[0];
      expect(recorded, `${source.id}: generation request was not recorded`).toBeTruthy();
      if (!recorded) continue;

      const requestAnalysis = normalizeAnalysisForRendering(recorded.request.analysis);
      const features = refineFeatureColorsFromAnalysis(
        requestAnalysis,
        fallbackFeaturesToHex(requestAnalysis.fallbackFeatures, requestAnalysis.renderHints.skinUndertone),
      );
      const faceStyle = buildFaceStyle(requestAnalysis, features);
      let beforeAtlas: RawImage | null = null;
      let deterministicAtlas: RawImage | undefined;
      let generatedSheetFace: RawImage | undefined;
      let generatedFaceStructuralValidity = false;
      if (successful?.result.ok) {
        const processed = await postprocessGeneratedSheet(
          successful.result.imageBytes,
          0,
          successful.result.mode ?? successful.request.mode,
          faceStyle,
          successful.request.skinPlan,
        );
        beforeAtlas = processed.atlas ?? null;
        generatedFaceStructuralValidity = processed.generatedFacePreserved === true;
        const sheet = await decodeImage(successful.result.imageBytes);
        generatedSheetFace = cropGeneratedSheetFace(sheet, successful.result.mode ?? successful.request.mode);
      } else {
        beforeAtlas = buildProceduralFallbackAtlas(features, faceStyle, recorded.request.skinPlan);
        if (beforeAtlas) {
          deterministicAtlas = createFacePlanAtlasCandidate(beforeAtlas, recorded.request.skinPlan.facePixelPlan, faceStyle);
        }
      }
      expect(beforeAtlas, `${source.id}: no baseline atlas`).toBeTruthy();
      if (!beforeAtlas) continue;
      deterministicAtlas ??= createFacePlanAtlasCandidate(
        beforeAtlas,
        recorded.request.skinPlan.facePixelPlan,
        faceStyle,
      );

      const sourceCropDataUrl = recorded.request.identityCropDataUrl ?? await createUpperBodyDetailCrop(dataUrl);
      expect(sourceCropDataUrl, `${source.id}: no focused source crop`).toBeTruthy();
      if (!sourceCropDataUrl) continue;
      const sourceFace = await decodeImage(Uint8Array.from(atob(sourceCropDataUrl.split(",")[1]), (value) => value.charCodeAt(0)));
      const beforeViews = renderSkinViews(beforeAtlas);
      const beforeMontageDataUrl = await pngDataUrl(buildSkinViewMontage(beforeViews));
      const beforeCritique = await runSkinCritique(
        env,
        requestAnalysis,
        [dataUrl],
        beforeMontageDataUrl,
        recorded.request.skinPlan,
        beforeAtlas,
        sourceCropDataUrl,
      );

      const finalAtlas = generation.body.skinPngBase64
        ? await decodePng(Uint8Array.from(atob(generation.body.skinPngBase64), (value) => value.charCodeAt(0)))
        : beforeAtlas;
      const finalViews = renderSkinViews(finalAtlas);
      const afterCritique = await runSkinCritique(
        env,
        requestAnalysis,
        [dataUrl],
        await pngDataUrl(buildSkinViewMontage(finalViews)),
        recorded.request.skinPlan,
        finalAtlas,
        sourceCropDataUrl,
      );
      const front = extractRenderedHeadView(finalViews.find((view) => view.name === "front")!);
      const left = extractRenderedHeadView(finalViews.find((view) => view.name === "front_left_three_quarter")!);
      const right = extractRenderedHeadView(finalViews.find((view) => view.name === "front_right_three_quarter")!);
      const candidateA = buildHeadViewMontage(beforeViews);
      const candidateB = deterministicAtlas
        ? buildHeadViewMontage(renderSkinViews(deterministicAtlas))
        : undefined;
      const selection = parseDiagnostic(diagnostics.get("diagnostic:last-head-candidate-selection")) as { selected?: string } | null;
      const beforeScores = beforeCritique.ok ? beforeCritique.critique : null;
      const afterScores = afterCritique.ok ? afterCritique.critique : null;
      const largestLossStage = selection?.selected === "face-plan-primary"
        ? successful ? "generated_sheet_identity" : "procedural_compose_face"
        : beforeScores && beforeScores.identityScore < 88
          ? "analysis_to_8x8_head"
          : "post_head_outfit_or_continuity";
      const metrics = {
        case: source.id,
        license: source.license,
        sourcePage: source.page,
        generationProvider: generation.body.generationProvider ?? recorded.result.provider,
        generationModel: generation.body.generationModel ?? recorded.result.model,
        imageGenerationAvailable: Boolean(successful),
        imageGenerationFailure: successful ? null : (recorded.result.ok ? null : recorded.result.error),
        inputDiagnostics: recorded.result.inputDiagnostics,
        providerInputLimit: recorded.result.providerInputLimit,
        generatedFaceStructuralValidity,
        candidateSelected: selection?.selected ?? "generated_or_single_candidate",
        pairwiseSelection: parseDiagnostic(diagnostics.get("diagnostic:last-head-candidate-selection")),
        correction: parseDiagnostic(diagnostics.get("diagnostic:last-targeted-correction")) ?? parseDiagnostic(diagnostics.get("diagnostic:last-procedural-correction")),
        largestLossStage,
        beforeScores,
        afterScores,
        finalSuccess: generation.success,
        strictThresholds: { identity: 88, faceHair: 85, outfit: 78, consistency: 82, layer: 70, p5HardGate: true },
      };
      await writeIdentityEvaluationArtifacts(LIVE_ARTIFACT_DIR, source.id, {
        sourceFace,
        generatedSheetFace,
        packedHeadBefore: extractRenderedHeadView(beforeViews[0]),
        facePixelPlan: recorded.request.skinPlan.facePixelPlan,
        candidateA,
        candidateB,
        ...buildHeadLayerDiagnosticViews(finalAtlas),
        finalHeadFront: front,
        finalHeadLeft: left,
        finalHeadRight: right,
        finalSkin: finalAtlas,
        critique: { before: beforeCritique, after: afterCritique },
        metrics,
      });
      summaries.push(metrics);
    }
    await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
    await writeFile(join(LIVE_ARTIFACT_DIR, "identity-stage-summary.json"), JSON.stringify(summaries, null, 2), "utf8");
    expect(summaries).toHaveLength(selectedCases.length);
  }, 900_000);
});

describe.skipIf(!LIVE)("live diverse real-photo Gemini analysis", () => {
  for (const photo of REAL_PHOTO_CASES) {
    it(`${photo.id} yields a salient canonical identity`, async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is required");
      const dataUrl = await fetchCommonsPhoto(photo.file);
      const result = await runPhotoAnalysis(
        {
          GEMINI_API_KEY: key,
          VISION_MODEL: "gemini-3.6-flash",
          VISION_FALLBACK_MODEL: "gemini-3.6-flash",
        } as Env,
        dataUrl,
      );
      expect(result.ok, result.ok ? undefined : result.detail).toBe(true);
      if (!result.ok) return;
      expect(result.analysis.quality).not.toBe("fail");
      expect(
        result.analysis.canonicalIdentity.mustPreserve.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        result.analysis.canonicalIdentity.features.length,
      ).toBeGreaterThanOrEqual(4);
      expect(
        result.analysis.canonicalIdentity.features[0].priority,
      ).toBeGreaterThanOrEqual(4);
      expect(
        result.analysis.canonicalIdentity.features.every(
          (feature) => feature.targetRegions.length > 0,
        ),
      ).toBe(true);
      const evidence = [
        result.analysis.observed.hair,
        result.analysis.observed.accessories,
        result.analysis.observed.clothing,
        ...result.analysis.canonicalIdentity.mustPreserve,
      ].join(" ");
      expect(evidence).toMatch(photo.expectedCue);
    }, 120_000);
  }
});

describe.skipIf(!FULL_LIVE)("live end-to-end Gemini skin generation", () => {
  it("runs a real photo through image generation, UV packing, six-view render and critique", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    const source = REAL_PHOTO_CASES.find(
      (photo) => photo.id === "headscarf-color-blocks",
    )!;
    const dataUrl = await fetchCommonsPhoto(source.file);
    const result = await generateSkin(
      {
        GEMINI_API_KEY: key,
        // Keep the full-path smoke independent from the 3.6 model's much
        // smaller free daily request bucket used by the six-case analysis.
        VISION_MODEL: LIVE_VISION_MODEL,
        VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
        GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
        GEMINI_IMAGE_TIMEOUT_MS: LIVE_IMAGE_TIMEOUT_MS,
        GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
        GEMINI_IMAGE_QUALITY_MODEL: "gemini-3.1-flash-image",
        IMAGE_GENERATION_ENABLED: "true",
        IMAGE_GEN_STRATEGY: "four_view",
        IMAGE_MODEL_TIER: "quality",
        IMAGE_CRITIQUE_ENABLED: "true",
        MCSKIN_KV: {
          put: async () => undefined,
        } as unknown as KVNamespace,
      },
      dataUrl,
    );
    expect(result.success, result.body.error).toBe(true);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.skinPngBase64?.length).toBeGreaterThan(1_000);
  }, 300_000);
});

describe.skipIf(!PROCEDURAL_QA)(
  "live real-photo procedural fallback quality",
  () => {
    if (PROCEDURAL_QA_CASES.length === 0) {
      it("selects at least one known procedural QA case", () => {
        throw new Error(
          `No real-photo case matched LIVE_GEMINI_PROCEDURAL_CASES=${PROCEDURAL_QA_CASE_FILTER}`,
        );
      });
    }

    for (const source of PROCEDURAL_QA_CASES) {
      it(`${source.id} renders and passes strict six-view Gemini critique`, async () => {
        const key = process.env.GEMINI_API_KEY;
        if (!key) throw new Error("GEMINI_API_KEY is required");
        const dataUrl = await fetchCommonsPhoto(source.file);
        const analysisResult = await runPhotoAnalysis(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
          } as Env,
          dataUrl,
        );
        expect(
          analysisResult.ok,
          analysisResult.ok ? undefined : analysisResult.detail,
        ).toBe(true);
        if (!analysisResult.ok) return;
        if (LIVE_DEBUG) {
          console.log(
            `${source.id} analysis`,
            JSON.stringify(
              {
                observed: analysisResult.analysis.observed,
                canonicalIdentity: analysisResult.analysis.canonicalIdentity,
                identityPrompt: analysisResult.analysis.identityPrompt,
                renderHints: analysisResult.analysis.renderHints,
                fallbackFeatures: analysisResult.analysis.fallbackFeatures,
              },
              null,
              2,
            ),
          );
        }

        // Persist the primary analysis before generation so a structural
        // fallback failure still leaves enough evidence for a deterministic
        // replay and renderer diagnosis.
        if (LIVE_ARTIFACT_DIR) {
          await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
          await writeFile(
            join(LIVE_ARTIFACT_DIR, `${source.id}-primary-analysis.json`),
            JSON.stringify(
              { primaryAnalysis: analysisResult.analysis },
              null,
              2,
            ),
            "utf8",
          );
        }

        const generation = await generateSkin(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
            MCSKIN_KV: {
              put: async () => undefined,
            } as unknown as KVNamespace,
            IMAGE_GENERATION_ENABLED: "false",
          },
          dataUrl,
        );
        expect(generation.success, generation.body.error).toBe(true);
        expect(
          generation.body.skinPngBase64,
          "generation succeeded without a skin PNG",
        ).toBeTruthy();
        if (!generation.body.skinPngBase64) return;
        const atlasBytes = Uint8Array.from(
          atob(generation.body.skinPngBase64),
          (value) => value.charCodeAt(0),
        );
        const atlas = await decodePng(atlasBytes);
        const montage = buildSkinViewMontage(renderSkinViews(atlas));
        const montageBytes = await encodePng(montage);
        const montageDataUrl = `data:image/png;base64,${bytesToBase64(montageBytes)}`;
        if (LIVE_ARTIFACT_DIR) {
          await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
          await Promise.all([
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-skin.png`),
              atlasBytes,
            ),
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-six-view.png`),
              montageBytes,
            ),
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-analysis.json`),
              JSON.stringify(
                {
                  primaryAnalysis: analysisResult.analysis,
                  generationAnalysis: generation.body.analysis,
                },
                null,
                2,
              ),
              "utf8",
            ),
          ]);
        }
        const critique = await runSkinCritique(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
          } as Env,
          analysisResult.analysis,
          [dataUrl],
          montageDataUrl,
          generation.body.analysis?.skinPlan,
          atlas,
        );
        if (LIVE_ARTIFACT_DIR) {
          await writeFile(
            join(LIVE_ARTIFACT_DIR, `${source.id}-critique.json`),
            JSON.stringify(critique, null, 2),
            "utf8",
          );
        }
        expect(critique.ok, critique.ok ? undefined : critique.detail).toBe(
          true,
        );
        if (!critique.ok) return;
        expect(critique.approved, JSON.stringify(critique.critique)).toBe(true);
      }, 300_000);
    }
  },
);

describe.skipIf(!MULTI_PHOTO_QA)(
  "live same-person multi-photo canonical integration",
  () => {
    it("uses the face crop for portrait identity and the full-body view for outfit and generation", async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is required");
      const [portraitDataUrl, fullBodyDataUrl] = await Promise.all([
        fetchCommonsPhoto(MULTI_PHOTO_CASE.portraitFile),
        fetchCommonsPhoto(MULTI_PHOTO_CASE.fullBodyFile),
      ]);
      const env = {
        GEMINI_API_KEY: key,
        VISION_MODEL: LIVE_VISION_MODEL,
        VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
        GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
        MCSKIN_KV: {
          put: async () => undefined,
        } as unknown as KVNamespace,
        IMAGE_GENERATION_ENABLED: "false",
      } as Env;

      const analysisResult = await runPhotoAnalysis(env, [
        portraitDataUrl,
        fullBodyDataUrl,
      ]);
      expect(
        analysisResult.ok,
        analysisResult.ok ? undefined : analysisResult.detail,
      ).toBe(true);
      if (!analysisResult.ok) return;

      const selection = analysisResult.analysis.sourceSelection;
      expect(selection.portraitImageIndex).toBe(0);
      expect(selection.outfitImageIndex).toBe(1);
      expect(selection.generationImageIndex).toBe(1);
      expect(selection.portraitEvidence.length).toBeGreaterThanOrEqual(8);
      expect(selection.outfitEvidence.length).toBeGreaterThanOrEqual(8);
      expect(selection.generationEvidence.length).toBeGreaterThanOrEqual(8);
      expect(["three_quarter", "full_body"]).toContain(
        analysisResult.analysis.framing,
      );
      expect(analysisResult.analysis.visibleRegions.lowerBody).toBe(true);
      expect(analysisResult.analysis.visibleRegions.feet).toBe(true);
      expect(analysisResult.analysis.inferred.lowerBody).toBeNull();
      expect(analysisResult.analysis.inferred.shoes).toBeNull();

      const generation = await generateSkin(
        env,
        portraitDataUrl,
        undefined,
        portraitDataUrl,
        [fullBodyDataUrl],
      );
      expect(generation.success, generation.body.error).toBe(true);
      expect(generation.body.generationMode).toBe("procedural_fallback");
      expect(generation.body.analysis?.sourceSelection).toMatchObject({
        portraitImageIndex: 0,
        outfitImageIndex: 1,
        generationImageIndex: 1,
      });

      const atlasBytes = Uint8Array.from(
        atob(generation.body.skinPngBase64!),
        (value) => value.charCodeAt(0),
      );
      const atlas = await decodePng(atlasBytes);
      const montage = buildSkinViewMontage(renderSkinViews(atlas));
      const montageBytes = await encodePng(montage);
      const montageDataUrl = `data:image/png;base64,${bytesToBase64(montageBytes)}`;
      const critique = await runSkinCritique(
        env,
        analysisResult.analysis,
        [portraitDataUrl, fullBodyDataUrl],
        montageDataUrl,
        generation.body.analysis?.skinPlan,
        atlas,
      );

      if (LIVE_DEBUG) {
        console.log(
          `${MULTI_PHOTO_CASE.id} result`,
          JSON.stringify(
            {
              sourceSelection: selection,
              framing: analysisResult.analysis.framing,
              visibleRegions: analysisResult.analysis.visibleRegions,
              observed: analysisResult.analysis.observed,
              inferred: analysisResult.analysis.inferred,
              generationSelection: generation.body.analysis?.sourceSelection,
              critique: critique.ok ? critique.critique : critique.detail,
            },
            null,
            2,
          ),
        );
      }

      if (LIVE_ARTIFACT_DIR) {
        await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
        await Promise.all([
          writeFile(
            join(LIVE_ARTIFACT_DIR, `${MULTI_PHOTO_CASE.id}-skin.png`),
            atlasBytes,
          ),
          writeFile(
            join(LIVE_ARTIFACT_DIR, `${MULTI_PHOTO_CASE.id}-six-view.png`),
            montageBytes,
          ),
          writeFile(
            join(LIVE_ARTIFACT_DIR, `${MULTI_PHOTO_CASE.id}-analysis.json`),
            JSON.stringify(
              {
                primaryAnalysis: analysisResult.analysis,
                generationAnalysis: generation.body.analysis,
                critique: critique.ok ? critique.critique : critique.detail,
              },
              null,
              2,
            ),
            "utf8",
          ),
        ]);
      }

      expect(critique.ok, critique.ok ? undefined : critique.detail).toBe(true);
      if (!critique.ok) return;
      expect(critique.approved, JSON.stringify(critique.critique)).toBe(true);
    }, 300_000);
  },
);
