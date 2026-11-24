import { expect, it } from "vitest";
import { PUBLIC_LEGWEAR_POLICY } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildSkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

function fixture(text: string, visible = true) {
  const b = makeAnalysis();
  return makeAnalysis({ observed: { ...b.observed, clothing: text, accessories: "None." }, outfitPrompt: text,
    visibleRegions: { ...b.visibleRegions, lowerBody: visible, feet: visible },
    inferred: { ...b.inferred, lowerBody: null, shoes: null },
    renderHints: { ...b.renderHints, legwear: "none", legwearAsymmetry: "none", legwearColor: "white" },
  });
}

it.each([
  ["Mini skirt. White thigh-high socks on both legs. Black loafers.", 5],
  ["Shorts above the knee. White knee-high socks on both legs. Black loafers.", 5],
  ["Mini skirt with a plaid pattern. Long white socks. White loafers.", 5],
])("draws an actual skin gap, then a white cuff and tall sock: %s", (text, start) => {
  const a = fixture(text);
  const plan = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY).outfitPlan;
  expect(plan.lower).toMatchObject({ garmentRows: 3, skinExposureRows: 2, legwear: { kind: "thigh_highs", startRow: start, color: "#f2f0ee" } });
  const atlas = { width: 64, height: 64, rgba: new Uint8Array(16384) };
  applyOutfitPlan(atlas, plan, "#d5a48f");
  const at = (r: Rect, x: number, y: number) => [...atlas.rgba.subarray(((r.y + y) * 64 + r.x + x) * 4, ((r.y + y) * 64 + r.x + x) * 4 + 4)];
  for (const part of ["leftLeg", "rightLeg"] as const) {
    const { base, overlay } = CLASSIC_LAYOUT[part];
    for (const face of ["front", "right", "left", "back"] as const) {
      const skin = at(base[face], 1, start - 1);
      expect(skin[0] - skin[1]).toBeGreaterThan(30);
      const sock = at(base[face], 1, start + 1);
      expect(sock[0] - sock[1]).toBeLessThan(7);
      expect(sock[1]).toBeGreaterThan(175);
      expect(at(overlay[face], 1, start - 1)[3]).toBe(0);
      expect(at(overlay[face], 1, start)[3]).toBe(255);
    }
  }
});

it("does not reinterpret ankle socks, tights, occluded legwear, or older replay plans", () => {
  const cases = [fixture("Mini skirt. Ankle socks."), fixture("Mini skirt. Opaque black stockings."),
    fixture("A long maxi skirt over white knee-high socks."), fixture("Mini skirt. White knee-high socks.", false)];
  for (const a of cases) expect(buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY).outfitPlan.lower.legwear.startRow).toBeUndefined();
  expect(buildSkinPlan(fixture("Mini skirt. White thigh-high socks."), true).outfitPlan.lower.legwear.startRow).toBeUndefined();
  expect(buildSkinPlan(fixture("Mini skirt. One white thigh-high sock on the viewer-right leg."), PUBLIC_LEGWEAR_POLICY)
    .outfitPlan.lower.legwear.asymmetry).toBe("right");
});
