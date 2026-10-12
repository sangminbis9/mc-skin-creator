import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";

const sourceRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-009";
const summaryBytes = fs.readFileSync(path.join(sourceRoot, "summary.json"));
const run = JSON.parse(summaryBytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = clothing;
  a.visibleRegions.upperBody = true;
  a.fallbackFeatures.topType = "jacket"; a.fallbackFeatures.sleeveLength = "short";
  a.renderHints.outerGarment = "open_jacket";
  return a;
}

it("keeps a conventional formal jacket long in the authoritative plan without claiming measured sleeves", () => {
  const a = input("A black formal suit jacket over a white shirt and a dark tie.");
  const original = JSON.stringify(a);
  const plan = buildSkinPlan(a).outfitPlan;
  expect(plan.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "conservative" });
  expect(plan.upper.rightSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "conservative" });
  expect(plan.provenance.filter(p => p.target === "upper.sleeves"))
    .toEqual([expect.objectContaining({ source: "conservative", confidence: 0.5 })]);
  expect([...plan.salience.primary, ...plan.salience.secondary, ...plan.salience.tertiary]
    .some(c => c.id === "sleeves_short_short")).toBe(false);
  expect(JSON.stringify(a)).toBe(original);
});

it.each([
  ["A short-sleeved formal suit jacket over a white shirt.", "short"],
  ["A sleeveless formal suit jacket over a white shirt.", "sleeveless"],
  ["A formal suit jacket with rolled sleeves over a white shirt.", "rolled"],
  ["A formal suit jacket with elbow-length sleeves over a white shirt.", "elbow"],
  ["A long-sleeved formal suit jacket over a white shirt.", "long"],
  ["A formal suit jacket with layered sleeves over a white shirt.", "layered"],
])("preserves actual jacket sleeve wording: %s", (text, expected) => {
  const p = buildSkinPlan(input(text)).outfitPlan;
  expect(p.upper.leftSleeve.length).toBe(expected);
  expect(p.upper.rightSleeve.length).toBe(expected);
  expect(p.upper.leftSleeve.source).toBe("observed");
});

it("preserves asymmetry, and cannot borrow the inner shirt's sleeve length", () => {
  const p = buildSkinPlan(input("A formal suit jacket with left sleeve short and right sleeve long over a white shirt.")).outfitPlan;
  expect([p.upper.leftSleeve.length, p.upper.rightSleeve.length]).toEqual(["short", "long"]);
  const inner = buildSkinPlan(input("A formal suit jacket over a short-sleeved white shirt.")).outfitPlan;
  expect(inner.upper.leftSleeve).toMatchObject({ length: "long", source: "conservative" });
});

it.each([
  "A casual jacket over a white shirt.",
  "Possibly a formal suit jacket over a white shirt.",
  "No formal suit jacket over a white shirt.",
  "A formal suit jacket with hidden sleeves over a white shirt.",
])("does not extend ambiguous/unrelated construction: %s", text => {
  expect(buildSkinPlan(input(text)).outfitPlan.upper.leftSleeve.length).toBe("short");
});

it("does not change an unseen torso, a non-jacket, or an already specific saved sleeve plan", () => {
  const a = input("A formal suit jacket over a white shirt.");
  a.visibleRegions.upperBody = false;
  expect(preserveObservedFormalSuit(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true;
  const p = structuredClone(saved.outfitPlan); p.upper.garmentType = "vest";
  expect(preserveObservedFormalSuit(p, a)).toBe(p);
  p.upper.garmentType = "jacket";
  p.upper.leftSleeve = { ...p.upper.leftSleeve, length: "rolled", terminationRow: 8 };
  expect(preserveObservedFormalSuit(p, a).upper.leftSleeve.length).toBe("rolled");
});

it("replays exact -009 before/after with arm-only pixel changes and preserves missed hair evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const style: FaceStyle = trace.injectedParameters.faceStyle;
    const design: ReferenceStylePlan = trace.referenceStyle.design;
    const beforePlan = JSON.stringify(saved), beforeAnalysis = JSON.stringify(trace.renderAnalysis);
    expect(style.sleeveLength).toBe("long");
    expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    const oldSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, saved)!;
    const before = composeReferenceStyleAtlas(oldSource, saved, design, style);
    const historicalBefore = withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(oldSource, saved, design, style));
    const intentionalTorsoMaterialPixels = assertTorsoMaterialBoundary(before.atlas, historicalBefore.atlas, saved.outfitPlan);
    const disk = await decodePng(fs.readFileSync(path.join(sourceRoot, "skin.png")));
    expect(sha(historicalBefore.atlas.rgba)).toBe(sha(disk.rgba));
    const fixed = structuredClone(saved);
    fixed.outfitPlan = preserveObservedFormalSuit(saved.outfitPlan, trace.renderAnalysis);
    // This exact historical comparison isolates the sleeve migration. The
    // separately tested current tie/front construction is not an arm edit.
    delete fixed.outfitPlan.formalSuit!.construction;
    delete fixed.outfitPlan.formalSuit!.frontDrape;
    const newSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, fixed)!;
    const after = composeReferenceStyleAtlas(newSource, fixed, design, style);
    expect(validateFinalAtlas(after.atlas).ok).toBe(true);
    const craft = validateReferenceAtlasCraft(after.atlas, newSource, fixed, style,
      buildReferenceCraftPlan(fixed, design, after));
    expect(craft.ok, craft.problems.join(",")).toBe(true);
    expect(after.diagnostic.constraints.ok).toBe(true);
    expect(composeReferenceStyleAtlas(newSource, fixed, design, style).atlas.rgba).toEqual(after.atlas.rgba);
    const armPixels = new Set<number>();
    for (const part of ["leftArm", "rightArm"] as const) for (const layer of ["base", "overlay"] as const)
      for (const rect of Object.values(CLASSIC_LAYOUT[part][layer]))
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) armPixels.add((rect.y + y) * 64 + rect.x + x);
    let changed = 0;
    for (let pixel = 0; pixel < 4096; pixel++) {
      const offset = pixel * 4;
      if (before.atlas.rgba.slice(offset, offset + 4).some((v, i) => v !== after.atlas.rgba[offset + i])) {
        changed++; expect(armPixels.has(pixel)).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).toBe(beforePlan); expect(JSON.stringify(trace.renderAnalysis)).toBe(beforeAnalysis);
    expect(sha(fs.readFileSync(path.join(sourceRoot, "summary.json")))).toBe(sha(summaryBytes));
    const root = fs.mkdtempSync("evaluation-artifacts/formal-suit-sleeve-construction-20261008-");
    for (const [name, atlas] of [["before", before.atlas], ["after", after.atlas]] as const) {
      fs.writeFileSync(path.join(root, `${name}.png`), await encodePng(atlas));
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter"].includes(v.name)))
        fs.writeFileSync(path.join(root, `${name}-${view.name}.png`), await encodePng(scaleNearestNeighbor(view.image, 256, 512)));
    }
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({ runId: run.runId,
      sourceSummarySha256: sha(summaryBytes), sourceEvidenceUnchanged: true, notFullAnalysisReconstruction: true,
      historicalBeforeMatchesLivePng: true, historicalBeforeRgbaSha256: sha(historicalBefore.atlas.rgba),
      intentionalTorsoMaterialPixels, sleeveComparisonContext: "same_current_torso_material_before_and_after",
      beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba),
      changedArmPixels: changed, nonArmPixelDiff: 0, craftPass: craft.ok, atlasPass: true,
      sleeveProvenance: "conservative_construction_not_provider_measurement", primaryMissedHairNotCorrected: true,
      providerCalls: 0 }, null, 2));
    console.log("SLEEVE_CONSTRUCTION_ARTIFACT", root);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
