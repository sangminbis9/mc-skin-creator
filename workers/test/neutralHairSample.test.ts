import { expect, it } from "vitest";
import { readAppearanceDetail } from "../src/appearanceDetail";
import { observedNeutralHairColor, sampleNeutralCrown } from "../src/neutralHairSample";
import { classifyPhotoHair } from "../src/photoHairFinish";
import { buildPhotoHeadGeometry } from "../src/photoHeadGeometry";
import { DEFAULT_FACE_STYLE } from "../src/skinPack";
import { makeAnalysis } from "./helpers";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const bounds = { headBox: rect(.25,.1,.75,.64), faceBox: rect(.32,.30,.68,.61), subjectBox: rect(.18,.08,.82,.95), confidence:.95 };
function fixture(crest: readonly [number,number,number], texture = true) {
  const rgba = new Uint8Array(120 * 120 * 4);
  for(let y=0;y<120;y++) for(let x=0;x<120;x++) {
    const inCrest = x > 32 && x < 88 && y >= 14 && y < 37;
    const delta = texture ? (x % 11) * 3 - 12 : 0;
    rgba.set(inCrest ? crest.map(c => c+delta).concat(255) : [152,152,152,255],(y*120+x)*4);
  }
  return { width:120, height:120, rgba };
}

it("corroborates textured gray and platinum without bleaching dark hair, warm brown or the background", () => {
  const gray=sampleNeutralCrown(fixture([88,86,86]),bounds)!;
  const platinum=sampleNeutralCrown(fixture([200,196,184]),bounds)!;
  expect(parseInt(gray.slice(1,3),16)).toBeGreaterThan(70);
  expect(parseInt(platinum.slice(1,3),16)).toBeGreaterThan(175);
  for (const c of [[27,25,24],[91,62,44],[146,145,143]] as const) expect(sampleNeutralCrown(fixture(c),bounds)).toBeUndefined();
  expect(sampleNeutralCrown(fixture([191,190,188], false),bounds)).toBeUndefined();
  const a = makeAnalysis({appearanceDetail: readAppearanceDetail({hairNeutral: "platinum"})});
  expect(observedNeutralHairColor(a)).toBe("#e0dbd3");
  expect(observedNeutralHairColor({ ...a, appearanceDetail: { ...a.appearanceDetail!, beanie: "beanie" } })).toBeUndefined();
});

it("shortens only the observed temple, preserving the opposite long lock, forehead and nape", () => {
  const observed="A layered shag with long nape and shorter temple strands.";
  const style={...DEFAULT_FACE_STYLE, hairstyle:"medium", hairPart:"center"} as const;
  const p=classifyPhotoHair(style, observed, true);
  const previous=buildPhotoHeadGeometry(style,p,observed);
  const next=buildPhotoHeadGeometry(style,p,observed,[],{templeLeft:"at_ear",templeRight:"below_jaw"});
  expect(previous.base.front[6][0]).toBe("#");
  expect(next.base.front[6][0]).toBe(".");
  expect(next.base.front[6][7]).toBe("#");
  expect(next.base.front.map(r => r.slice(1,7))).toEqual(previous.base.front.map(r => r.slice(1,7)));
  expect(next.overlay.front[6][0]).toBe(".");
  expect(next.base.back).toEqual(previous.base.back);
});
