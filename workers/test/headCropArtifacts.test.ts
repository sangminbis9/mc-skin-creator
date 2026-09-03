import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boxCoverage, cropNormalized, drawNormalizedBox, writeHeadCropEvaluationArtifacts } from "./headCropArtifacts";
import { makeSyntheticAtlas } from "./helpers";

describe("evaluation-only adaptive crop artifacts", () => {
  it("writes the required source-to-six-view sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-skin-head-crop-"));
    const source = makeSyntheticAtlas(41);
    const box = { left: 0.1, top: 0.12, right: 0.72, bottom: 0.8 };
    const overlay = drawNormalizedBox(source, box, [0, 255, 0, 255]);
    const crop = cropNormalized(source, box);
    const output = await writeHeadCropEvaluationArtifacts(root, "curly-case", {
      originalSource: source,
      originalHeadBox: overlay,
      desiredAdaptiveBox: overlay,
      finalHeadCrop: crop,
      headCropCoverageOverlay: overlay,
      sourceVsCropClipping: overlay,
      geometryOverlay: crop,
      quantizedPlan: crop,
      finalHead: crop,
      sixView: source,
      metrics: { sourceToCrop: 1 },
    });
    expect(await readdir(output)).toEqual(expect.arrayContaining([
      "01-original-source.png",
      "02-original-head-box.png",
      "03-desired-adaptive-box.png",
      "04-final-head-crop.png",
      "05-head-crop-coverage-overlay.png",
      "06-source-vs-crop-clipping.png",
      "07-geometry-overlay.png",
      "08-quantized-plan.png",
      "09-final-head.png",
      "10-six-view.png",
      "metrics.json",
    ]));
    expect(JSON.parse(await readFile(join(output, "metrics.json"), "utf8"))).toEqual({ sourceToCrop: 1 });
  });

  it("measures retained feature area rather than only checking the center point", () => {
    const feature = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 };
    expect(boxCoverage(feature, { left: 0.2, top: 0.1, right: 0.4, bottom: 0.3 })).toBeCloseTo(0.5);
    expect(boxCoverage(feature, { left: 0, top: 0, right: 1, bottom: 1 })).toBe(1);
  });
});
