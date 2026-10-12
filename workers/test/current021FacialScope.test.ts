import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { observedFacialHairCategory } from "../src/facialHairEvidence";
import { makeAnalysis } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const p = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021/summary.json", "utf8"))
  .currentDefaultE2E.result.diagnostics.normalizedPrimary;
it("does not mistake actual 021 clean-shaven scalp for absent facial hair", () => {
  expect(observedFacialHairCategory(p.fallbackFeatures.facialHair, p.observed.face, p.canonicalIdentity.mustPreserve, p.visibleRegions.face)).toBe("goatee");
});
it.each(["Clean-shaven scalp", "Clean-shaven scalp with very short cropped hair", "Clean shaven crown"])(
  "keeps independent scalp-only absence out of facial corroboration/conflicts: %s", scalp => {
    expect(observedFacialHairCategory("none", "Small goatee", ["Small goatee", scalp], true)).toBe("goatee");
    expect(observedFacialHairCategory("none", "Small goatee", [scalp], true)).toBeUndefined();
  });
it.each(["Clean-shaven", "Clean-shaven face", "Clean-shaven scalp and face", "Clean-shaven scalp and chin",
  "Clean-shaven scalp but no beard", "Clean-shaven scalp, clean-shaven", "Clean-shaven scalp and facial stubble",
  "Clean-shaven scalp with clean-shaven jawline", "Clean-shaven scalp and neck"])("keeps mixed/unlocalized facial conflict: %s", cue => {
    expect(observedFacialHairCategory("none", "Small goatee", ["Small goatee", cue], true)).toBeUndefined();
  });
it("does not invent a beard, override explicit categories, hidden faces or qualify uncertain evidence", () => {
  for (const face of ["No goatee", "Possibly a goatee", "Goatee-like shadow", "Neutral face"])
    expect(observedFacialHairCategory("none", face, ["Small goatee", "Clean-shaven scalp"], true)).toBeUndefined();
  expect(observedFacialHairCategory("beard", p.observed.face, p.canonicalIdentity.mustPreserve, true)).toBeUndefined();
  expect(observedFacialHairCategory("none", p.observed.face, p.canonicalIdentity.mustPreserve, false)).toBeUndefined();
});
it("retains recovered goatee through strict normalization and a bounded combined actual-plan replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021";
    const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
    const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-021-live-verification-20260928-mhdYLf/verification.json", "utf8"));
    const synthetic = makeAnalysis({ ...structuredClone(p),
      sourceSelection: makeAnalysis().sourceSelection, // Explicit synthetic complete wire; not recovered provider free text.
      identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" });
    const normalized = normalizeCompactPhotoAnalysisV3(wireFixture(synthetic), { imageCount: 1 });
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw new Error("strict_normalization_failed");
    expect(normalized.analysis.fallbackFeatures.facialHair).toBe("goatee");
    const a = normalizeAnalysisForRendering(normalized.analysis), parts = buildIdentityPixelPlans(a);
    const plan = structuredClone(live.analysis.skinPlan); plan.hairPlan = parts.hairPlan;
    expect(parts.headIdentityPlan).toEqual(plan.headIdentityPlan); expect(parts.facePixelPlan).toEqual(plan.facePixelPlan);
    const features = { ...live.features, facialHair: normalized.analysis.fallbackFeatures.facialHair };
    const validatedStyle = buildFaceStyle(a, features, plan.hairPlan);
    expect(validatedStyle.facialHair).toBe("goatee"); expect(validatedStyle.goateeHasMustache).not.toBe(true);
    // Synthetic complete-wire context is not the historical outfit context.
    // Transfer only the strictly normalized facial category into frozen style.
    const style = { ...baseline.style, facialHair: validatedStyle.facialHair };
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, live.analysis.skinPlan)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(features, style, plan)!;
    const hairOnly = buildProceduralFallbackAtlas(live.features, baseline.style, plan)!;
    let changed = 0, beardPixels = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[i * 4 + c] !== before.rgba[i * 4 + c])) { expect(Math.floor(i / 64)).toBeLessThan(16); changed++; }
      if ([0, 1, 2].some(c => after.rgba[i * 4 + c] !== hairOnly.rgba[i * 4 + c])) { expect(Math.floor(i / 64)).toBeLessThan(16); beardPixels++; }
    }
    expect(changed).toBeGreaterThan(0); expect(beardPixels).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-021-combined-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, mode: "offline_counterfactual_not_fresh_live",
      changedHeadPixels: changed, beardPixels, bodyDiff: 0, alphaDiff: 0, maskAndOwnershipDiff: 0,
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"), craft,
      facialHair: style.facialHair, goateeHasMustache: style.goateeHasMustache ?? false,
      scalpMaterial: plan.hairPlan.surfaceMaterial, tan: plan.outfitPlan.upper.pattern.color,
      limitation: "No missing mustache/sleeve/localization evidence fabricated; only accepted goatee and canonical scalp evidence connected." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`COMBINED_021_OFFLINE ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
