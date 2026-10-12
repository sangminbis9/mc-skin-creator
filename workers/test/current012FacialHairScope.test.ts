import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { observedFacialHairCategory } from "../src/facialHairEvidence";
import { makeAnalysis } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-012";
const bytes = readFileSync(`${root}/summary.json`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers observed goatee with independent scalp stubble in actual 012 canonical evidence", () => {
  expect(observedFacialHairCategory(primary.fallbackFeatures.facialHair, primary.observed.face,
    primary.canonicalIdentity.mustPreserve, primary.visibleRegions.face)).toBe("goatee");
});
it.each(["Close-cropped hair/bald appearance with very short stubble", "Short scalp stubble",
  "Visible stubble on the crown", "No scalp stubble"])("ignores only separately localized scalp evidence: %s", scalp => {
  expect(observedFacialHairCategory("none", "A dark goatee", ["Defined dark goatee", scalp], true)).toBe("goatee");
});
it.each(["Short stubble", "Chin stubble", "Facial stubble and scalp stubble", "Cropped hair and cheek stubble",
  "Scalp stubble with no goatee", "Close-cropped hair, clean-shaven face",
  "Crown stubble and full beard"])("retains conflicting/ambiguous facial evidence: %s", conflict => {
  expect(observedFacialHairCategory("none", "A dark goatee", ["Defined dark goatee", conflict], true)).toBeUndefined();
});
it("does not let scalp evidence establish a facial category or override hidden/explicit cache", () => {
  expect(observedFacialHairCategory("none", "A dark goatee", ["Short scalp stubble"], true)).toBeUndefined();
  expect(observedFacialHairCategory("none", "No visible facial hair", ["Short scalp stubble"], true)).toBeUndefined();
  expect(observedFacialHairCategory("none", primary.observed.face, primary.canonicalIdentity.mustPreserve, false)).toBeUndefined();
  expect(observedFacialHairCategory("beard", primary.observed.face, primary.canonicalIdentity.mustPreserve, true)).toBeUndefined();
});

it("retains the category through strict normalization and a controlled renderer replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const input = makeAnalysis({ ...primary, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "",
      // Saved allowlist omits this free-text field. This is explicit synthetic
      // fixture context, not recovered provider localization or evidence.
      sourceSelection: { ...primary.sourceSelection, portraitEvidence: "Offline fixture context; no localization marker." } });
    const wire = wireFixture(input);
    // portraitRegion is normalized output, not a V3 provider-wire property.
    delete (wire.sourceSelection as Record<string, unknown>).portraitRegion;
    const normalized = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(normalized.ok, normalized.ok ? "" : JSON.stringify(normalized)).toBe(true); if (!normalized.ok) throw new Error("strict_failed");
    expect(normalized.analysis.fallbackFeatures.facialHair).toBe("goatee");
    const after = normalizeAnalysisForRendering(normalized.analysis);
    const before = structuredClone(after); before.fallbackFeatures.facialHair = "none";
    const beforePlan = buildSkinPlan(before), afterPlan = buildSkinPlan(after);
    expect(afterPlan.hairPlan).toEqual(beforePlan.hairPlan);
    expect(afterPlan.outfitPlan).toEqual(beforePlan.outfitPlan);
    expect(afterPlan.facePixelPlan.layout).toEqual(beforePlan.facePixelPlan.layout);
    const beforeStyle = buildFaceStyle(before, live.features, beforePlan.hairPlan);
    const afterStyle = buildFaceStyle(after, live.features, afterPlan.hairPlan);
    expect(beforeStyle.facialHair).toBe("none"); expect(afterStyle.facialHair).toBe("goatee");
    const oldAtlas = buildProceduralFallbackAtlas(live.features, beforeStyle, beforePlan)!;
    const newAtlas = buildProceduralFallbackAtlas(live.features, afterStyle, afterPlan)!;
    expect(oldAtlas).not.toBeNull(); expect(newAtlas).not.toBeNull();
    const changed = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => oldAtlas.rgba[p * 4 + c] !== newAtlas.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16);
      expect(newAtlas.rgba[p * 4 + 3]).toBe(oldAtlas.rgba[p * 4 + 3]);
      changed.push({ x: p % 64, y: Math.floor(p / 64) });
    }
    const landmarks = beforePlan.facePixelPlan.pixels.filter(p => /eye|brow|mouth/.test(p.cluster));
    for (const p of landmarks) {
      const at = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect(newAtlas.rgba.slice(at, at + 4)).toEqual(oldAtlas.rgba.slice(at, at + 4));
    }
    expect(changed.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(newAtlas, afterStyle, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(newAtlas).ok).toBe(true);
    // Combined replay preserves the stored hidden-outfit completion instead
    // of claiming that the helper's unsaved inferred pants/shoes are live data.
    const historicalPlan = structuredClone(beforePlan);
    historicalPlan.outfitPlan = structuredClone(live.analysis.skinPlan.outfitPlan);
    delete historicalPlan.hairPlan.surfaceMaterial; // post-live visible-scalp material correction
    const historicalReplay = buildProceduralFallbackAtlas(live.features, beforeStyle, historicalPlan)!;
    const livePngBytes = readFileSync(`${root}/skin.png`);
    const livePng = await decodePng(livePngBytes);
    expect(sha(historicalReplay.rgba)).toBe(sha(livePng.rgba));
    const hairWithoutMaterial = structuredClone(afterPlan.hairPlan); delete hairWithoutMaterial.surfaceMaterial;
    expect(hairWithoutMaterial).toEqual(live.analysis.skinPlan.hairPlan);
    const upperWithoutFix = structuredClone(afterPlan.outfitPlan.upper);
    upperWithoutFix.pattern.color = historicalPlan.outfitPlan.upper.pattern.color;
    expect(upperWithoutFix).toEqual(historicalPlan.outfitPlan.upper);
    const combinedPlan = structuredClone(afterPlan);
    combinedPlan.outfitPlan = { ...structuredClone(historicalPlan.outfitPlan), upper: afterPlan.outfitPlan.upper };
    const combinedAtlas = buildProceduralFallbackAtlas(live.features, afterStyle, combinedPlan)!;
    expect(validateAtlasCraft(combinedAtlas, afterStyle, undefined, undefined, combinedPlan).ok).toBe(true);
    expect(validateFinalAtlas(combinedAtlas).ok).toBe(true);
    const combinedChanges = [];
    for (let p = 0; p < 4096; p++) {
      expect(combinedAtlas.rgba[p * 4 + 3]).toBe(livePng.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => combinedAtlas.rgba[p * 4 + c] !== livePng.rgba[p * 4 + c]))
        combinedChanges.push({ x: p % 64, y: Math.floor(p / 64) });
    }
    const output = mkdtempSync("evaluation-artifacts/current-012-facial-scope-20260927-");
    for (const [label, atlas] of [["before", oldAtlas], ["after", newAtlas]] as const) {
      writeFileSync(`${output}/${label}.png`, await encodePng(atlas), { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${output}/${label}-front.png`, await encodePng(scaleNearestNeighbor(front.image, front.image.width * 4, front.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, liveSummaryHash: sha(bytes),
      observedFace: primary.observed.face, mustPreserve: primary.canonicalIdentity.mustPreserve,
      categoryBefore: "none", categoryAfter: "goatee", changed, craft, bodyDiff: 0,
      hairPlanEqual: true, outfitPlanEqual: true, layoutEqual: true, afterRgbaHash: sha(newAtlas.rgba),
      limitation: "Controlled category-only ablation; missing saved rich context uses explicit helper fields. Not exact live PNG reproduction." }, null, 2), { flag: "wx" });
    writeFileSync(`${output}/combined-results.json`, JSON.stringify({ providerCalls: 0,
      livePngSha256: sha(livePngBytes), historicalReplayExact: true, historicalReplayRgbaSha256: sha(historicalReplay.rgba),
      combinedRgbaSha256: sha(combinedAtlas.rgba), combinedChanges, alphaDiff: 0, hairGeometryUnchanged: true,
      scalpMaterial: afterPlan.hairPlan.surfaceMaterial,
      category: after.fallbackFeatures.facialHair, patternColor: afterPlan.outfitPlan.upper.pattern.color,
      craft, limitation: "Offline combined correction using actual stored hidden-outfit plan, not synthetic inferred lower-body completion. Exact baseline replay is not evidence of a fresh provider result." }, null, 2), { flag: "wx" });
    writeFileSync(`${output}/combined.png`, await encodePng(combinedAtlas), { flag: "wx" });
    for (const view of renderSkinViews(combinedAtlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/combined-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`FACIAL_SCOPE_ARTIFACT ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
