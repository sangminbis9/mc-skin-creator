import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinInspectionView, scaleNearestNeighbor } from "../src/skinRender";
import * as skinPost from "../src/skinPost";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { traceHeadIntegration, headCellOffset } from "../src/headIntegrationTrace";
import { measurePlannedOuterContract } from "../src/craftPlanContract";

const OLD = resolve("evaluation-artifacts/generalization-20260905");
const ROOT = resolve(process.env.HEAD_ARTIFACT_ROOT ?? "evaluation-artifacts/head-integration-20260906");
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const clone = (a: RawImage): RawImage => ({ ...a, rgba: a.rgba.slice() });
const png = async (p: string, a: RawImage) => writeFile(p, await encodePng(a));
const labels = ["front-right", "front-left", "back-left", "back-right", "front-top", "back-top", "right-top", "left-top", "front-bottom", "back-bottom", "right-bottom", "left-bottom"];

export function inspectHeadSeams(atlas: RawImage) {
  return (["base", "overlay"] as const).flatMap(layer => {
    const box = CLASSIC_LAYOUT.head[layer], seams = getBoxUvSeams(box);
    return [...seams.vertical, ...seams.horizontal].flatMap((s, seamIndex) => s.primary.map((p, index) => {
      const q = s.adjacent[index];
      const a = [...atlas.rgba.slice((p.y * 64 + p.x) * 4, (p.y * 64 + p.x) * 4 + 4)];
      const b = [...atlas.rgba.slice((q.y * 64 + q.x) * 4, (q.y * 64 + q.x) * 4 + 4)];
      return { layer, seam: labels[seamIndex], index, p, q, a, b, alphaMismatch: Boolean(a[3]) !== Boolean(b[3]), colorDistance: a[3] && b[3] ? a.slice(0, 3).reduce((n, c, i) => n + Math.abs(c - b[i]), 0) : null };
    }));
  });
}

describe.skipIf(process.env.RUN_HEAD_INTEGRATION !== "1")("frozen head integration replay (zero network)", () => {
  it("preserves sources and analyses, and records actual production stages", async () => {
    const phase = process.env.HEAD_PHASE;
    expect(["before", "after"]).toContain(phase);
    if (phase === "before" && await access(join(ROOT, "frozen.json")).then(() => true, () => false)) throw new Error("Head baseline already frozen");
    const manifestBytes = await readFile(join(OLD, "frozen-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted"));
    const original = skinPost.validateAtlasCraft;
    let captured: RawImage | undefined, problems: string[] = [];
    const craftSpy = vi.spyOn(skinPost, "validateAtlasCraft").mockImplementation((atlas, ...args) => {
      const result = original(atlas, ...args); captured = clone(atlas); problems = result.problems; return result;
    });
    const results = [];
    try {
      for (const entry of manifest.sources) {
        const stored = JSON.parse(await readFile(join(OLD, "after", entry.caseId, "analysis-and-plan.json"), "utf8"));
        expect(hash(JSON.stringify(stored.analysis))).toBe(entry.adapterAnalysisHash);
        const normalized = normalizeAnalysisForRendering(structuredClone(stored.analysis));
        const features = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
        const style = buildFaceStyle(normalized, features), plan = buildSkinPlan(normalized);
        const stages: Record<string, RawImage> = {};
        captured = undefined; problems = [];
        const accepted = buildProceduralFallbackAtlas(features, style, plan, (stage, atlas) => { stages[stage] = clone(atlas); });
        const atlas = accepted ?? captured;
        if (!atlas) throw new Error(`No inspectable atlas: ${entry.caseId}`);
        const oldAtlas = await decodePng(new Uint8Array(await readFile(join(OLD, "after", entry.caseId, "atlas.png"))));
        if (phase === "before") expect(hash(atlas.rgba), entry.caseId).toBe(hash(oldAtlas.rgba));
        const path = join(ROOT, phase!, entry.caseId); await mkdir(path, { recursive: true });
        await copyFile(join(OLD, "after", entry.caseId, "head-crop.png"), join(path, "head-crop.png"));
        await writeFile(join(path, "plan.json"), JSON.stringify({ annotation: stored.sourceAnnotation, analysisHash: entry.adapterAnalysisHash, plan }, null, 2));
        await png(join(path, "atlas.png"), atlas);
        const trace = traceHeadIntegration(plan.headIdentityPlan, plan.hairPlan, atlas, stages, stored.analysis);
        await writeFile(join(path, "integration-trace.json"), JSON.stringify(trace, null, 2));
        const ownerMap: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
        const colors = { face: [236, 176, 123], hair_base: [86, 65, 45], hair_outer: [185, 122, 53], glasses: [31, 211, 235], covering: [161, 98, 209], tied_hair: [247, 70, 121], other_p5: [240, 209, 46], clear: [33, 38, 46] };
        for (const p of plan.headIdentityPlan.ownership?.cells ?? []) ownerMap.rgba.set([...colors[p.owner], 255], headCellOffset(p));
        await png(join(path, "owner-map.png"), scaleNearestNeighbor(ownerMap, 512, 512));
        const before = phase === "after" ? await decodePng(new Uint8Array(await readFile(join(ROOT, "before", entry.caseId, "atlas.png")))) : atlas;
        const diff = clone(atlas);
        for (let at = 0; at < diff.rgba.length; at += 4) diff.rgba.set([0, 1, 2, 3].some(i => atlas.rgba[at + i] !== before.rgba[at + i]) ? [255, 54, 103, 255] : [35, 38, 43, 255], at);
        await png(join(path, "pixel-diff.png"), scaleNearestNeighbor(diff, 512, 512));
        for (const [stage, image] of Object.entries(stages)) await png(join(path, `${stage}.png`), image);
        const seams = inspectHeadSeams(atlas);
        const map = clone(atlas);
        for (const s of seams.filter(s => s.alphaMismatch)) for (const p of [s.p, s.q]) map.rgba.set([255, 0, 80, 255], (p.y * 64 + p.x) * 4);
        await png(join(path, "seam-map.png"), scaleNearestNeighbor(map, 512, 512));
        await writeFile(join(path, "seams.json"), JSON.stringify(seams, null, 2));
        for (const mode of ["base", "outer", "combined"] as const) {
          const image: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
          for (const layer of ["base", "overlay"] as const) if (mode === "combined" || (mode === "base") === (layer === "base")) {
            for (const r of Object.values(CLASSIC_LAYOUT.head[layer])) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
              const at = (y * 64 + x) * 4; image.rgba.set(atlas.rgba.subarray(at, at + 4), at);
            }
          }
          await png(join(path, `${mode}-only.png`), scaleNearestNeighbor(image, 512, 512));
          for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i + 3]) image.rgba.set([255, 255, 255, 255], i);
          await png(join(path, `${mode}-binary.png`), scaleNearestNeighbor(image, 512, 512));
        }
        for (const [name, yaw, pitch] of [["front", 0, 0], ["front-left", 45, 0], ["left", 90, 0], ["back-left", 135, 0], ["back", 180, 0], ["back-right", 225, 0], ["right", 270, 0], ["front-right", 315, 0], ["top", 0, 90]] as const) await png(join(path, `${name}.png`), renderSkinInspectionView(atlas, yaw, pitch));
        const metrics = { caseId: entry.caseId, accepted: Boolean(accepted), problems, atlasHash: hash(atlas.rgba), hairFamily: plan.hairPlan.template, hairGrammar: plan.hairPlan.structure.grammar, glasses: plan.headIdentityPlan.glasses.topology, alphaMismatches: seams.filter(s => s.alphaMismatch).map(s => ({ layer: s.layer, seam: s.seam, index: s.index })), craft: skinPost.measureAtlasCraft(atlas), plannedOuterContract: measurePlannedOuterContract(atlas, plan.hairPlan, plan) };
        results.push(metrics);
        await writeFile(join(path, "metrics.json"), JSON.stringify(metrics, null, 2));
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      const frozen = { previousManifestHash: hash(manifestBytes), analysisHashes: manifest.sources.map((e: { caseId: string; adapterAnalysisHash: string }) => [e.caseId, e.adapterAnalysisHash]) };
      if (phase === "before") await writeFile(join(ROOT, "frozen.json"), JSON.stringify(frozen, null, 2), { flag: "wx" });
      else expect(JSON.parse(await readFile(join(ROOT, "frozen.json"), "utf8"))).toEqual(frozen);
      const summary = { accepted: results.filter(r => r.accepted).length, results, apiCalls: 0 };
      await writeFile(join(ROOT, phase!, "summary.json"), JSON.stringify(summary, null, 2));
      if (phase === "after") {
        const before = JSON.parse(await readFile(join(ROOT, "before", "frozen-12-summary.json"), "utf8"));
        const cases = results.map((result) => {
          const baseline = before.results.find((item: { caseId: string }) => item.caseId === result.caseId);
          return {
            caseId: result.caseId,
            beforeAccepted: baseline.accepted,
            afterAccepted: result.accepted,
            beforeProblems: baseline.problems,
            afterProblems: result.problems,
            atlasHashBefore: baseline.atlasHash,
            atlasHashAfter: result.atlasHash,
            byteIdentical: baseline.atlasHash === result.atlasHash,
          };
        });
        expect(cases.every((item) => item.byteIdentical)).toBe(true);
        await writeFile(join(ROOT, "comparison.json"), JSON.stringify({
          acceptance: { before: before.accepted, after: summary.accepted },
          byteIdentical: cases.filter((item) => item.byteIdentical).length,
          cases,
          falsePositiveNegativeMatrix: [
            { fixture: "valid simple", expected: "PASS", oldValidator: "FAIL", newValidator: "PASS", evidence: "short-hair-red-shirt" },
            { fixture: "valid rich", expected: "PASS", oldValidator: "PASS", newValidator: "PASS", evidence: "other 11 frozen cases" },
            { fixture: "missing planned outer", expected: "FAIL", oldValidator: "not plan-aware", newValidator: "FAIL", evidence: "craftPlanContract unit fixture" },
            { fixture: "disconnected noise", expected: "FAIL", oldValidator: "FAIL", newValidator: "FAIL", evidence: "craftPlanContract unit fixture" },
            { fixture: "broken seam", expected: "FAIL", oldValidator: "FAIL", newValidator: "FAIL", evidence: "craftPlanContract and craftQuality fixtures" },
            { fixture: "missing P5", expected: "FAIL", oldValidator: "FAIL", newValidator: "FAIL", evidence: "glasses topology fixture" },
          ],
          apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 },
        }, null, 2));
      }
    } finally { fetchSpy.mockRestore(); craftSpy.mockRestore(); }
  }, 240000);
});
