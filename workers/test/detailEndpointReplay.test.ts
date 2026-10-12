/** Saved-plan counterfactuals, never a reconstructed primary or new live run. */
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

it("replays both stored front-lock losses with immutable evidence and only authorized body-front changes", async () => {
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  const output = mkdtempSync("evaluation-artifacts/detail-endpoint-replay-20261012-"), rows = [];
  try {
    for (const [slot, points] of [[16, 8], [20, 16]]) {
      const id = String(slot).padStart(3, "0"), root = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}`;
      const bytes = readFileSync(`${root}/summary.json`), saved = readFileSync(`${root}/skin.png`);
      const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
      const plan = t.skinPlan.skinPlan, { features, faceStyle } = t.injectedParameters;
      const base = buildProceduralSourceAtlas(features, faceStyle, plan)!;
      const before = composeReferenceStyleAtlas(base, plan, t.referenceStyle.design, faceStyle);
      const actual = await decodePng(saved); expect(before.atlas.rgba).toEqual(actual.rgba);
      // Retained fields are used for drape selection only. No full primary or
      // missing prompt is reconstructed, and the saved source plan stays fixed.
      const design = structuredClone(t.referenceStyle.design);
      design.drape = buildReferenceStylePlan({ ...t.primary, ...t.renderAnalysis }).drape;
      expect(design.drape.eligible).toBe(true);
      const after = composeReferenceStyleAtlas(base, plan, design, faceStyle);
      const front = after.diagnostic.looseHair.points.filter(p => p.face === "front");
      expect(front).toHaveLength(points);
      const r = CLASSIC_LAYOUT.body.base.front;
      const allowed = new Set(front.map(p => (r.y + p.y) * 64 + r.x + p.x));
      let changed = 0;
      for (let p = 0; p < 4096; p++) {
        expect(after.atlas.rgba[p * 4 + 3]).toBe(actual.rgba[p * 4 + 3]);
        if ([0, 1, 2].some(c => after.atlas.rgba[p * 4 + c] !== actual.rgba[p * 4 + c])) {
          expect(allowed.has(p), `${id}: unrelated pixel ${p}`).toBe(true); changed++;
        }
      }
      expect(changed).toBe(points);
      expect(selectReferenceStyleAtlas(base, plan, design, faceStyle).selected).not.toBeNull();
      expect(validateFinalAtlas(after.atlas).ok).toBe(true);
      for (const [label, image] of [["before", actual], ["after", after.atlas]] as const) {
        writeFileSync(`${output}/${id}-${label}.png`, await encodePng(image), { flag: "wx" });
        for (const view of renderSkinViews(image)) writeFileSync(`${output}/${id}-${label}-${view.name}.png`,
          await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
      }
      rows.push({ slot, runId: e.runId, sourceSummarySha256: createHash("sha256").update(bytes).digest("hex"),
        exactBefore: true, changedPixels: changed, unrelatedChangedPixels: 0, sourcePlanUnchanged: true,
        providerCalls: 0, fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false });
      expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(saved);
    }
    expect(net).not.toHaveBeenCalled();
    writeFileSync(`${output}/results.json`, JSON.stringify({ rows }, null, 2), { flag: "wx" });
    console.info(`DETAIL_ENDPOINT_REPLAY ${output}`);
  } finally { net.mockRestore(); }
}, 120_000);
