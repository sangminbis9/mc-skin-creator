/**
 * Opt-in, evaluation-only old/new crop artifacts over the existing Commons
 * regression sources. No model, localization, geometry, or evaluator API is
 * called. The comparison deliberately uses the same deterministic fallback
 * inputs that produced the stored clipping regression.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentityCrops } from "../src/generate";
import { bytesToBase64, decodeImage, decodePng } from "../src/png";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { drawNormalizedBoxes, writeHeadCropEvaluationArtifacts } from "./headCropArtifacts";

const RUN = process.env.RUN_HEAD_CROP_ARTIFACTS === "1";
const ROOT = resolve(process.env.HEAD_CROP_ARTIFACT_DIR ?? "evaluation-artifacts/head-crop-20260903");
const SOURCE_ROOT = resolve(ROOT, "source-cache");
const PREVIOUS_ROOT = resolve("evaluation-artifacts/head-geometry-20260903");

const CASES: Array<{ id: "short-hair-red-shirt" | "curly-hair"; context: AdaptiveHeadCropContext }> = [
  {
    id: "short-hair-red-shirt",
    context: { hairVolume: "flat", hairTexture: "straight", overallHairLength: "ear", sideHairAsymmetry: "left" },
  },
  {
    id: "curly-hair",
    context: { hairVolume: "full", hairTexture: "curly", overallHairLength: "jaw", sideHairAsymmetry: "left" },
  },
];

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

describe.skipIf(!RUN)("offline adaptive head crop artifacts", () => {
  for (const sample of CASES) it(sample.id, async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(SOURCE_ROOT, `${sample.id}.jpg`)));
    const source = await decodeImage(sourceBytes);
    const dataUrl = `data:image/jpeg;base64,${bytesToBase64(sourceBytes)}`;
    const beforeStartedAt = performance.now();
    const before = await createIdentityCrops(dataUrl, null, {});
    const beforeDurationMs = performance.now() - beforeStartedAt;
    const afterStartedAt = performance.now();
    const after = await createIdentityCrops(dataUrl, null, sample.context);
    const afterDurationMs = performance.now() - afterStartedAt;
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (!before || !after) return;
    const oldBox = before.diagnostics.finalHeadBox!;
    const newBox = after.diagnostics.finalHeadBox!;
    const oldOverlay = drawNormalizedBoxes(source, [
      { box: oldBox, color: [255, 142, 48, 255] },
    ]);
    const newOverlay = drawNormalizedBoxes(source, [
      { box: newBox, color: [68, 224, 117, 255] },
    ]);
    const comparison = drawNormalizedBoxes(source, [
      { box: oldBox, color: [255, 142, 48, 255] },
      { box: newBox, color: [68, 224, 117, 255] },
    ]);
    const finalCrop = await decodeImage(Uint8Array.from(
      atob(after.headDataUrl.split(",")[1]),
      (character) => character.charCodeAt(0),
    ));
    const previous = resolve(PREVIOUS_ROOT, sample.id);
    const storedMetrics = JSON.parse(await readFile(resolve(previous, "metrics.json"), "utf8")) as {
      retention: { after: { stageRetention: { sourceToGeometry: number; geometryToPlan: number; planToAtlas: number } } };
      sourceGeometryAfter: { visibility: Record<string, boolean> };
    };
    const priorVisibility = storedMetrics.sourceGeometryAfter.visibility;
    const beforeComponents = {
      crown: priorVisibility.crownClipped ? 0 : 1,
      leftHair: priorVisibility.leftHairClipped ? 0 : 1,
      rightHair: priorVisibility.rightHairClipped ? 0 : 1,
      temples: average([priorVisibility.leftHairClipped ? 0 : 1, priorVisibility.rightHairClipped ? 0 : 1]),
      ears: average([priorVisibility.leftEarClipped ? 0 : 1, priorVisibility.rightEarClipped ? 0 : 1]),
      chin: priorVisibility.chinClipped ? 0 : 1,
    };
    const afterComponents = {
      crown: after.diagnostics.cropClipping.top ? 0 : 1,
      leftHair: after.diagnostics.cropClipping.left ? 0 : 1,
      rightHair: after.diagnostics.cropClipping.right ? 0 : 1,
      temples: average([after.diagnostics.cropClipping.left ? 0 : 1, after.diagnostics.cropClipping.right ? 0 : 1]),
      ears: average([after.diagnostics.cropClipping.left ? 0 : 1, after.diagnostics.cropClipping.right ? 0 : 1]),
      chin: after.diagnostics.cropClipping.bottom ? 0 : 1,
    };
    const beforeScore = average(Object.values(beforeComponents));
    const afterScore = average(Object.values(afterComponents));
    const stages = storedMetrics.retention.after.stageRetention;
    await writeHeadCropEvaluationArtifacts(ROOT, sample.id, {
      originalSource: source,
      originalHeadBox: oldOverlay,
      desiredAdaptiveBox: newOverlay,
      finalHeadCrop: finalCrop,
      headCropCoverageOverlay: comparison,
      sourceVsCropClipping: comparison,
      geometryOverlay: await decodePng(new Uint8Array(await readFile(resolve(previous, "01c-geometry-overlay.png")))),
      quantizedPlan: await decodePng(new Uint8Array(await readFile(resolve(previous, "04b-quantized-head-plan.png")))),
      finalHead: await decodePng(new Uint8Array(await readFile(resolve(previous, "07-final-head-front.png")))),
      sixView: await decodePng(new Uint8Array(await readFile(resolve(previous, "09e-six-view.png")))),
      metrics: {
        case: sample.id,
        calls: { gemini: 0, geometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0 },
        comparisonBasis: "same original source; legacy deterministic fallback vs semantic-margin deterministic fallback; no photo-specific coordinates",
        oldCropBox: oldBox,
        newCropBox: newBox,
        beforeDiagnostics: before.diagnostics,
        afterDiagnostics: after.diagnostics,
        imageProcessing: {
          sourceEncodedBytes: sourceBytes.byteLength,
          beforeHeadEncodedCharacters: before.headDataUrl.length,
          afterHeadEncodedCharacters: after.headDataUrl.length,
          beforeHeadOutputPixels: before.diagnostics.headCropDimensions.width * before.diagnostics.headCropDimensions.height,
          afterHeadOutputPixels: after.diagnostics.headCropDimensions.width * after.diagnostics.headCropDimensions.height,
          beforeFaceOutputPixels: before.diagnostics.faceCropDimensions.width * before.diagnostics.faceCropDimensions.height,
          afterFaceOutputPixels: after.diagnostics.faceCropDimensions.width * after.diagnostics.faceCropDimensions.height,
          beforeDurationMs,
          afterDurationMs,
          headDataUrlEqual: before.headDataUrl === after.headDataUrl,
          faceDataUrlEqual: before.faceDataUrl === after.faceDataUrl,
        },
        sourceToCrop: { before: beforeScore, after: afterScore, beforeComponents, afterComponents, basis: "stored geometry crop-loss flags vs new deterministic crop-only prediction; source-boundary uncertainty is reported separately" },
        cropToGeometry: { before: stages.sourceToGeometry, after: null, reason: "not claimed without a live geometry replay" },
        geometryToPlan: stages.geometryToPlan,
        planToAtlas: stages.planToAtlas,
        downstreamArtifacts: "07-10 retain the last verified geometry/plan/atlas controls; only 01-06 are regenerated by this crop-only iteration",
      },
    });
  });
});
