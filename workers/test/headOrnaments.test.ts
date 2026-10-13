import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildObservedHeadOrnaments, ornamentFootprint, type HeadOrnamentKind } from "../src/headOrnaments";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT } from "../src/gemmaPhotoAnalysis";
import { observedWearables } from "../src/observedWearables";

const cases: Array<[HeadOrnamentKind, string]> = [
  ["clip", "small silver hair clip on viewer-left"], ["bow", "paired pink hair bows on both sides"],
  ["ribbon", "paired blue hair ribbons on both sides"], ["flower", "paired small white hair flowers on both sides"],
  ["headband", "red headband"], ["headphones", "black headphones"], ["earmuffs", "white earmuffs"],
  ["crown", "gold crown"], ["tiara", "silver tiara"], ["animal_ears", "pink cat-ear headband"],
  ["horns", "black decorative horns"], ["goggles", "brown goggles resting on forehead"],
];
function input(text: string) {
  const a = makeAnalysis(); a.observed.accessories = text; a.fallbackFeatures.glasses = "none";
  a.fallbackFeatures.facialHair = "none"; a.fallbackFeatures.earrings = false;
  a.canonicalIdentity.features = a.canonicalIdentity.features.filter(f => f.category !== "accessory");
  a.renderHints.hairAccessory = "none"; a.renderHints.earExposure = "visible";
  return a;
}
function setup(text: string) {
  const a = normalizeAnalysisForRendering(input(text)), plan = buildSkinPlan(a);
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, features, plan.hairPlan), design = buildReferenceStylePlan(a);
  const atlas = buildProceduralSourceAtlas(features, style, plan)!;
  return { a, plan, style, design, atlas };
}
const offset = (p: {face: keyof typeof CLASSIC_LAYOUT.head.overlay; x: number; y: number}) => {
  const r = CLASSIC_LAYOUT.head.overlay[p.face]; return ((r.y + p.y) * 64 + r.x + p.x) * 4;
};
function headPanel(image: RawImage): RawImage {
  const width = Math.floor(image.width / 2), height = Math.floor(image.height * 5 / 18), x = Math.floor((image.width - width) / 2);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(image.rgba.subarray((y*image.width+x)*4, (y*image.width+x+width)*4), y*width*4);
  return {width, height, rgba};
}
function grid(panels: RawImage[], columns: number): RawImage {
  const w=panels[0].width, h=panels[0].height, width=w*columns, height=h*Math.ceil(panels.length/columns);
  const sheet: RawImage={width,height,rgba:new Uint8Array(width*height*4)};
  for (const [n,p] of panels.entries()) for (let y=0;y<h;y++) sheet.rgba.set(p.rgba.subarray(y*w*4,(y+1)*w*4),((Math.floor(n/columns)*h+y)*width+n%columns*w)*4);
  return scaleNearestNeighbor(sheet,width*4,height*4);
}

it("recognizes 12 bounded head accessory grammars without inventing types, laterality or negative/uncertain observations", () => {
  for (const [kind, text] of cases) {
    expect(buildObservedHeadOrnaments(input(text)).map(p => p.kind), text).toEqual([kind]);
    for (const prefix of ["no ", "without ", "possibly ", "hidden "]) expect(buildObservedHeadOrnaments(input(prefix + text)), prefix + text).toEqual([]);
  }
  for (const text of ["hair clip", "crown of the head has dark hair", "headband print on shirt", "bow tie at neck", "silver necklace", "goggles worn over eyes", "no headband, headphones or earmuffs", "without a headband and headphones"])
    expect(buildObservedHeadOrnaments(input(text)), text).toEqual([]);
  const mixed = buildObservedHeadOrnaments(input("black headphones; small pink hair clip on viewer-right; no crown"));
  expect(mixed.map(p => [p.kind, p.side])).toEqual([["headphones", "center"], ["clip", "right"]]);
  expect(mixed[1].cells[1].color).toEqual([218, 149, 177]);
  const localColor = input("none"); localColor.observed.hair = "black hair with a silver hair clip on viewer-left";
  expect(buildObservedHeadOrnaments(localColor)[0].cells[1].color).toEqual([176, 182, 194]);
  expect(buildObservedHeadOrnaments(input("two silver hair clips on viewer-left"))[0].side).toBe("left");
  const hidden = input("none"); hidden.inferred.hairBack.value = "gold crown and pink hair bows";
  hidden.observed.hair = "short black hair with a rounded crown";
  expect(buildObservedHeadOrnaments(hidden)).toEqual([]);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain("Inventory every clearly visible accessory independently");
});

it("keeps mirrored clips and physical headband seam partners on the correct side", () => {
  const color: [number, number, number] = [120, 80, 100];
  const left = ornamentFootprint("clip", "left", color), right = ornamentFootprint("clip", "right", color);
  expect(right).toEqual(left.map(p => ({...p, x: 7 - p.x})));
  const band = ornamentFootprint("headband", "center", color);
  for (const [topX, face, sideX] of [[0, "right", 3], [7, "left", 4]] as const) {
    expect(band.some(p => p.face === "top" && p.x === topX && p.y === 4)).toBe(true);
    expect(band.some(p => p.face === face && p.x === sideX && p.y === 0)).toBe(true);
    expect(band.find(p => p.face === "top" && p.x === topX && p.y === 4)!.color)
      .toEqual(band.find(p => p.face === face && p.x === sideX && p.y === 0)!.color);
  }
});

it("preserves observed ornament pixels through the production composer and selector; renders a fresh offline comparison", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/namemc-hair-accessories-");
  const panels: RawImage[] = [], results = [];
  try {
    for (const [kind, text] of cases) {
      const b = setup(text), immutable = JSON.stringify(b.plan);
      const ornaments = b.plan.headIdentityPlan.ownership!.ornaments ?? [];
      expect(ornaments.some(p => p.kind === kind), kind).toBe(true);
      const rendered = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
      const quality = measureReferenceRenderedQuality(rendered, b.atlas, b.plan, b.design, b.style);
      expect(quality.violations, kind).toEqual([]);
      expect(selectReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).selected, kind).not.toBeNull();
      expect(validateFinalAtlas(rendered.atlas).ok).toBe(true);
      for (const ornament of ornaments) for (const p of ornament.cells) {
        expect([...rendered.atlas.rgba.slice(offset(p), offset(p) + 4)], kind).toEqual([...p.color, 255]);
      }
      const corrupted = structuredClone(rendered), p = ornaments[0].cells[0];
      corrupted.atlas.rgba[offset(p)] ^= 127;
      expect(measureReferenceRenderedQuality(corrupted, b.atlas, b.plan, b.design, b.style).violations).toContain("source_head_accessory_changed");
      expect(JSON.stringify(b.plan)).toBe(immutable);
      expect(composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).atlas).toEqual(rendered.atlas);
      writeFileSync(`${root}/${kind}.png`, await encodePng(rendered.atlas), {flag:"wx"});
      const views = renderSkinViews(rendered.atlas);
      panels.push(...["front", "front_right_three_quarter", "right", "back"].map(name => headPanel(views.find(v => v.name === name)!.image)));
      results.push({ kind, cells: ornaments.reduce((n, p) => n + p.cells.length, 0), quality: quality.violations });
    }
    writeFileSync(`${root}/catalog.png`, await encodePng(grid(panels,4)), {flag:"wx"});
    // Same fixture, old material vs new material: no photo/model inference implied.
    const b = setup("none"), comparisons: RawImage[] = [];
    for (const policy of ["tapered_material_v2", "flow_locks_v3"] as const) {
      const output = composeReferenceStyleAtlas(b.atlas, b.plan, {...b.design, materialDetailPolicy:policy, hairProfilePolicy:policy === "flow_locks_v3" ? b.design.hairProfilePolicy : undefined}, b.style);
      const views = renderSkinViews(output.atlas); comparisons.push(...["front", "front_right_three_quarter", "right", "back"].map(name => headPanel(views.find(v => v.name === name)!.image)));
    }
    writeFileSync(`${root}/hair-before-after.png`, await encodePng(grid(comparisons,4)), {flag:"wx"});
    writeFileSync(`${root}/results.json`, JSON.stringify({providerCalls:0, results, referencePages:["https://ko.namemc.com/minecraft-skins/tag/egirl", "https://ko.namemc.com/minecraft-skins/tag/eboy"]}, null, 2), {flag:"wx"});
    expect(network).not.toHaveBeenCalled(); console.info(`NAMEMC_REPLAY ${root}`);
  } finally { network.mockRestore(); }
}, 60000);

it("rejects atomic ornaments that collide with measured or eyewear windows", () => {
  const a = input("brown goggles resting on forehead"); a.fallbackFeatures.glasses = "round";
  const plan = buildSkinPlan(a);
  for (const ornament of plan.headIdentityPlan.ownership?.ornaments ?? []) for (const p of ornament.cells)
    expect(plan.facePixelPlan.glassesPlan.framePixels.some(q => q.face === p.face && q.x === p.x && q.y === p.y)).toBe(false);
});

it("renders five source-visible neck/chest/wrist/waist wearables and never guesses hidden or unknown-side items", () => {
  for (const [kind, text] of [["choker", "black choker"], ["brooch", "gold brooch on viewer-left"],
    ["watch", "silver wristwatch on viewer-right"], ["bracelet", "pink bracelet on viewer-left"], ["waist_chain", "silver waist chain on viewer-left"]]) {
    const a = input(text); a.visibleRegions.lowerBody = true;
    const wearable = observedWearables(a);
    expect(wearable.map(p => p.kind)).toEqual([kind]);
    const plan = buildSkinPlan(a), features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, features, plan.hairPlan), design = buildReferenceStylePlan(a);
    const source = buildProceduralSourceAtlas(features, style, plan)!;
    const rendered = composeReferenceStyleAtlas(source, plan, design, style);
    expect(measureReferenceRenderedQuality(rendered, source, plan, design, style).violations, kind).toEqual([]);
    a.observed.accessories = `no ${text}`; expect(observedWearables(a)).toEqual([]);
    a.observed.accessories = text; a.visibleRegions.upperBody = false; a.visibleRegions.lowerBody = false;
    expect(observedWearables(a)).toEqual([]);
  }
  expect(observedWearables(input("a silver watch"))).toEqual([]);
  expect(observedWearables(input("no bracelet and gold watch on viewer-left"))).toEqual([]);
});

const publicReference = "C:/Users/sangm/Downloads/7eea5c21005577f2.png";
it.skipIf(!existsSync(publicReference))("inspects the downloaded public paired-ornament reference without altering or bundling it in production", async () => {
  const bytes = readFileSync(publicReference), raw = await decodePng(bytes);
  expect([raw.width, raw.height]).toEqual([64,64]);
  const root = mkdtempSync("evaluation-artifacts/namemc-reference-inspection-");
  const views = renderSkinViews(raw);
  for (const view of views.filter(v => ["front", "back", "right", "front_right_three_quarter"].includes(v.name)))
    writeFileSync(`${root}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width*6, view.image.height*6)), {flag:"wx"});
  writeFileSync(`${root}/source.json`, JSON.stringify({url:"https://ko.namemc.com/skin/7eea5c21005577f2", sha256:createHash("sha256").update(bytes).digest("hex")}), {flag:"wx"});
  expect(readFileSync(publicReference)).toEqual(bytes); console.info(`NAMEMC_REFERENCE ${root}`);
});
