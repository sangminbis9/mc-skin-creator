/** Immutable same-run evidence. No reconstructed provider prompts or calls. */
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

it("reproduces the first live PNG exactly, then restores its observed tie stripe without other pixel changes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const root = "evaluation-artifacts/detail-iteration-v3-e2e-20261012-001";
  const evidence = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
  const trace = JSON.parse(evidence.toString()).currentDefaultE2E.result.propagationTrace;
  const plan = trace.skinPlan.skinPlan, style = trace.injectedParameters.faceStyle;
  const features = trace.injectedParameters.features, design = trace.referenceStyle.design;
  try {
    const source = buildProceduralSourceAtlas(features, style, plan)!;
    const before = composeReferenceStyleAtlas(source, plan, design, style);
    expect(before.atlas.rgba).toEqual((await decodePng(png)).rgba);
    expect(plan.outfitPlan.formalSuit.tiePattern).toBeUndefined();
    const fixed = structuredClone(plan);
    fixed.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
    expect(fixed.outfitPlan.formalSuit.tiePattern).toBe("striped");
    expect(fixed.outfitPlan.formalSuit.tieAccent).toBeNull();
    const fixedStyle = { ...style, neckAccessoryPattern: "striped" as const };
    const fixedSource = buildProceduralSourceAtlas(features, fixedStyle, fixed)!;
    const after = composeReferenceStyleAtlas(fixedSource, fixed, design, fixedStyle);
    expect(measureReferenceRenderedQuality(after, fixedSource, fixed, design, fixedStyle).violations).toEqual([]);
    const changed = [];
    for (let p = 0; p < 4096; p++) if (!before.atlas.rgba.slice(p * 4, p * 4 + 4).every((v, c) => v === after.atlas.rgba[p * 4 + c])) changed.push(p);
    // Connected raised tie, not the face, hair, jacket silhouette or trousers.
    const tieUv = CLASSIC_LAYOUT.body.overlay.front;
    expect(changed).toEqual([[3, 2], [4, 3]].map(([x, y]) => (tieUv.y + y) * 64 + tieUv.x + x));
    const output = mkdtempSync("evaluation-artifacts/detail-tie-live-replay-20261012-");
    for (const [name, atlas] of [["before", before.atlas], ["after", after.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 8, view.image.height * 8)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ sourceRun: trace.runId, providerCalls: 0,
      sourcePngSha256: createHash("sha256").update(png).digest("hex"), exactBeforeReplay: true,
      firstLoss: "observed_clothing_to_formalSuit_tiePattern", changedPixels: changed,
      after: "offline_replay_not_new_provider_result", observationsUnchanged: true }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(evidence);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled();
    console.info(`DETAIL_TIE_REPLAY ${output}`);
  } finally { network.mockRestore(); }
});
