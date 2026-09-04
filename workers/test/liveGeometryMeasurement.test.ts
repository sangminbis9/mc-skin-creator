/**
 * Opt-in live geometry-only replay. Exactly one curly call is possible. No
 * evaluator, retry, fallback, alternate model, or probe is imported.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { createIdentityCrops } from "../src/generate";
import { parseIdentityGeometry, runIdentityGeometryAnalysis, type GeometryCropVisibility, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { measureHeadPixelDifference } from "../src/hairSilhouetteFidelity";
import { base64ToBytes, decodePng, type RawImage } from "../src/png";
import { applyHeadIdentityPlan, applyHeadMaskPlan, reconcileBaseHorizontalSeams, reconcileOverlaySeams, type FaceStyle } from "../src/skinPack";
import { buildHeadViewMontage, extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import type { Env } from "../src/types";
import {
  buildCrownContourOverlay,
  buildBeforeAfterHeadMontage,
  buildFaceGeometryOverlay,
  buildFaceWindowOverlay,
  buildFringeGeometryOverlay,
  buildGeometryOverlay,
  buildMajorVolumeGeometryOverlay,
  buildTempleGeometryOverlay,
  renderQuantizedHeadPlan,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_LIVE_GEOMETRY_MEASUREMENT === "1";
const OUTPUT_ROOT = resolve(process.env.LIVE_GEOMETRY_ARTIFACT_DIR ?? "evaluation-artifacts/geometry-measurement-20260904");
const CROP_ROOT = resolve("evaluation-artifacts/head-crop-20260903");
const LEGACY_ROOT = resolve("evaluation-artifacts/head-structure-iteration-final");
const ATLAS_ROOT = resolve("evaluation-artifacts/hair-identity-retention-20260903");

type CaseId = "curly-hair" | "short-hair-red-shirt";

function analysisFor(id: CaseId, identityGeometry?: IdentityGeometryAnalysis): PhotoAnalysis {
  const base = makeAnalysis({ identityGeometry });
  const curly = id === "curly-hair";
  const hair = curly
    ? "asymmetric full blonde curls with visible viewer-left crown, side and lower masses"
    : "short black side-swept hair with two fringe masses and asymmetric temples";
  return {
    ...base,
    identityGeometry,
    observed: { ...base.observed, hair },
    canonicalIdentity: {
      overallImpression: hair,
      mustPreserve: [hair, "source-specific face window"],
      features: [
        { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: "visible in the supplied wide head crop", targetRegions: ["head.front", "head.top", "head.side", "head.overlay"] },
        { feature: "source-specific face window", category: "face", priority: 4, confidence: "high", evidence: "visible hair and skin boundary", targetRegions: ["head.front"] },
      ],
    },
    renderHints: {
      ...base.renderHints,
      hairTexture: curly ? "curly" : "straight",
      hairVolume: curly ? "full" : "flat",
      hairSilhouette: curly ? "tousled" : "swept",
      overallHairLength: curly ? "jaw" : "ear",
      sideHairLength: curly ? "jaw" : "short",
      sideHairShape: curly ? "flared" : "tapered",
      sideHairAsymmetry: "left",
      bangs: curly ? "none" : "side",
      bangsLength: curly ? "none" : "brow",
    },
  };
}

function styleFor(id: CaseId): FaceStyle {
  const curly = id === "curly-hair";
  return {
    eyeColor: curly ? "#567a82" : "#3a2418", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile", facialHair: "none", glasses: "none",
    hairstyle: curly ? "curly" : "short", hat: "none", bangs: curly ? "none" : "side", bangsLength: curly ? "none" : "brow", bangsDensity: "balanced", fringeEdge: "staggered", fringeOpening: "none",
    hairTexture: curly ? "curly" : "straight", hairVolume: curly ? "full" : "flat", hairSilhouette: curly ? "tousled" : "swept", hairPart: curly ? "left" : "right",
    sideHairLength: curly ? "jaw" : "short", sideHairShape: curly ? "flared" : "tapered", sideHairAsymmetry: "left", earExposure: curly ? "covered" : "visible",
  };
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function decodedDataUrl(value: string): Promise<RawImage> {
  const encoded = value.slice(value.indexOf(",") + 1);
  return decodePng(base64ToBytes(encoded));
}

describe.skipIf(!RUN)("bounded live identity geometry measurement replay", () => {
  it("runs curly exactly once and writes source-to-pixel evidence", async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for the explicitly enabled live replay");
    const env = { GEMINI_API_KEY: apiKey, VISION_MODEL: process.env.LIVE_VISION_MODEL ?? "gemini-3.6-flash", GEMINI_STRUCTURED_TIMEOUT_MS: process.env.LIVE_STRUCTURED_TIMEOUT_MS ?? "45000" } as Env;
    let attempted = 0;
    let success = 0;
    for (const id of ["curly-hair"] as const) {
      const sourceBytes = new Uint8Array(await readFile(resolve(CROP_ROOT, "source-cache", `${id}.jpg`)));
      const analysis = analysisFor(id);
      const crops = await createIdentityCrops(dataUrl(sourceBytes), null, {
        hairTexture: analysis.renderHints.hairTexture,
        hairVolume: analysis.renderHints.hairVolume,
        overallHairLength: analysis.renderHints.overallHairLength,
        sideHairAsymmetry: analysis.renderHints.sideHairAsymmetry,
      });
      expect(crops).not.toBeNull();
      if (!crops) throw new Error(`${id}: crop creation failed`);
      const visibility: GeometryCropVisibility = {
        cropClippingKnown: crops.diagnostics.cropMode !== "center_fallback",
        sourceClippingKnown: crops.diagnostics.quality.sourceClippingKnown,
        crownClipped: crops.diagnostics.cropClipping.top,
        leftHairClipped: crops.diagnostics.cropClipping.left,
        rightHairClipped: crops.diagnostics.cropClipping.right,
        chinClipped: crops.diagnostics.cropClipping.bottom,
        leftEarClipped: crops.diagnostics.leftEarClipped,
        rightEarClipped: crops.diagnostics.rightEarClipped,
        sourceCrownClipped: crops.diagnostics.sourceClipping.top,
        sourceLeftHairClipped: crops.diagnostics.sourceClipping.left,
        sourceRightHairClipped: crops.diagnostics.sourceClipping.right,
        sourceChinClipped: crops.diagnostics.sourceClipping.bottom,
      };
      attempted++;
      const result = await runIdentityGeometryAnalysis(env, crops.faceDataUrl, crops.headDataUrl, analysis, visibility);
      if (!result.ok) {
        const failureDirectory = resolve(OUTPUT_ROOT, id);
        await mkdir(failureDirectory, { recursive: true });
        await writeFile(resolve(failureDirectory, "failure-diagnostic.json"), JSON.stringify({
          case: id,
          calls: { geometry: attempted, absoluteEvaluator: 0, pairwiseEvaluator: 0 },
          ...result.diagnostic,
        }, null, 2), "utf8");
      }
      expect(result.ok, result.ok ? undefined : result.detail).toBe(true);
      if (!result.ok) throw new Error(`${id}: geometry failed; no retry permitted`);
      success++;

      const legacyMetrics = JSON.parse(await readFile(resolve(LEGACY_ROOT, id, "metrics.json"), "utf8")) as { sourceGeometryAfter: Record<string, unknown> };
      const beforeGeometry = parseIdentityGeometry(legacyMetrics.sourceGeometryAfter);
      expect(beforeGeometry).not.toBeNull();
      const measuredAnalysis = analysisFor(id, result.geometry);
      const plans = buildIdentityPixelPlans(measuredAnalysis);
      const beforeAtlas = decodePng(new Uint8Array(await readFile(resolve(ATLAS_ROOT, id, "10-final-skin.png"))));
      const afterAtlas: RawImage = { ...beforeAtlas, rgba: beforeAtlas.rgba.slice() };
      const style = styleFor(id);
      const hairColor: [number, number, number] = id === "curly-hair" ? [194, 170, 108] : [28, 24, 22];
      const skinColor: [number, number, number] = id === "curly-hair" ? [211, 158, 137] : [174, 111, 77];
      applyHeadMaskPlan(afterAtlas, plans.hairPlan, hairColor, hairColor, style, plans.facePixelPlan);
      applyHeadIdentityPlan(afterAtlas, plans.headIdentityPlan, plans.hairPlan, hairColor, skinColor, style, true);
      reconcileBaseHorizontalSeams(afterAtlas);
      reconcileOverlaySeams(afterAtlas, style, hairColor);
      const views = renderSkinViews(afterAtlas);
      const beforeViews = renderSkinViews(beforeAtlas);
      const sourceFace = await decodedDataUrl(crops.faceDataUrl);
      const sourceHead = await decodedDataUrl(crops.headDataUrl);
      const front = extractRenderedHeadView(views.find((view) => view.name === "front")!);
      const beforeFront = extractRenderedHeadView(beforeViews.find((view) => view.name === "front")!);
      const caseDirectory = resolve(OUTPUT_ROOT, id);
      await mkdir(caseDirectory, { recursive: true });
      await writeFile(resolve(caseDirectory, "00-source.jpg"), sourceBytes);
      await writeIdentityEvaluationArtifacts(OUTPUT_ROOT, id, {
        sourceFace, sourceHead,
        geometryOverlay: beforeGeometry ? buildGeometryOverlay(sourceHead, beforeGeometry) : undefined,
        sourceHeadGeometryOverlay: buildGeometryOverlay(sourceHead, result.geometry),
        sourceFaceGeometryOverlay: buildFaceGeometryOverlay(sourceFace, result.geometry),
        fringeGeometryOverlay: buildFringeGeometryOverlay(sourceHead, result.geometry),
        templeGeometryOverlay: buildTempleGeometryOverlay(sourceHead, result.geometry),
        crownContourOverlay: buildCrownContourOverlay(sourceHead, result.geometry),
        majorVolumeOverlay: buildMajorVolumeGeometryOverlay(sourceHead, result.geometry),
        faceWindowOverlay: buildFaceWindowOverlay(sourceHead, result.geometry),
        quantizedHeadPlan: renderQuantizedHeadPlan(plans.hairPlan, plans.facePixelPlan),
        sixView: buildHeadViewMontage(views), facePixelPlan: plans.facePixelPlan,
        packedHeadBefore: beforeFront,
        beforeAfterHeadMontage: buildBeforeAfterHeadMontage(beforeFront, front),
        finalHeadFront: front,
        finalHeadLeft: extractRenderedHeadView(views.find((view) => view.name === "left")!),
        finalHeadRight: extractRenderedHeadView(views.find((view) => view.name === "right")!),
        finalSkin: afterAtlas, critique: { absoluteEvaluator: "not run", pairwiseEvaluator: "not run" },
        metrics: {
          case: id,
          calls: { geometry: 1, absoluteEvaluator: 0, pairwiseEvaluator: 0 },
          geometryBefore: beforeGeometry,
          geometryAfter: result.geometry,
          completeness: result.geometry.diagnostics.completeness,
          validationIssues: result.geometry.diagnostics.issues,
          geometryProvenance: plans.headIdentityPlan.geometryProvenance,
          requestShape: result.requestShape,
          quantizedGeometry: plans.facePixelPlan.layout,
          pixelDifference: measureHeadPixelDifference(beforeAtlas, afterAtlas, plans.facePixelPlan),
          cropDiagnostics: crops.diagnostics,
        },
      });
    }
    expect({ attempted, success }).toEqual({ attempted: 1, success: 1 });
  }, 120_000);
});
