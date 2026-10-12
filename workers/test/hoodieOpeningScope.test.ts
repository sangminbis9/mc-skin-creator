import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { Env } from "../src/types";

function fixture(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = clothing;
  a.canonicalIdentity.features = a.canonicalIdentity.features.filter(f => f.category !== "outfit");
  a.canonicalIdentity.features.push({ category: "outfit", feature: clothing, evidence: clothing,
    priority: 5, confidence: "high", targetRegions: ["torso.front", "arm.left", "arm.right"] });
  a.canonicalIdentity.mustPreserve = ["short side-swept black fringe", "thin silver glasses", clothing]; a.canonicalIdentity.overallImpression = clothing;
  Object.assign(a.fallbackFeatures, { topType: "hoodie", topColor: "black", topAccentColor: "white" });
  Object.assign(a.renderHints, { outerGarment: "none", neckAccessory: "none", garmentTexture: "plain" });
  return a;
}

it.each(["Black pullover hoodie", "Pink hoodie", "Black hoodie without an undershirt"])("does not turn %s into a full contrasting inner panel", clothing => {
  const a = fixture(clothing), original = JSON.stringify(a);
  const p = buildOutfitPlan(a);
  expect(p.upper.garmentType).toBe("hoodie");
  expect(p.upper.neckline).toMatchObject({ kind: "hood_opening", innerVisible: false });
  expect(p.upper.colorBlocks.map(b => b.id)).toEqual(["upper_base"]);
  expect(p.outerLayer.regions).toContain("hood_rim");
  expect(JSON.stringify(a)).toBe(original);
});

it("keeps an observed inner collar local instead of widening it to the waist", () => {
  const p = buildOutfitPlan(fixture("Black pullover hoodie over a white shirt; inner shirt visible at neckline"));
  expect(p.upper.neckline).toMatchObject({ kind: "hood_opening", innerVisible: true });
  expect(p.upper.colorBlocks.map(b => b.id)).toEqual(["upper_base"]);
});

it.each(["Open-front black hoodie over a white tee", "Open black jacket over a white tee", "Brown cardigan over a white blouse"])("retains source-supported open construction: %s", clothing => {
  const p = buildOutfitPlan(fixture(clothing));
  expect(p.upper.colorBlocks.some(b => b.id === "inner_panel")).toBe(true);
});

it("delivers the bounded hood opening through the default PNG and saves a counterfactual comparison", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const run = vi.spyOn(primary, "runPhotoAnalysis");
  try {
    const root = mkdtempSync("evaluation-artifacts/hoodie-opening-scope-20261008-");
    const raw = fixture("Black pullover hoodie"), a = normalizeAnalysisForRendering(raw);
    const valid = primary.validatePhotoAnalysis(raw);
    expect(valid.ok, JSON.stringify(valid.errors)).toBe(true);
    const plan = buildSkinPlan(a), source = JSON.stringify(plan);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, colors, plan.hairPlan);
    const base = buildProceduralSourceAtlas(colors, style, plan)!;
    const design = buildReferenceStylePlan(a);
    const selected = selectReferenceStyleAtlas(base, plan, design, style).selected!;
    expect(selected).not.toBeNull(); expect(selected.quality.violations).toEqual([]);
    const legacy = structuredClone(plan);
    legacy.outfitPlan.upper.neckline.innerVisible = true;
    legacy.outfitPlan.upper.colorBlocks.push({ id: "inner_panel", region: "front_center",
      color: legacy.outfitPlan.upper.accentColor, source: "observed", priority: 0.95 });
    const oldBase = buildProceduralSourceAtlas(colors, style, legacy)!;
    const oldSelected = selectReferenceStyleAtlas(oldBase, legacy, design, style).selected!;
    expect(oldSelected).not.toBeNull();
    run.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
    const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
    const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
    const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    const result = await generateSkin(env, input);
    expect(result.status).toBe(200);
    const png = base64ToBytes(result.body.skinPngBase64!), decoded = await decodePng(png);
    expect(decoded.rgba).toEqual(selected.composition.atlas.rgba);
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    const torsoRects = [...Object.values(CLASSIC_LAYOUT.body.base), ...Object.values(CLASSIC_LAYOUT.body.overlay)];
    let changedPixels = 0;
    for (let p = 0; p < 4096; p++) {
      expect(decoded.rgba[p * 4 + 3]).toBe(oldSelected.composition.atlas.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => decoded.rgba[p * 4 + c] !== oldSelected.composition.atlas.rgba[p * 4 + c])) {
        changedPixels++;
        const x = p % 64, y = Math.floor(p / 64);
        expect(torsoRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      }
    }
    expect(changedPixels).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toBe(source);
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    writeFileSync(`${root}/final.png`, png, { flag: "wx" });
    for (const [name, atlas] of [["before", oldSelected.composition.atlas], ["after", decoded]] as const) {
      writeFileSync(`${root}/${name}-atlas.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 4, v.image.height * 4)), { flag: "wx" });
    }
    const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    writeFileSync(`${root}/summary.json`, JSON.stringify({ provenance: "authored_semantic_offline_counterfactual", providerCalls: 0,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_STRUCTURE_INVENTED", before: legacy.outfitPlan.upper,
      after: plan.outfitPlan.upper, pngSha256: hash(png), quality: selected.quality,
      defaultPngEqualsSelected: true, richInputValid: true, sourcePlanUnchanged: true,
      changedPixels, changesOnlyOnTorso: true, alphaUnchanged: true }, null, 2), { flag: "wx" });
    console.info(`HOODIE_OPENING_SCOPE ${root}`);
  } finally { run.mockRestore(); network.mockRestore(); }
}, 60000);
