import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import type { SkinPlan } from "../src/skinPlan";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-017";
const bytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input() {
  return makeAnalysis({ ...structuredClone(primary),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing, negativePrompt: "" });
}
it("changes only the existing scalp material from an exact live PNG baseline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = normalizeAnalysisForRendering(input()), built = buildIdentityPixelPlans(a);
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const recovered = resolveHeadOwnership(a, beforePlan.hairPlan, beforePlan.facePixelPlan);
    expect(recovered.cells).toEqual(beforePlan.headIdentityPlan.ownership!.cells);
    beforePlan.headIdentityPlan.ownership = recovered;
    const afterPlan = structuredClone(beforePlan);
    expect(built.hairPlan.surfaceMaterial).toBe("scalp_shadow");
    const withoutMaterial = structuredClone(built.hairPlan); delete withoutMaterial.surfaceMaterial;
    expect(withoutMaterial).toEqual(beforePlan.hairPlan);
    afterPlan.hairPlan = built.hairPlan;
    expect(built.headIdentityPlan).toEqual(beforePlan.headIdentityPlan);
    const style = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    const actual = await decodePng(pngBytes);
    expect(sha(before.rgba)).toBe(sha(actual.rgba));
    const changes = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(y).toBeLessThan(16); expect(x).toBeLessThan(32);
        changes.push({ x, y });
      }
    }
    for (const p of beforePlan.facePixelPlan.pixels) {
      const at = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect(after.rgba.slice(at, at + 4)).toEqual(before.rgba.slice(at, at + 4));
    }
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    const output = mkdtempSync("evaluation-artifacts/current-017-scalp-visibility-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0,
      liveSummarySha256: sha(bytes), livePngSha256: sha(pngBytes), actualBaselineReplayExact: true,
      evidence: primary.observed.hair, changed: changes, craft, alphaDiff: 0, bodyDiff: 0, faceFeatureDiff: 0,
      afterRgbaSha256: sha(after.rgba), material: built.hairPlan.surfaceMaterial,
      limitation: "Offline existing-material selection only; not measured hair density or fresh provider verification." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`SCALP_VISIBILITY ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
