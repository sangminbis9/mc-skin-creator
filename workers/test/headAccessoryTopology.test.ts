import { describe, expect, it } from "vitest";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";

function headscarf(accessories: string) {
  const base = makeAnalysis();
  return buildSkinPlan(makeAnalysis({
    identityGeometry: undefined,
    observed: {
      ...base.observed,
      hair: "hair fully covered by a fitted headscarf",
      accessories,
    },
    fallbackFeatures: { ...base.fallbackFeatures, hat: "headscarf", glasses: "none" },
  }));
}

describe("source-derived head accessory topology", () => {
  it("quantizes a headscarf into a fitted connected face-opening profile without hair ownership", () => {
    const plan = headscarf("dark gray patterned headscarf");
    const mask = plan.hairPlan.headMask;
    expect(mask.source).toBe("semantic_template");
    expect(mask.semanticSilhouette).toBeUndefined();
    expect(mask.coveringTopology).toEqual({
      provenance: "observed_categorical",
      fit: "fitted_headscarf",
      accentSide: "none",
      patterned: true,
      frontOpeningWidthByRow: [0, 4, 6, 6, 6, 4, 4, 2],
    });
    expect(mask.faces.front.every((point) => point.role === "covering")).toBe(true);
    expect(plan.headIdentityPlan.ownership?.cells.some((cell) => cell.owner.startsWith("hair"))).toBe(false);
    expect(plan.headIdentityPlan.ownership?.cells.filter((cell) => cell.owner === "covering").length).toBeGreaterThan(0);
  });

  it("adds bounded asymmetry only for explicit viewer-side evidence", () => {
    const symmetric = headscarf("dark patterned headscarf").hairPlan.headMask;
    const left = headscarf("dark patterned headscarf with a fold on viewer-left").hairPlan.headMask;
    const right = headscarf("dark patterned headscarf with a fold on viewer-right").hairPlan.headMask;
    expect(symmetric.coveringTopology?.accentSide).toBe("none");
    expect(left.coveringTopology?.accentSide).toBe("viewer_left");
    expect(right.coveringTopology?.accentSide).toBe("viewer_right");
    expect(left.coveringTopology?.frontOpeningWidthByRow).toEqual(right.coveringTopology?.frontOpeningWidthByRow);
    const row = (mask: typeof symmetric, y: number) => mask.faces.front.filter((point) => point.y === y).map((point) => point.x);
    expect(row(left, 6)).toEqual([0, 1, 2, 6, 7]);
    expect(row(right, 6)).toEqual([0, 1, 5, 6, 7]);
    expect(row(symmetric, 6)).toEqual([0, 1, 6, 7]);
  });

  it("does not change the categorical long-straight and full-wavy silhouette contracts", () => {
    const base = makeAnalysis();
    const analysis = (texture: "straight" | "wavy", volume: "normal" | "full", shape: "tapered" | "flared") => makeAnalysis({
      identityGeometry: undefined,
      observed: { ...base.observed, hair: `${texture} chest-length visible hair` },
      renderHints: {
        ...base.renderHints,
        hairTexture: texture,
        hairVolume: volume,
        hairSilhouette: "rounded",
        hairBackShape: "long",
        overallHairLength: "chest",
        sideHairLength: "shoulder",
        sideHairShape: shape,
        sideHairAsymmetry: "none",
      },
    });
    const straight = buildIdentityPixelPlans(analysis("straight", "normal", "tapered")).hairPlan.headMask;
    const wavy = buildIdentityPixelPlans(analysis("wavy", "full", "tapered")).hairPlan.headMask;
    expect(straight.widthByRow.left).toEqual([6, 6, 5, 5, 5, 5, 4, 4]);
    expect(straight.endpointRows).toEqual({ left: 7, right: 7 });
    expect(wavy.widthByRow.left).toEqual([6, 7, 7, 7, 7, 7, 6, 6]);
    expect(wavy.endpointRows).toEqual({ left: 7, right: 7 });
  });
});
