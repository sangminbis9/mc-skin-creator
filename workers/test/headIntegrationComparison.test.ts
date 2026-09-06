import { createHash } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { decode as decodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinInspectionView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { traceHeadIntegration, headCellOffset } from "../src/headIntegrationTrace";
import { observedTiedHair } from "../src/headOwnership";
import { crop } from "./generalizationSupport";
import type { SkinPlan } from "../src/skinPlan";

const ROOT = "evaluation-artifacts/head-integration-20260906";
const OLD = "evaluation-artifacts/generalization-20260905";
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const load = async (p: string) => decodePng(new Uint8Array(await readFile(p)));
const json = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const save = async (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2));

describe.skipIf(process.env.RUN_HEAD_COMPARISON !== "1")("head comparison artifacts (no rendering or AI calls)", () => {
  it("audits immutable hashes, logical seam provenance and cue retention", async () => {
    const manifest = await json(`${OLD}/frozen-manifest.json`), annotations = await json(`${OLD}/annotations.json`);
    expect(hash(await readFile(`${OLD}/annotations.json`))).toBe(manifest.annotationFileHash);
    const comparison = [];
    const sheet: RawImage = { width: 900, height: 440, rgba: new Uint8Array(900 * 440 * 4).fill(230) };
    const paste = (src: RawImage, x: number, y: number) => {
      const im = scaleNearestNeighbor(src, 96, 100);
      for (let yy = 0; yy < 100; yy++) sheet.rgba.set(im.rgba.subarray(yy * 96 * 4, (yy + 1) * 96 * 4), ((y + yy) * 900 + x) * 4);
    };
    for (const [index, entry] of manifest.sources.entries()) {
      const id = entry.caseId, annotation = annotations.find((a: { id: string }) => a.id === id);
      const stored = await json(`${OLD}/after/${id}/analysis-and-plan.json`);
      const bytes = new Uint8Array(await readFile(annotation.existing ? `evaluation-artifacts/facial-feature-renderer-20260904/${id}/01-source.png` : `${OLD}/sources/${annotation.photoId}.jpg`));
      const source = annotation.existing ? await decodePng(bytes) : decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
      expect(hash("rgba" in source ? source.rgba : source.data), id).toBe(entry.sourceHash);
      expect(hash(JSON.stringify(stored.analysis))).toBe(entry.adapterAnalysisHash);
      const beforePlan: SkinPlan = (await json(`${ROOT}/before/${id}/plan.json`)).plan;
      const afterPlan: SkinPlan = (await json(`${ROOT}/after/${id}/plan.json`)).plan;
      const before = await load(`${ROOT}/before/${id}/atlas.png`), after = await load(`${ROOT}/after/${id}/atlas.png`);
      expect(hash(before.rgba)).toBe(hash((await load(`${OLD}/after/${id}/atlas.png`)).rgba));
      // A head-only integration may not silently change previously fixed outfits.
      const headOffsets = new Set<number>();
      for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT.head[layer])) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) headOffsets.add((y * 64 + x) * 4);
      for (let at = 0; at < after.rgba.length; at += 4) if (!headOffsets.has(at)) expect([...after.rgba.slice(at, at + 4)], `${id} body ${at}`).toEqual([...before.rgba.slice(at, at + 4)]);
      for (const [phase, plan, atlas] of [["before", beforePlan, before], ["after", afterPlan, after]] as const) {
        const path = `${ROOT}/${phase}/${id}`;
        const evidenceStages: Record<string, RawImage> = {};
        for (const stage of phase === "before" ? ["before_head_composition", "after_shading", "after_seam_reconcile", "final_head"] : ["before_head_composition", "after_shading", "after_seam_reconcile", "before_authoritative_head", "after_authoritative_head", "final_head"]) evidenceStages[stage] = await load(`${path}/${stage}.png`);
        await save(`${path}/evidence-trace.json`, traceHeadIntegration(plan.headIdentityPlan, plan.hairPlan, atlas, evidenceStages, stored.analysis));
        for (const layer of ["base", "outer"] as const) {
          const isolated = { ...atlas, rgba: atlas.rgba.slice() };
          for (const r of Object.values(CLASSIC_LAYOUT.head[layer === "base" ? "overlay" : "base"])) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) isolated.rgba.fill(0, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
          await writeFile(`${path}/${layer}-3d.png`, await encodePng(renderSkinInspectionView(isolated, 135, 25)));
        }
        if (phase === "before" && !await access(`${path}/integration-trace.json`).then(() => true, () => false)) {
          const stages: Record<string, RawImage> = {};
          for (const stage of ["before_head_composition", "after_shading", "after_seam_reconcile", "final_head"]) stages[stage] = await load(`${path}/${stage}.png`);
          await save(`${path}/integration-trace.json`, traceHeadIntegration(plan.headIdentityPlan, plan.hairPlan, atlas, stages));
          const map: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
          for (const g of plan.hairPlan.structure.groups) for (const p of g.points) map.rgba.set(p.layer === "base" ? [86, 65, 45, 255] : [185, 122, 53, 255], headCellOffset(p));
          for (const p of [...plan.headIdentityPlan.glasses.framePixels, ...plan.headIdentityPlan.glasses.sideArms]) map.rgba.set([31, 211, 235, 255], headCellOffset({ ...p, layer: "outer" }));
          await writeFile(`${path}/owner-map.png`, await encodePng(scaleNearestNeighbor(map, 512, 512)));
          await save(`${path}/owner-map-legend.json`, { warning: "Projected legacy groups, NOT authoritative actual owners; semantic hair groups were skipped by renderer", hair_base: "brown", hair_outer: "orange", glasses: "cyan" });
        }
        const seams = await json(`${path}/seams.json`);
        const provenance = seams.filter((s: { alphaMismatch: boolean }) => s.alphaMismatch).map((s: { layer: "base" | "overlay"; seam: string; index: number; p: { x: number; y: number }; q: { x: number; y: number } }, number: number) => ({
          ...s, issueId: number + 1, kind: "alpha coverage mismatch (not a shading difference)",
          participants: [s.p, s.q].map(p => {
            const offset = (p.y * 64 + p.x) * 4;
            const cell = plan.headIdentityPlan.ownership?.cells.find(c => headCellOffset(c) === offset);
            const groups = plan.hairPlan.structure.groups.filter(g => g.points.some(c => headCellOffset(c) === offset)).map(g => g.id);
            return { atlas: p, owner: cell?.owner ?? "unresolved legacy completion", sourceGroupId: cell?.sourceGroupId ?? "composeHair generic completion; no authoritative group", projectedPlanGroups: groups, missing: atlas.rgba[offset + 3] === 0 };
          }),
        }));
        await save(`${path}/seam-provenance.json`, provenance);
        const marks = provenance.flatMap((s: { issueId: number; p: { x: number; y: number }; q: { x: number; y: number } }) => [s.p, s.q].map(p => `<rect x="${p.x * 12}" y="${p.y * 12}" width="12" height="12" fill="#ff5782"/><text x="${p.x * 12 + 1}" y="${p.y * 12 + 9}" font-size="8">${s.issueId}</text>`)).join("");
        await writeFile(`${path}/seam-numbered.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768"><rect width="768" height="768" fill="#ddd"/>${marks}</svg>`);
      }
      const sourceCrop = await load(`${ROOT}/after/${id}/head-crop.png`);
      const x = (index % 3) * 300, y = Math.floor(index / 3) * 110;
      paste(sourceCrop, x, y);
      for (const [phase, dx] of [["before", 100], ["after", 200]] as const) paste(crop(await load(`${ROOT}/${phase}/${id}/front.png`), [0.25, 0, 0.5, 0.27]), x + dx, y);
      const b = await json(`${ROOT}/before/${id}/metrics.json`), a = await json(`${ROOT}/after/${id}/metrics.json`);
      comparison.push({ caseId: id, sourceHashUnchanged: true, analysisHashUnchanged: true, bodyPixelsUnchanged: true, craft: { before: b.accepted, after: a.accepted, problems: a.problems }, cueEvidence: { hair: annotation.hair, accessory: annotation.accessories, coveringContractOnly: id === "headscarf-color-blocks" }, tied: { source: observedTiedHair(stored.analysis), before: beforePlan.hairPlan.template, after: afterPlan.hairPlan.template, outerMassPixels: afterPlan.headIdentityPlan.ownership?.cells.filter(c => c.owner === "tied_hair").length ?? 0 }, geometryProvenance: afterPlan.hairPlan.structure.source, sourceSpecificPreviewReadability: "manual review required; occupancy is not a likeness score", afterTrace: (await json(`${ROOT}/after/${id}/integration-trace.json`)).cues });
    }
    await writeFile(`${ROOT}/head-comparison.png`, await encodePng(sheet));
    await save(`${ROOT}/comparison.json`, comparison);
    expect(comparison.filter(c => c.craft.after).length).toBeGreaterThanOrEqual(11);
  }, 60000);
});
