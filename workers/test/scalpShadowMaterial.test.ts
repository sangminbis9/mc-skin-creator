import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import type { SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { encodePng, decodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-011-scalp-shadow-20260927-5iK9tO";
const priorBytes = readFileSync(`${root}/results.json`), prior = JSON.parse(priorBytes.toString());
const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-011/summary.json", "utf8")).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it.each(["#633a23", "#a96d4c", "#e9bd99"])("scalp pigment follows complexion %s, preserving ordinary buzz and protected pixels", async skinTone => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...primary, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry }));
    const beforePlan = structuredClone(prior.afterPlan) as SkinPlan;
    expect(beforePlan.hairPlan.surfaceOnly).toBe(true);
    expect(beforePlan.hairPlan.surfaceMaterial).toBeUndefined();
    const afterPlan = structuredClone(beforePlan);
    afterPlan.hairPlan.surfaceMaterial = "scalp_shadow";
    const features = { ...live.features, skinTone };
    const style = buildFaceStyle(a, features, beforePlan.hairPlan);
    expect(buildFaceStyle(a, features, afterPlan.hairPlan)).toEqual(style);
    const before = buildProceduralFallbackAtlas(features, style, beforePlan)!;
    const after = buildProceduralFallbackAtlas(features, style, afterPlan)!;
    expect(before).not.toBeNull(); expect(after).not.toBeNull();
    const skin = [1, 3, 5].map(i => parseInt(skinTone.slice(i, i + 2), 16));
    const hair = [1, 3, 5].map(i => parseInt(features.hairColor.slice(i, i + 2), 16));
    const expectedTop = skin.map((v, i) => Math.round(v * 0.65 + hair[i] * 0.35));
    const top = (0 * 64 + 8 + 3) * 4;
    expect(Array.from(after.rgba.slice(top, top + 3))).toEqual(expectedTop);
    const distance = (at: Uint8Array) => skin.reduce((sum, v, i) => sum + Math.abs(v - at[i]), 0);
    expect(distance(after.rgba.slice(top, top + 3))).toBeLessThan(distance(before.rgba.slice(top, top + 3)));
    const changes = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(y).toBeLessThan(16);
        if (after.rgba[p * 4 + 3]) expect(x).toBeLessThan(32);
        changes.push({ x, y });
      }
    }
    expect(changes.length).toBeGreaterThan(0);
    for (const p of beforePlan.facePixelPlan.pixels) {
      const i = ((8 + p.y) * 64 + 8 + p.x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    for (let y = 12; y < 16; y++) for (let x = 8; x < 16; x++) {
      const i = (y * 64 + x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    if (skinTone === live.features.skinTone) {
      // Absence of the new material tag preserves the prior opaque-buzz output.
      expect(before.rgba).toEqual((await decodePng(readFileSync(`${root}/after.png`))).rgba);
      const output = mkdtempSync("evaluation-artifacts/current-011-scalp-material-20260927-");
      for (const [name, atlas] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
          writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      }
      writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, priorRoot: root, priorHash: sha(priorBytes),
        afterRgbaHash: sha(after.rgba), changes, expectedTop, craft, alphaDiff: 0, faceFeatureDiff: 0, bodyDiff: 0,
        limitation: "Offline material-only ablation, not new provider output or calibrated physical hair density." }, null, 2), { flag: "wx" });
      console.info(`SCALP_MATERIAL_ARTIFACT ${output}`);
    }
    expect(readFileSync(`${root}/results.json`)).toEqual(priorBytes); expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 30_000);
