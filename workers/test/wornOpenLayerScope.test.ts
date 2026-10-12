import { expect, it, vi } from "vitest";
import { buildOutfitPlan, preserveObservedCardiganSleeves } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";
import { readFileSync, writeFileSync } from "node:fs";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { verifyLegwearRedesign } from "./savedLegwearRendererEvidence";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { createHash } from "node:crypto";

function cardiganInput(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = "";
  a.visibleRegions.upperBody = true;
  a.fallbackFeatures.sleeveLength = "short";
  a.renderHints.outerGarment = "cardigan";
  return a;
}

it.each([
  "a cream colored open cardigan, white shirt with a collar",
  "a green knit cardigan worn open over a white short-sleeved shirt",
])("keeps the conventional cardigan sleeve default in the authoritative plan: %s", text => {
  const a = cardiganInput(text), original = JSON.stringify(a), p = buildOutfitPlan(a);
  expect(p.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "conservative" });
  expect(p.upper.rightSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "conservative" });
  expect(p.provenance.find(v => v.target === "upper.sleeves")).toMatchObject({ source: "conservative", confidence: 0.5 });
  expect(JSON.stringify(a)).toBe(original);
});

it.each([
  ["a short-sleeved cardigan", "short"], ["a sleeveless cardigan", "sleeveless"],
  ["a cardigan with rolled sleeves", "rolled"], ["a cardigan with elbow-length sleeves", "elbow"],
  ["a cardigan with left sleeve short and right sleeve long", "short"],
  ["maybe a cardigan", "short"], ["no cardigan", "short"], ["a hidden cardigan", "short"],
  ["a shirt with a graphic of a cardigan", "short"], ["a jacket over a cardigan", "short"],
  ["a cardigan. The sleeves are short", "short"],
] as const)("does not replace explicit, uncertain or unrelated sleeve evidence: %s", (text, length) => {
  expect(buildOutfitPlan(cardiganInput(text)).upper.leftSleeve.length).toBe(length);
});

it("does not recover a cardigan sleeve default from hidden or prompt-only clothing", () => {
  const a = cardiganInput("a cardigan"); a.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(a).upper.leftSleeve.length).toBe("short");
  a.visibleRegions.upperBody = true; a.observed.clothing = "a white shirt"; a.outfitPrompt = "a cardigan";
  expect(buildOutfitPlan(a).upper.leftSleeve.length).toBe("short");
});

function plan(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = clothing;
  a.fallbackFeatures.topAccentColor = "white";
  a.renderHints.outerGarment = "none";
  return buildOutfitPlan(a);
}

it.each([
  "a cream-colored knit cardigan worn open over a white collared shirt with a large pink fabric bow at the neck; a short pleated skirt with a brown and tan plaid pattern.",
  "A brown cardigan worn open over a white shirt.",
  "A green jacket is worn open over a white collared shirt.",
])("keeps the positively observed opening and inner shirt: %s", text => {
  expect(plan(text).upper.colorBlocks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "inner_panel", source: "observed" }),
    expect.objectContaining({ id: "opening", source: "observed" }),
  ]));
});

it.each([
  "A closed cardigan over a white shirt.",
  "A cardigan worn closed over a white shirt.",
  "A cardigan without an inner shirt.",
  "A cardigan possibly worn open.",
  "A cardigan with a graphic of a coat worn open.",
  "A plain white collared shirt.",
  "A plain black hoodie.",
])("keeps conservative or closed material without an invented inner panel: %s", text => {
  expect(plan(text).upper.colorBlocks.some(b => b.id === "inner_panel")).toBe(false);
});

it("restores the observed inner-shirt opening through G002's exact saved plan and PNG", async () => {
  const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-002";
  const bytes = readFileSync(`${root}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
  const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, { features } = t.injectedParameters;
  // Preserve the pre-scale footprint for this opening-only counterfactual.
  const faceStyle = { ...t.injectedParameters.faceStyle, hairAccessoryScale: "medium" as const };
  const historical = await decodePng(readFileSync(`${root}/skin.png`));
  const base = buildProceduralSourceAtlas(features, faceStyle, p)!;
  const actual = composeReferenceStyleAtlas(base, p, d, faceStyle).atlas;
  verifyLegwearRedesign(historical, actual, p.outfitPlan);
  // Resolve this stored construction in a synthetic field carrier. Only the
  // opening blocks are transferred; absent primary context is not rebuilt.
  const blocks = plan(t.primary.observed.clothing).upper.colorBlocks.filter(b => ["inner_panel", "opening"].includes(b.id));
  expect(blocks).toHaveLength(2);
  const fixed = { ...p, outfitPlan: { ...p.outfitPlan, upper: { ...p.outfitPlan.upper,
    colorBlocks: [...p.outfitPlan.upper.colorBlocks, ...blocks.map(b => ({ ...b, color: p.outfitPlan.upper.accentColor }))] } } };
  const afterBase = buildProceduralSourceAtlas(features, faceStyle, fixed)!;
  const after = composeReferenceStyleAtlas(afterBase, fixed, d, faceStyle);
  const front = CLASSIC_LAYOUT.body.base.front, permitted = new Set<number>();
  for (let y = 0; y < front.h; y++) for (let x = 0; x < front.w; x++) permitted.add((front.y + y) * 64 + front.x + x);
  let changed = 0;
  for (let i = 0; i < 4096; i++) {
    expect(after.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
    if ([0, 1, 2].some(ch => after.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
      expect(permitted.has(i), `outside torso front ${i}`).toBe(true); changed++;
    }
  }
  expect(changed).toBeGreaterThan(0);
  const panel = ((front.y + 7) * 64 + front.x + 3) * 4;
  expect([...after.atlas.rgba.slice(panel, panel + 3)]).toEqual([238, 234, 225]);
  expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
  expect(validateReferenceAtlasCraft(after.atlas, afterBase, fixed, faceStyle,
    buildReferenceCraftPlan(fixed, d, after)).ok).toBe(true);
  expect(composeReferenceStyleAtlas(afterBase, fixed, d, faceStyle).atlas.rgba).toEqual(after.atlas.rgba);
  const out = freshAuditOutput("evaluation-artifacts/worn-open-layer-replay-20261011-");
  for (const [label, atlas] of [["live-historical", historical], ["current-renderer-before", actual], ["offline-after", after.atlas]] as const) {
    writeFileSync(`${out}/${label}.png`, await encodePng(atlas), { flag: "wx" });
    const view = renderSkinViews(atlas).find(v => v.name === "front")!;
    writeFileSync(`${out}/${label}-front.png`, await encodePng(scaleNearestNeighbor(view.image,
      view.image.width * 4, view.image.height * 4)), { flag: "wx" });
  }
  writeFileSync(`${out}/verification.json`, JSON.stringify({ scope: "current_renderer_saved_plan_opening_blocks_only", historicalRendererByteEqualityRequired: false,
    changedTorsoFrontCells: changed, unrelatedCells: 0, alphaChanges: 0, craftValid: true,
    atlasValid: true, deterministic: true, providerCalls: 0, sourceObservedConstruction: t.primary.observed.clothing }, null, 2), { flag: "wx" });
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  console.info(`WORN_OPEN_REPLAY ${out}`);
}, 30000);

it("carries G003's existing cardigan sleeve policy into its saved executable atlas", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-003";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const original = JSON.stringify(t), saved = t.skinPlan.skinPlan;
    const { features, faceStyle } = t.injectedParameters;
    expect(faceStyle.sleeveLength).toBe("long");
    expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    // Isolate sleeve propagation from the separately verified ribbon-scale
    // change. Medium reproduces this consumed run's legacy bow footprint.
    const style = { ...faceStyle, hairAccessoryScale: "medium" as const };
    const historical = await decodePng(png), before = buildProceduralSourceAtlas(features, style, saved)!;
    const actual = composeReferenceStyleAtlas(before, saved, t.referenceStyle.design, style).atlas;
    verifyLegwearRedesign(historical, actual, saved.outfitPlan);
    const fixed = structuredClone(saved);
    // This boundary needs only persisted observed clothing/visibility. Never
    // reconstruct missing prompts or a full historical PhotoAnalysis.
    fixed.outfitPlan = preserveObservedCardiganSleeves(saved.outfitPlan, t.primary);
    expect(fixed.outfitPlan.upper.leftSleeve).toMatchObject({ length: "long", source: "conservative" });
    expect(fixed.outfitPlan.upper.rightSleeve).toMatchObject({ length: "long", source: "conservative" });
    const base = buildProceduralSourceAtlas(features, style, fixed)!;
    const after = composeReferenceStyleAtlas(base, fixed, t.referenceStyle.design, style);
    const arms = [CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm]
      .flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++;
      expect(arms.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
    expect(fixed.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
    expect(fixed.facePixelPlan).toEqual(saved.facePixelPlan); expect(fixed.hairPlan).toEqual(saved.hairPlan);
    expect(fixed.headIdentityPlan).toEqual(saved.headIdentityPlan);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, base, fixed, style,
      buildReferenceCraftPlan(fixed, t.referenceStyle.design, after)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(base, fixed, t.referenceStyle.design, style).atlas.rgba).toEqual(after.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/cardigan-sleeve-g003-offline-20261011-");
    for (const [name, atlas] of [["actual-live-before", historical], ["current-renderer-before", actual], ["offline-sleeves-after", after.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const v = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(v, v.width * 6, v.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/verification.json`, JSON.stringify({
      scope: "current_renderer_saved_plan_cardigan_sleeves_only_not_new_live", historicalRendererByteEqualityRequired: false, sourceSummarySha256: createHash("sha256").update(bytes).digest("hex"),
      earliestLoss: "PARAMETER_PRESERVED_PLAN_LOST", injectedSleeve: "long", priorPlanSleeve: "short", newPlanSleeve: "long",
      provenance: "conservative_construction_not_provider_measurement", changedArmCells: changed, unrelatedCells: 0,
      atlasValid: true, craftValid: true, deterministic: true, providerCalls: 0, freshLiveDeliveryVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(original); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info(`CARDIGAN_SLEEVE_G003 ${out}`);
  } finally { network.mockRestore(); }
}, 30000);
