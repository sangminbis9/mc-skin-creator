import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinInspectionView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "../src/uvLayout";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { headProportionOffset } from "../src/referenceHeadProportion";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { hasReferenceHairVolume } from "../src/referenceHairVolume";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const faces: (keyof BoxUV)[] = ["front", "right", "back", "left", "top", "bottom"];
function sheet(images: RawImage[], columns: number): RawImage {
  const w = images[0].width, h = images[0].height, width = w * columns, height = h * Math.ceil(images.length / columns);
  const out = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < out.rgba.length; i += 4) out.rgba.set([135, 155, 165, 255], i);
  images.forEach((v, n) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (v.rgba[i + 3]) out.rgba.set(v.rgba.subarray(i, i + 4), ((Math.floor(n / columns) * h + y) * width + n % columns * w + x) * 4);
  } });
  return out;
}
function tiles(atlas: RawImage, layer: "base" | "overlay") {
  return faces.map(face => {
    const r = CLASSIC_LAYOUT.head[layer][face], out = { width: 8, height: 8, rgba: new Uint8Array(256) };
    for (let y = 0; y < 8; y++) out.rgba.set(atlas.rgba.subarray(((r.y + y) * 64 + r.x) * 4, ((r.y + y) * 64 + r.x + 8) * 4), y * 32);
    return scaleNearestNeighbor(out, 128, 128);
  });
}
function seamAudit(result: ReturnType<typeof composeReferenceStyleAtlas>, layer: "base" | "overlay" = "base") {
  const hair = new Set(result.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === layer && c.owner === "hair").map(p => {
    const r = CLASSIC_LAYOUT.head[layer][p.face]; return ((r.y + p.y) * 64 + r.x + p.x) * 4;
  }));
  for (const p of layer === "base" ? result.diagnostic.headProportion?.paints ?? [] : []) {
    if (p.role === "hair") hair.add(headProportionOffset(p)); else hair.delete(headProportionOffset(p));
  }
  const seams = getBoxUvSeams(CLASSIC_LAYOUT.head[layer]);
  return [...seams.vertical, ...seams.horizontal].map((s, seam) => {
    const pairs = s.primary.map((p, n) => {
      const q = s.adjacent[n], a = (p.y * 64 + p.x) * 4, b = (q.y * 64 + q.x) * 4;
      return { n, p, q, hairA: hair.has(a), hairB: hair.has(b), delta: Math.max(...[0, 1, 2].map(c => Math.abs(result.atlas.rgba[a + c] - result.atlas.rgba[b + c]))) };
    });
    return { seam, pairs };
  });
}
function headView(atlas: RawImage, yaw: number, pitch: number) {
  const isolated: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
  for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT.head[layer]))
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * 64 + r.x + x) * 4; isolated.rgba.set(atlas.rgba.subarray(i, i + 4), i);
    }
  const image = renderSkinInspectionView(isolated, yaw, pitch);
  const top = Math.round((22 - 16 * Math.cos(pitch * Math.PI / 180)) / (28 / 192)) - 48;
  const out: RawImage = { width: 96, height: 96, rgba: new Uint8Array(96 * 96 * 4) };
  for (let y = 0; y < 96; y++) out.rgba.set(image.rgba.subarray(((y + top) * image.width + 48) * 4, ((y + top) * image.width + 144) * 4), y * 96 * 4);
  return scaleNearestNeighbor(out, 192, 192);
}

it("audits all twelve head edges against supplied references and saved production plans offline", async () => {
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/head-seams-20261012-"), references = [], rows = [];
    if (process.env.REFERENCE_SKIN_DIRECTORY) for (const id of "ABCDEFG") {
      const path = `${process.env.REFERENCE_SKIN_DIRECTORY}/${id} skin.png`, bytes = readFileSync(path), atlas = await decodePng(bytes);
      writeFileSync(`${root}/reference-${id}-faces.png`, await encodePng(sheet(["base", "overlay"].flatMap(l => tiles(atlas, l as "base" | "overlay")), 6)), { flag: "wx" });
      references.push({ id, sha256: hash(bytes) }); expect(readFileSync(path)).toEqual(bytes);
    }
    for (const id of ["012", "013", "017", "018", "019", "020"]) {
      const input = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}`;
      const bytes = readFileSync(`${input}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
      const plan = t.skinPlan.skinPlan, { features, faceStyle: style } = t.injectedParameters;
      const base = buildProceduralSourceAtlas(features, style, plan)!;
      const design: ReferenceStylePlan = { ...t.referenceStyle.design, hairVolumePolicy: "crown_relief_v1" };
      const before = composeReferenceStyleAtlas(base, plan, design, style);
      expect(before.atlas).toEqual(await decodePng(readFileSync(`evaluation-artifacts/hair-volume-replay-20261012-Nz9pz8/${id}-after.png`)));
      const afterDesign: ReferenceStylePlan = { ...design, headSeamPolicy: "connected_outline_v1" };
      const original = JSON.stringify({ plan, style, design });
      const after = composeReferenceStyleAtlas(base, plan, afterDesign, style);
      expect(after.atlas).toEqual(composeReferenceStyleAtlas(base, plan, afterDesign, style).atlas);
      const quality = measureReferenceRenderedQuality(after, base, plan, afterDesign, style);
      expect(quality.violations, id).toEqual([]);
      const beforeAudit = seamAudit(before), afterAudit = seamAudit(after);
      const outerAudit = seamAudit(after, "overlay");
      const eligible = hasReferenceHairVolume(plan, design, style);
      const changes = [];
      const authorized = new Set(after.diagnostic.headProportion!.paints.filter(p => p.role === "hair").map(headProportionOffset));
      for (let i = 0; i < 16384; i += 4) {
        expect(after.atlas.rgba[i + 3]).toBe(before.atlas.rgba[i + 3]);
        if ([0, 1, 2].some(c => after.atlas.rgba[i + c] !== before.atlas.rgba[i + c])) {
          expect(authorized.has(i), `${id} unauthorized paint ${i}`).toBe(true); changes.push(i / 4);
        }
      }
      for (const face of ["front", "bottom"] as const) {
        const r = CLASSIC_LAYOUT.head.base[face];
        for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) {
          const i = ((r.y + y) * 64 + r.x + x) * 4;
          expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
        }
      }
      if (eligible) {
        expect(changes.length, id).toBeGreaterThan(0);
        // Interior strand shading was already continuous. Added seam texels
        // must use that same material, not a second copied/dark side palette.
        for (const s of afterAudit) for (const p of s.pairs.filter(p => p.hairA && p.hairB)) expect(p.delta, `${id} seam ${s.seam}/${p.n}`).toBe(0);
        expect(afterAudit.flatMap(s => s.pairs.filter(p => p.hairA !== p.hairB)), id).toEqual([]);
        for (const s of outerAudit) for (const p of s.pairs.filter(p => p.hairA && p.hairB)) expect(p.delta, `${id} outer seam ${s.seam}/${p.n}`).toBe(0);
      } else expect(changes).toEqual([]);
      const selected = selectReferenceStyleAtlas(base, plan, afterDesign, style).selected;
      expect(selected, id).not.toBeNull();
      expect(selected!.design.headSeamPolicy).toBe("connected_outline_v1");
      expect(selected!.design.hair.family).toBe(selectReferenceStyleAtlas(base, plan, design, style).selected!.design.hair.family);
      writeFileSync(`${root}/${id}-after.png`, await encodePng(after.atlas), { flag: "wx" });
      writeFileSync(`${root}/${id}-comparison.png`, await encodePng(sheet([before.atlas, after.atlas].flatMap(a =>
        [[315, 20], [45, 20], [135, 20], [225, 20], [0, 60], [180, -50]].map(([yaw, pitch]) => headView(a, yaw, pitch))), 6)), { flag: "wx" });
      writeFileSync(`${root}/${id}-faces-comparison.png`, await encodePng(sheet([before.atlas, after.atlas].flatMap(a => tiles(a, "base")), 6)), { flag: "wx" });
      writeFileSync(`${root}/${id}-faces-before.png`, await encodePng(sheet(tiles(before.atlas, "base"), 6)), { flag: "wx" });
      writeFileSync(`${root}/${id}-views-before.png`, await encodePng(sheet([315, 45, 135, 225].map(yaw => renderSkinInspectionView(before.atlas, yaw, 20)), 4)), { flag: "wx" });
      rows.push({ id, inputSha256: hash(bytes), beforeSha256: hash(before.atlas.rgba), afterSha256: hash(after.atlas.rgba), changes, eligible, quality, beforeAudit, afterAudit, outerAudit });
      expect(JSON.stringify({ plan, style, design })).toBe(original);
      expect(readFileSync(`${input}/summary.json`)).toEqual(bytes);
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, columns: faces, references, rows }, null, 2), { flag: "wx" });
    writeFileSync(`${root}/REPORT.md`, [
      "# All-face head connection verification", "",
      "Offline replay of unchanged saved analyses; no provider calls, deployment or historical writes.", "",
      "References A-G were inspected separately on base/outer layers. Their common design is a connected crown/profile/nape mass, sparse raised accents, and an underside hair rim surrounding an intact neck opening. Hat/hood/scalp/ear boundaries are intentional, not seams to fill.", "",
      "New connected_outline_v1 completes only supported head-edge hair texels on ordinary semantic loose-hair designs. Front face, explicit openings, ears, central underside, alpha, outer layer, body and source plans are preserved. Old policy remains byte-identical to saved crown-relief PNGs.", "",
      "Base head: all 12 physical edges checked; five eligible replays have no hair-ownership mismatch or paired hair-color discontinuity. Hat negative control is byte-identical. Outer paired-hair colors checked separately; no new shell occupancy.", "",
      "*-comparison.png: upper row before, lower row after. Columns: front-right, front-left, back-left, back-right, crown, underside from rear. Both rows use the same corrected renderer. Head-only views expose underside without torso occlusion.",
      "*-faces-comparison.png: upper before/lower after; front, right, back, left, top, bottom atlas tiles.", "",
      ...rows.map(r => `- ${r.id}: ${r.changes.length} base-head pixels changed; eligible=${r.eligible}; construction violations=${r.quality.violations.length}`),
      "", "This is deterministic seam verification, not a new photographic-observation or live-provider quality claim.",
    ].join("\n"), { flag: "wx" });
    expect(net).not.toHaveBeenCalled(); console.info(`HEAD_SEAMS ${root}`);
  } finally { net.mockRestore(); }
}, 120_000);
