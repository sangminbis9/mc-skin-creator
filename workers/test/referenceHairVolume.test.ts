import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinInspectionView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { hasReferenceHairVolume, referenceHairVolumeGroups, referenceHairVolumeColor } from "../src/referenceHairVolume";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sheet(images: RawImage[], columns: number): RawImage {
  const w = images[0].width, h = images[0].height, width = w * columns, height = h * Math.ceil(images.length / columns);
  const out = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < out.rgba.length; i += 4) out.rgba.set([121, 145, 155, 255], i);
  images.forEach((v, n) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (v.rgba[i + 3]) out.rgba.set(v.rgba.slice(i, i + 4), ((Math.floor(n / columns) * h + y) * width + n % columns * w + x) * 4);
  } });
  return out;
}
function tile(atlas: RawImage, face: "top" | "back", layer: "base" | "overlay") {
  const r = CLASSIC_LAYOUT.head[layer][face], out = { width: 8, height: 8, rgba: new Uint8Array(256) };
  for (let y = 0; y < 8; y++) out.rgba.set(atlas.rgba.slice(((r.y + y) * 64 + r.x) * 4, ((r.y + y) * 64 + r.x + 8) * 4), y * 32);
  return scaleNearestNeighbor(out, 128, 128);
}
it("inspects reference top/back layers without changing source assets", async () => {
  if (!process.env.REFERENCE_SKIN_DIRECTORY) return;
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/hair-volume-reference-20261012-");
    const rows = [], tiles: RawImage[] = [], views: RawImage[] = [];
    for (const id of "ABCDEFG") {
      const path = `${process.env.REFERENCE_SKIN_DIRECTORY}/${id} skin.png`, bytes = readFileSync(path), atlas = await decodePng(bytes);
      for (const face of ["top", "back"] as const) for (const layer of ["base", "overlay"] as const) tiles.push(tile(atlas, face, layer));
      views.push(renderSkinInspectionView(atlas, 45, 25), renderSkinInspectionView(atlas, 135, 25));
      rows.push({ id, sha256: hash(bytes) }); expect(readFileSync(path)).toEqual(bytes);
    }
    writeFileSync(`${root}/tiles.png`, await encodePng(sheet(tiles, 4)), { flag: "wx" });
    writeFileSync(`${root}/views.png`, await encodePng(sheet(views, 2)), { flag: "wx" });
    writeFileSync(`${root}/evidence.json`, JSON.stringify({ rows, columns: ["top base", "top overlay", "back base", "back overlay"], providerCalls: 0 }, null, 2), { flag: "wx" });
    expect(net).not.toHaveBeenCalled(); console.info(`HAIR_VOLUME_REFERENCE ${root}`);
  } finally { net.mockRestore(); }
}, 120_000);

it("adds bounded crown/back relief on saved analyses, preserving face/body and exact historical replay", async () => {
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/hair-volume-replay-20261012-");
  const rows = [];
  try {
    for (const id of ["012", "013", "017", "018", "019", "020"]) {
      const input = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}`;
      const bytes = readFileSync(`${input}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
      const plan = t.skinPlan.skinPlan, { features, faceStyle: style } = t.injectedParameters;
      const base = buildProceduralSourceAtlas(features, style, plan)!;
      const original = JSON.stringify({ plan, style, design: t.referenceStyle.design });
      const before = composeReferenceStyleAtlas(base, plan, t.referenceStyle.design, style);
      // The old plan remains executable, including the already-approved
      // front-fringe fix. No old PNG/trace is overwritten by this replay.
      const historical = await decodePng(readFileSync(`${input}/skin.png`));
      const historicalDifferences = Array.from({ length: 4096 }, (_, p) => p).filter(p => [0, 1, 2, 3].some(c => historical.rgba[p * 4 + c] !== before.atlas.rgba[p * 4 + c])).length;
      expect(historicalDifferences, id).toBe(0);
      const design: ReferenceStylePlan = { ...t.referenceStyle.design, hairVolumePolicy: "crown_relief_v1" };
      const after = composeReferenceStyleAtlas(base, plan, design, style);
      const quality = measureReferenceRenderedQuality(after, base, plan, design, style);
      expect(quality.violations, id).toEqual([]);
      expect(after.atlas).toEqual(composeReferenceStyleAtlas(base, plan, design, style).atlas);
      const allowed = new Set<number>();
      for (const layer of ["base", "overlay"] as const) for (const face of ["top", "back"] as const) {
        const r = CLASSIC_LAYOUT.head[layer][face];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) allowed.add((r.y + y) * 64 + r.x + x);
      }
      let changed = 0, added = 0;
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.atlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) {
        expect(allowed.has(p), `${id}: outside crown/back ${p}`).toBe(true); changed++;
        if (!before.atlas.rgba[p * 4 + 3] && after.atlas.rgba[p * 4 + 3]) added++;
      }
      const eligible = hasReferenceHairVolume(plan, design, style);
      if (eligible) { expect(changed).toBeGreaterThan(20); expect(added).toBeGreaterThan(0); }
      else expect(changed).toBe(0);
      for (const variant of [
        { ...plan, hairPlan: { ...plan.hairPlan, surfaceOnly: true } },
        { ...plan, facePixelPlan: { ...plan.facePixelPlan, layout: { ...plan.facePixelPlan.layout, geometryUsage: { ...plan.facePixelPlan.layout.geometryUsage, hairline: true } } } },
      ]) expect(hasReferenceHairVolume(variant, design, style)).toBe(false);
      expect(hasReferenceHairVolume(plan, design, { ...style, hat: "cap" })).toBe(false);
      const selected = selectReferenceStyleAtlas(base, plan, design, style).selected;
      expect(selected, id).not.toBeNull();
      const oldSelection = selectReferenceStyleAtlas(base, plan, { ...design, hairVolumePolicy: undefined }, style).selected!;
      expect(selected!.design.hair.family, `${id}: volume must not select a different hairstyle`).toBe(oldSelection.design.hair.family);
      expect(selected!.design.face.family).toBe(oldSelection.design.face.family);
      expect(selected!.design.outfit.family).toBe(oldSelection.design.outfit.family);
      expect(selected!.quality.score).toBeCloseTo(oldSelection.quality.score, 2);
      if (eligible) {
        expect(hasReferenceHairVolume(plan, selected!.design, style)).toBe(true);
        const actual = selected!.composition;
        const withoutVolume = composeReferenceStyleAtlas(base, plan, { ...selected!.design, hairVolumePolicy: undefined }, style);
        expect(actual.atlas.rgba).not.toEqual(withoutVolume.atlas.rgba);
      }
      const views = [before, after].flatMap(r => [renderSkinInspectionView(r.atlas, 45, 25), renderSkinInspectionView(r.atlas, 135, 25)]);
      writeFileSync(`${root}/${id}-comparison.png`, await encodePng(sheet(views, 2)), { flag: "wx" });
      writeFileSync(`${root}/${id}-after.png`, await encodePng(after.atlas), { flag: "wx" });
      writeFileSync(`${root}/${id}-tiles.png`, await encodePng(sheet([before, after].flatMap(r => [tile(r.atlas, "top", "base"), tile(r.atlas, "top", "overlay"), tile(r.atlas, "back", "base"), tile(r.atlas, "back", "overlay")]), 4)), { flag: "wx" });
      rows.push({ id, inputSha256: hash(bytes), beforeHash: hash(before.atlas.rgba), afterHash: hash(after.atlas.rgba), historicalDifferences, eligible, changed, added,
        family: design.hair.family, selectedFamily: selected?.design.hair.family, selectedPolicy: selected?.design.hairVolumePolicy, quality });
      expect(JSON.stringify({ plan, style, design: t.referenceStyle.design })).toBe(original);
      expect(readFileSync(`${input}/summary.json`)).toEqual(bytes);
    }
    expect(net).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, provenance: "offline saved-plan counterfactual, not new inference", rows }, null, 2), { flag: "wx" });
    console.info(`HAIR_VOLUME_REPLAY ${root}`);
  } finally { net.mockRestore(); }
}, 240_000);

it("keeps each raised bundle connected across the top/back seam and leaves a part channel", () => {
  for (const hairPart of ["none", "center", "left", "right"] as const) for (const group of referenceHairVolumeGroups({ hairPart })) {
    expect(group.every(p => p.x >= 1 && p.x <= 6 && p.y < 4)).toBe(true);
    for (const p of group.filter(p => p.y === 0 && p.face === "top")) expect(group.some(q => q.face === "back" && q.x === 7 - p.x && q.y === 0)).toBe(true);
    if (hairPart !== "none") {
      const roots = hairPart === "center" ? [3, 4] : hairPart === "left" ? [2] : [5];
      expect(group.filter(p => p.face === "top").every(p => !roots.includes(p.x))).toBe(true);
    }
  }
});

it("uses identical crown/back seam colors with bounded pigments, without repainting the front or nape", () => {
  for (const hairPart of ["none", "center", "left", "right"] as const) for (const pigment of [[0, 0, 0], [48, 32, 20], [240, 220, 210]] as [number, number, number][]) {
    const current: [number, number, number] = [30, 25, 20];
    for (let x = 0; x < 8; x++) {
      expect(referenceHairVolumeColor(current, pigment, { face: "top", x, y: 0 }, { hairPart }, true))
        .toEqual(referenceHairVolumeColor(current, pigment, { face: "back", x: 7 - x, y: 0 }, { hairPart }, true));
      for (const p of [{ face: "front" as const, x, y: 1 }, { face: "back" as const, x, y: 7 }, { face: "top" as const, x, y: 7 }])
        expect(referenceHairVolumeColor(current, pigment, p, { hairPart })).toEqual(current);
    }
  }
});
