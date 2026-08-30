import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildHeadLayerDiagnosticViews, writeIdentityEvaluationArtifacts } from "./evaluationArtifacts";

describe("evaluation-only identity artifacts", () => {
  it("writes the fixed stage set only under an explicit case directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-skin-identity-eval-"));
    const image = makeSyntheticAtlas(19);
    const output = await writeIdentityEvaluationArtifacts(root, "glasses-case", {
      sourceFace: image,
      generatedSheetFace: image,
      packedHeadBefore: image,
      facePixelPlan: buildSkinPlan(makeAnalysis()).facePixelPlan,
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
      "02-generated-sheet-face.png",
      "03-packed-head-before-identity.png",
      "04-face-pixel-plan.png",
      "05-candidate-a.png",
      "06-candidate-b.png",
      "06c-base-head-only.png",
      "06d-outer-head-only.png",
      "06e-base-plus-outer-head.png",
      "07-final-head-front.png",
      "08-final-head-left.png",
      "09-final-head-right.png",
      "10-final-skin.png",
      "critique.json",
      "metrics.json",
    ]));
    expect(JSON.parse(await readFile(join(output, "metrics.json"), "utf8"))).toEqual({ largestLossStage: "generated_sheet" });
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
