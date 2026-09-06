import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const ROOT = resolve("evaluation-artifacts/tied-hair-renderer-20260906");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const image = async (path: string) => decodePng(new Uint8Array(await readFile(path)));
const background = (atlas: RawImage) => [...atlas.rgba.slice(0, 4)];
function topVisibleRow(atlas: RawImage): number {
  const bg = background(atlas);
  for (let y = 0; y < atlas.height; y++) for (let x = 0; x < atlas.width; x++) {
    const at = (y * atlas.width + x) * 4;
    if ([0, 1, 2, 3].some(i => atlas.rgba[at + i] !== bg[i])) return y;
  }
  return -1;
}
function changedPixels(a: RawImage, b: RawImage): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let count = 0;
  for (let at = 0; at < a.rgba.length; at += 4) if ([0, 1, 2, 3].some(i => a.rgba[at + i] !== b.rgba[at + i])) count++;
  return count;
}
function maximumRowWidth(cells: Array<{ face: string; x: number; y: number }>): number {
  const groups = new Map<string, number[]>();
  for (const cell of cells) groups.set(`${cell.face}:${cell.y}`, [...(groups.get(`${cell.face}:${cell.y}`) ?? []), cell.x]);
  return Math.max(0, ...[...groups.values()].map(xs => Math.max(...xs) - Math.min(...xs) + 1));
}
function headAtlasOffsets(): Set<number> {
  const offsets = new Set<number>();
  for (const layer of ["base", "overlay"] as const) for (const rect of Object.values(CLASSIC_LAYOUT.head[layer])) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) offsets.add((y * 64 + x) * 4);
  }
  return offsets;
}

describe.skipIf(process.env.RUN_TIED_HAIR_ARTIFACTS !== "1")("tied-hair frozen artifact comparison", () => {
  it("records silhouette prominence without changing non-tied or body pixels", async () => {
    const beforeSummary = JSON.parse(await readFile(join(ROOT, "before", "frozen-12-summary.json"), "utf8"));
    const afterSummary = JSON.parse(await readFile(join(ROOT, "after", "summary.json"), "utf8"));
    const tiedCases = afterSummary.results.filter((result: { hairFamily: string }) => result.hairFamily === "tied_bun");
    expect(tiedCases.length).toBeGreaterThan(0);
    expect(afterSummary.accepted).toBeGreaterThanOrEqual(11);
    expect(afterSummary.apiCalls).toBe(0);
    for (const result of beforeSummary.results.filter((item: { accepted: boolean }) => item.accepted)) {
      expect(afterSummary.results.find((item: { caseId: string }) => item.caseId === result.caseId).accepted).toBe(true);
    }
    for (const result of afterSummary.results.filter((item: { hairFamily: string }) => item.hairFamily !== "tied_bun")) {
      expect(result.atlasHash, result.caseId).toBe(beforeSummary.results.find((item: { caseId: string }) => item.caseId === result.caseId).atlasHash);
    }

    const comparisons = [];
    const headOffsets = headAtlasOffsets();
    for (const result of tiedCases) {
      const beforeDir = join(ROOT, "before", result.caseId), afterDir = join(ROOT, "after", result.caseId);
      const beforePlan = JSON.parse(await readFile(join(beforeDir, "plan.json"), "utf8")).plan.headIdentityPlan.ownership;
      const afterPlan = JSON.parse(await readFile(join(afterDir, "plan.json"), "utf8")).plan.headIdentityPlan.ownership;
      const beforeOuter = beforePlan.cells.filter((cell: { owner: string }) => cell.owner === "tied_hair");
      const afterOuter = afterPlan.cells.filter((cell: { owner: string }) => cell.owner === "tied_hair");
      const beforeAttachment = beforePlan.cells.filter((cell: { layer: string; sourceGroupId: string }) => cell.layer === "base" && cell.sourceGroupId === "tied-attachment");
      const afterAttachment = afterPlan.cells.filter((cell: { layer: string; sourceGroupId: string }) => cell.layer === "base" && cell.sourceGroupId === "tied-attachment");
      const viewMetrics: Record<string, { beforeTop: number; afterTop: number; prominencePixels: number; changedPixels: number }> = {};
      for (const view of ["front", "front-left", "front-right", "top", "back"]) {
        const before = await image(join(beforeDir, `${view}.png`)), after = await image(join(afterDir, `${view}.png`));
        viewMetrics[view] = { beforeTop: topVisibleRow(before), afterTop: topVisibleRow(after), prominencePixels: topVisibleRow(before) - topVisibleRow(after), changedPixels: changedPixels(before, after) };
        expect(viewMetrics[view].changedPixels, `${result.caseId}/${view}`).toBeGreaterThan(0);
      }
      for (const view of ["front", "front-left", "front-right"]) expect(viewMetrics[view].prominencePixels, `${result.caseId}/${view}`).toBeGreaterThanOrEqual(3);
      const beforeAtlas = await image(join(beforeDir, "atlas.png")), afterAtlas = await image(join(afterDir, "atlas.png"));
      for (let at = 0; at < beforeAtlas.rgba.length; at += 4) if (!headOffsets.has(at)) {
        expect([...afterAtlas.rgba.slice(at, at + 4)], `${result.caseId} body offset ${at}`).toEqual([...beforeAtlas.rgba.slice(at, at + 4)]);
      }
      expect(result.alphaMismatches).toHaveLength(0);
      expect(afterOuter.length).toBeLessThan(64);
      expect(maximumRowWidth(afterAttachment)).toBeLessThan(maximumRowWidth(beforeAttachment));
      for (const phase of ["before", "after"] as const) {
        const dir = phase === "before" ? beforeDir : afterDir;
        await copyFile(join(dir, "head-crop.png"), join(dir, "source-crop.png"));
        await copyFile(join(dir, "combined-binary.png"), join(dir, "binary-silhouette.png"));
      }
      comparisons.push({
        caseId: result.caseId,
        tiedMassPixels: { before: beforeOuter.length, after: afterOuter.length },
        attachmentWidth: { before: maximumRowWidth(beforeAttachment), after: maximumRowWidth(afterAttachment) },
        geometry: afterPlan.tiedMass,
        viewMetrics,
        atlasHash: { before: hash(beforeAtlas.rgba), after: hash(afterAtlas.rgba) },
        bodyPixelsUnchanged: true,
        alphaMismatches: result.alphaMismatches,
        accepted: result.accepted,
      });
    }
    await writeFile(join(ROOT, "comparison.json"), JSON.stringify({ accepted: { before: beforeSummary.accepted, after: afterSummary.accepted }, noNewRejects: true, nonTiedAtlasesUnchanged: true, apiCalls: 0, cases: comparisons }, null, 2));
  }, 120000);
});
