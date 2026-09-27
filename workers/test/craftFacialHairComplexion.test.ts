import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodePng, type RawImage } from "../src/png";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, normalizeAnalysisForRendering } from "../src/generate";
import { validateAtlasCraft } from "../src/skinPost";
import { makeAnalysis } from "./helpers";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";

const root = "evaluation-artifacts/current006-geometry-retention-20260927-JnBcfM";
const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json", "utf8")).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
  outfitPrompt: saved.observed.clothing, faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry }));
// Hold the historical grammar fixed: this test isolates complexion sampling,
// not the subsequent independently tested measured-eye-axis repair.
const plan: ReturnType<typeof buildSkinPlan> = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-zZif8t/results.json", "utf8"))
  .cases.find((row: { id: string }) => row.id === "current-geometry-fixed-context").plan;
const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
const paint = (image: RawImage, x: number, y: number, rgb: number[]) => image.rgba.set([...rgb, 255], ((y + 8) * 64 + x + 8) * 4);
const eyeProblems = (image: RawImage, facialHair = style.facialHair) =>
  validateAtlasCraft(image, { ...style, facialHair }, undefined, undefined, plan).problems.filter(p => p.startsWith("face has only"));

it("does not mistake the goatee chin for complexion in the stored asymmetric-eye atlas", async () => {
  const image = await decodePng(readFileSync(`${root}/enriched-rejected.png`));
  expect(style.facialHair).toBe("goatee");
  expect(eyeProblems(image)).toEqual([]);
  for (const color of [[0, 0, 0], [24, 24, 24], [100, 60, 36], [210, 190, 160]]) {
    paint(image, 3, 7, color); paint(image, 4, 7, color);
    expect(eyeProblems(image), JSON.stringify(color)).toEqual([]);
  }
});

it.each(["goatee", "beard", "stubble", "mustache", "none"])("preserves absent-eye rejection and the exact 45 cutoff with %s", async facialHair => {
  for (const skin of [[70, 42, 28], [135, 86, 52], [220, 180, 150]]) {
    const image = await decodePng(readFileSync(`${root}/enriched-rejected.png`));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) paint(image, x, y, skin);
    const beardCells = facialHair === "goatee" ? [[3, 7], [4, 7]]
      : ["beard", "stubble"].includes(facialHair) ? [...Array.from({ length: 8 }, (_, x) => [x, 7]), [0, 6], [7, 6]] : [];
    for (const [x, y] of beardCells) paint(image, x, y, [24, 24, 24]);
    expect(eyeProblems(image, facialHair)[0]).toContain("only 0 readable eye(s)");
    for (const contrast of [44, 45]) {
      for (const p of plan.facePixelPlan.pixels.filter(p => ["iris", "sclera"].includes(p.role)))
        paint(image, p.x, p.y, [skin[0] - contrast, skin[1], skin[2]]);
      if (contrast === 44) expect(eyeProblems(image, facialHair)[0]).toContain("only 0 readable eye(s)");
      else expect(eyeProblems(image, facialHair)).toEqual([]);
    }
    for (const p of plan.facePixelPlan.pixels.filter(p => p.cluster === "right_eye" && ["iris", "sclera"].includes(p.role)))
      paint(image, p.x, p.y, skin);
    expect(eyeProblems(image, facialHair)[0]).toContain("only 1 readable eye(s)");
  }
});

it.each(["none", "mustache", "goatee", "beard", "stubble", "unknown"])("shares exactly the existing paint footprint for %s", facialHair => {
  for (const goateeHasMustache of [false, true]) {
    const expected = [];
    if (facialHair === "mustache" || facialHair === "beard" || (facialHair === "goatee" && goateeHasMustache))
      expected.push({ x: 2, y: 5 }, { x: 5, y: 5 });
    if (facialHair === "goatee") expected.push({ x: 3, y: 7 }, { x: 4, y: 7 });
    if (facialHair === "beard" || facialHair === "stubble") {
      for (let x = 0; x < 8; x++) expected.push({ x, y: 7 });
      expected.push({ x: 0, y: 6 }, { x: 7, y: 6 });
    }
    expect(facialHairBaseFootprint({ facialHair, goateeHasMustache })).toEqual(expected);
  }
});

it("does not change the no-plan craft heuristic", async () => {
  const image = await decodePng(readFileSync(`${root}/enriched-rejected.png`));
  const baseline = validateAtlasCraft(image, { ...style, facialHair: "none" });
  for (const facialHair of ["mustache", "goatee", "beard", "stubble"])
    expect(validateAtlasCraft(image, { ...style, facialHair })).toEqual(baseline);
});
