import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { refineFeatureColorsFromAnalysis, fallbackFeaturesToHex, buildProceduralSourceAtlas } from "../src/generate";
import { resolveHeadOwnership } from "../src/headOwnership";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { SkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

function color(text: string, hat = "cap") {
  const a = makeAnalysis(); a.fallbackFeatures.hat = hat; a.fallbackFeatures.hatColor = "black";
  a.observed.accessories = text;
  const f = fallbackFeaturesToHex(a.fallbackFeatures);
  return { actual: refineFeatureColorsFromAnalysis(a, f).hatColor, fallback: f.hatColor };
}
it.each([
  "a large, textured, light-blue hat that resembles a pillow or soft cap",
  "a blue knitted beanie",
  "the cap is red",
])("retains directly named headwear material: %s", text => {
  // Expected ramps below are taken from the production color vocabulary.
  const a = makeAnalysis(); const name = text.includes("light-blue") ? "sky-blue" : text.includes("red") ? "red" : "blue";
  expect(color(text).actual).toBe(fallbackFeaturesToHex({ ...a.fallbackFeatures, hatColor: name }).hatColor);
});
it.each(["blue hair with a cap", "a cap with a blue ribbon", "blue cap sleeves", "blue cap-sleeve shirt", "no blue hat", "possibly blue hat",
  "a blue hat print", "hat color unknown", "a blue hat; a red hat", "blue bag and cap", "a black cap with blue trim"])(
  "does not borrow unrelated, uncertain or contradictory color: %s", text => {
    const r = color(text); expect(r.actual).toBe(r.fallback);
  });
it("does not invent headwear from prose when the category is none", () => {
  const r = color("a blue hat", "none"); expect(r.actual).toBe(r.fallback);
});
it.each([
  ["large, light blue, soft-textured plush hat", "#7fc3e8"],
  ["a red, soft-textured, plush beanie", "#c0392b"],
  ["a teal soft textured plush cap", "#2f7775"],
])("keeps color attached across bounded headwear material adjectives: %s", (text, expected) => {
  expect(color(text).actual).toBe(expected);
});
it.each([
  "light blue bag, soft-textured plush hat",
  "light blue, soft-textured plush ribbon on a cap",
  "possibly light blue, soft-textured plush hat",
  "no light blue, soft-textured plush hat",
  "light blue, soft-textured plush hat print",
  "blue, plush cap; red, plush cap",
  "black cap with blue, plush trim",
])("does not widen material-list ownership: %s", text => {
  const r = color(text); expect(r.actual).toBe(r.fallback);
});
it.each([
  ["a large, light blue, fuzzy/textured hat", "#7fc3e8"],
  ["a red fuzzy / textured beanie", "#c0392b"],
  ["a teal fuzzy hat", "#2f7775"],
])("retains color across bounded slash material descriptions: %s", (text, expected) => {
  expect(color(text).actual).toBe(expected);
});
it.each([
  "light blue bag, fuzzy/textured hat", "light blue, fuzzy/textured ribbon on a cap",
  "possibly light blue, fuzzy/textured hat", "no light blue, fuzzy/textured hat",
  "light blue, fuzzy/textured hat print", "blue fuzzy/textured cap; red fuzzy/textured cap",
  "black cap with blue fuzzy/textured trim", "blue fuzzy/bag hat",
])("preserves material slash ownership exclusions: %s", text => {
  const r = color(text); expect(r.actual).toBe(r.fallback);
});
it.each([
  ["a large, textured, teal-colored cap-like hat", "#2f7775"],
  ["a red coloured knitted beanie", "#c0392b"],
  ["a light-blue-colored soft hat", "#7fc3e8"],
])("retains directly attached color morphology: %s", (text, expected) => {
  expect(color(text).actual).toBe(expected);
});
it.each(["no teal-colored hat", "possibly teal-coloured cap", "teal-colored hair with a cap",
  "a cap with a teal-colored ribbon", "teal-colored cap sleeves", "a teal-colored hat print",
  "a teal-colored hat; a red-colored cap", "a black cap with a teal-colored trim"])(
  "keeps color ownership exclusions for morphology: %s", text => {
    const r = color(text); expect(r.actual).toBe(r.fallback);
  });
it("uses only saved D005 accessory evidence and produces a fresh offline material preview", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
    const bytes = readFileSync(`${root}/summary.json`), trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const immutable = JSON.stringify(a), f = trace.injectedParameters.features, s = trace.injectedParameters.faceStyle;
    const refined = refineFeatureColorsFromAnalysis(a, f);
    const expected = fallbackFeaturesToHex({ ...a.fallbackFeatures, hatColor: "sky-blue" }).hatColor;
    expect(refined.hatColor).toBe(expected); expect(f.hatColor).toBe("#22201e");
    const p: SkinPlan = structuredClone(trace.skinPlan.skinPlan);
    p.headIdentityPlan.ownership = resolveHeadOwnership(a, p.hairPlan, p.facePixelPlan);
    // Isolate the observed hat color only; do not replace other saved parameters.
    const style = { ...s, hatColor: refined.hatColor }, features = { ...f, hatColor: refined.hatColor };
    const baseline = buildProceduralSourceAtlas(features, style, p)!;
    const result = renderReferencePrimaryAtlas(baseline, p, a, style);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.reason);
    expect(result.summary.craftValidation).toBe("pass");
    const previous = renderReferencePrimaryAtlas(buildProceduralSourceAtlas(f, s, p)!, p, a, s);
    expect(previous.ok).toBe(true); if (!previous.ok) throw Error(previous.reason);
    const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    let changedHeadPixels = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => previous.atlas.rgba[i * 4 + c] !== result.atlas.rgba[i * 4 + c])) {
      expect(headRects.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
      changedHeadPixels++;
    }
    expect(changedHeadPixels).toBeGreaterThan(0);
    const out = freshAuditOutput("evaluation-artifacts/headwear-material-offline-20261010-");
    writeFileSync(`${out}/after.png`, await encodePng(result.atlas), { flag: "wx" });
    for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, sourceRun: trace.runId,
      sourceObservationUnchanged: true, beforeHatColor: f.hatColor, afterHatColor: refined.hatColor,
      ownership: "bounded_cap", craft: result.summary.craftValidation, unrelatedParametersChanged: false,
      changedHeadPixels, unrelatedPixelChanges: 0 }, null, 2), { flag: "wx" });
    expect(JSON.stringify(a)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 60_000);
