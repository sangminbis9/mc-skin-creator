import { describe, expect, it } from "vitest";
import { applyReferenceFaceFinish, referenceIrisPigmentCells } from "../src/referenceFaceFinish";
import { buildSkinPlan } from "../src/skinPlan";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

function fixture() {
  const a = makeAnalysis(), face = structuredClone(buildSkinPlan(a).facePixelPlan);
  face.layout.eyeTopology = "readable_iris"; face.glassesPlan.topology = "none";
  face.pixels = [{ x: 2, y: 4, cluster: "left_eye", role: "iris" }, { x: 5, y: 4, cluster: "right_eye", role: "iris" }];
  const protectedCells = Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8) }))
    .filter(p => !face.pixels.some(q => p.x === q.x && p.y === q.y));
  return { face, design: buildReferenceStylePlan(a), protectedCells };
}
describe("singleton iris uses source pigment, not a two-row contour or invented glint", () => {
  it.each([[74, 55, 40], [38, 73, 104], [156, 181, 198]] as const)("preserves source RGB %j on exactly two existing cells", (...eye) => {
    const b = fixture(), atlas = makeSyntheticAtlas(), before = atlas.rgba.slice(), plan = JSON.stringify(b.face);
    const result = applyReferenceFaceFinish(atlas, b.face, b.design,
      { skinMid: [242, 214, 192], skinShade: [189, 167, 150], lip: [224, 169, 147], eye }, b.protectedCells);
    expect(result.irisPigmentCells).toEqual(b.face.pixels.map(p => ({ x: p.x, y: p.y, color: eye })));
    expect(result.irisGlintCells).toEqual([]);
    const r = CLASSIC_LAYOUT.head.base.front, allowed = new Set(b.face.pixels.map(p => ((r.y + p.y) * 64 + r.x + p.x) * 4));
    for (let i = 0; i < before.length; i += 4) {
      expect(atlas.rgba[i + 3]).toBe(before[i + 3]);
      if (!allowed.has(i)) expect(atlas.rgba.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
    }
    expect(JSON.stringify(b.face)).toBe(plan);
  });
  it.each(["missing", "protected", "fringe", "glasses", "closed", "asymmetric", "tilted", "duplicate", "legacy"] as const)("does not manufacture a pair for %s", kind => {
    const b = fixture(); let eye: number[] | undefined = [74, 55, 40];
    if (kind === "missing") eye = undefined;
    if (kind === "protected") b.protectedCells.push({ x: 2, y: 4 });
    if (kind === "fringe") b.face.pixels.push({ x: 2, y: 4, cluster: "fringe", role: "hair_mid" });
    if (kind === "glasses") b.face.glassesPlan.topology = "rectangular_thin";
    if (kind === "closed") b.face.layout.eyeTopology = "smiling_squint";
    if (kind === "asymmetric") b.face.pixels.pop();
    if (kind === "tilted") b.face.pixels[1].y = 3;
    if (kind === "duplicate") b.face.pixels.push({ ...b.face.pixels[0] });
    if (kind === "legacy") b.design.version = "reference_style_v1";
    expect(referenceIrisPigmentCells(b.face, b.design, eye, b.protectedCells)).toEqual([]);
  });
});
