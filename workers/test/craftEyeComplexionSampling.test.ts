import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { validateAtlasCraft } from "../src/skinPost";
import type { RawImage } from "../src/png";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";

const replay = JSON.parse(readFileSync("evaluation-artifacts/current-source-v4-geometry-replay-20260926-9KY0Z7/results.json", "utf8"));
const previous = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json", "utf8")).currentDefaultE2E.result;
const saved = previous.diagnostics.normalizedPrimary;
const style = buildFaceStyle(makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing,
  faceIdentityGeometry: previous.diagnostics.geometry.acceptedGeometry }), previous.features);
const plan: SkinPlan = replay.renderComparison.beforePlan;
function atlas(): RawImage {
  let raw: RawImage | undefined;
  buildProceduralFallbackAtlas(previous.features, style, plan, (stage, image) => {
    if (stage === "final_head") raw = { ...image, rgba: new Uint8Array(image.rgba) };
  });
  expect(raw).toBeDefined();
  return raw!;
}
const paint = (image: RawImage, x: number, y: number, rgb: number[]) => image.rgba.set([...rgb, 255], ((y + 8) * 64 + x + 8) * 4);
const eyeProblems = (image: RawImage) => validateAtlasCraft(image, style, undefined, undefined, plan).problems.filter(p => p.startsWith("face has only"));

it("does not sample the non-anchor upper iris as complexion", () => {
  const image = atlas();
  const cells = plan.facePixelPlan.pixels.filter(p => p.cluster === "left_eye" && p.role === "iris");
  const lower = [...cells].sort((a, b) => b.y - a.y)[0];
  const upper = cells.find(p => p.y < lower.y)!;
  expect(upper).toBeDefined();
  // Alter a landmark that is not the visibility anchor. Its paint may change
  // eye appearance, but it can never define the comparison skin colour.
  for (const rgb of [[0, 0, 0], [36, 26, 19], [97, 57, 34], [255, 255, 255]]) {
    paint(image, upper.x, upper.y, rgb);
    expect(eyeProblems(image), JSON.stringify(rgb)).toEqual([]);
  }
});

it("still rejects both absent and one absent eye on a uniform skin surface", () => {
  const image = atlas();
  const skin = [100, 60, 36];
  // A synthetic uniform complexion removes beard/lighting ambiguity; this is
  // a negative validation fixture, not a repaired provider response.
  for (let y = 3; y < 8; y++) for (let x = 0; x < 8; x++) paint(image, x, y, skin);
  expect(eyeProblems(image)[0]).toContain("only 0 readable eye(s)");
  for (const p of plan.facePixelPlan.pixels.filter(p => p.cluster === "left_eye" && ["iris", "sclera"].includes(p.role))) paint(image, p.x, p.y, [12, 8, 6]);
  expect(eyeProblems(image)[0]).toContain("only 1 readable eye(s)");
  for (const p of plan.facePixelPlan.pixels.filter(p => p.cluster === "right_eye" && ["iris", "sclera"].includes(p.role))) paint(image, p.x, p.y, [12, 8, 6]);
  expect(eyeProblems(image)).toEqual([]);
});

it("keeps the 45-distance cutoff unchanged for each planned eye", () => {
  const image = atlas(), skin = [100, 60, 36];
  for (let y = 3; y < 8; y++) for (let x = 0; x < 8; x++) paint(image, x, y, skin);
  for (const p of plan.facePixelPlan.pixels.filter(p => ["iris", "sclera"].includes(p.role))) paint(image, p.x, p.y, [56, 60, 36]);
  expect(eyeProblems(image)[0]).toContain("only 0 readable eye(s)");
  for (const p of plan.facePixelPlan.pixels.filter(p => ["iris", "sclera"].includes(p.role))) paint(image, p.x, p.y, [55, 60, 36]);
  expect(eyeProblems(image)).toEqual([]);
});
