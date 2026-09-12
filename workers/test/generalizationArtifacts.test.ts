import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { decode as decodeJpeg } from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildOutfitPlanCandidates } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { measureAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import * as skinPost from "../src/skinPost";
import { headUvIsByteIdentical, measureOutfitPixelDifference, measureOutfitIdentityRetention } from "../src/outfitIdentityRetention";
import { buildBinaryHeadSilhouette } from "./evaluationArtifacts";
import { buildBodyLayerDiagnostic, buildBodySeamDiagnostic } from "./outfitEvaluationArtifacts";
import { analysisFromAnnotation, convergence, crop, diagnose, signatures, validateManifest, type AnnotatedCase, type Failure } from "./generalizationSupport";

const RUN = process.env.RUN_GENERALIZATION === "1";
const INPUT_ROOT = resolve("evaluation-artifacts/generalization-20260905");
const ROOT = resolve(process.env.GENERALIZATION_OUTPUT_ROOT ?? "evaluation-artifacts/generalization-20260905");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function canvas(width: number, height: number): RawImage { const rgba = new Uint8Array(width * height * 4); for (let i = 0; i < rgba.length; i += 4) rgba.set([228, 231, 234, 255], i); return { width, height, rgba }; }
function paste(out: RawImage, image: RawImage, x: number, y: number, w: number, h: number) {
  const ratio = Math.min(w / image.width, h / image.height);
  const resized = scaleNearestNeighbor(image, Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
  x += Math.floor((w - resized.width) / 2); y += Math.floor((h - resized.height) / 2);
  for (let py = 0; py < resized.height; py++) for (let px = 0; px < resized.width; px++) { const at = (py * resized.width + px) * 4; if (resized.rgba[at + 3]) out.rgba.set(resized.rgba.subarray(at, at + 4), ((y + py) * out.width + x + px) * 4); }
}
async function png(path: string, image: RawImage) { await writeFile(path, await encodePng(image)); }
function median(values: number[]) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

describe.skipIf(!RUN)("frozen real-source downstream generalization (no AI analysis)", () => {
  it("replays the same twelve annotated people on the production deterministic path", async () => {
    const phase = process.env.GENERALIZATION_PHASE;
    expect(["before", "after"]).toContain(phase);
    if (phase === "before") {
      // Refuse before ANY baseline artifact write, not only at final manifest save.
      const alreadyFrozen = await readFile(join(ROOT, "frozen-manifest.json")).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (alreadyFrozen) throw new Error("Baseline is frozen; only after/comparison may be rerun");
    }
    const annotationBytes = await readFile(join(INPUT_ROOT, "annotations.json"));
    const allCases: AnnotatedCase[] = JSON.parse(annotationBytes.toString());
    validateManifest(allCases);
    const selectedCaseIds = new Set((process.env.GENERALIZATION_CASES ?? "").split(",").filter(Boolean));
    const cases = selectedCaseIds.size > 0
      ? allCases.filter((sample) => selectedCaseIds.has(sample.id))
      : allCases;
    if (selectedCaseIds.size > 0) expect(cases).toHaveLength(selectedCaseIds.size);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in generalization replay"); });
    const manifest = [];
    const results: Array<{ caseId: string; signatures: ReturnType<typeof signatures>; failures: Failure[] }> = [];
    const fullSheet = canvas(900, 260 * cases.length);
    const headSheet = canvas(600, 190 * cases.length);
    const sourceHashes = new Set<string>();
    const originalCraft = skinPost.validateAtlasCraft;
    let lastCraftAtlas: RawImage | undefined;
    let lastCraftProblems: string[] = [];
    const craftSpy = vi.spyOn(skinPost, "validateAtlasCraft").mockImplementation((atlas, ...args) => {
      const verdict = originalCraft(atlas, ...args);
      lastCraftAtlas = { ...atlas, rgba: atlas.rgba.slice() };
      lastCraftProblems = verdict.problems;
      return verdict;
    });
    try {
      for (const [index, c] of cases.entries()) {
        lastCraftAtlas = undefined;
        lastCraftProblems = [];
        const sourcePath = c.existing ? resolve(`evaluation-artifacts/facial-feature-renderer-20260904/${c.id}/01-source.png`) : join(INPUT_ROOT, `sources/${c.photoId}.jpg`);
        const bytes = new Uint8Array(await readFile(sourcePath));
        // Source display/annotation decoding is artifact-only, outside Worker memory budgets.
        const jpeg = c.existing ? null : decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
        const source: RawImage = jpeg ? { width: jpeg.width, height: jpeg.height, rgba: jpeg.data } : await decodePng(bytes);
        const sourceHash = hash(source.rgba);
        expect(sourceHashes.has(sourceHash), c.id).toBe(false); sourceHashes.add(sourceHash);
        const analysis = analysisFromAnnotation(c);
        let storedMetadata: Record<string, string> = {};
        if (c.existing) {
          const stored = JSON.parse(await readFile(resolve(`evaluation-artifacts/head-structure-iteration-final/${c.id}/metrics.json`), "utf8"));
          const geometry = parseIdentityGeometry(stored.sourceGeometryAfter);
          if (!geometry) throw new Error(`invalid stored geometry: ${c.id}`);
          analysis.identityGeometry = geometry;
          storedMetadata = { sourceUrl: stored.sourcePage, license: stored.license, geometryOrigin: "stored sourceGeometryAfter; includes prior offline calibration, not a new AI response" };
        }
        const entry = { caseId: c.id, personKey: c.existing ? `existing:${c.id}` : `pexels:${c.photoId}`, source: c.existing ? "existing Wikimedia fixture" : "Pexels", sourceUrl: c.sourceUrl, author: c.author, license: c.existing ? undefined : "Pexels License", licenseUrl: c.existing ? undefined : "https://www.pexels.com/license/", ...storedMetadata, retrievedAt: "2026-09-05", trackedInGit: false, use: "internal development and generalization only; no endorsement", sourceHash, dimensions: [source.width, source.height], annotationHash: hash(JSON.stringify(c)), adapterAnalysisHash: hash(JSON.stringify(analysis)), analysisOrigin: "manual_source_annotation_adapter", pipelineProvidedAnalysis: false, coverage: { framing: c.framing, pose: c.pose, hair: c.hair, clothing: c.clothing, accessory: c.accessories, lowerVisible: c.lowerVisible, lighting: c.lighting } };
        manifest.push(entry);
        const normalized = normalizeAnalysisForRendering(structuredClone(analysis));
        const features = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
        const style = buildFaceStyle(normalized, features);
        const times = [], cpuTimes = [];
        let atlas: RawImage | null = null;
        let plan: SkinPlan;
        try { plan = buildSkinPlan(normalized); }
        catch (error) {
          const path = join(ROOT, phase!, c.id); await mkdir(path, { recursive: true });
          const result = { caseId: c.id, productionAccepted: false, noAtlas: true, checks: [], checked: 0, retained: 0, signatures: { head: "unavailable", body: "unavailable", whole: "unavailable" }, failures: [{ cue: "usable skin output", category: "QUANTIZATION_COLLAPSE", severity: "critical", stage: "quantization", detail: String(error) } satisfies Failure] };
          results.push(result);
          await writeFile(join(path, "metrics.json"), JSON.stringify(result, null, 2));
          await writeFile(join(path, "analysis-and-plan.json"), JSON.stringify({ sourceAnnotation: c, analysis, normalized, features, style, error: String(error) }, null, 2));
          paste(fullSheet, source, 0, index * 260, 300, 260);
          paste(headSheet, crop(source, c.headBox), 0, index * 190, 200, 190);
          continue;
        }
        for (let run = 0; run < 4; run++) {
          const startCpu = process.cpuUsage(), start = performance.now();
          plan = buildSkinPlan(normalized);
          atlas = buildProceduralFallbackAtlas(features, style, plan);
          const cpu = process.cpuUsage(startCpu);
          if (run > 0) { times.push(performance.now() - start); cpuTimes.push((cpu.user + cpu.system) / 1000); }
        }
        const productionAccepted = atlas !== null;
        if (!atlas) atlas = lastCraftAtlas ?? null;
        if (!atlas) throw new Error(`no inspectable pre-gate atlas: ${c.id}`);
        expect(validateFinalAtlas(atlas).ok, c.id).toBe(true);
        const candidates = buildOutfitPlanCandidates(normalized).length;
        expect(candidates).toBeLessThanOrEqual(3);
        const bodyTimes = [];
        for (let n = 0; n < 4; n++) { const scratch = { ...atlas, rgba: atlas.rgba.slice() }; const start = performance.now(); applyOutfitPlan(scratch, plan.outfitPlan, String(features.skinTone)); if (n) bodyTimes.push(performance.now() - start); }
        const beforePath = join(ROOT, "before", c.id, "atlas.png");
        const beforeHadNoAtlas = phase === "after" && JSON.parse(await readFile(join(ROOT, "before", c.id, "metrics.json"), "utf8")).noAtlas === true;
        // Only a recorded planner failure permits a blank diagnostic. I/O errors
        // or missing expected atlases must fail instead of silently fabricating a diff.
        const before = phase === "after" ? beforeHadNoAtlas ? canvas(64, 64) : await decodePng(new Uint8Array(await readFile(beforePath))) : atlas;
        const path = join(ROOT, phase!, c.id); await mkdir(path, { recursive: true });
        const artifactStart = performance.now();
        const views = renderSkinViews(atlas), beforeViews = renderSkinViews(before);
        const headCrop = crop(source, c.headBox);
        const bodyCrop = crop(source, [0, Math.min(0.95, c.headBox[1] + c.headBox[3] * 0.7), 1, 1 - Math.min(0.95, c.headBox[1] + c.headBox[3] * 0.7)]);
        const diff = canvas(64, 64);
        for (let p = 0; p < 4096; p++) diff.rgba.set([0, 1, 2, 3].some(k => before.rgba[p * 4 + k] !== atlas.rgba[p * 4 + k]) ? [255, 60, 80, 255] : [32, 36, 40, 255], p * 4);
        await png(join(path, "atlas.png"), atlas);
        await png(join(path, "head-crop.png"), headCrop); await png(join(path, "outfit-crop.png"), bodyCrop);
        await png(join(path, "head-silhouette.png"), buildBinaryHeadSilhouette(atlas));
        await png(join(path, "base-only.png"), buildBodyLayerDiagnostic(atlas, "base"));
        await png(join(path, "outer-only.png"), buildBodyLayerDiagnostic(atlas, "outer"));
        await png(join(path, "body-color-blocks.png"), buildBodyLayerDiagnostic(atlas, "combined"));
        await png(join(path, "pixel-diff.png"), scaleNearestNeighbor(diff, 384, 384));
        await png(join(path, "seams.png"), buildBodySeamDiagnostic(atlas));
        for (const view of views) await png(join(path, `${view.name}.png`), view.image);
        // Frozen baseline row order: source | before | current; no source substitution.
        paste(fullSheet, source, 0, index * 260, 300, 260);
        paste(fullSheet, beforeViews[0].image, 300, index * 260, 300, 260);
        paste(fullSheet, views[0].image, 600, index * 260, 300, 260);
        paste(headSheet, headCrop, 0, index * 190, 200, 190);
        paste(headSheet, extractRenderedHeadView(beforeViews[0]), 200, index * 190, 200, 190);
        paste(headSheet, extractRenderedHeadView(views[0]), 400, index * 190, 200, 190);
        const retention = diagnose(c, plan.outfitPlan, atlas);
        if (!productionAccepted) retention.failures.push({ cue: "usable skin output", category: "RENDERER_LOSS", severity: "critical", stage: "renderer", detail: `production craft gate returned null: ${lastCraftProblems.join(" / ")}` });
        Object.assign(retention, { productionAccepted, artifactIsPreGateDiagnostic: !productionAccepted });
        const seams = measureOutfitIdentityRetention(plan.outfitPlan, atlas);
        const result = { caseId: c.id, ...retention, analysisCoverageLimitation: true, cropQuality: "manual crop for review, automatic localization untested", geometryCoverage: c.existing ? "stored calibrated geometry" : "no measured geometry; categorical manual hints only", signatures: signatures(atlas), craft: measureAtlasCraft(atlas), continuity: { frontSide: seams.frontSideContinuity, sideBack: seams.sideBackContinuity }, performance: { productionWallMedianMs: median(times), productionCpuMedianMs: median(cpuTimes), bodyRenderMedianMs: median(bodyTimes), candidateCount: candidates, productionRenders: 1, artifactOnlyMs: performance.now() - artifactStart }, diff: measureOutfitPixelDifference(before, atlas), headBytesUnchanged: headUvIsByteIdentical(before, atlas), apiUsage: { geminiGeometry: 0, absolute: 0, pairwise: 0, interactions: 0 } };
        results.push(result);
        await writeFile(join(path, "metrics.json"), JSON.stringify(result, null, 2));
        await writeFile(join(path, "analysis-and-plan.json"), JSON.stringify({ analysisOrigin: entry.analysisOrigin, sourceAnnotation: c, analysis, normalized, features, style, plan }, null, 2));
      }
      const frozen = { annotationFileHash: hash(annotationBytes), sources: manifest };
      if (phase === "before") await writeFile(join(ROOT, "frozen-manifest.json"), JSON.stringify(frozen, null, 2), { flag: "wx" });
      else expect(JSON.parse(await readFile(join(ROOT, "frozen-manifest.json"), "utf8"))).toEqual(frozen);
      const summary = { phase, cases: results, convergence: Object.fromEntries((["head", "body", "whole"] as const).map(key => [key, convergence(results.filter(r => r.signatures[key] !== "unavailable").map(r => r.signatures[key]))])), failures: results.flatMap(r => r.failures.map(f => ({ caseId: r.caseId, ...f }))), manualVisualAudit: "required separately; automatic counts are a limited checked-cue subset; missing atlases excluded from convergence", fetchedDuringReplay: fetchSpy.mock.calls.length };
      await writeFile(join(ROOT, phase!, "summary.json"), JSON.stringify(summary, null, 2));
      await png(join(ROOT, phase!, "full-body-contact-sheet.png"), fullSheet);
      await png(join(ROOT, phase!, "head-contact-sheet.png"), headSheet);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); craftSpy.mockRestore(); }
  }, 120000);
});
