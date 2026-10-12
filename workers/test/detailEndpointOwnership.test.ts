import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { observedFrontHairDrape } from "../src/observedFrontHairDrape";
import { buildReferenceLooseHair } from "../src/referenceLooseHair";

it.each(["layered surface shading", "cuffs over the wrists", "pants under the sweatshirt hem"])(
  "standalone observed crewneck does not borrow layer construction from completion: %s", completion => {
    const a = makeAnalysis();
    a.observed.clothing = "black crewneck sweatshirt, gray plain pants, white sneakers";
    a.observed.accessories = "none";
    a.renderHints.outerGarment = "none"; a.renderHints.neckAccessory = "none";
    // Explicit synthetic prompt context, not a reconstruction of run 015.
    a.outfitPrompt = completion;
    const p = buildOutfitPlan(a);
    expect(p.upper.neckline.kind).toBe("crew");
    expect(p.upper.neckline.innerVisible).toBe(false);
    expect(p.upper.colorBlocks.some(b => b.id === "inner_panel")).toBe(false);
  });

it("preserves an actually observed second upper layer", () => {
  const a = makeAnalysis();
  a.observed.clothing = "black sweatshirt over a white shirt";
  a.renderHints.outerGarment = "none"; a.renderHints.neckAccessory = "none";
  a.outfitPrompt = "";
  expect(buildOutfitPlan(a).upper.neckline.innerVisible).toBe(true);
});

it.each(["face-framing locks reaching the shoulders", "front strands reach to the shoulders", "front locks that reach the shoulders"])(
  "recognizes an attached, bounded front endpoint: %s", text => {
    expect(observedFrontHairDrape(text)).toBe("observed_front_shoulder_endpoint");
  });
it.each([
  "hair frames the face on both sides and a scarf reaches down past the shoulders to the chest",
  "no face-framing locks reaching the shoulders", "maybe front locks reach the shoulders",
  "left front locks reach the shoulders", "front locks hidden at the shoulders",
  "front locks and a scarf reach the shoulders", "front locks; a scarf reaches the shoulders",
  "back locks reach the shoulders", "front locks printed on the shirt reach the shoulders",
  "front locks reach the shoulders in a drawing", "face-framing locks end at the jaw",
])("does not invent front endpoint evidence: %s", text => {
  expect(observedFrontHairDrape(text)).toBeNull();
});

it("binds bilateral face framing to its own chest endpoint", () => {
  expect(observedFrontHairDrape("The hair frames the face on both sides and reaches down past the shoulders to the chest area."))
    .toBe("observed_front_lock_endpoint");
});

it("paints the saved 016 shoulder endpoint from real roots without extending it to a chest endpoint", () => {
  const t = JSON.parse(readFileSync("evaluation-artifacts/detail-iteration-v3-e2e-20261012-016/summary.json", "utf8"))
    .currentDefaultE2E.result.propagationTrace;
  const plan = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle;
  // Isolate the existing stored plan, not missing provider prompt fields.
  const design = structuredClone(t.referenceStyle.design);
  design.drape.eligible = true; design.drape.maxShoulderColumns = 1;
  for (const overallHairLength of ["shoulder", "chest"]) {
    const result = buildReferenceLooseHair(plan, design, { ...style, overallHairLength });
    expect(result.frontEvidence).toBe("observed_front_shoulder_endpoint");
    const front = result.points.filter(p => p.face === "front");
    expect(front).toHaveLength(8);
    expect(Math.max(...front.map(p => p.y))).toBe(3);
  }
});
