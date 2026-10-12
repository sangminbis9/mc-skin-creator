import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { historicalHairMaterialPlan } from "./historicalHairMaterial";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009";
const baselineRoot = "evaluation-artifacts/sclera-role-regression-20260927-W98dzl";

it("retains the current source's coordinated tan pattern without a nearest-yellow promotion", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const savedBytes = readFileSync(`${liveRoot}/summary.json`), pngBytes = readFileSync(`${liveRoot}/skin.png`);
    const live = JSON.parse(savedBytes.toString()).currentDefaultE2E, result = live.result;
    expect(sha(pngBytes)).toBe(live.png.sha256);
    const primary = result.diagnostics.normalizedPrimary;
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary,
      identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing, negativePrompt: "",
      faceIdentityGeometry: result.diagnostics.geometry.acceptedGeometry }));
    // Preserve this earlier single-band palette comparison independently of
    // the later foundation-material migration; retain its original hashes.
    const plan = historicalHairMaterialPlan(buildSkinPlan(analysis));
    // This immutable -009 experiment isolates the earlier single pattern-color
    // slot. Later observed two-band propagation is covered independently by
    // plaidPatternRetention, not silently attributed to this historical fix.
    const laterCrossedBandColors = plan.outfitPlan.upper.pattern.crossedBandColors;
    expect(laterCrossedBandColors).toEqual(["#c5aa82", "#d5af3f"]);
    delete plan.outfitPlan.upper.pattern.crossedBandColors;
    const beforePlan = structuredClone(plan);
    const actualPattern = result.analysis.skinPlan.outfitPlan.upper.pattern;
    expect(actualPattern.color).toBe("#d5af3f");
    expect(plan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    beforePlan.outfitPlan.upper.pattern.color = actualPattern.color;
    expect(beforePlan.outfitPlan.upper).toEqual(result.analysis.skinPlan.outfitPlan.upper);
    const frozen = JSON.parse(readFileSync(`${baselineRoot}/results.json`, "utf8")).cases.find((c: { id: string }) => c.id === "live-009-replay");
    expect(sha(JSON.stringify(beforePlan))).toBe(frozen.planHash);
    const style = buildFaceStyle(analysis, result.features, plan.hairPlan);
    const before = buildProceduralFallbackAtlas(result.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(result.features, style, plan)!;
    expect(before).not.toBeNull(); expect(after).not.toBeNull();
    expect(sha(before.rgba)).toBe(frozen.rgbaHash);
    expect(before.rgba).toEqual((await decodePng(readFileSync(`${baselineRoot}/live-009-replay.png`))).rgba);
    const upperRects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    const changed = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(upperRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changed.push({ x, y });
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    const beforeCraft = validateAtlasCraft(before, style, beforePlan.facePixelPlan, beforePlan.hairPlan, beforePlan);
    const afterCraft = validateAtlasCraft(after, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(beforeCraft.ok).toBe(true); expect(afterCraft.ok).toBe(true);
    expect(validateFinalAtlas(after).ok).toBe(true);
    const root = mkdtempSync("evaluation-artifacts/current-009-pattern-palette-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "back"].includes(v.name)))
        writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, source: primary.observed.clothing,
      liveSummaryHash: sha(savedBytes), livePngHash: sha(pngBytes), baselineRoot,
      beforePattern: actualPattern, afterPattern: plan.outfitPlan.upper.pattern,
      scope: "historical_single_band_ablation", laterCrossedBandColorsExcluded: laterCrossedBandColors,
      beforePlanHash: frozen.planHash, afterPlanHash: sha(JSON.stringify(plan)), changed,
      headHairFaceLowerGarmentAndAlphaUnchanged: true, beforeCraft, afterCraft,
      limitation: "Fixed-context offline replay; not new provider output. One pattern-color slot selects the first non-material coordinated color, as in the existing postposed list grammar. Minor yellow thread is not separately represented." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(savedBytes);
    expect(readFileSync(`${liveRoot}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`PATTERN_PALETTE_ROOT ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
