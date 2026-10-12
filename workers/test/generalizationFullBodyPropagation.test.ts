import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const liveRoot = "evaluation-artifacts/generalization-v3-e2e-full-body-layered-20260928-001";
const live = JSON.parse(readFileSync(`${liveRoot}/summary.json`, "utf8")).currentDefaultE2E.result;
// The live diagnostic intentionally omits inferred/free-form fields. Fill the
// structural defaults only for this offline counterfactual; never call a model.
const source = normalizeAnalysisForRendering(makeAnalysis(structuredClone(live.diagnostics.normalizedPrimary)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("retains the observed inner tee and diagonal legwear without promoting boot chains", () => {
  const next = buildOutfitPlan(source);
  expect(next.upper.colorBlocks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "inner_panel", color: "#c96d32", source: "observed" }),
    expect.objectContaining({ id: "opening", color: "#c96d32", source: "observed" }),
  ]));
  expect(next.lower.legwear).toMatchObject({ kind: "stockings", pattern: "diagonal_stripe", source: "observed" });
  expect(next.accessories.some(item => item.kind === "necklace")).toBe(false);
});

it("requires visible, garment-scoped evidence and preserves a real necklace", () => {
  const hidden = structuredClone(source);
  hidden.visibleRegions.lowerBody = false;
  expect(buildOutfitPlan(hidden).lower.legwear.pattern).toBeUndefined();
  const shirtOnly = structuredClone(source);
  shirtOnly.observed.clothing = "Black jacket over an orange tee; striped shirt; plain black stockings; chain-detail boots.";
  shirtOnly.outfitPrompt = "";
  expect(buildOutfitPlan(shirtOnly).lower.legwear.pattern).toBeUndefined();
  expect(buildOutfitPlan(shirtOnly).accessories.some(item => item.kind === "necklace")).toBe(false);
  const closed = structuredClone(source);
  closed.observed.clothing = "Closed black jacket over an orange tee; plain black stockings.";
  closed.outfitPrompt = "";
  expect(buildOutfitPlan(closed).upper.colorBlocks.some(block => block.id === "inner_panel")).toBe(false);
  const necklace = structuredClone(source);
  necklace.observed.accessories = "Thin gold necklace.";
  expect(buildOutfitPlan(necklace).accessories.some(item => item.kind === "necklace")).toBe(true);
});

it("keeps the independent wavy open-blazer live result unchanged", async () => {
  const root = "evaluation-artifacts/generalization-v3-e2e-wavy-open-blazer-20260928-001";
  const result = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
  const analysis = normalizeAnalysisForRendering(makeAnalysis(structuredClone(result.diagnostics.normalizedPrimary)));
  const oldPlan = structuredClone(result.analysis.skinPlan);
  const newOutfit = buildOutfitPlan(analysis);
  expect(newOutfit.upper.colorBlocks).toEqual(oldPlan.outfitPlan.upper.colorBlocks);
  expect(newOutfit.accessories.map(item => [item.kind, item.color]))
    .toEqual(oldPlan.outfitPlan.accessories.map((item: { kind: string; color: string }) => [item.kind, item.color]));
  expect(newOutfit.lower.legwear.pattern).toBeUndefined();
  const style = buildFaceStyle(analysis, result.features, oldPlan.hairPlan);
  const actual = await decodePng(readFileSync(`${root}/skin.png`));
  expect(buildProceduralFallbackAtlas(result.features, style, oldPlan)!.rgba).toEqual(actual.rgba);
});

it("replays the stored live atlas exactly and confines corrected pixels to body UV", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const oldPlan = structuredClone(live.analysis.skinPlan);
    const style = buildFaceStyle(source, live.features, oldPlan.hairPlan);
    const before = await decodePng(readFileSync(`${liveRoot}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, style, oldPlan)!.rgba).toEqual(before.rgba);
    const newPlan = structuredClone(oldPlan);
    const correctedOutfit = buildOutfitPlan(source);
    // The sanitized diagnostic omits inferred prose; replay only the three
    // observed-cue fields, preserving every other stored live-plan decision.
    newPlan.outfitPlan.upper.colorBlocks = correctedOutfit.upper.colorBlocks;
    newPlan.outfitPlan.lower.legwear = correctedOutfit.lower.legwear;
    newPlan.outfitPlan.accessories = correctedOutfit.accessories;
    const after = buildProceduralFallbackAtlas(live.features, style, newPlan)!;
    const bodyRects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm,
      CLASSIC_LAYOUT.leftLeg, CLASSIC_LAYOUT.rightLeg].flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    let changed = 0, torso = 0, legs = 0, alphaChanged = 0;
    for (let p = 0; p < 4096; p++) {
      if ([0, 1, 2, 3].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(bodyRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
        if (after.rgba[p * 4 + 3] !== before.rgba[p * 4 + 3]) alphaChanged++;
        if (Object.values(CLASSIC_LAYOUT.body.base).some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) torso++;
        if ([CLASSIC_LAYOUT.leftLeg, CLASSIC_LAYOUT.rightLeg].some(box => Object.values(box.base)
          .some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h))) legs++;
        changed++;
      }
    }
    expect(torso).toBeGreaterThan(0);
    expect(legs).toBeGreaterThan(0);
    expect(validateFinalAtlas(after).ok).toBe(true);
    expect(validateAtlasCraft(after, style, undefined, undefined, newPlan).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/generalization-fullbody-propagation-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image,
        view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, exactStoredAtlasReplay: true,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba), changed, torso, legs,
      alphaChanged, headDiff: 0, craft: true, finalAtlas: true,
      limitation: "Targeted offline plan replay from sanitized primary (inferred prose omitted); not a new production live PNG." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
    console.info(`GENERALIZATION_FULLBODY ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
