import { describe, expect, it } from "vitest";
import { buildSkinPlan, formatSkinPlanForPrompt } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";

describe("canonical Minecraft skin plan", () => {
  it("routes ranked identity cues to explicit legal faces and layers", () => {
    const plan = buildSkinPlan(makeAnalysis());
    expect(plan.geometry).toBe("classic");
    expect(plan.assignments[0].priority).toBe(5);
    expect(plan.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          feature: "short side-swept black fringe",
          part: "head",
          faces: expect.arrayContaining(["front"]),
          layers: expect.arrayContaining(["base", "overlay"]),
        }),
        expect.objectContaining({
          feature: "mustard knit and white collar",
          part: "body",
          faces: expect.arrayContaining(["front"]),
        }),
      ]),
    );
    expect(plan.hiddenSurfaces.map((surface) => surface.part)).toEqual([
      "head",
      "body",
      "rightArm",
      "leftArm",
      "rightLeg",
      "leftLeg",
    ]);
    expect(formatSkinPlanForPrompt(plan)).toContain("Explicit surface plan");
  });

  it("falls back semantically instead of dropping an unknown high-priority region", () => {
    const analysis = makeAnalysis();
    analysis.canonicalIdentity.features[0] = {
      ...analysis.canonicalIdentity.features[0],
      targetRegions: ["portrait.magic-zone"],
    };
    const plan = buildSkinPlan(analysis);
    expect(plan.assignments[0]).toMatchObject({ part: "head", priority: 5 });
  });
});
