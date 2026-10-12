import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-011";
const bytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hair = primary.observed.hair) {
  const a = makeAnalysis({ ...structuredClone(primary), identityPrompt: hair,
    outfitPrompt: primary.observed.clothing, negativePrompt: "",
    faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry });
  a.observed.hair = hair;
  return normalizeAnalysisForRendering(a);
}

it.each([primary.observed.hair, "Shaved scalp with visible hair shadow.",
  "Shaved scalp with visible hair shadow; no fringe.",
  "Shaved head with visible hair shadow, no bangs."])("retains explicit scalp pigment: %s", hair => {
  const a = input(hair);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  const plan = buildSkinPlan(a);
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.hairPlan.surfaceMaterial).toBe("scalp_shadow");
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  expect(plan.hairPlan.structure.groups.every(g => g.points.every(p => p.layer === "base"))).toBe(true);
  expect(a.fallbackFeatures.hairstyle).toBe("bald"); // provider category remains immutable
});
it.each(["Bald scalp.", "Bald head with no visible hair.", "Shaved scalp with visible lighting shadow.",
  "Shaved beard with visible hair shadow.", "Shaved sides with visible hair shadow.",
  "Possibly shaved scalp with visible hair shadow.", "Not shaved scalp with visible hair shadow.",
  "No shaved scalp with visible hair shadow.",
  "No evidence of shaved scalp with visible hair shadow.",
  "Shaved scalp with visible hair shadow, no bangs or hair shadow actually visible.",
  "Shaved scalp with visible hair shadow, no fringe and no scalp pigment.",
  "Shaved scalp without visible hair shadow.", "Shaved scalp with no visible hair shadow.",
  "Shaved scalp with visible hair shadow, crown clipped.",
  "Shaved scalp with visible hair shadow around a bare crown.",
  "Shaved scalp with visible hair shadow, receding hairline."])("rejects insufficient/confounded material evidence: %s", hair => {
  const a = input(hair);
  expect(observedShavedScalpHairShadow(a)).toBe(false);
  expect(buildSkinPlan(a).hairPlan.surfaceMaterial).toBeUndefined();
});
it.each(["hidden", "covering", "accessory", "volume", "length", "fringe", "sides", "fullGeometry", "bareCanonical"])("keeps %s guard", mode => {
  const a = input();
  if (mode === "hidden") a.visibleRegions.hair = false;
  if (mode === "covering") a.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") a.renderHints.hairAccessory = "bow";
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "length") a.renderHints.overallHairLength = "jaw";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "sides") a.renderHints.sideHairLength = "short";
  if (mode === "fullGeometry") a.identityGeometry = makeIdentityGeometry();
  if (mode === "bareCanonical") a.canonicalIdentity.mustPreserve.push("bare crown with no visible hair");
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});
it("isolates scalp pigment from actual 011 while preserving face, beard, body and historical bytes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = input(), built = buildSkinPlan(a), beforePlan = live.analysis.skinPlan as SkinPlan;
    expect(built.facePixelPlan).toEqual(beforePlan.facePixelPlan);
    const beforeStyle = buildFaceStyle(a, live.features, beforePlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, beforeStyle, beforePlan)!;
    expect(before.rgba).toEqual((await decodePng(pngBytes)).rgba);
    // Keep unsaved inferred outfit context pinned to the returned plan. Only
    // fully observed head material plans change in this controlled ablation.
    const afterPlan = structuredClone(beforePlan);
    afterPlan.hairPlan = built.hairPlan;
    afterPlan.headIdentityPlan = built.headIdentityPlan;
    const afterStyle = buildFaceStyle(a, live.features, afterPlan.hairPlan);
    const after = buildProceduralFallbackAtlas(live.features, afterStyle, afterPlan)!;
    expect(after).not.toBeNull();
    const changes = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
      const x = p % 64, y = Math.floor(p / 64);
      expect(y).toBeLessThan(16);
      // The former bald painter can leave raised side-hair pixels. Surface
      // material may remove those but must never add an outer hair pixel.
      if (x >= 32) expect(after.rgba[p * 4 + 3]).toBe(0);
      else expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      changes.push({ x, y, beforeAlpha: before.rgba[p * 4 + 3], afterAlpha: after.rgba[p * 4 + 3] });
    }
    for (const p of beforePlan.facePixelPlan.pixels) {
      const i = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    for (let y = 12; y < 16; y++) for (let x = 8; x < 16; x++) {
      const i = (y * 64 + x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    expect(changes.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, afterStyle, undefined, undefined, afterPlan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-011-scalp-shadow-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, liveSummaryHash: sha(bytes),
      livePngHash: sha(pngBytes), observation: primary.observed.hair, afterPlan,
      afterRgbaHash: sha(after.rgba), changes, craft, bodyDiff: 0, faceFeatureDiff: 0,
      limitation: "Offline head-material counterfactual with pinned stored outfit; not a fresh live response." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`SCALP_SHADOW_ARTIFACT ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
