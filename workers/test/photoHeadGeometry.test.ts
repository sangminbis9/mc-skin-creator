import { expect, it } from "vitest";
import { buildPhotoHeadGeometry } from "../src/photoHeadGeometry";
import { classifyPhotoHair } from "../src/photoHairFinish";
import { NAMEMC_EYES } from "../src/namemcHeadTemplate";
import { DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";

function render(patch: Partial<FaceStyle>, text: string) {
  const style = { ...DEFAULT_FACE_STYLE, ...patch };
  return buildPhotoHeadGeometry(style, classifyPhotoHair(style,text),text);
}
it("represents crops, bobs, parts, curls and ties using distinct two-layer silhouettes, not recoloring", () => {
  const variants: Array<[Partial<FaceStyle>,string]> = [
    [{hairstyle:"buzz"}, "Buzz cut."], [{hairstyle:"short"}, "Crew cut."],
    [{hairstyle:"short", bangs:"straight"}, "Bowl cut with a level fringe."],
    [{hairstyle:"short", bangs:"curtain", hairPart:"left"}, "Part on the viewer-left."],
    [{hairstyle:"short", bangs:"curtain", hairPart:"right"}, "Part on the viewer-right."],
    [{hairstyle:"short", bangs:"curtain", hairPart:"center"}, "Center part."],
    [{hairstyle:"medium", bangs:"straight"}, "Bob cut."],
    [{hairstyle:"short", hairTexture:"curly"}, "Short curls."],
    [{hairstyle:"bun"}, "Tied bun."], [{hairstyle:"long", hairStructure:"braids"}, "Twin braids."],
  ];
  const cuts = variants.map(([style,text]) => render(style,text));
  expect(cuts.map(x=>x.cut)).toEqual(["buzz","crew","bowl","side_part","side_part","curtain","bob","curls","tied","braids"]);
  expect(new Set(cuts.map(x=>JSON.stringify([x.base,x.overlay]))).size).toBe(variants.length);
  for (const g of cuts) for (const p of NAMEMC_EYES) {
    expect(g.base.front[p.y][p.x],g.cut).toBe(".");
    expect(g.overlay.front[p.y][p.x],g.cut).toBe(".");
  }
  expect(cuts[3].base.front[2][2]).toBe("."); expect(cuts[3].base.front[2][5]).toBe("#");
  expect(cuts[4].base.front[2][5]).toBe("."); expect(cuts[4].base.front[2][2]).toBe("#");
  expect(cuts[5].base.front[2].slice(3,5)).toBe("..");
  expect(cuts[0].overlay.top.join("")).not.toContain("#");
});

it("keeps straight and wavy long hair structurally different at the same part", () => {
  const style = { hairstyle:"long", overallHairLength:"chest", hairPart:"center", bangs:"curtain" } as const;
  const straight = render({ ...style, hairTexture:"straight" }, "Long straight hair with a center part.");
  const waves = render({ ...style, hairTexture:"wavy" }, "Long wavy hair with a center part.");
  expect(straight.overlay.top).not.toEqual(waves.overlay.top);
  expect(straight.base.front).not.toEqual(waves.base.front);
});

it("moves the hairline gap of long fringe-free hair with the observed side part", () => {
  const s = { hairstyle:"long", overallHairLength:"chest", bangs:"none" } as const;
  const left = render({...s,hairPart:"left"}, "Long straight hair with a visible part on the viewer-left.");
  const right = render({...s,hairPart:"right"}, "Long straight hair with a visible part on the viewer-right.");
  expect(left.base.front[2]).not.toEqual(right.base.front[2]);
  expect(left.base.front[2][2]).toBe("."); expect(right.base.front[2][2]).toBe("#");
});
