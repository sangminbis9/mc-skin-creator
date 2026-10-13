import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { applyReferenceGarmentFinish, referenceGarmentFoldPlan } from "../src/referenceGarmentFinish";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";

function fixture(kind: "knit" | "hoodie" | "suit" | "printed" = "knit") {
  const a = makeAnalysis();
  a.fallbackFeatures.glasses = "none"; a.fallbackFeatures.facialHair = "none"; a.observed.accessories = "none";
  const text = kind === "suit" ? "charcoal formal suit jacket over white shirt with navy striped tie" : kind === "hoodie"
    ? "black long-sleeved hoodie and blue jeans" : kind === "printed" ? "pink and white striped sweater with short skirt and white socks" : "pastel pink long-sleeved sweater with short skirt and white socks";
  a.observed.clothing = text; a.outfitPrompt = text; a.visibleRegions.lowerBody = true;
  a.canonicalIdentity.features = a.canonicalIdentity.features.filter(f => f.category !== "outfit" && f.category !== "accessory");
  a.canonicalIdentity.features.push({feature: text, evidence: text, category: "outfit", confidence: "high", priority: 5, targetRegions: ["torso.front", "torso.back"]});
  if (kind === "suit") { a.renderHints.outerGarment = "open_jacket"; a.renderHints.neckAccessory = "tie"; a.fallbackFeatures.topType = "jacket"; a.fallbackFeatures.topColor = "black"; }
  const analysis = normalizeAnalysisForRendering(a), plan = buildSkinPlan(analysis);
  // Explicit unit cloth contracts keep this comparison independent of model
  // observation. Never modify a saved analysis to fill missing evidence.
  if (kind !== "suit") {
    const o = plan.outfitPlan, color = kind === "hoodie" ? "#202127" : "#d1a8b7";
    o.upper.baseColor = color; o.upper.garmentType = kind === "hoodie" ? "hoodie" : "sweater";
    o.upper.colorBlocks = []; o.upper.neckline = {...o.upper.neckline, kind: "crew", depth: 1};
    o.upper.pattern = {...o.upper.pattern, kind: kind === "printed" ? "horizontal_stripe" : "none", color: "#ece7e2", placement: "wrap", surfaceParts: undefined};
    o.upper.leftSleeve = {...o.upper.leftSleeve, length: "long", terminationRow: 11, color};
    o.upper.rightSleeve = {...o.upper.rightSleeve, length: "long", terminationRow: 11, color};
    o.lower.pattern.kind = "none"; o.lower.baseColor = kind === "hoodie" ? "#526b86" : "#64525c";
    o.lower.garmentType = kind === "hoodie" ? "jeans" : "skirt"; o.lower.garmentRows = kind === "hoodie" ? 10 : 2;
    o.accessories = []; o.outerLayer.regions = ["cuffs", "hem", "shoe_depth"];
    if (kind !== "hoodie") o.lower.legwear = {kind: "socks", color: "#eeeeee", asymmetry: "both", source: "observed"};
  }
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
  return {plan, style, design, source: buildProceduralSourceAtlas(features, style, plan)!};
}

it("uses connected bounded cloth clusters and atomically skips decoration collisions", () => {
  const o = fixture("hoodie").plan.outfitPlan;
  const atlas: RawImage = {width:64,height:64,rgba:new Uint8Array(16384)};
  applyOutfitPlan(atlas, {...o, accessories:[], outerLayer:{...o.outerLayer,regions:[]}}, "#c69579");
  const before = atlas.rgba.slice(), planned = referenceGarmentFoldPlan(o, "articulated_cloth_v1");
  expect(planned.some(p => p.cluster?.endsWith(":bend"))).toBe(true);
  for (const p of planned) {
    const r = CLASSIC_LAYOUT[p.part].base[p.face];
    expect(p.x > 0 && p.x < r.w - 1 && p.y > 0 && p.y < r.h - 1).toBe(true);
    expect(planned.some(q => q.cluster === p.cluster && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) === 1)).toBe(true);
    expect(p.color.every(c => c >= 0 && c <= 255 && Number.isInteger(c))).toBe(true);
  }
  const p = planned[0], r = CLASSIC_LAYOUT[p.part].base[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
  atlas.rgba.set([255,0,220,255], i);
  const painted = applyReferenceGarmentFinish(atlas, o, "articulated_cloth_v1");
  expect(painted.length).toBeGreaterThan(0);
  expect(painted.some(q => q.cluster === p.cluster)).toBe(false);
  expect([...atlas.rgba.slice(i,i+4)]).toEqual([255,0,220,255]);
  const changed = new Set(painted.map(q => {const rect = CLASSIC_LAYOUT[q.part].base[q.face]; return ((rect.y+q.y)*64+rect.x+q.x)*4;}));
  for (let at = 0; at < 16384; at += 4) if (at !== i && !changed.has(at)) expect(atlas.rgba.slice(at,at+4)).toEqual(before.slice(at,at+4));
  expect(applyReferenceGarmentFinish(atlas, o, "articulated_cloth_v1")).toEqual([]);
});

it("reserves openings/prints/exposed skin and never invents folds on short sleeves or skirt legs", () => {
  const o = fixture().plan.outfitPlan;
  o.upper.colorBlocks = [{id:"opening",region:"front_center",color:"#eeeeee",priority:5,source:"observed"}];
  const panels = referenceGarmentFoldPlan(o, "articulated_cloth_v1").filter(p => p.part === "body" && p.face === "front");
  expect(panels.length).toBeGreaterThan(0); expect(panels.every(p => p.x === 1 || p.x === 6)).toBe(true);
  o.upper.pattern.frontGraphic = {color:"#ff0000",anchor:"center",source:"observed",evidence:"observed chest symbol"};
  expect(referenceGarmentFoldPlan(o, "articulated_cloth_v1").some(p => p.part === "body" && p.face === "front")).toBe(false);
  o.upper.rightSleeve.terminationRow = 3;
  expect(referenceGarmentFoldPlan(o, "articulated_cloth_v1").filter(p => p.part === "rightArm")).toEqual([]);
  expect(referenceGarmentFoldPlan(o, "articulated_cloth_v1").filter(p => p.part.endsWith("Leg"))).toEqual([]);
  expect(referenceGarmentFoldPlan(fixture("printed").plan.outfitPlan, "articulated_cloth_v1")).toEqual([]);
  const localPrint = fixture("printed").plan.outfitPlan;
  localPrint.upper.pattern.surfaceParts = ["rightArm"];
  localPrint.upper.pattern.frontGraphic = {color:"#ffffff",anchor:"center",source:"observed",evidence:"observed shirt logo"};
  const scoped = referenceGarmentFoldPlan(localPrint,"articulated_cloth_v1");
  expect(scoped.some(p=>p.part==="rightArm")).toBe(false);
  expect(scoped.some(p=>p.part==="leftArm")).toBe(true);
});

it("keeps dark, pale and saturated cloth ramps bounded without random noise or hue inversion", () => {
  for (const color of ["#000000", "#ffffff", "#f8eae1", "#cc2255", "#203a56"]) {
    const o = fixture().plan.outfitPlan;
    o.upper.baseColor = color; o.upper.leftSleeve.color = color; o.upper.rightSleeve.color = color;
    const a = referenceGarmentFoldPlan(o,"articulated_cloth_v1");
    expect(a).toEqual(referenceGarmentFoldPlan(o,"articulated_cloth_v1"));
    expect(a.every(p=>p.color.every(c=>Number.isInteger(c)&&c>=0&&c<=255))).toBe(true);
    expect(new Set(a.filter(p=>p.face==="front").map(p=>p.color.join())).size).toBeGreaterThan(1);
    for (const p of a) for (let i=0;i<3;i++) for (let j=0;j<3;j++)
      if (p.sourceColor[i]>=p.sourceColor[j]) expect(p.color[i]).toBeGreaterThanOrEqual(p.color[j]);
  }
});

it("produces offline before/after cloth with identical head, seams, alpha and source structure", async () => {
  const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/reference-cloth-detail-");
  const gallery: RawImage[] = [], results = [];
  try {
    for (const kind of ["knit", "hoodie", "suit", "printed"] as const) {
      const b = fixture(kind), frozen = JSON.stringify(b);
      const beforeDesign = {...b.design, garmentDetailPolicy:undefined};
      const before = composeReferenceStyleAtlas(b.source,b.plan,beforeDesign,b.style);
      const after = composeReferenceStyleAtlas(b.source,b.plan,b.design,b.style);
      const quality = measureReferenceRenderedQuality(after,b.source,b.plan,b.design,b.style);
      expect(quality.violations,kind).toEqual([]);
      expect(validateFinalAtlas(after.atlas).ok).toBe(true);
      expect(selectReferenceStyleAtlas(b.source,b.plan,b.design,b.style).selected,kind).not.toBeNull();
      expect(composeReferenceStyleAtlas(b.source,b.plan,b.design,b.style).atlas).toEqual(after.atlas);
      let changed = 0;
      for (let i = 0; i < 16384; i += 4) { expect(after.atlas.rgba[i+3]).toBe(before.atlas.rgba[i+3]); if ([0,1,2].some(c=>after.atlas.rgba[i+c]!==before.atlas.rgba[i+c])) changed++; }
      if (kind !== "printed") expect(changed,kind).toBeGreaterThan(0);
      else expect(after.atlas.rgba).toEqual(before.atlas.rgba);
      for (const part of Object.keys(CLASSIC_LAYOUT) as (keyof typeof CLASSIC_LAYOUT)[]) for (const layer of ["base","overlay"] as const)
        for (const rect of Object.values(CLASSIC_LAYOUT[part][layer])) for (let y=0;y<rect.h;y++) for (let x=0;x<rect.w;x++) {
          // Every outer cell and every physical base seam stays exact, as does the complete head.
          if (part!=="head" && layer!=="overlay" && x>0 && x<rect.w-1 && y>0 && y<rect.h-1) continue;
          const i=((rect.y+y)*64+rect.x+x)*4;
          expect(after.atlas.rgba.slice(i,i+4)).toEqual(before.atlas.rgba.slice(i,i+4));
        }
      const panels: RawImage[] = [];
      for (const [name,output] of [["before",before],["after",after]] as const) {
        writeFileSync(`${root}/${kind}-${name}.png`,await encodePng(output.atlas),{flag:"wx"});
        const views=renderSkinViews(output.atlas);
        for (const view of ["front","right","back"]) panels.push(views.find(v=>v.name===view)!.image);
      }
      writeFileSync(`${root}/${kind}-comparison.png`,await encodePng(sheet(panels,3)),{flag:"wx"}); gallery.push(...panels);
      expect(JSON.stringify(b)).toBe(frozen);
      results.push({kind,changedPixels:changed,quality,headUnchanged:true,providerCalls:0});
      if (kind==="hoodie") {
        const mutant=structuredClone(after), p=referenceGarmentFoldPlan(b.plan.outfitPlan,"articulated_cloth_v1")[0];
        const r=CLASSIC_LAYOUT[p.part].base[p.face], i=((r.y+p.y)*64+r.x+p.x)*4;
        mutant.atlas.rgba[i]^=127;
        expect(measureReferenceRenderedQuality(mutant,b.source,b.plan,b.design,b.style).constructionValid).toBe(false);
      }
    }
    writeFileSync(`${root}/comparison.png`,await encodePng(sheet(gallery,6,2)),{flag:"wx"});
    writeFileSync(`${root}/results.json`,JSON.stringify({provenance:"authored offline same-analysis cloth fixtures, not new primary observations",results},null,2),{flag:"wx"});
    expect(network).not.toHaveBeenCalled(); console.info(`CLOTH_DETAIL_REPLAY ${root}`);
  } finally {network.mockRestore();}
},60_000);

function sheet(images: RawImage[], columns: number, scale = 3): RawImage {
  const w = images[0].width, h = images[0].height, width = w * columns, height = h * Math.ceil(images.length / columns);
  const out: RawImage = {width, height, rgba: new Uint8Array(width * height * 4)};
  images.forEach((image, n) => { for (let y = 0; y < h; y++) out.rgba.set(image.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(n / columns) * h + y) * width + n % columns * w) * 4); });
  return scaleNearestNeighbor(out, width * scale, height * scale);
}

it.skipIf(!process.env.REFERENCE_SKIN_DIRECTORY)("inspects reference garment layers offline without modifying the source art", async () => {
  const root = mkdtempSync("evaluation-artifacts/reference-cloth-inspection-");
  const records = [], gallery = [];
  const references = ["D", "E", "G"].map(id=>({id,path:`${process.env.REFERENCE_SKIN_DIRECTORY}/${id} skin.png`}));
  if (process.env.NAMEMC_DEPTH_REFERENCES) for (const id of ["215a16a5df1506c8","c807a1e71f2eaeb1"])
    references.push({id,path:`${process.env.NAMEMC_DEPTH_REFERENCES}/${id}.png`});
  for (const {id,path} of references) {
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path), atlas = await decodePng(bytes);
    expect([atlas.width, atlas.height]).toEqual([64, 64]);
    const panels: RawImage[] = [];
    for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      const panel: RawImage = {width: 32, height: 36, rgba: new Uint8Array(32 * 36 * 4)};
      for (const [n, face] of (["front", "right", "back", "left"] as const).entries()) {
        const base = CLASSIC_LAYOUT[part].base[face], outer = CLASSIC_LAYOUT[part].overlay[face];
        for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
          const pixels = [base, outer].map(r => atlas.rgba.slice(((r.y + y) * 64 + r.x + x) * 4, ((r.y + y) * 64 + r.x + x) * 4 + 4));
          for (let row = 0; row < 3; row++) {
            const p = row < 2 ? pixels[row] : pixels[1][3] ? pixels[1] : pixels[0];
            panel.rgba.set(p[3] ? p : [100, 120, 135, 255], ((row * 12 + y) * 32 + n * 8 + x) * 4);
          }
        }
      }
      panels.push(panel);
    }
    writeFileSync(`${root}/${id}-layers.png`, await encodePng(sheet(panels, 5, 6)), {flag:"wx"});
    gallery.push(...renderSkinViews(atlas).filter(v => ["front", "right", "back"].includes(v.name)).map(v => v.image));
    records.push({id, sha256: createHash("sha256").update(bytes).digest("hex")});
    expect(readFileSync(path)).toEqual(bytes);
  }
  writeFileSync(`${root}/gallery.png`, await encodePng(sheet(gallery, 3, 2)), {flag:"wx"});
  writeFileSync(`${root}/references.json`, JSON.stringify({records, parts:["body","rightArm","leftArm","rightLeg","leftLeg"], faces:["front","right","back","left"], rows:["base","outer","composite"]}, null, 2), {flag:"wx"});
  console.info(`CLOTH_REFERENCE_INSPECTION ${root}`);
});
