import { describe, expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { applyReferenceGarmentFinish, referenceGarmentFoldPlan } from "../src/referenceGarmentFinish";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { RawImage } from "../src/png";

function fixture() {
  const plan = buildSkinPlan(makeAnalysis()).outfitPlan;
  plan.upper.baseColor = "#b89b78"; plan.upper.pattern.kind = "none"; plan.upper.colorBlocks = [];
  plan.upper.rightSleeve.color = plan.upper.baseColor; plan.upper.leftSleeve.color = plan.upper.baseColor;
  plan.upper.rightSleeve.terminationRow = 12; plan.upper.leftSleeve.terminationRow = 12;
  plan.upper.neckline.depth = 2; plan.lower.waistRow = 10;
  plan.lower.pattern.kind = "none"; plan.lower.garmentRows = 10; plan.lower.shoeRows = 2;
  plan.lower.baseColor = "#506c8c";
  plan.accessories = []; plan.outerLayer.regions = [];
  const atlas: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
  applyOutfitPlan(atlas, plan, "#c69579");
  return { plan, atlas };
}
describe("reference garment material folds", () => {
  it("keeps a plain wide torso center quiet instead of manufacturing a long central placket", () => {
    const b = fixture(); b.plan.upper.baseColor = "#242326";
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const original = b.atlas.rgba.slice();
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan);
    for (const face of ["front", "back"] as const) {
      const cells = paints.filter(p => p.part === "body" && p.face === face);
      expect(new Set(cells.map(p => p.x))).toEqual(new Set([1, 6]));
      const r = CLASSIC_LAYOUT.body.base[face];
      for (let y = 0; y < r.h; y++) for (const x of [2, 3, 4, 5]) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        expect(b.atlas.rgba.slice(i, i + 4)).toEqual(original.slice(i, i + 4));
      }
    }
    // Narrow side/sleeve planes keep the same connected two-column material.
    expect(new Set(paints.filter(p => p.part === "rightArm" && p.face === "front").map(p => p.x))).toEqual(new Set([1, 2]));
  });
  it("uses paired connected folds inside the source cloth without new colors/geometry evidence", () => {
    const b = fixture(), source = JSON.stringify(b.plan), original = b.atlas.rgba.slice();
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan);
    expect(paints.length).toBeGreaterThan(0);
    expect(JSON.stringify(b.plan)).toBe(source);
    const positions = new Set(paints.map(p => `${p.part}:${p.face}:${p.x}:${p.y}`));
    for (const p of paints) {
      const r = CLASSIC_LAYOUT[p.part].base[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
      expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(r.w - 1);
      expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(r.h - 1);
      expect([...original.slice(i, i + 3)]).toEqual(p.sourceColor);
      expect([...b.atlas.rgba.slice(i, i + 3)]).toEqual(p.color);
      expect([-1, 1].some(dy => positions.has(`${p.part}:${p.face}:${p.x}:${p.y + dy}`))).toBe(true);
    }
    // All unplanned pixels, including physical seam edges and all outer faces,
    // are identical. Repeated rendering is deterministic and idempotent.
    const changed = new Set(paints.map(p => { const r = CLASSIC_LAYOUT[p.part].base[p.face]; return ((r.y + p.y) * 64 + r.x + p.x) * 4; }));
    for (let i = 0; i < original.length; i += 4) if (!changed.has(i)) expect(b.atlas.rgba.slice(i, i + 4)).toEqual(original.slice(i, i + 4));
    expect(applyReferenceGarmentFinish(b.atlas, b.plan)).toEqual([]);
    const repeated = { ...b.atlas, rgba: original.slice() };
    applyReferenceGarmentFinish(repeated, b.plan);
    expect(repeated.rgba).toEqual(b.atlas.rgba);
  });
  it.each(["horizontal_stripe", "checker_block", "center_graphic"] as const)("does not smooth a source %s into the plain material ramp", kind => {
    const b = fixture(); b.plan.upper.pattern.kind = kind; b.plan.lower.pattern.kind = kind;
    b.plan.upper.pattern.placement = "wrap"; b.plan.lower.pattern.placement = "wrap";
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const before = b.atlas.rgba.slice();
    expect(referenceGarmentFoldPlan(b.plan)).toEqual([]);
    expect(applyReferenceGarmentFinish(b.atlas, b.plan)).toEqual([]);
    expect(b.atlas.rgba).toEqual(before);
  });
  it("keeps layered color blocks and neckline openings exact", () => {
    const b = fixture();
    b.plan.upper.colorBlocks = [{ id: "unit-opening", region: "vertical_opening", color: "#eeeeee", source: "observed", priority: 5 }];
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const before = b.atlas.rgba.slice();
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan);
    expect(paints.some(p => p.part === "body" && p.face === "front")).toBe(false);
    expect(paints.some(p => p.part === "body" && p.face === "back")).toBe(true);
    expect(paints.some(p => p.part === "rightArm")).toBe(true);
    for (const r of [CLASSIC_LAYOUT.body.base.front, CLASSIC_LAYOUT.body.base.top, CLASSIC_LAYOUT.body.base.bottom]) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        expect(b.atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
      }
    }
  });
  it("does not extend short sleeves/shorts, repaint skin or modify shoes/legwear", () => {
    const b = fixture(); b.plan.upper.rightSleeve.terminationRow = 4;
    b.plan.lower.garmentRows = 3; b.plan.lower.shoeRows = 2;
    b.plan.lower.legwear.kind = "thigh_highs"; b.plan.lower.legwear.color = "#663355";
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const before = b.atlas.rgba.slice();
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan);
    expect(paints.filter(p => p.part === "rightArm").every(p => p.y < 3)).toBe(true);
    expect(paints.filter(p => p.part.endsWith("Leg")).every(p => p.y < 2)).toBe(true);
    for (const [part, start] of [["rightArm", 3], ["rightLeg", 2], ["leftLeg", 2]] as const) {
      for (const face of ["front", "right", "left", "back"] as const) {
        const r = CLASSIC_LAYOUT[part].base[face];
        for (let y = start; y < r.h; y++) for (let x = 0; x < r.w; x++) {
          const i = ((r.y + y) * 64 + r.x + x) * 4;
          expect(b.atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
        }
      }
    }
  });
  it("does not reinterpret a non-material pixel as cloth or manufacture missing alpha", () => {
    const b = fixture(), p = referenceGarmentFoldPlan(b.plan)[0], r = CLASSIC_LAYOUT[p.part].base[p.face];
    const i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
    for (const color of [[245, 0, 219, 255], [0, 0, 0, 0]]) {
      const atlas = { ...b.atlas, rgba: b.atlas.rgba.slice() }; atlas.rgba.set(color, i);
      applyReferenceGarmentFinish(atlas, b.plan);
      expect([...atlas.rgba.slice(i, i + 4)]).toEqual(color);
    }
  });
  it("gives white cloth a connected visible crease rather than a clipped highlight", () => {
    const b = fixture();
    b.plan.upper.baseColor = "#ffffff";
    b.plan.upper.rightSleeve.color = "#ffffff"; b.plan.upper.leftSleeve.color = "#ffffff";
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan).filter(p => p.part === "body" && p.face === "front");
    expect(paints.length).toBeGreaterThan(0);
    expect(new Set(paints.map(p => p.color.join(":")))).toEqual(new Set(["230:230:230", "214:214:214"]));
    expect(paints.every(p => p.sourceColor.join(":") === "255:255:255")).toBe(true);
    const r = CLASSIC_LAYOUT.body.base.front;
    for (let y = 0; y < r.h; y++) for (const x of [0, r.w - 1]) {
      const i = ((r.y + y) * 64 + r.x + x) * 4;
      // Physical seams remain unmodified by the interior crease.
      expect(paints.some(p => p.x === x && p.y === y)).toBe(false);
      expect(b.atlas.rgba[i + 3]).toBe(255);
    }
  });
  it.each(["#242326", "#111820", "#303c40"])("gives %s cloth a quiet reflected ridge without changing its hue or boundaries", hex => {
    const b = fixture(); b.plan.upper.baseColor = hex;
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const before = b.atlas.rgba.slice();
    const paints = applyReferenceGarmentFinish(b.atlas, b.plan).filter(p => p.part === "body");
    expect(paints.length).toBeGreaterThan(0);
    for (const face of ["front", "right", "left", "back"] as const) {
      const cells = paints.filter(p => p.face === face);
      const source = cells[0].sourceColor;
      const ridge = cells.find(p => p.color[0] > source[0])!.color;
      const lift = face === "front" || face === "back" ? 6 : 16;
      expect(ridge.map((v, i) => v - source[i])).toEqual([lift, lift, lift]);
      expect(cells.some(p => p.color.every((v, i) => v <= source[i]))).toBe(true);
      const r = CLASSIC_LAYOUT.body.base[face];
      for (let y = 0; y < r.h; y++) for (const x of [0, r.w - 1]) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        expect(b.atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
      }
    }
  });
  it("does not mistake an all-material declaration or front-only print for full-surface color blocks", () => {
    const b = fixture();
    b.plan.upper.colorBlocks = [{ id: "unit-base", region: "all", color: b.plan.upper.baseColor, source: "observed", priority: 1 }];
    b.plan.upper.pattern.kind = "center_graphic"; b.plan.upper.pattern.placement = "front";
    b.plan.lower.pattern.kind = "checker_block"; b.plan.lower.pattern.placement = "front";
    applyOutfitPlan(b.atlas, b.plan, "#c69579");
    const before = b.atlas.rgba.slice(), paints = applyReferenceGarmentFinish(b.atlas, b.plan);
    expect(paints.some(p => p.part === "body" && p.face === "back")).toBe(true);
    expect(paints.some(p => p.part === "rightArm")).toBe(true);
    expect(paints.some(p => p.part.endsWith("Leg") && p.face === "back")).toBe(true);
    for (const part of ["body", "rightLeg", "leftLeg"] as const) {
      const r = CLASSIC_LAYOUT[part].base.front;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        expect(b.atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
      }
    }
  });
});
