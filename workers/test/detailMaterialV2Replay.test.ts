/** Material-only counterfactuals; never replaces immutable live outputs. */
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { encodePng, decodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

it("preserves exact v1 history and changes only owned hair material in v2 on six live analyses", async () => {
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const root = mkdtempSync("evaluation-artifacts/detail-material-v2-20261012-");
  const rows = [];
  try {
    for (const slot of [1, 4, 5, 6, 8, 9]) {
      const id = String(slot).padStart(3, "0"), input = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}`;
      const bytes = readFileSync(`${input}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
      const plan = t.skinPlan.skinPlan, { features, faceStyle } = t.injectedParameters;
      const source = buildProceduralSourceAtlas(features, faceStyle, plan)!;
      const before = composeReferenceStyleAtlas(source, plan, t.referenceStyle.design, faceStyle);
      expect(before.atlas.rgba).toEqual((await decodePng(readFileSync(`${input}/skin.png`))).rgba);
      const design = { ...t.referenceStyle.design, materialDetailPolicy: "tapered_material_v2" as const };
      const after = composeReferenceStyleAtlas(source, plan, design, faceStyle);
      expect(measureReferenceRenderedQuality(after, source, plan, design, faceStyle).violations, id).toEqual([]);
      const hair = new Set<number>();
      for (const p of after.diagnostic.surfaces.filter(p => p.owner === "hair")) {
        const r = CLASSIC_LAYOUT[p.part][p.layer][p.face]; hair.add((r.y + p.y) * 64 + r.x + p.x);
      }
      for (const p of after.diagnostic.headProportion?.paints.filter(p => p.role === "hair") ?? []) {
        const r = CLASSIC_LAYOUT.head.base[p.face]; hair.add((r.y + p.y) * 64 + r.x + p.x);
      }
      let changed = 0;
      for (let p = 0; p < 4096; p++) {
        expect(after.atlas.rgba[p * 4 + 3]).toBe(before.atlas.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => before.atlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) {
          expect(hair.has(p), `${id}: non-hair pixel ${p}`).toBe(true); changed++;
        }
      }
      const views = [before, after].flatMap(r => renderSkinViews(r.atlas).filter(v => ["front", "right", "back"].includes(v.name)).map(v => v.image));
      const w = views[0].width, h = views[0].height;
      const sheet: RawImage = { width: w * 3, height: h * 2, rgba: new Uint8Array(w * h * 6 * 4) };
      views.forEach((v, n) => { for (let y = 0; y < h; y++) sheet.rgba.set(v.rgba.slice(y * w * 4, (y + 1) * w * 4), ((Math.floor(n / 3) * h + y) * w * 3 + n % 3 * w) * 4); });
      writeFileSync(`${root}/${id}-comparison.png`, await encodePng(scaleNearestNeighbor(sheet, sheet.width * 6, sheet.height * 6)), { flag: "wx" });
      writeFileSync(`${root}/${id}-after.png`, await encodePng(after.atlas), { flag: "wx" });
      rows.push({ slot, changedHairPixels: changed, exactHistoricalReplay: true, after: "offline material counterfactual, not a fresh live run" });
      expect(readFileSync(`${input}/summary.json`)).toEqual(bytes);
    }
    expect(net).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, rows }, null, 2), { flag: "wx" });
    console.info(`DETAIL_MATERIAL_V2 ${root}`);
  } finally { net.mockRestore(); }
}, 120_000);
