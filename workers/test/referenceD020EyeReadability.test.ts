// Offline diagnosis of immutable actual PNG; no source/geometry inference.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import { FACE_STYLE_TEMPLATES } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const pixel = (a: RawImage, x: number, y: number) => [...a.rgba.slice((y * a.width + x) * 4, (y * a.width + x) * 4 + 4)];
it("distinguishes D020 eye atlas delivery, projected occlusion and pigment adjacency", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    expect(sha(png)).toBe("da9c4621e73baaa871b76db9338140864de5c83c1c42eaa1c3ba09dbced2a73c");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const plan: SkinPlan = t.skinPlan.skinPlan, face = plan.facePixelPlan;
    const atlas = await decodePng(png), front = renderSkinViews(atlas)[0].image;
    const r = CLASSIC_LAYOUT.head.base.front, o = CLASSIC_LAYOUT.head.overlay.front;
    const color = [1, 3, 5].map(i => Number.parseInt(t.injectedParameters.faceStyle.eyeColor.slice(i, i + 2), 16));
    const eyes = face.pixels.filter(p => p.role === "iris");
    expect(eyes.map(p => [p.x, p.y])).toEqual([[2, 3], [5, 3]]);
    const rows = eyes.map(p => {
      const base = pixel(atlas, r.x + p.x, r.y + p.y), outer = pixel(atlas, o.x + p.x, o.y + p.y);
      expect(base).toEqual([...color, 255]); expect(outer[3]).toBe(0);
      const scale = 28 / front.width;
      const sx = Math.round(front.width / 2 + (p.x - 3.5) / scale - 0.5);
      const sy = Math.round((2.5 + p.y) / scale - 0.5);
      const projected = pixel(front, sx, sy);
      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => {
        const x = p.x + dx, y = p.y + dy;
        const rgba = pixel(atlas, r.x + x, r.y + y);
        return { x, y, rgba, rgbDistance: color.reduce((n, v, i) => n + Math.abs(v - rgba[i]), 0),
          owner: plan.headIdentityPlan.ownership?.cells.find(c => c.face === "front" && c.layer === "base" && c.x === x && c.y === y)?.owner ?? null };
      });
      return { x: p.x, y: p.y, base, outer, projected, centerVisible: JSON.stringify(base) === JSON.stringify(projected), neighbors,
        upperCatch: { x: p.x, y: p.y - 1, hairline: face.layout.hairlineDepthByColumn[p.x],
          blockedByHairline: p.y - 1 <= face.layout.hairlineDepthByColumn[p.x] } };
    });
    const out = freshAuditOutput("evaluation-artifacts/d020-eye-readability-20261011-");
    const head: RawImage = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4) };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) head.rgba.set(pixel(atlas, r.x + x, r.y + y), (y * 8 + x) * 4);
    writeFileSync(`${out}/base-front.png`, await encodePng(scaleNearestNeighbor(head, 320, 320)), { flag: "wx" });
    writeFileSync(`${out}/rendered-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    // Design study only: compare two eye-led presentations in the free lower
    // skin window. The current production validator must still reject these
    // uncontracted paints. No phenotype/measurement/plan is changed.
    const planBefore = JSON.stringify(plan), style = t.injectedParameters.faceStyle, design = t.referenceStyle.design;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, style, plan)!;
    const composition = composeReferenceStyleAtlas(base, plan, design, style);
    expect(composition.atlas.rgba).toEqual(atlas.rgba);
    const catches = color.map((v, i) => Math.round(v * (1 - FACE_STYLE_TEMPLATES[design.face.family as keyof typeof FACE_STYLE_TEMPLATES].irisGlint)
      + [248, 246, 240][i] * FACE_STYLE_TEMPLATES[design.face.family as keyof typeof FACE_STYLE_TEMPLATES].irisGlint));
    const variants = [];
    for (const variant of ["lower-catch", "upper-catch-lower-pigment"] as const) {
      const candidate = structuredClone(atlas), allowed = new Set<number>();
      for (const p of eyes) {
        const q = { x: p.x, y: p.y + 1 };
        expect(face.pixels.some(c => c.cluster !== "complexion" && c.x === q.x && c.y === q.y)).toBe(false);
        expect(plan.headIdentityPlan.ownership?.cells.some(c => c.face === "front" && c.layer === "base" && c.x === q.x && c.y === q.y
          && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner))).toBe(false);
        expect(pixel(atlas, o.x + q.x, o.y + q.y)[3]).toBe(0);
        const lower = ((r.y + q.y) * 64 + r.x + q.x) * 4;
        candidate.rgba.set(variant === "lower-catch" ? catches : color, lower); allowed.add(lower);
        if (variant === "upper-catch-lower-pigment") {
          const upper = ((r.y + p.y) * 64 + r.x + p.x) * 4;
          candidate.rgba.set(catches, upper); allowed.add(upper);
        }
      }
      let changed = 0;
      for (let i = 0; i < atlas.rgba.length; i += 4) {
        expect(candidate.rgba[i + 3]).toBe(atlas.rgba[i + 3]);
        if (![0, 1, 2].some(c => candidate.rgba[i + c] !== atlas.rgba[i + c])) continue;
        changed++; expect(allowed.has(i)).toBe(true);
      }
      expect(changed).toBe(allowed.size);
      const quality = measureReferenceRenderedQuality({ ...composition, atlas: candidate }, base, plan, design, style);
      expect(quality.constructionValid).toBe(false);
      const view = renderSkinViews(candidate)[0].image;
      writeFileSync(`${out}/${variant}-front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
      variants.push({ variant, changedPixels: changed, changedCoordinates: [...allowed].map(i => ({ x: i / 4 % 64 - r.x, y: Math.floor(i / 256) - r.y })),
        rgbaSha256: sha(candidate.rgba), currentProductionRejects: quality.violations, adopted: false });
    }
    expect(JSON.stringify(plan)).toBe(planBefore);
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, productionChanges: 0,
      sourceSummarySha256: sha(bytes), pngSha256: sha(png), rows,
      geometryUsage: face.layout.geometryUsage, measurementTrace: face.layout.measurementTrace,
      eyeRow: face.layout.eyeRow, faceShape: t.renderAnalysis.renderHints.faceShape,
      bangsLength: t.renderAnalysis.renderHints.bangsLength, uncertainAxes: face.layout.uncertainAxes,
      sourceEyePigmentDelivered: true, changedSourceEvidence: false, variants,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D020_EYE_READABILITY", out, JSON.stringify(rows));
  } finally { network.mockRestore(); }
});
