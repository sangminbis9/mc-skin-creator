/** Authored source-binding counterfactuals; no provider or live source labels. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildFaceStyle, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

function styleFor(raw: PhotoAnalysis) {
  const analysis = normalizeAnalysisForRendering(raw);
  const features = refineFeatureColorsFromAnalysis(analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  return buildFaceStyle(analysis, features, buildSkinPlan(analysis).hairPlan);
}

it.each(["mustard", "red", "blue", "black"])("keeps independent %s garment fields away from silver frames", color => {
  const raw = makeAnalysis();
  raw.canonicalIdentity.mustPreserve.push(`${color} knit`);
  raw.canonicalIdentity.features.push({ category: "outfit", feature: `${color} knit`,
    evidence: `${color} garment`, confidence: "high", priority: 5, targetRegions: ["torso.front"] });
  expect(styleFor(raw).glassesColor).toBe("#8c8c8c");
});

it.each(["black", "red", "blue", "gold"] as const)("retains directly observed %s frames and ignores contradictory canonical prose", color => {
  const raw = makeAnalysis(); raw.observed.accessories = `${color} glasses`;
  const expected = color === "gold" ? "#e3c14d" : fallbackFeaturesToHex({ ...raw.fallbackFeatures, glassesColor: color }).glassesColor;
  raw.canonicalIdentity.mustPreserve.unshift("green glasses");
  expect(styleFor(raw).glassesColor).toBe(expected);
});

it("keeps clause boundaries within an observed field", () => {
  const raw = makeAnalysis();
  raw.observed.accessories = "thin silver glasses; mustard knit; red shoes";
  expect(styleFor(raw).glassesColor).toBe("#8c8c8c");
});

it("changes only glasses-owned PNG pixels through actual mocked default generation", async () => {
  const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
  const root = mkdtempSync("evaluation-artifacts/reference-eyewear-color-20261009-");
  const historical = "evaluation-artifacts/reference-low-confidence-20261009-lxnvUQ/observed-short-straight.png";
  const historicalBytes = readFileSync(historical);
  expect(hash(historicalBytes)).toBe("df2c9031dc64e566b3c85eb8fa54b5f6c45e70e16ea5689e7f37f2faf4467e2a");
  const before = await decodePng(historicalBytes);
  const raw = makeAnalysis(), frozen = JSON.stringify(raw);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis").mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  // Offline binding doubles, never credentials or remote config.
  const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
  try {
    const image = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    const result = await generateSkin(env, image);
    expect(result.status).toBe(200); expect(result.body.ok).toBe(true);
    expect(result.body.analysis!.referenceStyle!.craftValidation).toBe("pass");
    expect(result.body.analysis!.referenceStyle!.constraints!.ok).toBe(true);
    const png = base64ToBytes(result.body.skinPngBase64!);
    const after = await decodePng(png), plan = result.body.analysis!.skinPlan!;
    expect(validateFinalAtlas(after).ok).toBe(true);
    expect([after.width, after.height]).toEqual([64, 64]);
    expect(plan).toEqual(buildSkinPlan(normalizeAnalysisForRendering(raw)));
    const glasses = plan.facePixelPlan.glassesPlan;
    const allowed = new Set([...glasses.framePixels, ...glasses.sideArms].map(p => {
      const rect = CLASSIC_LAYOUT.head.overlay[p.face];
      return (rect.y + p.y) * 64 + rect.x + p.x;
    }));
    const changed: number[] = [];
    for (let pixel = 0; pixel < 64 * 64; pixel++) {
      const i = pixel * 4;
      if (before.rgba.slice(i, i + 4).every((v, c) => v === after.rgba[i + c])) continue;
      changed.push(pixel); expect(allowed.has(pixel), `unexpected pixel ${pixel % 64},${Math.floor(pixel / 64)}`).toBe(true);
      expect(after.rgba[i + 3]).toBe(before.rgba[i + 3]);
    }
    expect(changed.length).toBeGreaterThan(0);
    expect((await generateSkin(env, image)).body.skinPngBase64).toBe(result.body.skinPngBase64);
    expect(JSON.stringify(raw)).toBe(frozen);
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    for (const [label, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${root}/${label}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${label}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    expect(readFileSync(historical)).toEqual(historicalBytes);
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "authored_fixture_mocked_default_generation",
      beforeEvidence: historical, beforePngSha256: hash(historicalBytes), afterPngSha256: hash(png),
      observedAccessory: raw.observed.accessories, finalStyleColor: styleFor(raw).glassesColor,
      changedPixels: changed.map(p => ({ x: p % 64, y: Math.floor(p / 64) })),
      onlyGlassesOwnedPixelsChanged: true, planUnchanged: true, craftPass: true, uvPass: true,
      deterministic: true, inputUnchanged: true, providerCalls: 0, networkCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_EYEWEAR_COLOR ${root}`);
  } finally { runPrimary.mockRestore(); network.mockRestore(); }
}, 60_000);

it.each(["medium", "high", "low"] as const)("uses only reliable canonical accessory colour when direct observation is absent: %s", confidence => {
  const raw = makeAnalysis();
  raw.observed.accessories = ""; raw.observed.face = "round face";
  raw.identityPrompt = "round face";
  raw.canonicalIdentity.overallImpression = "round face";
  raw.canonicalIdentity.mustPreserve = [];
  raw.canonicalIdentity.features = [{ category: "accessory", feature: "blue glasses",
    evidence: "authored confidence counterfactual", confidence, priority: 5, targetRegions: ["head.front"] }];
  const expected = confidence === "low" ? "gray" : "blue";
  expect(styleFor(raw).glassesColor).toBe(fallbackFeaturesToHex({ ...raw.fallbackFeatures, glassesColor: expected }).glassesColor);
});

it("does not introduce glasses or alter unrelated style when eyewear is absent", () => {
  const raw = makeAnalysis();
  raw.observed.accessories = "none"; raw.identityPrompt = "round face";
  raw.canonicalIdentity.overallImpression = "round face";
  raw.canonicalIdentity.mustPreserve = ["mustard knit"];
  raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "accessory");
  raw.fallbackFeatures.glasses = "none";
  expect(styleFor(raw).glasses).toBe("none");
});

it("does not bind a separate canonical garment color to observed silver glasses", () => {
  const raw = makeAnalysis(), analysis = normalizeAnalysisForRendering(raw);
  const before = JSON.stringify(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, buildSkinPlan(analysis).hairPlan);
  console.info("EYEWEAR_COLOR_BOUNDARY", JSON.stringify({
    observedAccessories: analysis.observed.accessories,
    normalizedCacheColor: analysis.fallbackFeatures.glassesColor,
    injectedFeatureColor: features.glassesColor,
    finalStyleColor: style.glassesColor,
    inputUnchanged: JSON.stringify(analysis) === before,
  }));
  expect(style.glassesColor).toBe(features.glassesColor);
  expect(JSON.stringify(analysis)).toBe(before);
});
