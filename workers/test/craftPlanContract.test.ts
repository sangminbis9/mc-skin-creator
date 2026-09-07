import { describe, expect, it } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex } from "../src/generate";
import { measurePlannedOuterContract } from "../src/craftPlanContract";
import type { PhotoAnalysis } from "../src/analysis";
import type { RawImage } from "../src/png";
import { validateAtlasCraft } from "../src/skinPost";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { ATLAS_SIZE, CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

function simpleAnalysis(): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    observed: {
      ...base.observed,
      hair: "simple short black side-swept hair with exposed ears",
      accessories: "none",
      clothing: "plain solid red short-sleeve t-shirt",
      colorPalette: ["red", "black"],
    },
    canonicalIdentity: {
      overallImpression: "Simple short hair, warm face and a plain red t-shirt.",
      mustPreserve: ["short side-swept hair", "warm face", "plain red t-shirt"],
      features: base.canonicalIdentity.features.filter((feature) => feature.category !== "accessory"),
    },
    renderHints: {
      ...base.renderHints,
      garmentTexture: "plain",
      outerLayer: "none",
      outerGarment: "none",
      neckAccessory: "none",
      bottomPattern: "plain",
      bottomAccent: "none",
      legwear: "none",
      thighAccessory: "none",
      earExposure: "visible",
    },
    fallbackFeatures: {
      ...base.fallbackFeatures,
      glasses: "none",
      topType: "tshirt",
      topColor: "red",
      sleeveLength: "short",
      bottomType: "pants",
    },
    outfitPrompt: "Plain solid red short-sleeve t-shirt and plain dark pants.",
  });
}

function render(analysis: PhotoAnalysis): { atlas: RawImage; plan: SkinPlan; style: ReturnType<typeof buildFaceStyle> } {
  const plan = buildSkinPlan(analysis);
  const features = fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone);
  const style = buildFaceStyle(analysis, features);
  const atlas = buildProceduralFallbackAtlas(features, style, plan);
  expect(atlas).not.toBeNull();
  return { atlas: atlas!, plan, style };
}

function clone(atlas: RawImage): RawImage {
  return { ...atlas, rgba: atlas.rgba.slice() };
}

function clearRect(atlas: RawImage, rect: { x: number; y: number; w: number; h: number }): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    atlas.rgba.fill(0, (y * ATLAS_SIZE + x) * 4, (y * ATLAS_SIZE + x) * 4 + 4);
  }
}

function clearBodyOuter(atlas: RawImage): void {
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) clearRect(atlas, rect);
  }
}

describe("source/plan-aware craft contract", () => {
  it("accepts a coherent simple skin without demanding unrelated body outer richness", () => {
    const { atlas, plan, style } = render(simpleAnalysis());
    const withoutBodyDepth = clone(atlas);
    clearBodyOuter(withoutBodyDepth);
    const simplePlan: SkinPlan = {
      ...plan,
      outfitPlan: {
        ...plan.outfitPlan,
        outerLayer: { ...plan.outfitPlan.outerLayer, regions: [], expectedPixels: 0 },
        outerLayerRegions: [],
        accessories: [],
      },
    };
    const verdict = validateAtlasCraft(withoutBodyDepth, style, undefined, undefined, simplePlan);
    expect(verdict.ok, verdict.problems.join(" / ")).toBe(true);
    expect(verdict.problems.join(" / ")).not.toMatch(/connected faces|face shading/);
    expect(validateAtlasCraft(withoutBodyDepth, style).problems.join(" / ")).toMatch(/connected faces|face shading/);
  });

  it("accepts a rich planned skin and reports its expected head and outfit groups", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const measurement = measurePlannedOuterContract(atlas, plan.hairPlan, plan);
    expect(validateAtlasCraft(atlas, style).ok).toBe(true);
    expect(validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan).ok).toBe(true);
    expect(measurement.status).toBe("satisfied");
    expect(measurement.expectedGroups).toBeGreaterThan(1);
    expect(measurement.groups.some((group) => group.scope === "head")).toBe(true);
    expect(measurement.groups.some((group) => group.scope === "outfit")).toBe(true);
  });

  it("rejects a source-derived outfit group when all of its expected UV faces disappear", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const missing = clone(atlas);
    for (const part of ["rightArm", "leftArm"] as const) for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) clearRect(missing, rect);
    const verdict = validateAtlasCraft(missing, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" / ")).toContain("planned outer group missing (outfit:cuffs");
  });

  it("rejects flat coloring when a planned outer group contains distinct shade roles", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const flat = clone(atlas);
    for (const part of ["head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
        const at = (y * ATLAS_SIZE + x) * 4;
        if (flat.rgba[at + 3]) flat.rgba.set([80, 80, 80, 255], at);
      }
    }
    const verdict = validateAtlasCraft(flat, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" / ")).toContain("planned outer group lacks shading");
  });

  it("keeps seam and P5 glasses failures strict on the plan-aware path", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const brokenSeam = clone(atlas);
    const seam = getBoxUvSeams(CLASSIC_LAYOUT.head.overlay).vertical.find((candidate) => candidate.primary.some((point, index) => {
      const other = candidate.adjacent[index];
      return brokenSeam.rgba[(point.y * ATLAS_SIZE + point.x) * 4 + 3] > 0 && brokenSeam.rgba[(other.y * ATLAS_SIZE + other.x) * 4 + 3] > 0;
    }))!;
    const index = seam.primary.findIndex((point, candidateIndex) => {
      const other = seam.adjacent[candidateIndex];
      return brokenSeam.rgba[(point.y * ATLAS_SIZE + point.x) * 4 + 3] > 0 && brokenSeam.rgba[(other.y * ATLAS_SIZE + other.x) * 4 + 3] > 0;
    });
    const point = seam.adjacent[index];
    brokenSeam.rgba[(point.y * ATLAS_SIZE + point.x) * 4 + 3] = 0;
    expect(validateAtlasCraft(brokenSeam, style, plan.facePixelPlan, plan.hairPlan, plan).problems.join(" / ")).toMatch(/seam|planned outer group missing/);

    const missingGlasses = clone(atlas);
    for (const point of [...plan.facePixelPlan.glassesPlan.framePixels, ...plan.facePixelPlan.glassesPlan.sideArms]) {
      const rect = CLASSIC_LAYOUT.head.overlay[point.face];
      missingGlasses.rgba.fill(0, ((rect.y + point.y) * ATLAS_SIZE + rect.x + point.x) * 4, ((rect.y + point.y) * ATLAS_SIZE + rect.x + point.x) * 4 + 4);
    }
    expect(validateAtlasCraft(missingGlasses, style, plan.facePixelPlan, plan.hairPlan, plan).problems.join(" / ")).toContain("glasses topology contract violated");
  });

  it("continues to reject disconnected decorative color noise", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const noisy = clone(atlas);
    for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const at = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
        noisy.rgba.set((x + y) % 2 === 0 ? [250, 30, 30, 255] : [20, 40, 240, 255], at);
      }
    }
    const verdict = validateAtlasCraft(noisy, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" / ")).toContain("isolated pixel noise too high");
  });

  it("rejects occupancy in a head cell reserved as transparent by ownership", () => {
    const { atlas, plan, style } = render(makeAnalysis());
    const invalid = clone(atlas);
    const reserved = plan.headIdentityPlan.ownership!.cells.find((cell) => cell.layer === "outer" && cell.owner === "clear" && !cell.retain)!;
    const rect = CLASSIC_LAYOUT.head.overlay[reserved.face];
    invalid.rgba.set([240, 20, 220, 255], ((rect.y + reserved.y) * ATLAS_SIZE + rect.x + reserved.x) * 4);
    const verdict = validateAtlasCraft(invalid, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" / ")).toContain("planned outer ownership violated");
  });
});
