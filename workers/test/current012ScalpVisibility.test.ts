import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-012";
const bytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function input(hair = primary.observed.hair) {
  const a = makeAnalysis({ ...structuredClone(primary), identityPrompt: hair,
    outfitPrompt: primary.observed.clothing, negativePrompt: "" });
  a.observed.hair = hair;
  return normalizeAnalysisForRendering(a);
}

it.each([primary.observed.hair,
  "Very short dark hair, nearly shaved, with visible scalp.",
  "Closely cropped hair with scalp visible through the stubble.",
  "Almost shaved blond hair, scalp visible through the short stubble.",
])("retains directly observed skin visibility under shaved hair: %s", hair => {
  const a = input(hair);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  const plan = buildSkinPlan(a);
  expect(plan.hairPlan.surfaceMaterial).toBe("scalp_shadow");
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
});

it.each([
  "Very short black hair.",
  "Closely cropped dark hair covering the scalp.",
  "Nearly shaved dark hair.",
  "Visible scalp.",
  "Short hair with a scalp-visible part.",
  "Nearly shaved hair with no visible scalp.",
  "Possibly nearly shaved hair with visible scalp.",
  "Nearly shaved hair, with scalp hidden by a hat.",
  "Nearly shaved hair with visible scalp and a receding hairline.",
  "Nearly shaved hair with visible scalp through thinning patches.",
  "Nearly shaved sides with visible scalp beneath long crown hair.",
  "Nearly shaved beard, visible scalp elsewhere.",
  "Nearly shaved facial hair; visible scalp elsewhere.",
  "Nearly shaved hair with visible scalp below long locks.",
  "Nearly shaved hair with visible scalp and a bun.",
  "Nearly shaved hair with visible scalp, bare crown.",
  "Nearly shaved hair with visible scalp, not enough resolution.",
])("does not infer translucent scalp material from insufficient/confounded evidence: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(false);
});

it.each(["hidden", "geometry", "covering", "volume", "fringe", "canonicalBare", "canonicalThinning", "inferredOnly"])("preserves %s boundary", mode => {
  const a = input();
  if (mode === "hidden") a.visibleRegions.hair = false;
  if (mode === "geometry") a.identityGeometry = makeIdentityGeometry();
  if (mode === "covering") a.fallbackFeatures.hat = "headscarf";
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "canonicalBare") a.canonicalIdentity.mustPreserve.push("bare crown");
  if (mode === "canonicalThinning") a.canonicalIdentity.mustPreserve.push("thinning crown hair");
  if (mode === "inferredOnly") {
    a.observed.hair = "Short dark hair";
    a.inferred.hairBack = { value: primary.observed.hair, rationale: "Unseen rear completion" };
  }
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});

it("changes only the existing scalp material from an exact live PNG baseline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = input(), built = buildSkinPlan(a);
    const beforePlan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const recovered = resolveHeadOwnership(a, beforePlan.hairPlan, beforePlan.facePixelPlan);
    expect(recovered.cells.slice(0, 512)).toEqual(beforePlan.headIdentityPlan.ownership!.cells);
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
    const output = mkdtempSync("evaluation-artifacts/current-012-scalp-visibility-20260927-");
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
