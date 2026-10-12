import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("connects D013's observed face-framing torso endpoint without changing other same-run evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-013";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("f6b5f27266e8bebb9ed0b05552838d23054db779af0289106f7274ed68869a61");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const p = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle, f = t.injectedParameters.features;
    const immutable = JSON.stringify(t), a = { ...t.primary, ...t.renderAnalysis };
    // Retained analysis projection supplies design inputs only. Do not rebuild
    // missing provider tuples or the full primary object or replace its plan.
    const design = structuredClone(t.referenceStyle.design);
    expect(design.drape.eligible).toBe(false);
    design.drape = buildReferenceStylePlan(a).drape;
    expect(design.drape.eligible).toBe(true);
    const base = buildProceduralSourceAtlas(f, style, p)!;
    const before = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
    const actual = await decodePng(png); expect(before.atlas.rgba).toEqual(actual.rgba);
    const after = composeReferenceStyleAtlas(base, p, design, style);
    const front = after.diagnostic.looseHair.points.filter(c => c.face === "front");
    expect(after.diagnostic.looseHair.frontEvidence).toBe("observed_front_lock_endpoint");
    expect(front).toHaveLength(16);
    expect(after.diagnostic.looseHair.points.filter(c => c.face === "back"))
      .toEqual(before.diagnostic.looseHair.points.filter(c => c.face === "back"));
    const selected = selectReferenceStyleAtlas(base, p, design, style).selected!;
    expect(selected).not.toBeNull(); expect(selected.composition.atlas.rgba).toEqual(after.atlas.rgba);
    expect(validateReferenceAtlasCraft(after.atlas, base, p, style, buildReferenceCraftPlan(p, design, after)).ok).toBe(true);
    expect(validateFinalAtlas(after.atlas).ok).toBe(true);
    const uv = CLASSIC_LAYOUT.body.base.front, overlay = CLASSIC_LAYOUT.body.overlay.front;
    const allowed = new Set(front.map(c => (uv.y + c.y) * 64 + uv.x + c.x));
    let changedPixels = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(c => after.atlas.rgba[i * 4 + c] !== actual.rgba[i * 4 + c])) continue;
      changedPixels++; expect(allowed.has(i), `unrelated:${i}`).toBe(true);
    }
    expect(changedPixels).toBe(16);
    const occluded = front.filter(c => after.atlas.rgba[((overlay.y + c.y) * 64 + overlay.x + c.x) * 4 + 3] !== 0);
    expect(occluded.map(c => [c.x, c.y])).toEqual([[0, 0], [7, 0]]);
    const out = freshAuditOutput("evaluation-artifacts/face-framing-endpoint-20261011-");
    for (const [name, result] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(result.atlas), { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, sourceSummarySha256: sha(bytes), runId: e.runId,
      earliestLoss: "NORMALIZED_PRESERVED_SELECTION_LOST", observedHair: a.observed.hair,
      productionModule: "src/observedFrontHairDrape.ts", actualPngExactBaseline: true, fullAnalysisReconstructed: false,
      sourcePlanUnchanged: true, beforeDrape: t.referenceStyle.design.drape, afterDrape: design.drape,
      frontPoints: front.length, changedPixels, unrelatedChangedPixels: 0, alphaUnchanged: true,
      visibleFrontCells: front.length - occluded.length, preservedHoodRimOcclusion: occluded.map(c => [c.x, c.y]),
      selectionAccepted: true, craftPass: true, atlasPass: true, beforeRgbaSha256: sha(actual.rgba), afterRgbaSha256: sha(after.atlas.rgba),
      providerCalls: 0, freshLiveDeliveryVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("FACE_FRAMING_ENDPOINT_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
