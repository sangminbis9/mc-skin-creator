import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { observedFacialHairCategory, observedGoateeMustache } from "../src/facialHairEvidence";
import { makeAnalysis } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-027";
const bytes = readFileSync(`${root}/summary.json`), live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const p = live.diagnostics.normalizedPrimary;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-027-live-verification-20260928-9H1CYc/verification.json", "utf8"));
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
it.each([p.observed.face, "Dark goatee and a shaved head", "A shaved scalp, dark goatee", "Dark goatee; shaved crown."])(
  "separates a bounded scalp-only shaving clause from corroborated facial anatomy: %s", observed => {
    expect(observedFacialHairCategory("none", observed, ["Dark goatee"], true)).toBe("goatee");
  });
it.each(["Goatee and a shaved head and face", "Goatee and a shaved head and chin", "Goatee and a shaved face",
  "Shaved goatee and a shaved head", "No goatee and a shaved head", "Possibly a goatee and a shaved head",
  "Goatee-like shadow and a shaved head", "Goatee and shaved", "Goatee and a shaved head with no beard",
  "Goatee and a shaved head, clean-shaven face", "Goatee and a shaved head, no facial hair"])(
  "preserves unlocalized, mixed anatomy and facial negation: %s", observed => {
    expect(observedFacialHairCategory("none", observed, ["Dark goatee"], true)).toBeUndefined();
  });
it("does not invent corroboration, a mustache combination, visibility or override a category", () => {
  expect(observedFacialHairCategory("none", p.observed.face, ["Shaved head"], true)).toBeUndefined();
  expect(observedFacialHairCategory("none", p.observed.face, ["Goatee", "Clean-shaven face"], true)).toBeUndefined();
  expect(observedFacialHairCategory("none", p.observed.face, p.canonicalIdentity.mustPreserve, false)).toBeUndefined();
  expect(observedFacialHairCategory("beard", p.observed.face, p.canonicalIdentity.mustPreserve, true)).toBeUndefined();
  expect(observedGoateeMustache(p.observed.face, p.canonicalIdentity.mustPreserve, true, p.canonicalIdentity.features)).toBe(false);
});
it("retains the accepted goatee through strict normalization and isolates face/chin-seam atlas changes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(bytes)).toBe(baseline.summarySha256);
    const synthetic = makeAnalysis({ ...structuredClone(p), sourceSelection: makeAnalysis().sourceSelection,
      identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" });
    // A complete synthetic wire carrying accepted cue fields, not recovery of
    // omitted original source-selection or inferred free text.
    const normalized = normalizeCompactPhotoAnalysisV3(wireFixture(synthetic), { imageCount: 1 });
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw new Error("strict_normalization_failed");
    expect(normalized.analysis.fallbackFeatures.facialHair).toBe("goatee");
    const analysis = normalizeAnalysisForRendering(normalized.analysis), plan = live.analysis.skinPlan;
    const features = { ...live.features, facialHair: normalized.analysis.fallbackFeatures.facialHair };
    const validatedStyle = buildFaceStyle(analysis, features, plan.hairPlan);
    expect(validatedStyle.facialHair).toBe("goatee"); expect(validatedStyle.goateeHasMustache).not.toBe(true);
    const style = { ...baseline.style, facialHair: validatedStyle.facialHair };
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, plan)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(features, style, plan)!;
    // Existing reconcileBaseHorizontalSeams copies the chin edge onto the
    // physically adjacent head underside; this is not scalp or hair paint.
    const chinSeam = getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal[4];
    let changed = 0, changedChinSeam = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[i * 4 + c] !== before.rgba[i * 4 + c])) {
        const x = i % 64, y = Math.floor(i / 64);
        const seamIndex = chinSeam.adjacent.findIndex(p => p.x === x && p.y === y);
        if (seamIndex >= 0) {
          const p = chinSeam.primary[seamIndex], at = (p.y * 64 + p.x) * 4;
          expect(after.rgba.slice(i * 4, i * 4 + 4)).toEqual(after.rgba.slice(at, at + 4)); changedChinSeam++;
        } else {
          expect(y).toBeGreaterThanOrEqual(8); expect(y).toBeLessThan(16);
          expect(x).toBeGreaterThanOrEqual(8); expect(x).toBeLessThan(16); changed++;
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-027-facial-anatomy-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(bytes), changedFacePixels: changed, changedChinSeamPixels: changedChinSeam,
      bodyDiff: 0, alphaDiff: 0, hairDiff: 0, planDiff: 0, craft, facialHair: style.facialHair, goateeHasMustache: false,
      limitation: "Offline normalized category correction only. No new live result, no missing canonical mustache or hair pigment evidence fabricated." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`FACIAL_027_OFFLINE ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
