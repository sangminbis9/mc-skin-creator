import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("isolates actual D010 front-lock loss without rebuilding missing analysis or changing palettes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("26c58761d0f08a862e8f4721194d02a8271236beb252c3700682c203a9ab8eb6");
    const run = JSON.parse(bytes.toString()).currentDefaultE2E, t = run.result.propagationTrace;
    const p = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle, features = t.injectedParameters.features;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const immutable = JSON.stringify(t);
    // Only design's placement authorization is recalculated. Missing prompts,
    // provider tuples and the saved full plan are never reconstructed.
    const design = structuredClone(t.referenceStyle.design);
    expect(design.drape.eligible).toBe(false);
    design.drape = buildReferenceStylePlan(a).drape;
    expect(design.drape.eligible).toBe(true);
    const base = buildProceduralSourceAtlas(features, style, p)!;
    const before = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
    const actual = await decodePng(png); expect(before.atlas.rgba).toEqual(actual.rgba);
    const after = composeReferenceStyleAtlas(base, p, design, style);
    const loose = after.diagnostic.looseHair;
    expect(loose.frontEvidence).toBe("observed_front_lock_endpoint");
    const front = loose.points.filter(c => c.face === "front");
    expect(front).toHaveLength(16);
    expect(loose.points.filter(c => c.face === "back")).toEqual(before.diagnostic.looseHair.points.filter(c => c.face === "back"));
    expect(measureReferenceRenderedQuality(after, base, p, design, style).violations).toEqual([]);
    const selection = selectReferenceStyleAtlas(base, p, design, style).selected!;
    expect(selection).not.toBeNull(); expect(selection.composition.atlas.rgba).toEqual(after.atlas.rgba);
    const craft = validateReferenceAtlasCraft(after.atlas, base, p, style, buildReferenceCraftPlan(p, design, after));
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after.atlas).ok).toBe(true);
    const uv = CLASSIC_LAYOUT.body.base.front;
    const allowed = new Set(front.map(c => (uv.y + c.y) * 64 + uv.x + c.x));
    let changedPixels = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(c => after.atlas.rgba[i * 4 + c] !== actual.rgba[i * 4 + c])) continue;
      changedPixels++; expect(allowed.has(i), `unrelated:${i}`).toBe(true);
    }
    expect(changedPixels).toBe(16);
    // Composited visibility, not merely hidden base writes beneath a hoodie.
    // The two existing hood-rim corner pixels remain in front of each root;
    // preserve that garment construction, and require every lower lock cell.
    const overlay = CLASSIC_LAYOUT.body.overlay.front;
    const occluded = front.filter(c => after.atlas.rgba[((overlay.y + c.y) * 64 + overlay.x + c.x) * 4 + 3] !== 0);
    expect(occluded.map(c => [c.x, c.y])).toEqual([[0, 0], [7, 0]]);
    expect(front.filter(c => !occluded.includes(c))).toHaveLength(14);
    for (const c of occluded) {
      const i = ((overlay.y + c.y) * 64 + overlay.x + c.x) * 4;
      expect(after.atlas.rgba.slice(i, i + 4)).toEqual(actual.rgba.slice(i, i + 4));
    }
    const root = freshAuditOutput("evaluation-artifacts/front-lock-endpoint-20261010-");
    for (const [name, output] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(output.atlas), { flag: "wx" });
      for (const view of renderSkinViews(output.atlas)) writeFileSync(`${root}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: run.runId,
      providerCalls: 0, earliestLoss: "NORMALIZED_PRESERVED_SELECTION_LOST", observedHair: a.observed.hair,
      beforeDrape: t.referenceStyle.design.drape, afterDrape: design.drape, looseHair: loose,
      sourcePlanUnchanged: true, actualPngExactBaseline: true, fullAnalysisReconstructed: false,
      changedPixels, unrelatedPixels: 0, alphaUnchanged: true, visibleFrontLockCells: 14,
      preservedHoodRimOcclusion: occluded.map(c => ({ x: c.x, y: c.y })),
      selectionAccepted: true, craftPass: true, atlasPass: true,
      beforeRgbaSha256: sha(actual.rgba), afterRgbaSha256: sha(after.atlas.rgba), freshLiveDeliveryVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("FRONT_LOCK_ENDPOINT_REPLAY", root);
  } finally { network.mockRestore(); }
}, 60_000);
