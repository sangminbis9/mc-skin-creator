import { describe, expect, it } from "vitest";
import { applyProceduralCritiqueCorrections } from "../src/proceduralCorrection";
import { DEFAULT_FACE_STYLE } from "../src/skinPack";
import type { SkinCritique } from "../src/skinCritique";
import { makeAnalysis } from "./helpers";

function critique(
  defects: SkinCritique["defects"],
): SkinCritique {
  return {
    identityScore: 60,
    faceHairScore: 58,
    outfitScore: 64,
    consistencyScore: 82,
    layerScore: 62,
    defects,
  };
}

describe("procedural critique correction", () => {
  it("strengthens analyzed curl geometry without accepting invented hair facts", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        hair: "Full blonde curls end at the jaw above the shoulders.",
      },
      renderHints: {
        ...base.renderHints,
        hairTexture: "curly",
        hairVolume: "full",
        hairSilhouette: "tousled",
        overallHairLength: "jaw",
        sideHairLength: "jaw",
        sideHairShape: "flared",
      },
    });
    const result = applyProceduralCritiqueCorrections(
      analysis,
      {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "short",
        hairTexture: "straight",
        hairVolume: "normal",
        hairSilhouette: "rounded",
      },
      critique([
        {
          category: "face_hair",
          severity: "major",
          feature: "curly hair silhouette",
          evidence: "The rendered hair reads as a flat helmet.",
          targetRegions: ["head.front", "head.overlay"],
          correction: "Restore visible curl depth and jaw-length side volume.",
        },
      ]),
    );

    expect(result.style).toMatchObject({
      hairstyle: "curly",
      hairTexture: "curly",
      hairVolume: "full",
      hairSilhouette: "tousled",
      overallHairLength: "jaw",
      sideHairLength: "jaw",
      sideHairShape: "flared",
      hairDepthBoost: true,
    });
    expect(result.applied).toEqual([
      "head.hair:analysis_geometry+contrast",
    ]);
  });

  it("restores only observed garment details on targeted outfit defects", () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        clothing:
          "A red athletic shirt with a blue and gold viewer-left chest badge and a striped tie.",
      },
      renderHints: {
        ...base.renderHints,
        outerGarment: "open_jacket",
      },
    });
    const result = applyProceduralCritiqueCorrections(
      analysis,
      { ...DEFAULT_FACE_STYLE, topGraphic: false },
      critique([
        {
          category: "outfit",
          severity: "major",
          feature: "badge and tie",
          evidence: "The chest badge and striped tie are not readable.",
          targetRegions: ["torso.front", "torso.overlay"],
          correction: "Restore the observed badge, tie, and jacket depth.",
        },
      ]),
    );

    expect(result.style).toMatchObject({
      outerLayer: "heavy",
      outerGarment: "open_jacket",
      topGraphic: true,
      topGraphicSide: "viewer_left",
      neckAccessory: "tie",
      neckAccessoryPattern: "striped",
    });
    expect(result.applied).toEqual([
      "body.overlay:strengthened",
      "torso.front:observed_graphic",
      "torso.front:observed_tie",
    ]);
  });

  it("ignores minor feedback and unsupported requested motifs", () => {
    const result = applyProceduralCritiqueCorrections(
      makeAnalysis(),
      DEFAULT_FACE_STYLE,
      critique([
        {
          category: "outfit",
          severity: "minor",
          feature: "imagined badge",
          evidence: "A badge could add detail.",
          targetRegions: ["torso.front"],
          correction: "Invent a new badge.",
        },
      ]),
    );

    expect(result.applied).toEqual([]);
    expect(result.style.topGraphic).toBe(DEFAULT_FACE_STYLE.topGraphic);
  });
});
