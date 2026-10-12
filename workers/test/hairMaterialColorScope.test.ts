// Offline source-binding evidence; no provider/remote runner imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { fallbackFeaturesToHex, refineFeatureColorsFromAnalysis, buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { preserveObservedNeckBowColor, preserveObservedWristCuffs } from "../src/outfitIdentity";
import type { PhotoAnalysis } from "../src/analysis";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { withHistoricalCalmMouth } from "./historicalHairMaterial";
import { assertHistoricalSingletonEyePresentation } from "./historicalSingletonEyePresentation";
import { verifyLegwearRedesign } from "./savedLegwearRendererEvidence";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

function recover(hair: string) {
  const a = makeAnalysis(); a.observed.hair = hair; a.fallbackFeatures.hairColor = "dark-brown";
  const input = fallbackFeaturesToHex(a.fallbackFeatures);
  return { result: refineFeatureColorsFromAnalysis(a, input).hairColor, fallback: input.hairColor };
}

it.each([
  ["long straight brown hair, viewer-left white bow", "brown"],
  ["white bow with long brown hair", "brown"],
  ["brown hair with blonde highlights", "brown"],
  ["hair is brown with a white bow", "brown"],
  ["brown wavy hair with red ribbon", "brown"],
  ["light brown straight hair with white bow", "light-brown"],
  ["long dark-brown hair with platinum clip", "dark-brown"],
  ["white hair with brown ribbon", "white"],
  ["platinum blonde hair", "platinum"],
  ["silver-white platinum hair, tousled and voluminous", "white"],
  ["platinum-white straight hair", "white"],
  ["silver-white hair with a pink ribbon", "white"],
  ["brown hair with a silver-white platinum clip", "brown"],
  ["black locs with silver bands", "black"],
  ["silver hair with black bow", "gray"],
  ["ashy-gray/silver hair, thick and tousled with eye-length bangs", "gray"],
  ["silver/grey layered hair with a black ribbon", "gray"],
  ["gray / silver hair", "gray"],
  ["Ash-gray/silver-toned hair, medium length reaching the jaw", "gray"],
  ["silver-toned layered hair with a black ribbon", "gray"],
  ["gray-toned hair", "gray"],
  ["short ginger curls", "red"],
  ["brown hair with white hair bow", "brown"],
  ["ash-gray, medium-length hair with thick eye-length bangs", "gray"],
  ["silver, long straight hair", "gray"],
  ["black, short curly hair", "black"],
  ["light brown, medium-length hair with a white ribbon", "light-brown"],
  ["ashy gray color, thick and somewhat messy texture; the fringe is dense", "gray"],
  ["silver colour, straight texture", "gray"],
  ["dark-brown color, thick texture", "dark-brown"],
])("binds hair material, not accessory priority: %s", (hair, expected) => {
  const a = makeAnalysis();
  expect(recover(hair).result).toBe(fallbackFeaturesToHex({ ...a.fallbackFeatures, hairColor: expected }).hairColor);
});

it.each(["white bow in hair", "hair with red ribbon", "white hair bow", "hair white bow", "possibly white hair",
  "possibly silver-white platinum hair", "silver-white hair bow", "silver and white hair",
  "no white hair", "hair color unknown, white ribbon", "black and white hair", "brown hair and white hair",
  "brown hair; white hair", "hair with blonde highlights", "brown ribbon in hair",
  "white ribbon, long hair", "gray jacket, medium-length hair", "possibly gray, medium-length hair",
  "no gray, medium-length hair", "gray, medium-length hair bow", "gray, medium-length hair, white hair",
  "silver, unknown hair", "white ribbon, soft natural flowing hair",
  "gray color ribbon, thick texture", "ribbon: gray color", "possibly gray color, thick texture",
  "no gray color, brown ribbon", "gray color unknown", "gray color and white color",
  "gray color, white hair", "gray color bow", "black coat, gray color"])(
  "does not infer uncertain, accessory-only or contradictory material: %s", hair => {
    const r = recover(hair); expect(r.result).toBe(r.fallback);
  });

it.each([
  "gray/silver hair bow", "gray/silver ribbon in hair", "possibly gray/silver hair",
  "no gray/silver hair", "gray/silver hair hidden", "gray/silver and white hair",
  "gray/brown hair", "silver/black hair", "gray/silver jacket with brown hair",
  "silver-toned hair bow", "gray/silver-toned ribbon in hair", "possibly silver-toned hair",
  "gray/silver-toned hair hidden", "silver-toned and brown hair", "brown and gray-toned hair",
])("equivalent gray names do not bypass material ownership or multicolor gates: %s", hair => {
  const r = recover(hair);
  if (hair === "gray/silver jacket with brown hair")
    expect(r.result).toBe(fallbackFeaturesToHex({ ...makeAnalysis().fallbackFeatures, hairColor: "brown" }).hairColor);
  else expect(r.result).toBe(r.fallback);
});

it("bounds H-004 historical eye presentation and isolates hair-palette correction without recovering missing prose", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-004";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    const t = run.result.propagationTrace, a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const plan = t.skinPlan.skinPlan, features = t.injectedParameters.features;
    // This consumed palette experiment predates scale-aware ribbon painting.
    // Pin its former medium footprint on both color counterfactuals; current
    // small-ribbon delivery is separately covered by hairRibbonOwnership.
    const style = { ...t.injectedParameters.faceStyle, hairAccessoryScale: "medium" as const };
    expect(a.fallbackFeatures.hairColor).toBe("dark-brown");
    expect(a.observed.hair).toContain("brown hair"); expect(a.observed.hair).toContain("white bow");
    expect(features.hairColor).toBe("#e8e8e8");
    const refined = refineFeatureColorsFromAnalysis(a, features);
    expect(refined.hairColor).toBe(fallbackFeaturesToHex({ ...a.fallbackFeatures, hairColor: "brown" }).hairColor);
    expect({ ...refined, hairColor: features.hairColor }).toEqual(features);
    const render = (f: typeof features, s: typeof style) => {
      const baseline = buildProceduralSourceAtlas(f, s, plan)!;
      // Isolate this historical hair-palette experiment from the later face finish.
      // A saved palette experiment must use its saved design, not today's
      // default proportions/material finish. Current-default delivery is
      // separately exercised by the combined render below.
      const r = withHistoricalCalmMouth(() => {
        const result = composeReferenceStyleAtlas(baseline, plan, t.referenceStyle.design, s);
        expect(measureReferenceRenderedQuality(result, baseline, plan, t.referenceStyle.design, s).violations).toEqual([]);
        return result;
      });
      return r.atlas;
    };
    const before = render(features, style);
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    // Separate the already-reviewed legwear redesign from the four historical
    // eye cells. Both boundaries remain checked; neither is exact old-renderer
    // equality and the immutable historical PNG is never rewritten.
    const eyeBoundary = { ...historical, rgba: before.rgba.slice() };
    const legwearBoundary = { ...historical, rgba: historical.rgba.slice() };
    const head = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    for (let i = 0; i < 4096; i++) if (head.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)) {
      eyeBoundary.rgba.set(historical.rgba.slice(i * 4, i * 4 + 4), i * 4);
      legwearBoundary.rgba.set(before.rgba.slice(i * 4, i * 4 + 4), i * 4);
    }
    const legwearRedesignChanges = verifyLegwearRedesign(legwearBoundary, before, plan.outfitPlan);
    const historicalEyeChanges = assertHistoricalSingletonEyePresentation(before, eyeBoundary,
      buildProceduralSourceAtlas(features, style, plan)!, plan, style, t.referenceStyle.design);
    // The migration boundary must not hide unrelated paint, alpha, or a
    // wrong eye color merely because exactly four cells were expected.
    for (const index of [0, ((8 + 4) * 64 + 8 + 2) * 4, 3]) {
      const bad = { ...before, rgba: before.rgba.slice() }; bad.rgba[index] ^= 1;
      expect(() => assertHistoricalSingletonEyePresentation(bad, eyeBoundary,
        buildProceduralSourceAtlas(features, style, plan)!, plan, style, t.referenceStyle.design)).toThrow();
    }
    const newStyle = { ...style, hairColor: refined.hairColor };
    const after = render(refined, newStyle);
    expect(after.rgba).not.toEqual(before.rgba);
    expect(render(refined, newStyle).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    // Independent, source-supported palette/localization repairs composed after
    // the isolated hair counterfactual. Do not call this the original live PNG.
    const combinedPlan = { ...plan, outfitPlan: preserveObservedWristCuffs(preserveObservedNeckBowColor(plan.outfitPlan, a), a) };
    expect(combinedPlan.outfitPlan.accessories).toContainEqual(expect.objectContaining({ kind: "bow", color: "#c8798c" }));
    expect(combinedPlan.outfitPlan.accessories).toContainEqual(expect.objectContaining({ kind: "wrist_cuff", color: "#c8798c" }));
    const combinedBase = buildProceduralSourceAtlas(refined, newStyle, combinedPlan)!;
    const combined = renderReferencePrimaryAtlas(combinedBase, combinedPlan, a, newStyle);
    if (!combined.ok) throw new Error(combined.reason);
    expect(combined.summary.craftValidation).toBe("pass");
    expect(validateFinalAtlas(combined.atlas)).toEqual({ ok: true, problems: [] });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    const output = freshAuditOutput("evaluation-artifacts/hair-material-scope-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after], ["combined", combined.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_plan_palette_counterfactual_not_live",
      sourceRun: run.runId, summarySha256: hash(bytes), beforeMatchesLive: false,
      historicalEyeChanges, historicalLegwearRedesignChanges: legwearRedesignChanges,
      outsideHistoricalEyeAndLegwearChangesExact: true,
      earliestLoss: "NORMALIZED_PRESERVED_PARAMETER_LOST", primaryHairColor: a.fallbackFeatures.hairColor,
      oldParameter: features.hairColor, correctedParameter: refined.hairColor,
      missingProseReconstructed: false, otherFeaturesUnchanged: true, savedPlanUnchanged: true,
      beforeRgba: hash(before.rgba), afterRgba: hash(after.rgba), combinedRgba: hash(combined.atlas.rgba),
      combinedScope: "observed hair palette plus independently observed neckline bow, wrist cuffs and eligible calm neutral presentation",
      isolatedHairReplayUsesHistoricalCalmMouth: true,
      isolatedHairReplayUsesHistoricalMediumRibbon: true,
      craftPass: true, atlasValid: true, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`HAIR_MATERIAL_SCOPE ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
