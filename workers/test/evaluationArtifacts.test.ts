import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis, makeIdentityGeometry, makeSyntheticAtlas } from "./helpers";
import {
  buildCrownContourOverlay,
  buildFaceGeometryOverlay,
  buildFaceWindowOverlay,
  buildFringeGeometryOverlay,
  buildGeometryOverlay,
  buildHeadLayerDiagnosticViews,
  buildTempleGeometryOverlay,
  renderQuantizedHeadPlan,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";

describe("evaluation-only identity artifacts", () => {
  it("writes the fixed stage set only under an explicit case directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-skin-identity-eval-"));
    const image = makeSyntheticAtlas(19);
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const plan = buildSkinPlan(analysis);
    const geometryOverlay = buildGeometryOverlay(image, analysis.identityGeometry!);
    const output = await writeIdentityEvaluationArtifacts(root, "glasses-case", {
      sourceFace: image,
      sourceHead: image,
      sourceHeadGeometryOverlay: geometryOverlay,
      sourceFaceGeometryOverlay: buildFaceGeometryOverlay(image, analysis.identityGeometry!),
      fringeGeometryOverlay: buildFringeGeometryOverlay(image, analysis.identityGeometry!),
      templeGeometryOverlay: buildTempleGeometryOverlay(image, analysis.identityGeometry!),
      crownContourOverlay: buildCrownContourOverlay(image, analysis.identityGeometry!),
      faceWindowOverlay: buildFaceWindowOverlay(image, analysis.identityGeometry!),
      quantizedHeadPlan: renderQuantizedHeadPlan(plan.hairPlan, plan.facePixelPlan),
      sixView: image,
      generatedSheetFace: image,
      packedHeadBefore: image,
      facePixelPlan: plan.facePixelPlan,
      candidateA: image,
      candidateB: image,
      ...buildHeadLayerDiagnosticViews(image),
      finalHeadFront: image,
      finalHeadLeft: image,
      finalHeadRight: image,
      finalSkin: image,
      critique: { approved: false },
      metrics: { largestLossStage: "generated_sheet" },
    });
    const files = await readdir(output);
    expect(files).toEqual(expect.arrayContaining([
      "01-source-face.png",
      "01b-source-head.png",
      "01d-source-head-geometry-overlay.png",
      "01e-source-face-geometry-overlay.png",
      "01f-fringe-geometry-overlay.png",
      "01g-temple-geometry-overlay.png",
      "01h-crown-contour-overlay.png",
      "01i-face-window-overlay.png",
      "02-generated-sheet-face.png",
      "03-packed-head-before-identity.png",
      "04-face-pixel-plan.png",
      "04b-quantized-head-plan.png",
      "05-candidate-a.png",
      "06-candidate-b.png",
      "06c-base-head-only.png",
      "06d-outer-head-only.png",
      "06e-base-plus-outer-head.png",
      "07-final-head-front.png",
      "08-final-head-left.png",
      "09-final-head-right.png",
      "09e-six-view.png",
      "10-final-skin.png",
      "critique.json",
      "metrics.json",
    ]));
    expect(JSON.parse(await readFile(join(output, "metrics.json"), "utf8"))).toEqual({ largestLossStage: "generated_sheet" });
    expect(geometryOverlay).not.toBe(image);
    expect(geometryOverlay.rgba).not.toEqual(image.rgba);
  });

  it("refuses implicit output roots and unsafe case ids", async () => {
    const image = makeSyntheticAtlas(3);
    const artifacts = {
      sourceFace: image,
      facePixelPlan: buildSkinPlan(makeAnalysis()).facePixelPlan,
      finalHeadFront: image,
      finalHeadLeft: image,
      finalHeadRight: image,
      finalSkin: image,
      critique: {},
      metrics: {},
    };
    await expect(writeIdentityEvaluationArtifacts("", "case", artifacts)).rejects.toThrow("explicit");
    await expect(writeIdentityEvaluationArtifacts(tmpdir(), "../escape", artifacts)).rejects.toThrow("Invalid");
  });
});
