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
import { measureReferenceGarmentFoundation } from "../src/referenceOutfitRetention";
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
  a.canonicalIdentity.mustPreserve = ["short side-swept black fringe", "thin silver glasses", clothing];
  a.canonicalIdentity.overallImpression = clothing;
  a.visibleRegions.lowerBody = true;
  Object.assign(a.fallbackFeatures, { topType: "sweater", topColor: "black", topAccentColor: "red", bottomColor: "black", sleeveLength: "long" });
  Object.assign(a.renderHints, { garmentTexture: "plain", outerGarment: "none", neckAccessory: "none", bottomPattern: "plain" });
  return a;
}

it.each([
  ["Black sweater with red floral sleeves", ["rightArm", "leftArm"]],
  ["Black sweater with red floral print on viewer-left sleeve", ["rightArm"]],
  ["Black sweater with red rose graphics on viewer-left sleeve", ["rightArm"]],
  ["Black sweater with blue rose motifs on viewer-right sleeve", ["leftArm"]],
  ["Black sweater with red roses on left sleeve", ["leftArm"]],
  ["Black sweater with a rose on right sleeve", ["rightArm"]],
  ["Black sweater without rose embroidery on left sleeve", []],
  ["Black sweater with possibly red rose prints on left sleeve", []],
  ["Black sweater with hidden rose graphics on right sleeve", []],
  ["Black sweater without blue roses on left sleeve but with red rose graphics on chest", ["body"]],
  ["Black sweater with red floral print on viewer-right sleeve", ["leftArm"]],
  ["Black sweater with red floral print on left sleeve", ["leftArm"]],
  ["Black sweater with right sleeve covered in red flowers", ["rightArm"]],
  ["Black sweater with long sleeves and a floral chest motif", ["body"]],
  ["Black sweater with floral print on one sleeve", []],
  ["Black sweater without floral sleeves", []],
  ["Black sweater with possibly floral sleeves", []],
  ["Black sweater with floral print on back", []],
  ["Black sweater without floral sleeves but with floral chest motif", ["body"]],
])("preserves observed floral placement instead of cloning it: %s", (text, parts) => {
  const p = buildOutfitPlan(fixture(text as string));
  expect(p.upper.pattern.surfaceParts).toEqual(parts);
});

it.each(["floral print", "rose graphics"])("delivers asymmetric observed %s through the unchanged default generation PNG path", async motif => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const run = vi.spyOn(primary, "runPhotoAnalysis");
  try {
    const raw = fixture(`Black sweater with red ${motif} on viewer-left sleeve; black trousers with red ${motif} on viewer-left leg`);
    expect(primary.validatePhotoAnalysis(raw).ok).toBe(true);
    const a = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(a);
    const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, colors, plan.hairPlan), design = buildReferenceStylePlan(a);
    const base = buildProceduralSourceAtlas(colors, style, plan)!;
    const selected = selectReferenceStyleAtlas(base, plan, design, style).selected!;
    expect(selected).not.toBeNull();
    expect(selected.quality.violations).toEqual([]);
    run.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
    const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
    const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
    const result = await generateSkin(env, `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`);
    expect(result.status).toBe(200);
    const png = base64ToBytes(result.body.skinPngBase64!), decoded = await decodePng(png);
    expect(decoded.rgba).toEqual(selected.composition.atlas.rgba);
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    const motifs: Record<string, number> = {};
    for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      const r = CLASSIC_LAYOUT[part].base.front;
      motifs[part] = 0;
      for (let y = 2; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        // Independent chromatic check: red ink must not appear on the chest
        // or opposite limbs. Skin/black cloth are not this red garment ink.
        if (decoded.rgba[i] > decoded.rgba[i + 1] * 1.7 && decoded.rgba[i] > decoded.rgba[i + 2] * 1.7) motifs[part]++;
      }
    }
    expect(motifs).toEqual({ body: 0, rightArm: 5, leftArm: 0, rightLeg: 5, leftLeg: 0 });
    // Independent retention must reject newly invented paint on the other arm.
    const tampered = { ...decoded, rgba: decoded.rgba.slice() }, r = CLASSIC_LAYOUT.leftArm.base.front;
    tampered.rgba.set([220, 20, 20, 255], ((r.y + 4) * 64 + r.x + 2) * 4);
    expect(measureReferenceGarmentFoundation(tampered, plan.outfitPlan, style.skinTone!, design,
      selected.composition.diagnostic.bodyGroups, selected.composition.diagnostic.surfaces).valid).toBe(false);
    const legacy = structuredClone(plan);
    delete legacy.outfitPlan.upper.pattern.surfaceParts; delete legacy.outfitPlan.upper.pattern.motif;
    delete legacy.outfitPlan.lower.pattern.surfaceParts; delete legacy.outfitPlan.lower.pattern.motif;
    legacy.outfitPlan.lower.pattern.kind = "none";
    const before = selectReferenceStyleAtlas(buildProceduralSourceAtlas(colors, style, legacy)!, legacy, design, style).selected!;
    expect(before).not.toBeNull();
    const root = mkdtempSync("evaluation-artifacts/floral-placement-scope-20261008-");
    writeFileSync(`${root}/final.png`, png, { flag: "wx" });
    for (const [name, atlas] of [["before", before.composition.atlas], ["after", decoded]] as const) {
      writeFileSync(`${root}/${name}-atlas.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 4, v.image.height * 4)), { flag: "wx" });
    }
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    writeFileSync(`${root}/summary.json`, JSON.stringify({ provenance: "authored_semantic_offline_counterfactual_not_live",
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_PLACEMENT_LOST", providerCalls: 0,
      observedClothing: raw.observed.clothing, upperPattern: plan.outfitPlan.upper.pattern,
      lowerPattern: plan.outfitPlan.lower.pattern, motifs, selectedQuality: selected.quality,
      defaultPngEqualsSelected: true, pngSha256: createHash("sha256").update(png).digest("hex") }, null, 2), { flag: "wx" });
    console.info(`FLORAL_PLACEMENT_SCOPE ${root}`);
  } finally { run.mockRestore(); network.mockRestore(); }
}, 60000);

it("keeps upper and lower garment motifs independently located", () => {
  const a = fixture("Black sweater with floral print on viewer-left sleeve; black trousers with floral print on viewer-left leg");
  const p = buildOutfitPlan(a);
  expect(p.upper.pattern.surfaceParts).toEqual(["rightArm"]);
  expect(p.lower.pattern.surfaceParts).toEqual(["rightLeg"]);
  expect(p.lower.pattern.kind).toBe("irregular_group");
});

it.each([
  ["right lower leg", ["rightLeg"]], ["viewer-left lower leg", ["rightLeg"]],
  ["left upper leg", ["leftLeg"]], ["both lower legs", ["rightLeg", "leftLeg"]],
  ["one lower leg", []], ["lower leg", []],
])("retains anatomical side through a vertical location modifier: %s", (location, parts) => {
  const a = fixture(`Black sweater; black pants with red rose floral graphics down the ${location}.`);
  expect(buildOutfitPlan(a).lower.pattern.surfaceParts).toEqual(parts);
});

it.each(["rose pink", "rose-pink", "rose gold", "rose-colored"])("does not mistake %s garment color for a flower motif", tone => {
  const a = fixture(`Black sweater with ${tone} sleeves; plain black trousers`);
  const p = buildOutfitPlan(a);
  expect(p.upper.pattern.motif).toBeUndefined();
  expect(p.upper.pattern.kind).toBe("none");
  expect(buildReferenceStylePlan(a).candidates.outfit.map(c => c.family)).not.toContain("black_floral_streetwear");
});

it("keeps named rose ink and perspective attached to their own garments", () => {
  const a = fixture("Black knit sweater with red rose graphics on viewer-left sleeve; black trousers with blue roses on viewer-right leg");
  a.fallbackFeatures.topAccentColor = "white";
  const p = buildOutfitPlan(a);
  expect(p.upper.pattern).toMatchObject({ motif: "floral", surfaceParts: ["rightArm"], color: "#b53a35" });
  expect(p.lower.pattern).toMatchObject({ motif: "floral", surfaceParts: ["leftLeg"], color: "#416b9d" });
  expect(buildReferenceStylePlan(a).outfit.family).toBe("black_floral_streetwear");
});

it.each([
  "Black sweater with possibly red rose graphics on right sleeve",
  "Black sweater without rose embroidery on left sleeve",
  "Black sweater with a rose gold brooch",
  "Plain black sweater; rose-print shoes",
])("does not select a floral garment from unavailable or unrelated rose evidence: %s", clothing => {
  expect(buildReferenceStylePlan(fixture(clothing)).candidates.outfit.map(c => c.family)).not.toContain("black_floral_streetwear");
});

it("does not promote hidden or prompt-only rose evidence into a visible garment motif", () => {
  const a = fixture("Black sweater with red rose graphics on right sleeve; black pants with red roses on left leg");
  a.visibleRegions.upperBody = false; a.visibleRegions.lowerBody = false;
  expect(buildOutfitPlan(a).upper.pattern.surfaceParts).toEqual([]);
  expect(buildOutfitPlan(a).lower.pattern.motif).toBeUndefined();
  expect(buildReferenceStylePlan(a).candidates.outfit.map(c => c.family)).not.toContain("black_floral_streetwear");
  a.visibleRegions.upperBody = true; a.observed.clothing = "Plain black sweater";
  expect(buildOutfitPlan(a).upper.pattern.motif).toBeUndefined();
});

it.each([
  "Black sweater with pink floral sleeves",
  "Black sweater with blue flowers on right sleeve",
  "Black sweater with flowers in blue on right sleeve",
])("does not replace observed flower ink with an unrelated shared accent: %s", clothing => {
  const a = fixture(clothing), p = buildOutfitPlan(a);
  // Compare to the same canonical palette used for an explicit plain garment,
  // not a new flower-specific palette or a copied reference RGB.
  const named = /pink/.test(clothing) ? "pink" : "blue";
  const plain = buildOutfitPlan(fixture(`${named} sweater`));
  expect(p.upper.pattern.color).toBe(plain.upper.baseColor);
  expect(p.upper.pattern.color).not.toBe(buildOutfitPlan(fixture("Black sweater with red floral sleeves")).upper.pattern.color);
});

it("does not steal a named ink color from negated flowers or unrelated clothing", () => {
  const p = buildOutfitPlan(fixture("Black sweater without pink floral sleeves but with red floral chest motif; blue trousers"));
  expect(p.upper.pattern.surfaceParts).toEqual(["body"]);
  expect(p.upper.pattern.color).toBe(buildOutfitPlan(fixture("Red sweater")).upper.baseColor);
  const unnamed = buildOutfitPlan(fixture("Black sweater with floral sleeves; blue trousers"));
  expect(unnamed.upper.pattern.color).toBe(buildOutfitPlan(fixture("Red sweater")).upper.baseColor);
});

it("does not reuse the upper flower palette for an independently colored lower motif", () => {
  const p = buildOutfitPlan(fixture("Black sweater with red floral sleeves; black trousers with blue flowers on right leg"));
  const blue = buildOutfitPlan(fixture("Blue sweater")).upper.baseColor;
  expect(p.lower.pattern.color).toBe(blue);
  expect(p.lower.pattern.color).not.toBe(p.upper.pattern.color);
});

it("keeps the pre-existing frozen short-hair outfit plan exact while identifying the old full-plan baseline boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const { strictBoundaryAnalysisFromAnnotation } = await import("./strictBoundaryFixtureSupport");
  const annotations = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const fixture = annotations.find((row: { id: string }) => row.id === "short-hair-red-shirt");
  const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
  if (fixture.existing) {
    const { parseIdentityGeometry } = await import("../src/identityGeometry");
    raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
  }
  const plan = buildSkinPlan(normalizeAnalysisForRendering(raw));
  const old = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8"))
    .cases.find((row: { id: string }) => row.id === fixture.id).plan;
  expect(plan.outfitPlan).toEqual(old.outfitPlan);
  expect(JSON.stringify(plan)).not.toEqual(JSON.stringify(old));
  const differingTopLevel = Object.keys(plan).filter(k => JSON.stringify(plan[k as keyof typeof plan]) !== JSON.stringify(old[k]));
  console.info(`HISTORICAL_PLAN_DIFFERENCE ${JSON.stringify({ caseId: fixture.id, differingTopLevel, outfitEqual: true })}`);
});

it("does not use hidden completion or another garment to invent localized motifs", () => {
  const a = fixture("Plain black sweater; black trousers with floral print on right leg");
  expect(buildOutfitPlan(a).upper.pattern.kind).toBe("none");
  a.visibleRegions.lowerBody = false;
  expect(buildOutfitPlan(a).lower.pattern.surfaceParts).toBeUndefined();
  a.observed.clothing = "Plain black sweater";
  a.outfitPrompt = "Black sweater with floral sleeves";
  expect(buildOutfitPlan(a).upper.pattern.surfaceParts).toBeUndefined();
  a.observed.clothing = "Black sweater with floral sleeves"; a.visibleRegions.upperBody = false;
  expect(buildOutfitPlan(a).upper.pattern.surfaceParts).toEqual([]);
});

it.each([
  ["Plain black sweater; black trousers with floral print on right leg", ["rightLeg"]],
  ["Black sweater without floral sleeves; plain black trousers", []],
  ["Black sweater with possibly floral sleeves; plain black trousers", []],
])("does not let family composition resurrect unsupported upper flowers: %s", (clothing, wanted) => {
  const a = normalizeAnalysisForRendering(fixture(clothing)), plan = buildSkinPlan(a);
  const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, colors, plan.hairPlan), base = buildProceduralSourceAtlas(colors, style, plan)!;
  const selected = selectReferenceStyleAtlas(base, plan, buildReferenceStylePlan(a), style).selected!;
  expect(selected).not.toBeNull(); expect(selected.quality.violations).toEqual([]);
  const actual = [];
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    const r = CLASSIC_LAYOUT[part].base.front, rgba = selected.composition.atlas.rgba;
    let red = 0;
    for (let y = 2; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * 64 + r.x + x) * 4;
      if (rgba[i] > rgba[i + 1] * 1.7 && rgba[i] > rgba[i + 2] * 1.7) red++;
    }
    if (red) actual.push(part);
  }
  expect(actual).toEqual(wanted);
});
