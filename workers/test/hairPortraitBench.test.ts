/** Offline rendering of individually analyzed, synthetic portraits. Uses
 * compact visual audit observations; production EO checks are a separate run. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { ADAPTIVE_NAMEMC_HEAD_FINISH, applyNameMcHead, DRAPE_NAMEMC_HEAD_FINISH, NAMEMC_EYES } from "../src/namemcHeadTemplate";
import { decodeImage, encodePng, type RawImage } from "../src/png";
import { photoHeadForRender, renderSkinEngine } from "../src/skinEngine";
import { buildPhotoDrape } from "../src/photoHairFinish";
import { buildSkinPlan } from "../src/skinPlan";
import { renderSkinInspectionView } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

type Entry = {id:string; sheetId:string; row:number; col:number; sha256:string};
type Audit = {
  cut:string; part:"none"|"left"|"center"|"right"; fringe:"none"|"straight"|"side"|"curtain"|"wispy"|"textured";
  length:"cropped"|"ear"|"jaw"|"shoulder"|"chest"|"waist"|"hip"; texture:"straight"|"wavy"|"curly"|"coily";
  sides:"tapered"|"undercut"|"ear_hugging"|"face_framing"|"flared"; front:"none"|"left"|"right"|"both";
  tied:"none"|"bun"|"ponytail"|"twintails"; tuck:"none"|"left"|"right"|"both";
  color:"black"|"dark-brown"|"brown"|"blonde"|"gray"|"red"|"other";
};
const intended = {
  "a-short": ["buzz", "crew", "crop", "spiky"], "b-parts": ["side_part", "side_part", "curtain", "slick"],
  "c-bobs": ["pixie", "bob", "bob", "shag"], "d-long": ["long", "wave", "wave", "long"],
  "e-curls": ["wave", "curtain", "curls", "curls"], "f-tied": ["tied", "tied", "tied", "braids"],
  "g-fringe": ["bob", "long", "side_part", "crop"], "h-mixed": ["side_part", "bowl", "shag", "bob"],
} as Record<string, string[]>;
const wording: Record<string,string> = { buzz:"buzz cut", crew:"crew cut", crop:"short crop", spiky:"spiky cut", slick:"slicked-back quiff", side_part:"side parted hair", curtain:"curtain bangs", bowl:"bowl cut", pixie:"pixie cut", bob:"bob cut", shag:"layered shag", long:"long loose hair", wave:"loose wavy hair", curls:"curly hair", coils:"coily hair", braids:"two braids", locs:"locs", tied:"tied hair", bald:"bald scalp" };
const directory = process.env.HAIR_BENCH_DIR;
const at = (r:Rect, x:number, y:number) => ((r.y + y) * 64 + r.x + x) * 4;
const sig = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
function analysisFromObservation(o: Audit) {
  const raw = makeAnalysis(), length = o.length;
  const long = ["shoulder", "chest", "waist", "hip"].includes(length);
  const exactStyle = o.cut === "tied" && o.tied !== "none" ? o.tied : wording[o.cut] ?? "hair";
  const frontal = o.front === "none" ? "" : `Hair lies over the front of the top on ${o.front === "both" ? "both sides" : `the viewer ${o.front}`} to the ${long ? length : "shoulder"}.`;
  const tucks = o.tuck === "none" ? "" : o.tuck === "both" ? "Both sides are tucked behind the ears." : `The viewer-${o.tuck} side is tucked behind the ear.`;
  const root = o.part === "none" ? "No visible scalp part." : o.part === "center" ? "Visible center part." : `Visible part on the viewer-${o.part}.`;
  raw.observed.hair = `${exactStyle}. ${o.texture} ${length}-length hair. ${root} ${frontal} ${tucks}`;
  raw.observed.accessories = "No visible accessories.";
  raw.observed.clothing = "A plain long-sleeved charcoal sweatshirt.";
  raw.identityPrompt = raw.observed.hair;
  raw.outfitPrompt = raw.observed.clothing;
  raw.inferred.hairBack = { value: long && o.tied === "none" ? "Long loose hair towards the back" : "Conservative visible cut continuation", rationale: "Match visible length; keep unseen detail conservative." };
  raw.canonicalIdentity = { overallImpression: raw.observed.hair, mustPreserve: [exactStyle], features: [
    { feature: exactStyle, evidence: raw.observed.hair, category: "hair", confidence: "high", priority: 5, targetRegions: ["head.front", "head.top"] },
  ] };
  Object.assign(raw.fallbackFeatures, { hairstyle: o.cut === "buzz" ? "buzz" : o.cut === "bald" ? "bald" : o.tied !== "none" ? o.tied
    : long ? "long" : length === "jaw" ? "medium" : "short", hairColor: o.color === "other" ? "dark-brown" : o.color,
    glasses: "none", earrings: false, hat: "none", topType:"sweater", topColor:"gray" });
  Object.assign(raw.renderHints, { hairPart:o.part, fringeOpening:o.fringe === "straight" || o.fringe === "textured" ? "none" : o.part,
    bangs:o.fringe === "textured" ? "straight" : o.fringe, bangsLength:o.fringe === "none" ? "none" : "brow",
    fringeEdge:o.fringe === "wispy" ? "wispy" : o.fringe === "straight" ? "blunt" : "staggered",
    hairTexture:o.texture, overallHairLength:length, sideHairLength:long ? "shoulder" : length === "jaw" ? "jaw" : "short",
    sideHairShape:o.sides, hairBackShape:o.tied !== "none" ? "tied" : long ? "long" : "tapered" });
  return normalizeAnalysisForRendering(raw);
}
function draw(target: RawImage, img: RawImage, lx:number, ly:number, w:number, h:number, crop = {x:0,y:0,w:img.width,h:img.height}) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((crop.y + Math.floor(y * crop.h / h)) * img.width + crop.x + Math.floor(x * crop.w / w)) * 4;
    if (img.rgba[i+3]) target.rgba.set(img.rgba.subarray(i, i+4), ((ly+y)*target.width+lx+x)*4);
  }
}

it.skipIf(!directory)("renders the 100+ individually observed portraits and audits visual shape rather than dye", async () => {
  const root = directory!, review = process.env.HAIR_BENCH_OUTPUT_DIR ?? root, output = join(review,"renders");
  await mkdir(output,{recursive:true});
  const entries = JSON.parse(await readFile(join(root,"portraits.json"),"utf8")) as Entry[];
  const report: Array<Entry & { observed?:Audit; cut?:string; target:string; pattern?:string; sameEyes?:boolean; taskError?:string }> = [];
  const first = new Set<string>();
  const preview: RawImage = { width: 896, height: 1120, rgba: new Uint8Array(896 * 1120 * 4) };
  for (let i = 0; i < preview.rgba.length; i += 4) preview.rgba.set([229,236,241,255],i);
  for (const e of entries) {
    const target = intended[e.sheetId][e.row-1];
    let o: Audit;
    try {
      const saved = JSON.parse(await readFile(join(root,"vision",`${e.id}.json`),"utf8"));
      if (saved.sha256 !== e.sha256) throw Error("input identity mismatch");
      o = saved.observed;
    } catch { report.push({ ...e,target,taskError:"no_visual_observation" }); continue; }
    const a = analysisFromObservation(o);
    const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const plan = buildSkinPlan({ ...a, fallbackFeatures:{...a.fallbackFeatures, topColor:String(features.topColor), bottomColor:String(features.bottomColor), topAccentColor:String(features.topAccentColor), shoesColor:String(features.shoesColor)} });
    features.topColor = plan.outfitPlan.upper.baseColor;
    const style = buildFaceStyle(a, features, plan.hairPlan), source = buildProceduralSourceAtlas(features,style,plan);
    if (!source) { report.push({...e,target,observed:o,taskError:"no_valid_source"}); continue; }
    const r = renderSkinEngine(source,plan,a,style,5,"source");
    if (!r.ok) { report.push({...e,target,observed:o,taskError:r.reason}); continue; }
    const drape = buildPhotoDrape(plan,a,style,true);
    const geom = photoHeadForRender(style,a,drape);
    const baseline = photoHeadForRender(style,a,drape,"source",ADAPTIVE_NAMEMC_HEAD_FINISH);
    expect(geom.base,e.id).toEqual(baseline.base);
    expect(geom.cut,e.id).toBe(baseline.cut);
    const old = applyNameMcHead(source,source,plan,style,"source",DRAPE_NAMEMC_HEAD_FINISH);
    const visible = NAMEMC_EYES.every(p => {
      const i = at(CLASSIC_LAYOUT.head.base.front,p.x,p.y), j = at(CLASSIC_LAYOUT.head.overlay.front,p.x,p.y);
      return r.atlas.rgba[j+3] === 0 && r.atlas.rgba.subarray(i,i+4).every((v,c) => v === old.rgba[i+c]);
    });
    expect(visible,e.id).toBe(true); expect(validateFinalAtlas(r.atlas).ok,e.id).toBe(true);
    const pattern = sig(JSON.stringify([geom.base,geom.overlay]));
    report.push({...e,target,observed:o,cut:geom.cut,pattern,sameEyes:visible});
    await writeFile(join(output,`${e.id}.skin.png`),await encodePng(r.atlas));
    const front = renderSkinInspectionView(r.atlas,0,0);
    await writeFile(join(output,`${e.id}.preview.png`),await encodePng(front));
    const label = `${e.sheetId}:${e.row}`;
    if (!first.has(label)) {
      first.add(label);
      const k = Object.keys(intended).indexOf(e.sheetId)*4+e.row-1, col = k%4, row = Math.floor(k/4);
      const photo = await decodeImage(await readFile(join(root,"photos",`${e.id}.jpg`)));
      draw(preview,photo,col*224+8,row*140+14,100,100);
      draw(preview,front,col*224+111,row*140+14,108,110,{x:37,y:10,w:118,h:120});
    }
  }
  const valid = report.filter(e => e.pattern), targets = valid.filter(e => e.target === e.cut).length;
  const statistics = { portraits:entries.length, individualVision:report.filter(e => e.observed).length, rendered:valid.length,
    distinctGeometry:new Set(valid.map(e => e.pattern)).size, exactIntentRowMatch:targets,
    unchangedEyeCases:valid.filter(e => e.sameEyes).length, failures:report.filter(e=>e.taskError).reduce<Record<string,number>>((s,e)=>(s[e.taskError!] = (s[e.taskError!] ?? 0)+1,s),{}) };
  await writeFile(join(review,"render-report.json"),JSON.stringify({ statistics, cases:report },null,2));
  await writeFile(join(review,"hairstyle-overview.png"),await encodePng(preview));
  const photos = relative(review, join(root,"photos")).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  const cards = valid.map(e=>`<figure><img width="150" src="${photos}/${e.id}.jpg"><img width="118" src="renders/${e.id}.preview.png"><figcaption>${e.id} · ${e.cut} · part ${e.observed?.part} <a href="renders/${e.id}.skin.png">PNG</a></figcaption></figure>`).join("");
  await writeFile(join(review,"review.html"),`<!doctype html><meta charset="utf-8"><title>Photo hair geometry review</title><style>body{background:#e5ecf1;color:#172432;font:16px system-ui;padding:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:14px}figure{padding:12px;margin:0;background:#fff}img{vertical-align:middle}a{color:#045b9b}</style><h1>Synthetic hairstyle review</h1><p>${valid.length}/${entries.length} valid rendered skins; ${statistics.distinctGeometry} distinct head masks. Derived from individual compact vision observations. The photos are fictional.</p><main>${cards}</main>`);
  console.log(JSON.stringify(statistics));
  expect(valid.length).toBeGreaterThanOrEqual(100);
  expect(statistics.distinctGeometry).toBeGreaterThanOrEqual(15);
}, 180_000);
