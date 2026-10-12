import { expect, it } from "vitest";
import { repairSkinIntegrity } from "../../shared/skinIntegrity";
import { ALL_PARTS, CLASSIC_LAYOUT, SLIM_LAYOUT, getBoxUvSeams } from "../../shared/skinLayout";
import { SkinModel } from "../../src/editor/SkinModel";
import { makeSyntheticAtlas } from "./helpers";
it.each(["classic", "slim"] as const)("audits every part/layer on %s and repairs structural faults using trusted pixels", geometry => {
  const reference = makeSyntheticAtlas(64), layout = geometry === "slim" ? SLIM_LAYOUT : CLASSIC_LAYOUT;
  for (const p of ALL_PARTS) for (const r of Object.values(layout[p].base)) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) reference.rgba[((r.y+y)*64+r.x+x)*4+3] = 255;
  const source = { ...reference, rgba: reference.rgba.slice() }, offsets = [];
  for (const p of ALL_PARTS) { const r = layout[p].base.front, i = (r.y*64+r.x)*4; source.rgba[i+3]=0; offsets.push(i); }
  source.rgba.set([22, 33, 44, 255], (63*64+63)*4);
  const repaired = repairSkinIntegrity(source, reference, geometry);
  expect(repaired.report).toMatchObject({ valid: true, baseHoles: 6, unresolved: 0 });
  for(const i of offsets) expect(repaired.atlas.rgba.slice(i,i+4)).toEqual(reference.rgba.slice(i,i+4));
  expect(repairSkinIntegrity(source, undefined, geometry).report.valid).toBe(false);
  expect(repaired.report.seamPairs).toBe(ALL_PARTS.reduce((sum,p)=>sum+2*[...getBoxUvSeams(layout[p].base).vertical,...getBoxUvSeams(layout[p].base).horizontal].reduce((n,s)=>n+s.primary.length,0),0));
  expect(source.rgba[offsets[0]+3]).toBe(0);
});
it("places asymmetric limbs on the correct anatomical side while preserving app UVs", () => {
  const model = new SkinModel({ width: 64, height: 64 } as HTMLCanvasElement);
  try {
    for(const [index,x] of [[4,-6],[6,6],[8,-2],[10,2]]) expect(model.meshes[index].position.x).toBe(x);
    const left = model.meshes[6], right = model.meshes[4];
    expect([...left.geometry.getAttribute("uv").array]).not.toEqual([...right.geometry.getAttribute("uv").array]);
  } finally { model.dispose(); }
});
