/** Source-bound tie pattern counterfactuals; no provider calls or photo labels. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildFaceStyle, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { validateFinalAtlas } from "../src/skinPost";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function fixture(tie: string) {
  const raw = makeAnalysis();
  raw.observed.clothing = `A white collared dress shirt under a black suit jacket with ${tie}.`;
  raw.outfitPrompt = raw.observed.clothing;
  raw.renderHints.outerGarment = "open_jacket";
  raw.renderHints.neckAccessory = "tie";
  raw.fallbackFeatures.topType = "jacket";
  return normalizeAnalysisForRendering(raw);
}
function render(tie: string) {
  const analysis = fixture(tie), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan);
  const atlas = makeSyntheticAtlas(64);
  if (typeof features.skinTone !== "string") throw new Error("fixture_skin_tone_missing");
  applyOutfitPlan(atlas, plan.outfitPlan, features.skinTone);
  return { analysis, plan, style, atlas };
}

it("preserves observed striped topology independently of an unspecified stripe hue", async () => {
  const root = mkdtempSync("evaluation-artifacts/formal-tie-pattern-20261009-");
  const plain = render("a plain dark necktie"), striped = render("a dark striped necktie");
  const rows = [];
  for (const [id, value] of [["plain", plain], ["striped", striped]] as const) {
    writeFileSync(`${root}/${id}.png`, await encodePng(value.atlas), { flag: "wx" });
    const front = renderSkinViews(value.atlas).find(v => v.name === "front")!.image;
    writeFileSync(`${root}/${id}-front.png`, await encodePng(scaleNearestNeighbor(front, front.width * 4, front.height * 4)), { flag: "wx" });
    rows.push({ id, observed: value.analysis.observed.clothing, stylePattern: value.style.neckAccessoryPattern,
      formalSuit: value.plan.outfitPlan.formalSuit, tie: value.plan.outfitPlan.accessories.find(a => a.kind === "tie"),
      atlasSha256: hash(value.atlas.rgba) });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "authored_offline_pattern_counterfactual", providerCalls: 0, rows }, null, 2), { flag: "wx" });
  console.info(`FORMAL_TIE_PATTERN ${root}`);
  expect(striped.style.neckAccessoryPattern).toBe("striped");
  expect(striped.plan.outfitPlan.formalSuit?.tieAccent).toBeNull();
  expect(striped.plan.outfitPlan.formalSuit?.tiePattern).toBe("striped");
  expect(striped.atlas.rgba).not.toEqual(plain.atlas.rgba);
});

it.each(["a dark striped necktie", "a striped navy tie", "a black tie with diagonal stripes",
  "a dark charcoal necktie featuring thin, light-colored diagonal stripes",
  "a navy tie with fine, narrow, diagonal stripes"])(
  "preserves explicit tie topology without naming a trim color: %s", tie => {
    const analysis = fixture(tie), before = JSON.stringify(analysis);
    expect(buildSkinPlan(analysis).outfitPlan.formalSuit).toMatchObject({ tiePattern: "striped", tieAccent: null });
    expect(render(tie).style.neckAccessoryPattern).toBe("striped");
    expect(JSON.stringify(analysis)).toBe(before);
  });

it.each([
  "a plain dark tie", "a dark tie", "a dark tie without stripes", "a possibly striped tie",
  "a dark tie and striped trousers", "a dark tie, striped socks", "a hidden striped tie",
  "a dark tie with striped socks", "a dark tie with stripes on socks",
  "a dark tie featuring thin, possibly diagonal stripes",
])("does not invent tie stripes from absent/uncertain/other-garment evidence: %s", tie => {
  expect(buildSkinPlan(fixture(tie)).outfitPlan.formalSuit?.tiePattern).toBeUndefined();
  expect(render(tie).style.neckAccessoryPattern).toBe("plain");
});

it("ignores an observed shirt pattern, unseen clothing, and unrelated low-confidence prose", () => {
  const raw = fixture("a dark tie");
  raw.observed.clothing = "A striped white shirt under a black suit jacket with a dark tie.";
  raw.canonicalIdentity.features.push({ category: "outfit", feature: "striped tie", evidence: "uncertain detail",
    confidence: "low", priority: 5, targetRegions: ["torso.front"] });
  expect(buildSkinPlan(raw).outfitPlan.formalSuit?.tiePattern).toBeUndefined();
  const hidden = fixture("a dark striped tie"); hidden.visibleRegions.upperBody = false;
  expect(buildSkinPlan(hidden).outfitPlan.formalSuit).toBeUndefined();
});

it.each(["white", "silver", "gold"])("retains named %s accent evidence under narrow-tie shading", color => {
  const { plan, atlas } = render(`a dark tie with ${color} diagonal stripes`);
  expect(plan.outfitPlan.formalSuit?.tiePattern).toBe("striped");
  expect(plan.outfitPlan.formalSuit?.tieAccent).not.toBeNull();
  const legacy = structuredClone(plan.outfitPlan);
  delete legacy.formalSuit!.tiePattern;
  const expected = makeSyntheticAtlas(64);
  applyOutfitPlan(expected, legacy, "#e8b98f");
  // Skin is not visible in the tie region; compare the whole outer torso.
  const r = CLASSIC_LAYOUT.body.overlay.front;
  const stripe = ((r.y + 2) * 64 + r.x + 3) * 4;
  expect(Math.max(...atlas.rgba.slice(stripe, stripe + 3))).toBeLessThan(130);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const i = ((r.y + y) * 64 + r.x + x) * 4;
    expect(atlas.rgba.slice(i, i + 4)).toEqual(expected.rgba.slice(i, i + 4));
  }
});

it("delivers stripes through mocked default generation on the connected tie footprint only", async () => {
  const root = mkdtempSync("evaluation-artifacts/formal-tie-default-20261009-");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  // Local test doubles; no credentials or live Workers runtime.
  const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
  const rows = [];
  const images: Awaited<ReturnType<typeof decodePng>>[] = [];
  try {
    const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    for (const [id, tie] of [["plain", "a plain dark necktie"], ["striped", "a dark striped necktie"]] as const) {
      const raw = fixture(tie), frozen = JSON.stringify(raw);
      runPrimary.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
      const result = await generateSkin(env, input);
      expect(result.status).toBe(200); expect(result.body.ok).toBe(true);
      expect(result.body.analysis!.referenceStyle!.craftValidation).toBe("pass");
      expect(result.body.analysis!.referenceStyle!.constraints!.ok).toBe(true);
      const png = base64ToBytes(result.body.skinPngBase64!), atlas = await decodePng(png);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      expect(result.body.analysis!.skinPlan!.outfitPlan.formalSuit?.tieAccent).toBeNull();
      expect((await generateSkin(env, input)).body.skinPngBase64).toBe(result.body.skinPngBase64);
      expect(JSON.stringify(raw)).toBe(frozen);
      writeFileSync(`${root}/${id}.png`, png, { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${id}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      rows.push({ id, pngSha256: hash(png), formalSuit: result.body.analysis!.skinPlan!.outfitPlan.formalSuit,
        craftPass: true, uvPass: true, deterministic: true, inputUnchanged: true });
      images.push(atlas);
    }
    const changed: number[] = [];
    for (let p = 0; p < 4096; p++) if (!images[0].rgba.slice(p * 4, p * 4 + 4).every((v, c) => v === images[1].rgba[p * 4 + c])) changed.push(p);
    const r = CLASSIC_LAYOUT.body.overlay.front;
    expect(changed).toEqual([[3, 2], [4, 3]].map(([x, y]) => (r.y + y) * 64 + r.x + x));
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ primary: "mocked_authored_fixture", providerCalls: 0,
      networkCalls: 0, changedPixels: changed, onlyTieOwnedPixelsChanged: true, rows }, null, 2), { flag: "wx" });
    console.info(`FORMAL_TIE_DEFAULT ${root}`);
  } finally { runPrimary.mockRestore(); network.mockRestore(); }
}, 60_000);
