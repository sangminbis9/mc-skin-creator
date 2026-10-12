/** Authored confidence counterfactuals; no provider observation or photo labels. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import type { PhotoAnalysis } from "../src/analysis";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { generateSkin, normalizeAnalysisForRendering } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { observedTiedHair, quantizeTiedMassGeometry } from "../src/headOwnership";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";

const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function claim(confidence: "low" | "medium" | "high", category: "hair" | "outfit" = "hair") {
  const a = makeAnalysis();
  a.canonicalIdentity.features.push({ category, feature: "large high left bun", confidence,
    evidence: "authored confidence counterfactual", priority: 5, targetRegions: ["head.back"] });
  return a;
}

it("does not promote a speculative bun over observed short hair", () => {
  const a = claim("low"), before = JSON.stringify(a);
  expect(observedTiedHair(a)).toBe(false);
  expect(quantizeTiedMassGeometry(a)).toEqual(quantizeTiedMassGeometry(makeAnalysis()));
  expect(buildSkinPlan(normalizeAnalysisForRendering(a)).headIdentityPlan.ownership)
    .toEqual(buildSkinPlan(normalizeAnalysisForRendering(makeAnalysis())).headIdentityPlan.ownership);
  expect(JSON.stringify(a)).toBe(before);
});

it.each(["medium", "high"] as const)("retains %s-confidence tied construction", confidence => {
  expect(observedTiedHair(claim(confidence))).toBe(true);
  expect(quantizeTiedMassGeometry(claim(confidence))).toMatchObject({ position: "high_back", horizontalBias: "left", massWidth: 6 });
});

it("retains direct observed hair but not an unrelated garment claim", () => {
  const a = claim("low"); a.observed.hair = "large high left bun";
  expect(observedTiedHair(a)).toBe(true);
  expect(quantizeTiedMassGeometry(a)).toMatchObject({ position: "high_back", horizontalBias: "left", massWidth: 6 });
  expect(observedTiedHair(claim("high", "outfit"))).toBe(false);
  const ordinary = makeAnalysis(); ordinary.observed.hair = "hair tied in a bun";
  const weakModifier = claim("low"); weakModifier.observed.hair = ordinary.observed.hair;
  expect(quantizeTiedMassGeometry(weakModifier)).toEqual(quantizeTiedMassGeometry(ordinary));
});

it("checks speculative tied mass through mocked default PNG generation", async () => {
  const root = mkdtempSync("evaluation-artifacts/reference-tied-confidence-20261009-");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
  const rows: Array<{ id: string; pngHash: string; tiedObserved: boolean; craft: unknown }> = [];
  const direct = claim("low"); direct.observed.hair = "large high left bun";
  const cases: Array<[string, PhotoAnalysis]> = [["baseline", makeAnalysis()], ["weak-bun", claim("low")],
    ["medium-bun", claim("medium")], ["high-bun", claim("high")], ["direct-bun", direct]];
  try {
    const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    for (const [id, raw] of cases) {
      const before = JSON.stringify(raw);
      runPrimary.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
      const result = await generateSkin(env, input);
      expect(result.status).toBe(200);
      const png = base64ToBytes(result.body.skinPngBase64!), atlas = await decodePng(png);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      expect(result.body.analysis?.referenceStyle?.craftValidation).toBe("pass");
      expect((await generateSkin(env, input)).body.skinPngBase64).toBe(result.body.skinPngBase64);
      expect(JSON.stringify(raw)).toBe(before);
      writeFileSync(`${root}/${id}.png`, png, { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${id}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      rows.push({ id, pngHash: hash(png), tiedObserved: observedTiedHair(raw), craft: result.body.analysis?.referenceStyle?.craftValidation });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "authored_mocked_primary", providerCalls: 0, rows }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_TIED_CONFIDENCE ${root}`);
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    expect(rows[1].pngHash).toBe(rows[0].pngHash);
    for (const row of rows.slice(2)) {
      expect(row.tiedObserved).toBe(true);
      expect(row.pngHash).not.toBe(rows[0].pngHash);
    }
  } finally { runPrimary.mockRestore(); network.mockRestore(); }
}, 60_000);
