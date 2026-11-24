import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPhotoAnalysis } from "../src/analysis";
import { generateFreeSkin } from "../src/engineService";
import { FREE_VISION_MODEL } from "../src/freeBudget";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { ADAPTIVE_NAMEMC_HEAD_FINISH, DRAPE_NAMEMC_HEAD_FINISH, NAMEMC_EYES, NAMEMC_HEAD_FINISH } from "../src/namemcHeadTemplate";
import { buildPhotoDrape, classifyPhotoHair } from "../src/photoHairFinish";
import { decodeImage, decodePng, encodePng, type RawImage } from "../src/png";
import { renderNameMcPresentation, renderSkinEngine } from "../src/skinEngine";
import { buildSkinPlan } from "../src/skinPlan";
import { renderSkinInspectionView } from "../src/skinRender";
import type { Env } from "../src/types";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

// Optional repeatable review: replay captured *synthetic* Workers AI replies
// without using network or quota. No raw images/provider replies in Git.
const directory = process.env.SYNTHETIC_PORTRAIT_REVIEW_DIR;
const artDirectory = process.env.STYLIZED_HAIR_REVIEW_DIR;
const capture = process.env.SYNTHETIC_PORTRAIT_CAPTURE === "revised" ? "revised" : "final";
const examples = [["soft-wave", "feminine"], ["short-part", "masculine"], ["wispy-fringe", "source"]] as const;

function draw(img: RawImage, target: RawImage, left: number, top: number, width: number, height: number,
  crop = { x: 0, y: 0, w: img.width, h: img.height }) {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const read = ((crop.y + Math.floor(y * crop.h / height)) * img.width + crop.x + Math.floor(x * crop.w / width)) * 4;
    const dest = ((top + y) * target.width + left + x) * 4;
    if (img.rgba[read + 3] !== 0) target.rgba.set(img.rgba.subarray(read, read + 4), dest);
  }
}

it.skipIf(!directory)("compares photo-led drape and hair families against the fixed-drape release", async () => {
  const root = directory!;
  const poster: RawImage = { width: 862, height: 694, rgba: new Uint8Array(862 * 694 * 4) };
  const art: RawImage | undefined = artDirectory ? { width: 1020, height: 516, rgba: new Uint8Array(1020 * 516 * 4) } : undefined;
  const masks = new Set<string>();
  for (let i = 0; i < poster.rgba.length; i += 4) poster.rgba.set([239, 244, 244, 255], i);
  if (art) for (let i = 0; i < art.rgba.length; i += 4) art.rgba.set([239, 244, 244, 255], i);
  for (const [row, [name, presentation]] of examples.entries()) {
    const captured = JSON.parse((await readFile(join(root, `${name}.${capture}.json`), "utf8")).replace(/^\uFEFF/, ""));
    expect(captured.status, name).toBe(200);
    const original = await readFile(join(root, `${name}.jpg`));
    const upload = `data:image/jpeg;base64,${original.toString("base64")}`;
    const spy = async () => captured.reply;
    const env = { AI_POLICY: "workers_free_only", WORKERS_VISION_MODEL: FREE_VISION_MODEL,
      FREE_ANALYSIS_RUN: spy, AI: { run: spy }, FREE_IMAGE_GENERATION_ENABLED: "false" } as unknown as Env;
    const analysis = await runPhotoAnalysis(env, upload);
    if (!analysis.ok) throw new Error(`${name}: ${analysis.detail}`);
    const renderAnalysis = normalizeAnalysisForRendering(analysis.analysis);
    const features = refineFeatureColorsFromAnalysis(renderAnalysis,
      fallbackFeaturesToHex(renderAnalysis.fallbackFeatures, renderAnalysis.renderHints.skinUndertone));
    const source = buildSkinPlan({ ...renderAnalysis, fallbackFeatures: { ...renderAnalysis.fallbackFeatures,
      topColor: String(features.topColor), bottomColor: String(features.bottomColor),
      topAccentColor: String(features.topAccentColor), shoesColor: String(features.shoesColor) } }, true);
    features.topColor = source.outfitPlan.upper.baseColor;
    if (source.outfitPlan.upper.leftSleeve.length === source.outfitPlan.upper.rightSleeve.length
        && ["long", "short"].includes(source.outfitPlan.upper.leftSleeve.length)) {
      features.sleeveLength = source.outfitPlan.upper.leftSleeve.length;
    }
    const style = buildFaceStyle(renderAnalysis, features, source.hairPlan);
    const base = buildProceduralSourceAtlas(features, style, source)!;
    const beforeFinish = renderSkinEngine(base, source, renderAnalysis, style, 5);
    if (!beforeFinish.ok) throw new Error(`${name}: no render plan`);
    const previous = renderNameMcPresentation(beforeFinish.atlas, source, renderAnalysis, style, presentation,
      beforeFinish.summary.design, DRAPE_NAMEMC_HEAD_FINISH);
    const replay = await generateFreeSkin(env, { image: upload, presentation });
    expect(replay.status, name).toBe(200);
    expect(replay.body.features?.fixedHairMask).toMatch(/^[A-Za-z0-9+/]{683}=$/);
    masks.add(String(replay.body.features?.fixedHairMask));
    const expected = renderSkinEngine(base, source, renderAnalysis, style, 5, presentation);
    if (!expected.ok) throw new Error(`${name}: final render rejected`);
    expect(expected.summary.headFinish?.policy).toBe(NAMEMC_HEAD_FINISH);
    const skin = Buffer.from(replay.body.skinPngBase64!, "base64");
    const current = await decodePng(skin);
    expect(current.rgba, `${name}: end-to-end output matches the inspected atlas`).toEqual(expected.atlas.rgba);
    expect([current.width, current.height]).toEqual([64, 64]);
    const hairMask = Buffer.from(String(replay.body.features?.fixedHairMask), "base64");
    let changedHeadHair = 0;
    const maskAt = (pixel: number) => !!(hairMask[pixel >> 3] & (1 << (pixel % 8)));
    const headAt = (x: number, y: number) => Object.values(CLASSIC_LAYOUT.head).some(box => Object.values(box).some(r =>
      x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h));
    for (let pixel = 0; pixel < 4096; pixel++) {
      const i = pixel * 4;
      const x = pixel % 64, y = pixel >> 6;
      if (!headAt(x, y)) continue;
      if (!current.rgba.subarray(i, i + 4).some((v, c) => v !== previous.rgba[i + c])) continue;
      changedHeadHair++;
    }
    expect(changedHeadHair, `${name}: public head finish`).toBeGreaterThan(0);
    const drape = buildPhotoDrape(source, renderAnalysis, style);
    if (name === "soft-wave") {
      expect(drape.some(p => p.face === "front" && p.x >= 6 && p.y === 7)).toBe(true);
      expect(drape.some(p => p.face === "front" && p.x <= 1)).toBe(false);
    } else expect(drape).toHaveLength(0);
    for (const p of drape) {
      const r = CLASSIC_LAYOUT.body[p.layer][p.face];
      expect(maskAt((r.y + p.y) * 64 + r.x + p.x)).toBe(true);
    }
    for (const { x, y, role } of NAMEMC_EYES) {
      const base = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
      const i = ((base.y + y) * 64 + base.x + x) * 4;
      if (role.startsWith("sclera")) expect(current.rgba[i]).toBeGreaterThan(180);
      else expect(current.rgba[i]).toBeLessThan(130);
      expect(current.rgba[((outer.y + y) * 64 + outer.x + x) * 4 + 3]).toBe(0);
    }
    const portrait = await decodeImage(original);
    draw(portrait, poster, 12, row * 230 + 12, 159, 212);
    if (art) {
      draw(portrait, art, 12, row * 170 + 10, 120, 150);
      const images = [renderNameMcPresentation(beforeFinish.atlas, source, renderAnalysis, style, "source", beforeFinish.summary.design, ADAPTIVE_NAMEMC_HEAD_FINISH),
        ...(["source", "feminine", "masculine"] as const).map(mode =>
          renderNameMcPresentation(beforeFinish.atlas, source, renderAnalysis, style, mode, beforeFinish.summary.design))];
      expect(images[2].rgba).not.toEqual(images[3].rgba);
      for (const [column, atlas] of images.entries()) {
        expect(atlas.rgba.slice(16 * 64 * 4), `${name}: body is not changed by the head finish`).toEqual(images[0].rgba.slice(16 * 64 * 4));
        for (const [angle, yaw] of [0, -35].entries()) {
          const view = renderSkinInspectionView(atlas, yaw, yaw ? 9 : 0);
          draw(view, art, 142 + column * 218 + angle * 103, row * 170 + 10, 103, 150, { x: 53, y: 0, w: 86, h: 125 });
        }
      }
      await writeFile(join(artDirectory!, `${name}-egirl.skin.png`), await encodePng(images[2]));
      await writeFile(join(artDirectory!, `${name}-eboy.skin.png`), await encodePng(images[3]));
    }
    for (const [column, [atlas, yaw]] of ([[previous, 0], [current, 0], [previous, -35], [current, -35]] as const).entries()) {
      const view = renderSkinInspectionView(atlas, yaw, yaw ? 8 : 0);
      draw(view, poster, 184 + column * 166, row * 230 + 12, 156, 212, { x: 39, y: 15, w: 114, h: 155 });
    }
    if (!artDirectory) await writeFile(join(root, `${name}-adaptive-hair-skin.png`), skin);
    console.log(name, { ...classifyPhotoHair(style, renderAnalysis.observed.hair), changedHeadHair,
      frontCells: drape.filter(p => p.face === "front").length, rearCells: drape.filter(p => p.face === "back").length });
  }
  expect(masks.size).toBe(3);
  if (art) await writeFile(join(artDirectory!, "stylized-hair-comparison.png"), await encodePng(art));
  else await writeFile(join(root, "adaptive-hair-before-after.png"), await encodePng(poster));
}, 60_000);
