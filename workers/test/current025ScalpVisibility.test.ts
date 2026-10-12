import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-025";
const summary = readFileSync(`${root}/summary.json`), live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-025-live-verification-20260928-KeAuKb/verification.json", "utf8"));
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hair = live.diagnostics.normalizedPrimary.observed.hair) {
  const p = live.diagnostics.normalizedPrimary;
  const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
  a.observed.hair = hair; return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.hair,
  "Very short closely cropped hair; scalp is mostly visible."])("recognizes explicit mostly-visible scalp without inventing density: %s", hair => {
  const a = input(hair), before = structuredClone(a);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  const p = buildIdentityPixelPlans(a);
  expect(p.hairPlan.surfaceOnly).toBe(true); expect(p.hairPlan.surfaceMaterial).toBe("scalp_shadow");
  expect(p.hairPlan.lengthClass).toBe("short"); expect(a).toEqual(before);
});
it.each(["Very short closely cropped hair; scalp mostly hidden.", "Very short closely cropped hair; scalp mostly not visible.",
  "Very short closely cropped hair; possibly scalp mostly visible.", "Very short closely cropped hair; scalp mostly visible through thinning.",
  "Very short closely cropped hair; scalp mostly visible on sides.", "Very short closely cropped hair; scalp mostly visible along the part.",
  "Very short closely cropped hair; scalp mostly visible, bare crown.", "Very short closely cropped beard; scalp mostly visible.",
  "Hair, scalp mostly visible.", "Very short closely cropped hair; scalp mostly visible under long braids."])("keeps confounded/unsupported visibility rejected: %s", hair => {
  expect(observedShavedScalpHairShadow(input(hair))).toBe(false);
});
it("isolates 025 scalp occupancy, preserves face/body/base alpha and removes only unclaimed hair-shell cells", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(summary)).toBe(baseline.summarySha256);
    const a = input(), before = structuredClone(live.analysis.skinPlan), parts = buildIdentityPixelPlans(a);
    expect(parts.facePixelPlan).toEqual(before.facePixelPlan);
    const after = structuredClone(before); after.hairPlan = parts.hairPlan; after.headIdentityPlan = parts.headIdentityPlan;
    expect(after.hairPlan.surfaceOnly).toBe(true); expect(after.hairPlan.surfaceMaterial).toBe("scalp_shadow");
    const oldAtlas = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, before)!.rgba).toEqual(oldAtlas.rgba);
    const style = buildFaceStyle(a, live.features, after.hairPlan), atlas = buildProceduralFallbackAtlas(live.features, style, after)!;
    expect(style.facialHair).toBe(baseline.style.facialHair);
    // Old bald/coily plan preserved the generic outer grammar. The existing
    // surface-only resolver instead clears unclaimed depth; that intended
    // shell removal is not a base/body transparency regression.
    expect(before.headIdentityPlan.ownership.execution).toBe("preserve_existing_grammar");
    expect(after.headIdentityPlan.ownership!.execution).toBe("resolved");
    let changed = 0, removedUnclaimedShellCells = 0;
    for (let p = 0; p < 4096; p++) {
      if (atlas.rgba[p * 4 + 3] !== oldAtlas.rgba[p * 4 + 3]) {
        const x = p % 64, y = Math.floor(p / 64);
        const cell = after.headIdentityPlan.ownership!.cells.find(c => {
          const r = CLASSIC_LAYOUT.head.overlay[c.face];
          return c.layer === "outer" && r.x + c.x === x && r.y + c.y === y;
        });
        expect(cell).toMatchObject({ owner: "clear", sourceGroupId: "unclaimed-depth" });
        expect(cell!.face).not.toBe("front");
        expect(oldAtlas.rgba[p * 4 + 3]).toBe(255); expect(atlas.rgba[p * 4 + 3]).toBe(0);
        removedUnclaimedShellCells++;
      }
      if ([0, 1, 2].some(c => atlas.rgba[p * 4 + c] !== oldAtlas.rgba[p * 4 + c])) { expect(Math.floor(p / 64)).toBeLessThan(16); changed++; }
    }
    for (const cell of before.facePixelPlan.pixels) {
      const i = ((8 + cell.y) * 64 + cell.x + 8) * 4; expect(atlas.rgba.slice(i, i + 4)).toEqual(oldAtlas.rgba.slice(i, i + 4));
    }
    expect(changed).toBeGreaterThan(0);
    expect(removedUnclaimedShellCells).toBe(24);
    const craft = validateAtlasCraft(atlas, style, undefined, undefined, after); expect(craft.ok).toBe(true); expect(validateFinalAtlas(atlas).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-025-scalp-visibility-offline-20260928-");
    for (const [name, image] of [["before", oldAtlas], ["after", atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(image), { flag: "wx" });
      const view = renderSkinViews(image).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), changedHeadPixels: changed,
      facePixelDiff: 0, bodyDiff: 0, baseAlphaDiff: 0, removedUnclaimedShellCells, surfaceOnly: true, material: "scalp_shadow", craft,
      limitation: "Offline counterfactual only; mostly-visible is explicit skin visibility, not a measured scalp density. Source, fallback cues, validation, face geometry and clothing unchanged." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`SCALP_025_OFFLINE ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
