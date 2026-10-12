import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { validateAtlasCraftFoundation } from "../src/skinPost";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

it("isolates the saved hat observation without claiming missing prompt reconstruction", () => {
  const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const bytes = readFileSync("evaluation-artifacts/detail-iteration-v3-e2e-20261012-007/summary.json");
    const primary = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace.primary;
    // Explicit synthetic context. Original prompt fields were not persisted.
    const raw = { ...primary, identityPrompt: "", outfitPrompt: "", negativePrompt: "" };
    const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
    const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, plan.hairPlan), source = buildProceduralSourceAtlas(features, style, plan)!;
    expect(source).not.toBeNull();
    const result = renderReferencePrimaryAtlas(source, plan, analysis, style);
    const selection = selectReferenceStyleAtlas(source, plan, buildReferenceStylePlan(analysis), style);
    const composed = composeReferenceStyleAtlas(source, plan, { ...buildReferenceStylePlan(analysis), headProportionPolicy: undefined }, style);
    expect(result.ok).toBe(true);
    expect(selection.selected).not.toBeNull();
    const selected = selection.selected!;
    for (const y of [3, 4]) {
      const changed = structuredClone(selected.composition);
      const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + y) * 64 + r.x + 2) * 4;
      changed.atlas.rgba[i] ^= 127;
      expect(measureReferenceRenderedQuality(changed, source, plan, selected.design, style).constructionValid).toBe(false);
    }
    const f = CLASSIC_LAYOUT.head.base.front;
    const pixels = plan.facePixelPlan.pixels.filter(p => p.role === "brow" || p.cluster === "left_eye" || p.cluster === "right_eye").map(p => {
      const i = ((f.y + p.y) * 64 + f.x + p.x) * 4;
      return { ...p, before: [...source.rgba.slice(i, i + 4)], after: [...composed.atlas.rgba.slice(i, i + 4)] };
    });
    const root = mkdtempSync("evaluation-artifacts/detail-hat-offline-isolation-20261012-");
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "saved observations with explicitly empty missing prompts; not an exact historical replay", providerCalls: 0,
      result: result.ok ? "accepted" : result, foundation: validateAtlasCraftFoundation(source, style), pixels, faceFinish: composed.diagnostic.faceFinish,
      candidates: selection.candidates.map(c => ({ id: c.id, rejection: c.rejection, violations: c.quality?.violations, foundation: c.foundation })) }, null, 2), { flag: "wx" });
    expect(net).not.toHaveBeenCalled();
    console.info(`DETAIL_HAT_ISOLATION ${root}`);
  } finally { net.mockRestore(); }
});
