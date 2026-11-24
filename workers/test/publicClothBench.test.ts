import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PhotoAnalysis, PixelRenderHints } from "../src/analysis";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex } from "../src/generate";
import { headUvIsByteIdentical } from "../src/outfitIdentityRetention";
import { PUBLIC_LEGWEAR_POLICY } from "../src/outfitIdentity";
import { renderOutfitFabricFoundation } from "../src/outfitRenderer";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { applyPublicClothFinish } from "../src/publicClothFinish";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { renderReferenceGarmentUnderlay } from "../src/referenceStyleRenderer";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinInspectionView } from "../src/skinRender";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

type Look = { name: string; words: string; kind: string; color: string; sleeve?: string; accent?: string; hints?: Partial<PixelRenderHints> };
const tops: Look[] = [
  { name: "Cotton tee", words: "A plain crew-neck short-sleeve T-shirt", kind: "tshirt", color: "#dfdbcf", sleeve: "short" },
  { name: "Breton stripe", words: "A horizontal striped boat-neck short-sleeve T-shirt", kind: "tshirt", color: "#425b75", accent: "#d9d9cc", sleeve: "short", hints: { garmentTexture: "striped" } },
  { name: "Graphic tee", words: "A short-sleeve T-shirt with a small chest graphic", kind: "tshirt", color: "#682e49", accent: "#e9ad8a", sleeve: "short" },
  { name: "Sleeveless top", words: "A sleeveless V-neck tank top", kind: "tank", color: "#a46779", sleeve: "sleeveless" },
  { name: "Cable knit", words: "A cable-knit crew-neck sweater with long sleeves", kind: "sweater", color: "#8d7c4a", sleeve: "long", hints: { garmentTexture: "knit" } },
  { name: "High-neck rib", words: "A rib-knit turtleneck sweater with long sleeves", kind: "sweater", color: "#262531", sleeve: "long", hints: { garmentTexture: "knit" } },
  { name: "Drawstring hood", words: "A long-sleeve pullover hoodie with hood strings and a large pocket", kind: "hoodie", color: "#536d63", accent: "#abbeb2", sleeve: "long" },
  { name: "Rolled button-up", words: "A collared button-down shirt with rolled sleeves", kind: "shirt", color: "#9db8b5", sleeve: "rolled" },
  { name: "Open cardigan", words: "An open cardigan over a contrasting inner shirt, with long sleeves", kind: "cardigan", color: "#9c725a", accent: "#e4dcc9", sleeve: "long", hints: { outerGarment: "cardigan", outerLayer: "light" } },
  { name: "Two-tone jacket", words: "An open varsity jacket with contrasting sleeves over an inner shirt", kind: "jacket", color: "#263a53", accent: "#d9bc99", sleeve: "long", hints: { outerGarment: "open_jacket", outerLayer: "heavy" } },
  { name: "Wool coat", words: "A closed long-sleeve coat with a high neck and a wide hem", kind: "coat", color: "#4d403c", sleeve: "long", hints: { outerGarment: "coat", outerLayer: "heavy" } },
  { name: "Tailored vest", words: "An open collared vest with no sleeves over a sleeveless inner shirt", kind: "vest", color: "#4b4b57", accent: "#c6c2ba", sleeve: "sleeveless", hints: { outerGarment: "vest", outerLayer: "light" } },
];
const bottoms: Look[] = [
  { name: "Straight trousers", words: "Plain straight-leg trousers", kind: "pants", color: "#353444" },
  { name: "Track stripe", words: "Track pants with a side stripe", kind: "pants", color: "#383d67", hints: { bottomAccent: "side_stripe" } },
  { name: "Plaid trousers", words: "Plaid trousers", kind: "pants", color: "#60554e", hints: { bottomPattern: "plaid" } },
  { name: "Belted chinos", words: "Chino pants with a belt", kind: "pants", color: "#987d5b", hints: { bottomAccent: "belt" } },
  { name: "Dark straight denim", words: "Straight-cut jeans", kind: "jeans", color: "#274557" },
  { name: "Cuffed denim", words: "Cuffed jeans", kind: "jeans", color: "#6093a6", hints: { bottomAccent: "cuffs" } },
  { name: "One distressed knee", words: "Distressed jeans with a rip at the viewer-left knee showing skin", kind: "jeans", color: "#527483" },
  { name: "Bare-leg shorts", words: "Plain shorts with bare legs", kind: "shorts", color: "#664d51" },
  { name: "Shorts and ankle socks", words: "Athletic shorts with ankle socks on both legs", kind: "shorts", color: "#5d6650", hints: { legwear: "socks", legwearColor: "white", legwearAsymmetry: "both" } },
  { name: "Shorts and leg warmers", words: "Shorts with leg warmers on both legs", kind: "shorts", color: "#41525b", hints: { legwear: "leg_warmers", legwearColor: "gray", legwearAsymmetry: "both" } },
  { name: "One thigh-high", words: "Shorts with a thigh-high sock on the viewer-right leg", kind: "shorts", color: "#50434c", hints: { legwear: "thigh_highs", legwearColor: "black", legwearAsymmetry: "right" } },
  { name: "Plain mini skirt", words: "Plain mini skirt with bare legs", kind: "skirt", color: "#64667b" },
  { name: "Pleated skirt", words: "Pleated mini skirt", kind: "skirt", color: "#723c45", hints: { bottomPattern: "pleated" } },
  { name: "Plaid skirt", words: "Plaid mini skirt", kind: "skirt", color: "#7d5a50", hints: { bottomPattern: "plaid" } },
  { name: "Maxi skirt", words: "Long maxi skirt", kind: "skirt", color: "#606884" },
  { name: "Lace skirt", words: "Mini skirt with a lace pattern", kind: "skirt", color: "#ad95a2", hints: { bottomPattern: "lace" } },
  { name: "Stockings and skirt", words: "Mini skirt with stockings on both legs", kind: "skirt", color: "#334b46", hints: { legwear: "stockings", legwearColor: "black", legwearAsymmetry: "both" } },
  { name: "Stretch leggings", words: "Plain stretch leggings", kind: "pants", color: "#39313e" },
];

function observation(top: Look, bottom: Look, visible = true): PhotoAnalysis {
  const base = makeAnalysis();
  const clothing = `${top.words}.${visible ? ` ${bottom.words}. White low-top sneakers.` : ""}`;
  return makeAnalysis({
    framing: visible ? "full_body" : "upper_body",
    visibleRegions: { ...base.visibleRegions, lowerBody: visible, feet: visible },
    observed: { ...base.observed, clothing, accessories: "No visible accessories." },
    inferred: { ...base.inferred, lowerBody: visible ? null : { value: "plain straight trousers", rationale: "Conservative completion." }, shoes: null },
    renderHints: { ...base.renderHints, garmentTexture: "plain", outerLayer: "none", outerGarment: "none", neckAccessory: "none",
      bottomPattern: "plain", bottomAccent: "none", ...top.hints, ...(visible ? bottom.hints : {}) },
    fallbackFeatures: { ...base.fallbackFeatures, topType: top.kind, topColor: top.color, topAccentColor: top.accent ?? "#b8a797",
      bottomType: visible ? bottom.kind : "pants", bottomColor: bottom.color, sleeveLength: top.sleeve!, shoesColor: "#e7e8dc", glasses: "none" },
    outfitPrompt: clothing,
  });
}

const skin = "#d39e80";
const template = observation(tops[0], bottoms[0]);
const features = fallbackFeaturesToHex(template.fallbackFeatures, template.renderHints.skinUndertone);
const templatePlan = buildSkinPlan(template);
const style = { ...buildFaceStyle(template, features, templatePlan.hairPlan), skinTone: skin };
const neutral = buildProceduralSourceAtlas(features, style, templatePlan)!;
const coordinate = (r: Rect, x: number, y: number) => ((r.y + y) * 64 + r.x + x) * 4;
const copy = (a: RawImage) => ({ ...a, rgba: a.rgba.slice() });
const hash = (a: Uint8Array) => createHash("sha256").update(a).digest("hex");
const noHue = (p: SkinPlan) => {
  const { upper: u, lower: l, outerLayer, accessories, formalSuit } = p.outfitPlan;
  return JSON.stringify([u.garmentType, u.neckline.kind, u.neckline.width, u.leftSleeve.length, u.rightSleeve.length, u.hem?.endRow,
    u.colorBlocks.map(x => x.region), u.leftSleeve.color !== u.rightSleeve.color, u.leftSleeve.color !== u.baseColor, u.pattern.kind,
    l.garmentType, l.garmentRows, l.pattern.kind, l.kneeDistressing?.parts, l.accent, l.legwear.kind, l.legwear.asymmetry, l.shoeStyle,
    outerLayer.regions, accessories.map(x => x.kind), formalSuit?.lapelStyle]);
};

const examples = new Set(["0-0", "1-13", "2-6", "3-8", "4-4", "5-14", "6-1", "7-2", "8-12", "9-5", "10-15", "11-3"]);
function drawCard(view: RawImage, target: RawImage, x: number, y: number) {
  // Show the material at native texel edges; crop out most of the fixed head.
  for (let v = 0; v < 145; v++) for (let u = 0; u < 100; u++) {
    const i = ((79 + Math.floor(v * 1.27)) * view.width + 32 + Math.floor(u * 1.28)) * 4;
    if (view.rgba[i + 3]) target.rgba.set(view.rgba.subarray(i, i + 4), ((y + v) * target.width + x + u) * 4);
  }
}

it("generates 216 full Minecraft outfits through the public fabric path and verifies non-fabric retention", async () => {
  const directory = process.env.PUBLIC_CLOTH_BENCH_DIR;
  const signature = new Set<string>(), visual = new Set<string>();
  const rows: Array<{ id: string; outfit: string; construction: string; changed: number; patterned: boolean }> = [];
  const poster: RawImage = { width: 876, height: 480, rgba: new Uint8Array(876 * 480 * 4) };
  for (let i = 0; i < poster.rgba.length; i += 4) poster.rgba.set([233, 239, 243, 255], i);
  if (directory) await mkdir(join(directory, "skins"), { recursive: true });
  let card = 0;
  for (const [u, top] of tops.entries()) for (const [l, bottom] of bottoms.entries()) {
    const id = `${u}-${l}`, label = `${top.name} / ${bottom.name}`;
    const a = observation(top, bottom), source = buildSkinPlan(a, PUBLIC_LEGWEAR_POLICY), design = buildReferenceStylePlan(a);
    const planJson = JSON.stringify(source.outfitPlan);
    const before = renderReferenceGarmentUnderlay(neutral, source, design, style, new Set(), 0);
    const after = copy(before);
    const protectedFabric = renderOutfitFabricFoundation(source.outfitPlan, skin);
    const changed = applyPublicClothFinish(after, source, skin, design.garmentDetailPolicy!);
    const expected = validateFinalAtlas(after);
    expect(expected.ok, label).toBe(true);
    expect(headUvIsByteIdentical(before, after), label).toBe(true);
    const proof = { changed: 0, alpha: 0, nonFabric: 0, edges: 0, visibleOuter: 0 };
    for (let i = 0; i < after.rgba.length; i += 4) {
      if (after.rgba[i + 3] !== before.rgba[i + 3]) proof.alpha++;
      if (after.rgba[i] === before.rgba[i] && after.rgba[i + 1] === before.rgba[i + 1] && after.rgba[i + 2] === before.rgba[i + 2]) continue;
      proof.changed++;
      if (!protectedFabric.fabric.has(i)) proof.nonFabric++;
    }
    for (const [part, boxes] of Object.entries(CLASSIC_LAYOUT)) if (part !== "head") {
      for (const [face, rect] of Object.entries(boxes.base) as [keyof typeof boxes.base, Rect][]) {
        const outer = boxes.overlay[face];
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          const i = coordinate(rect, x, y), j = coordinate(outer, x, y);
          if (after.rgba.subarray(i, i + 3).every((v, c) => v === before.rgba[i + c])) continue;
          if (x === 0 || x === rect.w - 1 || face === "top" || face === "bottom") proof.edges++;
          if (before.rgba[j + 3]) proof.visibleOuter++;
        }
      }
    }
    expect(proof, label).toEqual({ changed, alpha: 0, nonFabric: 0, edges: 0, visibleOuter: 0 });
    expect(changed, label).toBeGreaterThan(0);
    expect(applyPublicClothFinish(after, source, skin, design.garmentDetailPolicy!), label).toBe(0);
    expect(JSON.stringify(source.outfitPlan), label).toBe(planJson);
    const png = await encodePng(after), decoded = await decodePng(png);
    expect([decoded.width, decoded.height, hash(decoded.rgba)], label).toEqual([64, 64, hash(after.rgba)]);
    signature.add(noHue(source)); visual.add(hash(after.rgba));
    rows.push({ id, outfit: label, construction: source.outfitPlan.upper.garmentType + "/" + source.outfitPlan.lower.garmentType,
      changed, patterned: source.outfitPlan.upper.pattern.kind !== "none" || source.outfitPlan.lower.pattern.kind !== "none" });
    if (directory) {
      await writeFile(join(directory, "skins", `${id}.png`), png);
      if (examples.has(id)) {
        const prev = renderSkinInspectionView(before, -25), next = renderSkinInspectionView(after, -25);
        await writeFile(join(directory, `${id}-before.png`), await encodePng(prev));
        await writeFile(join(directory, `${id}-after.png`), await encodePng(next));
        const x = 10 + (card % 4) * 218, y = 8 + Math.floor(card / 4) * 157;
        drawCard(prev, poster, x, y); drawCard(next, poster, x + 103, y);
        card++;
      }
    }
  }
  const summary = { rendered: rows.length, uniqueAtlases: visual.size, structuralSignatures: signature.size,
    averageChangedTexels: Math.round(rows.reduce((a, r) => a + r.changed, 0) / rows.length), patternedLooks: rows.filter(r => r.patterned).length };
  console.log(summary);
  if (directory) {
    await writeFile(join(directory, "summary.json"), JSON.stringify({ summary, rows }, null, 2));
    await writeFile(join(directory, "comparison.png"), await encodePng(poster));
    const cards = rows.map(r => `<article><h3>${r.outfit}</h3>${examples.has(r.id) ? `<img src="${r.id}-before.png"><img src="${r.id}-after.png">` : `<img class="atlas" src="skins/${r.id}.png">`}<p>${r.construction} · ${r.changed} cloth texels · <a download href="skins/${r.id}.png">64×64 PNG</a></p></article>`).join("");
    await writeFile(join(directory, "review.html"), `<!doctype html><meta charset="utf-8"><title>Clothing bench</title><style>body{background:#e9eff3;color:#182633;font:16px system-ui;padding:28px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}article{background:white;border-radius:12px;padding:14px}img{width:100px;height:auto;image-rendering:pixelated}img.atlas{width:128px}h3{font-size:17px;margin:0}</style><h1>Clothing benchmark · ${rows.length} synthetic looks</h1><p>Design fixtures, not photographs. Before/after cards show the existing garment renderer on the left and the final cloth pass on the right.</p><main>${cards}</main>`);
  }
  expect(summary).toMatchObject({ rendered: 216, uniqueAtlases: 216 });
  expect(summary.structuralSignatures).toBeGreaterThanOrEqual(200);
}, 120_000);

it("does not promote unseen clothes or overwrite same-color fabric decorations and hair", () => {
  const a = observation(tops[2], bottoms[13], false), p = buildSkinPlan(a);
  expect(p.outfitPlan.lowerBodySource).toBe("minimum_inference");
  expect(p.outfitPlan.lower.pattern.kind).toBe("none");
  p.outfitPlan.upper.pattern = { ...p.outfitPlan.upper.pattern, kind: "center_graphic", placement: "front", anchor: "center",
    color: p.outfitPlan.upper.baseColor, source: "observed" };
  const design = buildReferenceStylePlan(a), image = renderReferenceGarmentUnderlay(neutral, p, design, style, new Set(), 0);
  const before = copy(image);
  const hair = { face: "front", layer: "base", x: 1, y: 2, tone: 2 } as const;
  const front = CLASSIC_LAYOUT.body.base.front;
  const i = coordinate(front, hair.x, hair.y), graphic = coordinate(front, 3, 4);
  const traced = renderOutfitFabricFoundation(p.outfitPlan, skin);
  expect(traced.fabric.has(graphic)).toBe(false);
  expect(traced.atlas.rgba.slice(graphic, graphic + 3)).toEqual(traced.atlas.rgba.slice(i, i + 3));
  // Even if cloth and hair RGB happen to be identical, ownership wins.
  applyPublicClothFinish(image, p, skin, design.garmentDetailPolicy!, [hair]);
  expect(image.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
  expect(image.rgba.slice(graphic, graphic + 4)).toEqual(before.rgba.slice(graphic, graphic + 4));
  expect(headUvIsByteIdentical(before, image)).toBe(true);
});

it("keeps a mini skirt short under long sleeves and accepts only skirt-local ankle length", () => {
  const mini = observation(tops[4], bottoms[11]);
  expect(buildSkinPlan(mini).outfitPlan.lower.garmentRows).toBe(9); // replay of the previous public result
  expect(buildSkinPlan(mini, true).outfitPlan.lower).toMatchObject({ garmentType: "skirt", garmentRows: 3, skinExposureRows: 6 });
  const long = observation(tops[4], bottoms[14]);
  expect(buildSkinPlan(long, true).outfitPlan.lower.garmentRows).toBe(9);
  const ankle = observation(tops[0], { ...bottoms[11], words: "Skirt falls to the ankles" });
  expect(buildSkinPlan(ankle, true).outfitPlan.lower.garmentRows).toBe(9);
  const dress = { ...tops[4], kind: "dress", words: "A long-sleeve knee-length dress" };
  expect(buildSkinPlan(observation(dress, bottoms[0]), true).outfitPlan.lower.garmentRows).toBe(5);
  expect(buildSkinPlan(observation({ ...dress, words: "A floor-length dress with sleeves" }, bottoms[0]), true)
    .outfitPlan.lower.garmentRows).toBe(9);
});
