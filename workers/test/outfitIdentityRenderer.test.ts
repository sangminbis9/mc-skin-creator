import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import {
  buildOutfitPlan,
  buildOutfitPlanCandidates,
  outfitPlanSignature,
  scoreOutfitPlan,
} from "../src/outfitIdentity";
import {
  headUvIsByteIdentical,
  measureOutfitIdentityRetention,
  measureOutfitPixelDifference,
  outfitConvergence,
} from "../src/outfitIdentityRetention";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas, type FaceStyle } from "../src/skinPack";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeFrontView } from "./helpers";

interface Variant {
  id: string;
  clothing: string;
  topType: string;
  topColor: string;
  accent: string;
  sleeve: string;
  bottomType: string;
  bottomColor: string;
  hints?: Partial<PhotoAnalysis["renderHints"]>;
}

const VARIANTS: Variant[] = [
  { id: "solid-short", clothing: "solid red crew-neck short-sleeve t-shirt with dark pants", topType: "tshirt", topColor: "red", accent: "white", sleeve: "short", bottomType: "pants", bottomColor: "black" },
  { id: "contrast-long", clothing: "blue long-sleeve shirt with contrasting white raglan sleeves and navy pants", topType: "shirt", topColor: "blue", accent: "white", sleeve: "long", bottomType: "pants", bottomColor: "navy" },
  { id: "open-jacket", clothing: "open black jacket over a white inner shirt with a visible vertical opening", topType: "jacket", topColor: "black", accent: "white", sleeve: "long", bottomType: "jeans", bottomColor: "denim", hints: { outerGarment: "open_jacket", outerLayer: "heavy" } },
  { id: "striped", clothing: "green and yellow horizontal striped short-sleeve shirt with plain pants", topType: "shirt", topColor: "green", accent: "yellow", sleeve: "short", bottomType: "pants", bottomColor: "brown", hints: { garmentTexture: "striped" } },
  { id: "dress", clothing: "purple v-neck dress continuing from torso into a knee skirt", topType: "dress", topColor: "purple", accent: "pink", sleeve: "short", bottomType: "skirt", bottomColor: "purple", hints: { bottomPattern: "pleated" } },
  { id: "shorts", clothing: "yellow sleeveless top with blue shorts and clearly visible bare legs", topType: "tank", topColor: "yellow", accent: "white", sleeve: "sleeveless", bottomType: "shorts", bottomColor: "blue" },
  { id: "strap", clothing: "cream sweater with a dark crossbody bag strap continuing around the side", topType: "sweater", topColor: "cream", accent: "brown", sleeve: "long", bottomType: "pants", bottomColor: "brown" },
  { id: "graphic", clothing: "orange crew-neck t-shirt with a large blue center graphic", topType: "tshirt", topColor: "orange", accent: "blue", sleeve: "short", bottomType: "jeans", bottomColor: "denim" },
];

function analysisFor(variant: Variant, visibleLower = true): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    framing: visibleLower ? "full_body" : "upper_body",
    visibleRegions: { ...base.visibleRegions, upperBody: true, lowerBody: visibleLower, feet: visibleLower },
    observed: { ...base.observed, clothing: variant.clothing, accessories: variant.clothing, colorPalette: [variant.topColor, variant.accent, variant.bottomColor] },
    inferred: {
      ...base.inferred,
      lowerBody: visibleLower ? null : { value: `plain ${variant.bottomColor} ${variant.bottomType}`, rationale: "minimum continuation of visible formality and palette" },
    },
    renderHints: { ...base.renderHints, ...variant.hints },
    fallbackFeatures: {
      ...base.fallbackFeatures,
      topType: variant.topType,
      topColor: variant.topColor,
      topAccentColor: variant.accent,
      sleeveLength: variant.sleeve,
      bottomType: variant.bottomType,
      bottomColor: variant.bottomColor,
      shoesColor: "black",
    },
    outfitPrompt: variant.clothing,
  });
}

function styleFor(variant: Variant): FaceStyle {
  return {
    ...DEFAULT_FACE_STYLE,
    hairstyle: "short",
    hairColor: "#392b24",
    skinTone: "#d39e80",
    topType: variant.topType,
    topColor: buildOutfitPlan(analysisFor(variant)).upper.baseColor,
    topAccentColor: buildOutfitPlan(analysisFor(variant)).upper.accentColor,
    sleeveLength: variant.sleeve,
    bottomType: variant.bottomType,
    bottomColor: buildOutfitPlan(analysisFor(variant)).lower.baseColor,
    shoesColor: "#242326",
    garmentTexture: variant.hints?.garmentTexture ?? "plain",
    outerGarment: variant.hints?.outerGarment ?? "none",
    outerLayer: variant.hints?.outerLayer ?? "none",
  };
}

function render(variant: Variant, visibleLower = true) {
  const analysis = analysisFor(variant, visibleLower);
  const plan = buildOutfitPlan(analysis);
  const atlas = packFrontViewToAtlas(makeFrontView(), styleFor(variant), 2, { outfitPlan: plan })!.atlas;
  return { analysis, plan, atlas };
}

function pixel(atlas: ReturnType<typeof render>["atlas"], rect: { x: number; y: number }, x: number, y: number): number[] {
  const index = ((rect.y + y) * atlas.width + rect.x + x) * 4;
  return [...atlas.rgba.subarray(index, index + 4)];
}

describe("OutfitPlan render contract", () => {
  it("builds eight source-specific plans and atlas signatures without generic convergence", () => {
    const rendered = VARIANTS.map((variant) => render(variant));
    expect(new Set(rendered.map(({ plan }) => outfitPlanSignature(plan))).size).toBe(VARIANTS.length);
    const before = outfitConvergence(rendered.map(({ plan }) => plan), rendered.map(() => rendered[0].atlas));
    expect(before).toMatchObject({ unique: 1, total: 8, pairCollisions: 28, pairCount: 28, rate: 1 });
    const convergence = outfitConvergence(rendered.map(({ plan }) => plan), rendered.map(({ atlas }) => atlas));
    expect(convergence).toMatchObject({ unique: 8, total: 8, pairCollisions: 0, pairCount: 28, rate: 0 });
  });

  it("keeps dominant upper colors and connected large blocks in the torso base", () => {
    for (const variant of VARIANTS) {
      const { plan, atlas } = render(variant);
      const torso = CLASSIC_LAYOUT.body.base.front;
      const opaque = Array.from({ length: torso.w * torso.h }, (_, index) => pixel(atlas, torso, index % torso.w, Math.floor(index / torso.w))[3]).filter((alpha) => alpha === 255).length;
      expect(opaque, variant.id).toBe(torso.w * torso.h);
      expect(plan.upper.colorBlocks[0]).toMatchObject({ id: "upper_base", source: "observed" });
    }
  });

  it("maps neckline and paired collar structures to readable torso clusters", () => {
    const jacket = render(VARIANTS[2]);
    const dress = render(VARIANTS[4]);
    expect(jacket.plan.upper.neckline.kind).toBe("open_collar");
    expect(jacket.plan.upper.collar).toBe("lapel");
    expect(dress.plan.upper.neckline.kind).toBe("v_neck");
    expect(dress.plan.upper.neckline.depth).toBeGreaterThan(jacket.plan.upper.neckline.depth);
    expect(jacket.plan.outerLayer.regions).toContain("lapels");
  });

  it("preserves short, long, sleeveless, rolled and asymmetric sleeve boundaries on all arm faces", () => {
    const short = render(VARIANTS[0]);
    const long = render(VARIANTS[1]);
    const sleeveless = render(VARIANTS[5]);
    expect(short.plan.upper.leftSleeve.terminationRow).toBe(4);
    expect(long.plan.upper.leftSleeve.terminationRow).toBe(11);
    expect(sleeveless.plan.upper.leftSleeve.terminationRow).toBe(0);
    const base = analysisFor(VARIANTS[0]);
    const asymmetric = buildOutfitPlan(makeAnalysis({
      ...base,
      observed: { ...base.observed, clothing: "left sleeve rolled, right sleeve long on a red shirt" },
      outfitPrompt: "left sleeve rolled, right sleeve long on a red shirt",
    }));
    expect(asymmetric.upper.leftSleeve.length).toBe("rolled");
    expect(asymmetric.upper.rightSleeve.length).toBe("long");
    for (const face of ["front", "right", "left", "back"] as const) {
      const rect = CLASSIC_LAYOUT.leftArm.base[face];
      expect(pixel(short.atlas, rect, 1, 3)).not.toEqual(pixel(short.atlas, rect, 1, 5));
    }
  });

  it("carries horizontal bands from torso through sleeves and around the back", () => {
    const { plan, atlas } = render(VARIANTS[3]);
    expect(plan.upper.pattern).toMatchObject({ kind: "horizontal_stripe", placement: "wrap" });
    const row = 2;
    const samples = [
      pixel(atlas, CLASSIC_LAYOUT.body.base.front, 1, row),
      pixel(atlas, CLASSIC_LAYOUT.body.base.back, 1, row),
      pixel(atlas, CLASSIC_LAYOUT.body.base.left, 1, row),
      pixel(atlas, CLASSIC_LAYOUT.rightArm.base.front, 1, row),
    ];
    expect(new Set(samples.map((value) => value.slice(0, 3).join(","))).size).toBeGreaterThan(1);
    expect(samples.every((value) => value[3] === 255)).toBe(true);
  });

  it("renders shorts skin exposure and dress continuity as different lower grammars", () => {
    const shorts = render(VARIANTS[5]);
    const dress = render(VARIANTS[4]);
    expect(shorts.plan.lower).toMatchObject({ garmentType: "shorts", garmentRows: 3 });
    expect(shorts.plan.lower.skinExposureRows).toBeGreaterThan(0);
    expect(dress.plan.lower.garmentType).toBe("dress_continuation");
    expect(dress.plan.lower.garmentRows).toBeGreaterThan(shorts.plan.lower.garmentRows);
    const leg = CLASSIC_LAYOUT.rightLeg.base.front;
    expect(pixel(shorts.atlas, leg, 1, 4)).not.toEqual(pixel(shorts.atlas, leg, 1, 1));
    expect(pixel(dress.atlas, leg, 1, 4)).not.toEqual(pixel(shorts.atlas, leg, 1, 4));
  });

  it("keeps a crossbody strap coherent from front through side to back", () => {
    const { plan, atlas } = render(VARIANTS[6]);
    expect(plan.accessories.map((item) => item.kind)).toContain("bag_strap");
    for (const rect of [CLASSIC_LAYOUT.body.overlay.front, CLASSIC_LAYOUT.body.overlay.right, CLASSIC_LAYOUT.body.overlay.back]) {
      const count = Array.from({ length: rect.w * rect.h }, (_, index) => pixel(atlas, rect, index % rect.w, Math.floor(index / rect.w))[3]).filter(Boolean).length;
      expect(count).toBeGreaterThan(4);
    }
  });

  it("keeps base identity while reserving overlay for selective physical depth", () => {
    for (const variant of VARIANTS) {
      const { plan, atlas } = render(variant);
      const retention = measureOutfitIdentityRetention(plan, atlas);
      expect(retention.torsoColorBlockRetention, variant.id).toBe(1);
      expect(retention.sleeveRetention, variant.id).toBe(1);
      expect(retention.outerOccupancy.actual, variant.id).toBeLessThan(180);
      expect(retention.outerOccupancy.actual, variant.id).toBeGreaterThan(0);
    }
  });

  it("uses minimum-inference lower completion without inventing patterns or accessories", () => {
    const { plan } = render(VARIANTS[0], false);
    expect(plan.lowerBodySource).toBe("minimum_inference");
    expect(plan.lower.source).toBe("conservative");
    expect(plan.lower.pattern.kind).toBe("none");
    expect(plan.hiddenCompletion).toContain("plain");
  });

  it("caps deterministic ambiguity candidates at three and exposes their cost", () => {
    const analysis = analysisFor(VARIANTS[0], false);
    const candidates = buildOutfitPlanCandidates(analysis, 99);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates.map((candidate) => candidate.candidate.cost)).toEqual([...candidates.map((candidate) => candidate.candidate.cost)].sort((a, b) => a - b));
    expect(scoreOutfitPlan(candidates[0]).total).toBe(candidates[0].candidate.cost);
  });

  it("records plan-to-atlas retention, seam continuity, and selective occupancy", () => {
    const { plan, atlas } = render(VARIANTS[2]);
    const retention = measureOutfitIdentityRetention(plan, atlas);
    expect(retention.garmentTypeRetention).toBe(1);
    expect(retention.frontSideContinuity).toBeGreaterThan(0.35);
    expect(retention.sideBackContinuity).toBeGreaterThan(0.35);
    expect(retention.outerOccupancy.retained).toBeGreaterThan(0);
  });

  it("changes body pixels while keeping the complete head UV byte-identical", () => {
    const variant = VARIANTS[2];
    const style = styleFor(variant);
    const source = makeFrontView();
    const before = packFrontViewToAtlas(source, style)!.atlas;
    const after = packFrontViewToAtlas(source, style, 2, { outfitPlan: buildOutfitPlan(analysisFor(variant)) })!.atlas;
    const difference = measureOutfitPixelDifference(before, after);
    expect(difference.torso + difference.arms + difference.legs).toBeGreaterThan(0);
    expect(difference.head).toBe(0);
    expect(headUvIsByteIdentical(before, after)).toBe(true);
  });
});
