import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { preserveObservedSleeveCuffs, outfitPlanSignature } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

it("replays D020's observed white cuffs without altering sleeve endpoints or unrelated pixels", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions"> = t.renderAnalysis;
    const original: SkinPlan = t.skinPlan.skinPlan, fixed = structuredClone(original);
    expect(t.primary.observed.clothing).toContain("white ribbed cuffs");
    expect(analysis.observed).toEqual(t.primary.observed);
    const immutable = JSON.stringify(t);
    fixed.outfitPlan = preserveObservedSleeveCuffs(original.outfitPlan, analysis);
    expect(outfitPlanSignature(fixed.outfitPlan)).not.toBe(outfitPlanSignature(original.outfitPlan));
    expect(preserveObservedSleeveCuffs(fixed.outfitPlan, analysis)).toBe(fixed.outfitPlan);
    for (const side of ["leftSleeve", "rightSleeve"] as const) {
      expect(original.outfitPlan.upper[side].cuff).toBeUndefined();
      expect(fixed.outfitPlan.upper[side].cuff).toEqual({ color: "#eeeae1", source: "observed", evidence: "white ribbed cuffs" });
      const withoutCuff = { ...fixed.outfitPlan.upper[side] }; delete withoutCuff.cuff;
      expect(withoutCuff).toEqual(original.outfitPlan.upper[side]);
    }
    expect(fixed.outfitPlan.outerLayer).toEqual(original.outfitPlan.outerLayer);
    expect(fixed.outfitPlan.accessories).toEqual(original.outfitPlan.accessories);
    const restored = structuredClone(fixed); restored.outfitPlan = original.outfitPlan;
    expect(restored).toEqual(original);
    const render = (p: SkinPlan) => {
      const base = buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, p)!;
      const composed = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, t.injectedParameters.faceStyle);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      const craft = validateReferenceAtlasCraft(composed.atlas, base, p, t.injectedParameters.faceStyle,
        buildReferenceCraftPlan(p, t.referenceStyle.design, composed));
      expect(craft.ok, JSON.stringify(craft)).toBe(true);
      return composed.atlas;
    };
    const before = render(original), after = render(fixed);
    expect(before.rgba).toEqual((await decodePng(png)).rgba);
    expect(render(fixed).rgba).toEqual(after.rgba);
    const cuffRows = ["rightArm", "leftArm"].flatMap(part => {
      const arm = CLASSIC_LAYOUT[part as "rightArm" | "leftArm"];
      return [arm.base, arm.overlay].flatMap(box => ["front", "back", "left", "right"].map(face => {
        const r = box[face as "front" | "back" | "left" | "right"];
        return { x: r.x, y: r.y + 10, w: r.w };
      }));
    });
    const changed = [];
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[i * 4 + c] !== before.rgba[i * 4 + c])) {
        const x = i % 64, y = Math.floor(i / 64);
        expect(cuffRows.some(r => y === r.y && x >= r.x && x < r.x + r.w)).toBe(true);
        changed.push({ x, y });
      }
    }
    expect(changed).toHaveLength(56);
    for (const part of ["rightArm", "leftArm"] as const) {
      const r = CLASSIC_LAYOUT[part].overlay.front;
      const i = ((r.y + 10) * 64 + r.x + 1) * 4;
      expect([...after.rgba.slice(i, i + 4)]).toEqual([255, 253, 243, 255]);
    }
    const out = freshAuditOutput("evaluation-artifacts/observed-sleeve-cuff-replay-20261011-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      const encoded = await encodePng(atlas); expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(renderSkinViews(atlas)[0].image, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_same_run_cuff_only_replay", providerCalls: 0,
      sourceRoot: root, sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), historicalPngExact: true,
      earliestLoss: "normalized_observed_cuff_color_not_bound_to_outfit_plan", cue: "white ribbed cuffs",
      beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba), cuff: fixed.outfitPlan.upper.leftSleeve.cuff,
      changedPixels: changed.length, unrelatedPixelChanges: 0, alphaChanges: 0,
      sleeveTopologyUnchanged: true, craftPass: true, atlasPass: true, freshLiveVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("OBSERVED_SLEEVE_CUFF_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
