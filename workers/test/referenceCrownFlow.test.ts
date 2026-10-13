import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { referenceHairMaterial, referenceLooseHairMaterial } from "../src/referenceMaterialDetail";
import { referenceHairVolumeColor } from "../src/referenceHairVolume";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";

it("preserves lock modulation across the reversed crown/back seam for every part and pigment", () => {
  for (const hairPart of ["none", "center", "left", "right"] as const)
    for (const pigment of [[0, 0, 0], [30, 23, 19], [216, 168, 133], [255, 255, 255]] as [number, number, number][])
      for (const outer of [false, true]) {
        const style = { hairPart, hairTexture: "wavy" as const };
        const color = (face: "top" | "back", x: number, y: number) => referenceHairVolumeColor(
          referenceHairMaterial(pigment, face, x, y, style, outer, "continuous_locks_v4"), pigment,
          {face, x, y}, style, outer, "flowing_crown_v2");
        for (let x = 0; x < 8; x++) expect(color("top", x, 0)).toEqual(color("back", 7 - x, 0));
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
          expect(color("back", x, y).every(c => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
      }
  const a = referenceHairVolumeColor([20, 20, 20], [30, 30, 30], {face: "back", x: 2, y: 2}, {}, false, "flowing_crown_v2");
  const b = referenceHairVolumeColor([30, 30, 30], [30, 30, 30], {face: "back", x: 2, y: 2}, {}, false, "flowing_crown_v2");
  expect(a).not.toEqual(b); // Crown no longer destroys underlying lock shading.
});

it("continues observed long-hair reflections below the nape without changing historical shading", () => {
  const pigment: [number, number, number] = [32, 26, 20], style = {hairPart: "center" as const, hairTexture: "straight" as const};
  for (let x = 0; x < 8; x++) expect(referenceLooseHairMaterial(pigment, {face: "back", x, y: 0, shade: 1}, style, "continuous_locks_v4"))
    .toEqual(referenceHairMaterial(pigment, "back", x, 7, style, false, "continuous_locks_v4"));
  const colors = Array.from({length: 9}, (_, y) => referenceLooseHairMaterial(pigment, {face: "back", x: 1, y, shade: 1}, style, "continuous_locks_v4")[0]);
  expect(new Set(colors).size).toBeGreaterThan(1);
  const old = Array.from({length: 9}, (_, y) => referenceLooseHairMaterial(pigment, {face: "back", x: 1, y, shade: 1}, style, "flow_locks_v3")[0]);
  expect(new Set(old).size).toBe(1);
});

it("replays same-analysis short/long hair with unchanged occupancy, identity and accessories", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/namemc-crown-flow-");
  const panels: RawImage[] = [], entries = [];
  try {
    for (const long of [false, true]) {
      const raw = makeAnalysis();
      raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "none"; raw.observed.accessories = "silver hair clip on viewer left";
      if (long) {
        raw.observed.hair = "chest-length brown straight hair with bangs; face-framing front locks extend to the chest";
        raw.renderHints.overallHairLength = "chest"; raw.fallbackFeatures.hairstyle = "long";
        raw.fallbackFeatures.hairColor = "brown"; raw.renderHints.hairBackShape = "long"; raw.renderHints.sideHairLength = "shoulder";
        raw.inferred.hairBack = {value: "long straight brown curtain continuing down the back", rationale: "visible long side lengths"};
        raw.canonicalIdentity.features = [{category: "hair", feature: raw.observed.hair, evidence: raw.observed.hair,
          priority: 5, confidence: "high", targetRegions: ["head.front", "head.back"]}];
        raw.canonicalIdentity.mustPreserve = [raw.observed.hair]; raw.canonicalIdentity.overallImpression = raw.observed.hair;
      }
      const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
      const source = buildProceduralSourceAtlas(features, style, plan)!, frozen = JSON.stringify({plan, style, design, source});
      const beforeDesign = {...design, materialDetailPolicy: "flow_locks_v3" as const, hairVolumePolicy: "crown_relief_v1" as const};
      const before = composeReferenceStyleAtlas(source, plan, beforeDesign, style), after = composeReferenceStyleAtlas(source, plan, design, style);
      expect(measureReferenceRenderedQuality(after, source, plan, design, style).violations).toEqual([]);
      expect(selectReferenceStyleAtlas(source, plan, design, style).selected).not.toBeNull();
      expect(validateFinalAtlas(after.atlas).ok).toBe(true);
      expect(composeReferenceStyleAtlas(source, plan, design, style).atlas).toEqual(after.atlas);
      const changed = [];
      for (let i = 0; i < source.rgba.length; i += 4) {
        expect(after.atlas.rgba[i + 3]).toBe(before.atlas.rgba[i + 3]);
        if ([0, 1, 2].some(c => after.atlas.rgba[i + c] !== before.atlas.rgba[i + c])) changed.push(i);
      }
      expect(changed.length).toBeGreaterThan(0);
      expect(after.diagnostic.looseHair).toEqual(before.diagnostic.looseHair);
      if (long) {
        expect(after.diagnostic.looseHair.points.length).toBeGreaterThan(16);
        expect(after.diagnostic.looseHair.points.some(p => {
          const r = CLASSIC_LAYOUT.body.base[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
          return changed.includes(i);
        })).toBe(true);
      }
      for (const cell of plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "other_p5" || c.owner === "glasses")) {
        const r = CLASSIC_LAYOUT.head[cell.layer === "outer" ? "overlay" : "base"][cell.face], i = ((r.y + cell.y) * 64 + r.x + cell.x) * 4;
        expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
      }
      expect(JSON.stringify({plan, style, design, source})).toBe(frozen);
      const id = long ? "long" : "short";
      for (const [mode, result] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${root}/${id}-${mode}.png`, await encodePng(result.atlas), {flag: "wx"});
        const views = renderSkinViews(result.atlas);
        for (const name of ["front", "front_right_three_quarter", "right", "back"]) panels.push(views.find(v => v.name === name)!.image);
      }
      entries.push({id, changedPixels: changed.length, actualTorsoHairPixels: after.diagnostic.looseHair.points.length,
        before: createHash("sha256").update(before.atlas.rgba).digest("hex"), after: createHash("sha256").update(after.atlas.rgba).digest("hex")});
    }
    const w = panels[0].width, h = panels[0].height;
    const sheet: RawImage = {width: w * 4, height: h * 4, rgba: new Uint8Array(w * h * 16 * 4)};
    panels.forEach((p, n) => { for (let y = 0; y < h; y++) sheet.rgba.set(p.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(n / 4) * h + y) * sheet.width + n % 4 * w) * 4); });
    writeFileSync(`${root}/comparison.png`, await encodePng(scaleNearestNeighbor(sheet, sheet.width * 2, sheet.height * 2)), {flag: "wx"});
    writeFileSync(`${root}/results.json`, JSON.stringify({entries, providerCalls: 0, provenance: "authored same-analysis offline fixtures, not live photo generation"}, null, 2), {flag: "wx"});
    expect(network).not.toHaveBeenCalled();
    console.info(`CROWN_FLOW_REPLAY ${root}`);
  } finally { network.mockRestore(); }
}, 60_000);

it.skipIf(!process.env.NAMEMC_DEPTH_REFERENCES)("inspects four public reference atlases offline without changing source bytes", async () => {
  const root = mkdtempSync("evaluation-artifacts/namemc-depth-inspection-");
  const records = [];
  for (const id of ["31eadc2ebabad00b", "215a16a5df1506c8", "c807a1e71f2eaeb1", "eb032063161b4add"]) {
    const path = `${process.env.NAMEMC_DEPTH_REFERENCES}/${id}.png`, bytes = readFileSync(path), atlas = await decodePng(bytes);
    expect([atlas.width, atlas.height]).toEqual([64, 64]);
    const sheet: RawImage = { width: 48, height: 24, rgba: new Uint8Array(48 * 24 * 4) };
    for (const [n, face] of (["front", "right", "back", "left", "top", "bottom"] as const).entries()) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const pixels = (["base", "overlay"] as const).map(layer => {
          const r = CLASSIC_LAYOUT.head[layer][face], i = ((r.y + y) * 64 + r.x + x) * 4;
          return atlas.rgba.slice(i, i + 4);
        });
        for (let row = 0; row < 3; row++) {
          const p = row < 2 ? pixels[row] : pixels[1][3] ? pixels[1] : pixels[0];
          sheet.rgba.set(p[3] ? p : [110 + (x + y) % 2 * 18, 125, 140, 255], ((row * 8 + y) * 48 + n * 8 + x) * 4);
        }
      }
    }
    writeFileSync(`${root}/${id}-layers.png`, await encodePng(scaleNearestNeighbor(sheet, 960, 480)), { flag: "wx" });
    records.push({ url: `https://ko.namemc.com/skin/${id}`, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(readFileSync(path)).toEqual(bytes);
  }
  writeFileSync(`${root}/references.json`, JSON.stringify({ records, faces: ["front", "right", "back", "left", "top", "bottom"], rows: ["base", "outer", "composite"] }, null, 2), { flag: "wx" });
  console.info(`NAMEMC_DEPTH_INSPECTION ${root}`);
});
