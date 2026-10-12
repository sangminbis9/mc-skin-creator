import { expect, it } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

it.each(["rightArm", "leftArm"] as const)("fits floral ink within %s cloth without changing hem, skin or other UVs", part => {
  for (const terminationRow of [0, 1, 2, 3, 4, 5, 6, 7, 11, 12]) {
    const plan = buildOutfitPlan(makeAnalysis());
    plan.upper.pattern = { kind: "irregular_group", motif: "floral", surfaceParts: [part],
      color: "#b53a35", placement: "front", anchor: "center", frequency: 2,
      source: "observed", evidence: "red floral sleeve" };
    const sleeve = part === "rightArm" ? plan.upper.rightSleeve : plan.upper.leftSleeve;
    sleeve.terminationRow = terminationRow;
    sleeve.color = "#202020";
    const original = JSON.stringify(plan), plain = structuredClone(plan);
    plain.upper.pattern.kind = "none";
    const before = makeSyntheticAtlas(4), after = makeSyntheticAtlas(4);
    applyOutfitPlan(before, plain, "#cfa88b");
    applyOutfitPlan(after, plan, "#cfa88b");
    const r = CLASSIC_LAYOUT[part].base.front;
    const ink: Array<[number, number]> = [];
    for (let p = 0; p < 64 * 64; p++) {
      if ([0, 1, 2, 3].every(c => before.rgba[p * 4 + c] === after.rgba[p * 4 + c])) continue;
      const x = p % 64 - r.x, y = Math.floor(p / 64) - r.y;
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(r.w);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThan(terminationRow - (terminationRow < r.h ? 1 : 0));
      ink.push([x, y]);
    }
    if (terminationRow <= 2) expect(ink).toEqual([]);
    if (terminationRow === 4) expect(ink).toEqual([[2, 1], [1, 2], [2, 2], [3, 2]]);
    if (terminationRow >= 7) expect(ink).toEqual([[2, 3], [1, 4], [2, 4], [3, 4], [2, 5]]);
    expect(JSON.stringify(plan)).toBe(original);
    const repeat = makeSyntheticAtlas(4);
    applyOutfitPlan(repeat, plan, "#cfa88b");
    expect(repeat.rgba).toEqual(after.rgba);
  }
});
