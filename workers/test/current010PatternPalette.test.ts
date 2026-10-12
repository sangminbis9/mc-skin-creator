import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-010";
const beforeRoot = "evaluation-artifacts/current-010-scalp-close-20260927-Poi1zx";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers the observed tan paired-direction palette with exact fixed head/body context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const liveBytes = readFileSync(`${liveRoot}/summary.json`), pngBytes = readFileSync(`${liveRoot}/skin.png`);
    const baselineBytes = readFileSync(`${beforeRoot}/results.json`), beforePng = readFileSync(`${beforeRoot}/live-010-replay.png`);
    const state = JSON.parse(liveBytes.toString()).currentDefaultE2E, live = state.result;
    expect(sha(pngBytes)).toBe(state.png.sha256);
    const baseline = JSON.parse(baselineBytes.toString()).cases.find((c: { id: string }) => c.id === "live-010-replay");
    const primary = live.diagnostics.normalizedPrimary;
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary,
      identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const built = buildSkinPlan(analysis), beforePlan = baseline.plan as SkinPlan;
    expect(built.hairPlan).toEqual(beforePlan.hairPlan);
    expect(built.facePixelPlan).toEqual(beforePlan.facePixelPlan);
    expect(built.headIdentityPlan).toEqual(beforePlan.headIdentityPlan);
    expect(built.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    const oldPaletteUpper = structuredClone(built.outfitPlan.upper);
    oldPaletteUpper.pattern.color = beforePlan.outfitPlan.upper.pattern.color;
    expect(oldPaletteUpper).toEqual(beforePlan.outfitPlan.upper);
    // Preserve unsaved lower-body inference using the authoritative before plan,
    // replacing only the fully checked observed upper plan, not helper defaults.
    const afterPlan = structuredClone(beforePlan);
    afterPlan.outfitPlan.upper = built.outfitPlan.upper;
    const style = buildFaceStyle(analysis, live.features, afterPlan.hairPlan);
    const before = buildProceduralFallbackAtlas(live.features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(live.features, style, afterPlan)!;
    expect(before).not.toBeNull(); expect(after).not.toBeNull();
    expect(sha(before.rgba)).toBe(baseline.rgbaHash);
    expect(before.rgba).toEqual((await decodePng(beforePng)).rgba);
    const upperRects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    const changed = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(upperRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        changed.push({ x, y });
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    const beforeCraft = validateAtlasCraft(before, style, beforePlan.facePixelPlan, beforePlan.hairPlan, beforePlan);
    const afterCraft = validateAtlasCraft(after, style, afterPlan.facePixelPlan, afterPlan.hairPlan, afterPlan);
    expect(beforeCraft.ok).toBe(true); expect(afterCraft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-010-pattern-palette-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "back"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot,
      liveSummarySha256: sha(liveBytes), livePngSha256: sha(pngBytes), beforePlanHash: baseline.planHash,
      afterPlanHash: sha(JSON.stringify(afterPlan)), beforeRgbaHash: baseline.rgbaHash, afterRgbaHash: sha(after.rgba),
      sourceEvidence: primary.observed.clothing, beforeColor: beforePlan.outfitPlan.upper.pattern.color,
      afterColor: afterPlan.outfitPlan.upper.pattern.color, beforeCraft, afterCraft, changed,
      headFaceHairLowerBodyAndAlphaDiff: 0,
      limitation: "Same stored normalized allowlist and pinned lower-body context; offline counterfactual, not new production output or photo-sampled RGB." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(liveBytes);
    expect(readFileSync(`${liveRoot}/skin.png`)).toEqual(pngBytes);
    expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(baselineBytes);
    expect(readFileSync(`${beforeRoot}/live-010-replay.png`)).toEqual(beforePng);
    expect(network).not.toHaveBeenCalled(); console.info(`PAIRED_PALETTE_ROOT ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
