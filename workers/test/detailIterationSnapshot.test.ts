/** Offline exact-atlas checks for completed batch runs; never starts providers. */
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";

it("recovers exact selected pixels and four-surface detail from completed sanitized batch evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  const output = mkdtempSync("evaluation-artifacts/detail-batch-local-replay-20261012-"), rows = [];
  try {
    for (let slot = 1; slot <= 20; slot++) {
      const id = String(slot).padStart(3, "0"), root = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}`;
      if (!existsSync(`${root}/skin.png`) || !existsSync(`${root}/summary.json`)) continue;
      const evidence = readFileSync(`${root}/summary.json`), savedPng = readFileSync(`${root}/skin.png`);
      const summary = JSON.parse(evidence.toString()), e = summary.currentDefaultE2E;
      const trace = e.result.propagationTrace, plan = trace.skinPlan.skinPlan;
      expect(summary.shutdownLatch.phase).toBe("finalized");
      expect(e.accounting).toBe("known"); expect(e.diskRecovery).toBe(true);
      const { features, faceStyle } = trace.injectedParameters;
      const source = buildProceduralSourceAtlas(features, faceStyle, plan)!;
      const design = trace.referenceStyle.design;
      const composed = design ? composeReferenceStyleAtlas(source, plan, design, faceStyle) : null;
      const actual = await decodePng(savedPng), replay = composed?.atlas ?? source;
      const exactAtlasReplay = replay.rgba.every((v, i) => v === actual.rgba[i]);
      const mismatchedPixels = Array.from({ length: 4096 }, (_, p) => p).filter(p => [0, 1, 2, 3].some(c => replay.rgba[p * 4 + c] !== actual.rgba[p * 4 + c]));
      // Never label a projection-limited replay as verified or repair its
      // historical evidence. Unexplained mismatches remain a test failure.
      if (!exactAtlasReplay) expect(trace.projectionChanges.some((p: string) => p.startsWith("skinPlan.")), `${id}: unexplained replay mismatch`).toBe(true);
      expect(hash(savedPng)).toBe(trace.finalPng.sha256);
      expect(hash(actual.rgba)).toBe(trace.finalPng.rgbaSha256);
      if (composed && exactAtlasReplay) expect(measureReferenceRenderedQuality(composed, source, plan, design, faceStyle).violations).toEqual([]);
      expect(validateFinalAtlas(actual).ok).toBe(true);
      const views = renderSkinViews(actual);
      const sheet: RawImage = { width: views.reduce((n, v) => n + v.image.width, 0), height: Math.max(...views.map(v => v.image.height)), rgba: new Uint8Array(views.reduce((n, v) => n + v.image.width, 0) * Math.max(...views.map(v => v.image.height)) * 4) };
      let left = 0;
      for (const view of views) {
        for (let y = 0; y < view.image.height; y++) sheet.rgba.set(view.image.rgba.slice(y * view.image.width * 4, (y + 1) * view.image.width * 4), (y * sheet.width + left) * 4);
        left += view.image.width;
      }
      writeFileSync(`${output}/${id}-views.png`, await encodePng(scaleNearestNeighbor(sheet, sheet.width * 4, sheet.height * 4)), { flag: "wx" });
      rows.push({ slot, runId: e.runId, caseId: e.preprocessing.source.caseId, providerAttempts: e.result.bindingAttempts,
        exactAtlasReplay, replayStatus: exactAtlasReplay ? "verified" : "MISMATCH_WITH_TRUNCATED_PLAN_EVIDENCE_NOT_VERIFIED", mismatchedPixels,
        evidenceProjectionChanges: trace.projectionChanges, selectedFamilies: trace.selectedFamilies,
        observed: trace.primary.observed, hints: trace.primary.renderHints, pngSha256: hash(savedPng),
        sourcePlanReconstruction: "not_claimed", originalRemoteParameterEvidence: trace.parameterEvidence });
      expect(readFileSync(`${root}/summary.json`)).toEqual(evidence);
    }
    expect(rows.length).toBeGreaterThan(0); expect(network).not.toHaveBeenCalled();
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, rows }, null, 2), { flag: "wx" });
    console.info(`DETAIL_BATCH_REPLAY ${output}`);
  } finally { network.mockRestore(); }
}, 120_000);
