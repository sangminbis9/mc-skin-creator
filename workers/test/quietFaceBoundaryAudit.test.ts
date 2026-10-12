// Historical conflict remains reproducible beside the new authored default;
// the generic source validator must still reject unauthorized mouth erasure.
import fs from "node:fs";
import { expect, it } from "vitest";
import { FACE_STYLE_TEMPLATES } from "../src/referenceStyleTemplates";
import { measureFaceRenderContract } from "../src/identityRenderContract";
import { decodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { FacePixelPlan } from "../src/identityPlans";

it("locates the quiet-family default conflict without changing source landmarks or validation", async () => {
  const root = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002";
  const trace = JSON.parse(fs.readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result.propagationTrace;
  const plan: FacePixelPlan = trace.skinPlan.skinPlan.facePixelPlan;
  expect(trace.selectedFamilies.face).toBe("clean_masculine_soft");
  expect(trace.primary.renderHints).toMatchObject({ mouthShape: "small", mouthOpening: "closed" });
  expect(trace.injectedParameters.faceStyle.expression).toBe("neutral");
  expect(trace.referenceStyle.design.version).toBe("reference_style_v1");
  expect(trace.injectedParameters.familyDesign.face.mouthCells).toBe(2);
  expect(FACE_STYLE_TEMPLATES.clean_masculine_soft.mouthCells).toBe(0);
  expect(plan.renderContract.mouth!.minimumPerceptualWidth).toBeGreaterThan(0);
  const atlas = await decodePng(fs.readFileSync(`${root}/skin.png`));
  expect(measureFaceRenderContract(atlas, plan).violations).toEqual([]);
  const head = CLASSIC_LAYOUT.head.base.front;
  // A uniformly painted lower-face mutant must be rejected by today's source
  // contract. This is evidence that editing a template alone is insufficient.
  const mutant = { ...atlas, rgba: atlas.rgba.slice() };
  for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++)
    mutant.rgba.set([242, 214, 192, 255], ((head.y + y) * 64 + head.x + x) * 4);
  expect(measureFaceRenderContract(mutant, plan).violations).toContain("mouth landmark missing");
  expect(measureFaceRenderContract(mutant, plan).violations).toContain("mouth perceptual width contract violated");
});
