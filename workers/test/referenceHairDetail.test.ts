import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { headProportionOffset } from "../src/referenceHeadProportion";
import { validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";

const referencePaths = ["C:/Users/sangm/Downloads/2e8c98dab33b766f.png", "C:/Users/sangm/Downloads/0d6ef930518a8724.png"];
it.skipIf(!referencePaths.every(path => existsSync(path)))("inspects supplied male/female reference head layers without modifying the sources or calling providers", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/reference-hair-detail-20261013-");
  const entries = [];
  try {
    for (const [id, path] of [["long", "C:/Users/sangm/Downloads/2e8c98dab33b766f.png"],
      ["short", "C:/Users/sangm/Downloads/0d6ef930518a8724.png"]]) {
      const bytes = readFileSync(path), atlas = await decodePng(bytes);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      const sheet: RawImage = { width: 48, height: 24, rgba: new Uint8Array(48 * 24 * 4) };
      const faces = ["front", "right", "back", "left", "top", "bottom"] as const;
      const coverage = [];
      for (const [n, face] of faces.entries()) {
        const count = Array(8).fill(0) as number[];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const pixels = (["base", "overlay"] as const).map(layer => {
            const r = CLASSIC_LAYOUT.head[layer][face], i = ((r.y + y) * 64 + r.x + x) * 4;
            return atlas.rgba.slice(i, i + 4);
          });
          if (pixels[1][3]) count[y]++;
          for (let row = 0; row < 3; row++) {
            const p = row < 2 ? pixels[row] : pixels[1][3] ? pixels[1] : pixels[0];
            const i = ((row * 8 + y) * 48 + n * 8 + x) * 4;
            sheet.rgba.set(p[3] ? p : [110 + (x + y) % 2 * 18, 125 + (x + y) % 2 * 18, 140 + (x + y) % 2 * 18, 255], i);
          }
        }
        coverage.push({ face, outerCellsByRow: count });
      }
      writeFileSync(`${root}/${id}-head-layers.png`, await encodePng(scaleNearestNeighbor(sheet, 960, 480)), { flag: "wx" });
      entries.push({ id, sourceSha256: createHash("sha256").update(bytes).digest("hex"), coverage });
      expect(readFileSync(path)).toEqual(bytes);
    }
    writeFileSync(`${root}/inspection.json`, JSON.stringify({ faceOrder: ["front", "right", "back", "left", "top", "bottom"],
      rowOrder: ["base", "outer", "composite"], entries }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
    console.info(`REFERENCE_HAIR_DETAIL ${root}`);
  } finally { network.mockRestore(); }
});

function setup(long = false, glasses = false) {
  const raw = makeAnalysis();
  raw.fallbackFeatures.glasses = glasses ? "round" : "none"; raw.fallbackFeatures.facialHair = "none"; raw.observed.accessories = glasses ? "round glasses" : "none";
  if (!long) raw.renderHints.earExposure = "visible";
  if (long) { raw.observed.hair = "long straight hair with bangs"; raw.renderHints.overallHairLength = "chest"; raw.fallbackFeatures.hairstyle = "long"; }
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
  const atlas = buildProceduralSourceAtlas(features, style, plan)!;
  return { plan, style, design, atlas };
}

function comparisonHead(image: RawImage): RawImage {
  // The legacy evaluator crop starts below the crown. These inspection-only
  // panels include the entire raised head; production/evaluator stays unchanged.
  const width = Math.floor(image.width / 2), height = Math.floor(image.height * 5 / 18);
  const x = Math.floor((image.width - width) / 2), rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x + width) * 4), y * width * 4);
  return scaleNearestNeighbor({ width, height, rgba }, width * 3, height * 3);
}

it("raises connected source-supported fringe to the eye boundary on short and long hair, preserving the body and input plan", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/reference-hair-relief-replay-20261013-");
  const entries = [];
  const comparisons: RawImage[] = [];
  try {
    for (const long of [false, true]) {
      const b = setup(long), original = JSON.stringify(b.plan), id = long ? "long" : "short";
      const beforeDesign = { ...b.design, hairDetailPolicy: undefined };
      const before = composeReferenceStyleAtlas(b.atlas, b.plan, beforeDesign, b.style);
      const after = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
      const relief = after.diagnostic.headProportion!.paints.filter(p => p.layer === "overlay");
      expect(relief.length, id).toBeGreaterThan(0);
      expect(relief.some(p => p.y === 4), id).toBe(true);
      expect(relief.filter(p => p.face !== "front").length, `${id} profile relief actually renders`).toBeGreaterThan(0);
      expect(relief.every(p => ["front", "right", "left"].includes(p.face) && p.y >= 1 && p.y <= (p.face === "front" ? 4 : 3))).toBe(true);
      expect(relief.every(p => relief.some(q => q.face === p.face && q.x === p.x && Math.abs(q.y - p.y) === 1))).toBe(true);
      expect(after.diagnostic.headProportion!.eyePixels).toEqual(before.diagnostic.headProportion!.eyePixels);
      expect(measureReferenceRenderedQuality(after, b.atlas, b.plan, b.design, b.style).violations, id).toEqual([]);
      const selected = selectReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).selected;
      expect(selected).not.toBeNull();
      expect(selected!.design.hair.family).toBe(selectReferenceStyleAtlas(b.atlas, b.plan, beforeDesign, b.style).selected!.design.hair.family);
      expect(validateFinalAtlas(after.atlas).ok).toBe(true);
      // Added raised locks are interior texels. All physical outer seam
      // partners, including the reversed top/back edge, stay byte-identical.
      const seams = getBoxUvSeams(CLASSIC_LAYOUT.head.overlay);
      for (const seam of [...seams.vertical, ...seams.horizontal]) for (const p of [...seam.primary, ...seam.adjacent]) {
        const i = (p.y * 64 + p.x) * 4;
        expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
      }
      expect(composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).atlas).toEqual(after.atlas);
      expect(JSON.stringify(b.plan)).toBe(original);
      const headPixels = new Set(["base", "overlay"].flatMap(layer => Object.values(CLASSIC_LAYOUT.head[layer as "base" | "overlay"]).flatMap(r =>
        Array.from({ length: r.h }, (_, y) => Array.from({ length: r.w }, (_, x) => ((r.y + y) * 64 + r.x + x) * 4)).flat())));
      for (let i = 0; i < 16384; i += 4) if (!headPixels.has(i)) expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
      const mutated = structuredClone(after), p = relief.at(-1)!;
      mutated.atlas.rgba[headProportionOffset(p)] ^= 127;
      mutated.diagnostic.headProportion!.paints.find(q => q.layer === p.layer && q.face === p.face && q.x === p.x && q.y === p.y)!.color[0] ^= 127;
      expect(measureReferenceRenderedQuality(mutated, b.atlas, b.plan, b.design, b.style).constructionValid).toBe(false);
      for (const [name, output] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${root}/${id}-${name}.png`, await encodePng(output.atlas), { flag: "wx" });
        const views = renderSkinViews(output.atlas).filter(v => ["front", "back", "right", "left"].includes(v.name));
        for (const v of views) writeFileSync(`${root}/${id}-${name}-${v.name}.png`, await encodePng(scaleNearestNeighbor(v.image, v.image.width * 4, v.image.height * 4)), { flag: "wx" });
        const all = renderSkinViews(output.atlas);
        for (const view of ["front", "front_right_three_quarter", "right", "back"])
          comparisons.push(comparisonHead(all.find(v => v.name === view)!.image));
      }
      const ears = after.diagnostic.headProportion!.paints.filter(p => !p.layer && p.role === "skin" && ["right", "left"].includes(p.face));
      if (!long) expect(ears.length).toBeGreaterThan(0);
      entries.push({ id, relief, ears });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ entries, providerCalls: 0 }, null, 2), { flag: "wx" });
    const w = comparisons[0].width, h = comparisons[0].height;
    const sheet: RawImage = { width: w * 4, height: h * 4, rgba: new Uint8Array(w * h * 16 * 4) };
    for (const [n, image] of comparisons.entries()) for (let y = 0; y < h; y++)
      sheet.rgba.set(image.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(n / 4) * h + y) * sheet.width + n % 4 * w) * 4);
    writeFileSync(`${root}/head-before-after.png`, await encodePng(sheet), { flag: "wx" });
    console.info(`REFERENCE_HAIR_RELIEF ${root}`);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

it("keeps covered ears covered, mirrors exposed ear anatomy and preserves actual eyewear pixels", () => {
  const b = setup(), after = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
  const ears = after.diagnostic.headProportion!.paints.filter(p => !p.layer && p.role === "skin" && ["right", "left"].includes(p.face));
  expect(ears.length).toBeGreaterThan(0);
  const right = ears.filter(p => p.face === "right").map(p => [7 - p.x, p.y, p.color]).sort();
  const left = ears.filter(p => p.face === "left").map(p => [p.x, p.y, p.color]).sort();
  expect(left).toEqual(right);
  b.style.earExposure = "covered";
  const covered = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
  expect(covered.diagnostic.headProportion!.paints.filter(p => !p.layer && p.role === "skin" && ["right", "left"].includes(p.face))).toEqual([]);
  const glasses = setup(false, true), frozen = composeReferenceStyleAtlas(glasses.atlas, glasses.plan, { ...glasses.design, hairDetailPolicy: undefined }, glasses.style);
  const detailed = composeReferenceStyleAtlas(glasses.atlas, glasses.plan, glasses.design, glasses.style);
  const frames = glasses.plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "glasses");
  expect(frames.length).toBeGreaterThan(0);
  for (const c of frames) {
    const r = CLASSIC_LAYOUT.head[c.layer === "outer" ? "overlay" : "base"][c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
    expect(detailed.atlas.rgba.slice(i, i + 4)).toEqual(frozen.atlas.rgba.slice(i, i + 4));
  }
  expect(measureReferenceRenderedQuality(detailed, glasses.atlas, glasses.plan, glasses.design, glasses.style).violations).toEqual([]);
});

it("retains center-part openings and excludes headwear, scalp, undercut, tied and measured geometry", () => {
  const part = setup(); part.plan.facePixelPlan.layout.fringeOpening = "center";
  const projected = composeReferenceStyleAtlas(part.atlas, part.plan, part.design, part.style).diagnostic.headProportion!;
  expect(projected.paints.filter(p => p.layer === "overlay" && [3, 4].includes(p.x))).toEqual([]);
  for (const kind of ["hat", "scalp", "undercut", "measured", "tied"] as const) {
    const b = setup();
    if (kind === "hat") b.style.hat = "cap";
    if (kind === "scalp") b.plan.hairPlan.surfaceOnly = true;
    if (kind === "undercut") b.style.sideHairShape = "undercut";
    if (kind === "measured") b.plan.facePixelPlan.layout.geometryUsage.hairline = true;
    if (kind === "tied") b.plan.headIdentityPlan.ownership!.tiedMass = { position: "high_back", horizontalBias: "center", verticalProminence: 1,
      massWidth: 4, attachmentWidth: 2, attachmentRegion: "crown_back", outerDepth: 1, source: "observed", groupId: "tied", attachmentGroupId: "attachment" };
    const after = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
    expect(after.diagnostic.headProportion!.paints.some(p => p.layer === "overlay"), kind).toBe(false);
  }
});
