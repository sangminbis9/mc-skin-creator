// Offline only: immutable -004 evidence, no live selector or provider requests.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";
import { assertRetainedMouthBoundary, withHistoricalMouthBudget } from "./historicalHairMaterial";

const root = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004";
const bytes = fs.readFileSync(path.join(root, "summary.json"));
const run = JSON.parse(bytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace;
const savedPlan: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

function input(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = clothing;
  a.visibleRegions.upperBody = true; a.visibleRegions.lowerBody = false;
  a.renderHints.outerGarment = "open_jacket"; a.renderHints.neckAccessory = "tie";
  a.fallbackFeatures.topColor = "blue";
  return a;
}
function cell(image: RawImage, part: "body" | "rightLeg", layer: "base" | "overlay", x: number, y: number) {
  const r = CLASSIC_LAYOUT[part][layer].front, i = ((r.y + y) * 64 + r.x + x) * 4;
  return [...image.rgba.slice(i, i + 4)];
}

describe("formal suit material binding at the observed-to-plan boundary", () => {
  it("repairs the exact -004 material loss without altering observed evidence or saved inputs", () => {
    const analysisBefore = JSON.stringify(trace.renderAnalysis), planBefore = JSON.stringify(savedPlan);
    const fixed = preserveObservedFormalSuit(savedPlan.outfitPlan, trace.renderAnalysis);
    expect(savedPlan.outfitPlan.formalSuit).toMatchObject({ jacketColor: "#416b9d", tieColor: "#eeeae1" });
    expect(fixed.formalSuit).toMatchObject({ jacketColor: "#242326", shirtColor: "#eeeae1",
      tieColor: "#242326", tieAccent: "#eeeae1", trouserColor: "#242326" });
    expect(fixed.upper.baseColor).toBe("#242326");
    expect(fixed.upper.leftSleeve.color).toBe("#242326");
    expect(fixed.upper.rightSleeve.color).toBe("#242326");
    expect(fixed.upper.colorBlocks.find(b => b.id === "upper_base")?.color).toBe("#242326");
    expect(fixed.lower.baseColor).toBe("#242326");
    expect(fixed.provenance).toContainEqual(expect.objectContaining({ target: "formalSuit.trouserColor", source: "conservative" }));
    expect(JSON.stringify(trace.renderAnalysis)).toBe(analysisBefore);
    expect(JSON.stringify(savedPlan)).toBe(planBefore);
  });

  it.each([
    ["A dark formal suit jacket over a white shirt and a dark tie with white stripes.", "#242326", "#242326", "#eeeae1"],
    ["A dark formal suit jacket over a white shirt and a dark tie, white diagonal stripes.", "#242326", "#242326", "#eeeae1"],
    ["A blue formal suit jacket over a cream shirt and a red tie with white diagonal stripes.", "#416b9d", "#b53a35", "#eeeae1"],
    ["A brown formal suit jacket over a white shirt with a navy tie featuring silver stripes.", "#684b38", "#273954", "#b9bec5"],
    ["A dark-blue formal suit jacket over a white shirt with a green tie with gold lines.", "#273954", "#467a50", "#c6a34b"],
    ["A formal suit jacket is navy, over a cream shirt with a red tie.", "#273954", "#b53a35", null],
  ] as const)("keeps each material separate from shirt/trim colors: %s", (clothing, jacket, tie, trim) => {
    const plan = buildSkinPlan(input(clothing)).outfitPlan;
    expect(plan.formalSuit).toMatchObject({ jacketColor: jacket, tieColor: tie, tieAccent: trim });
  });

  it("does not promote a trim-only white stripe into an unspecified tie material", () => {
    const a = input("A black formal suit jacket over a white shirt with a tie with white stripes.");
    const old = structuredClone(savedPlan.outfitPlan);
    old.accessories.find(v => v.kind === "tie")!.color = "#273954";
    expect(preserveObservedFormalSuit(old, a).formalSuit).toMatchObject({ tieColor: "#273954", tieAccent: "#eeeae1" });
  });

  it.each([
    "A dark casual jacket over a white shirt and a dark tie.",
    "Possibly a dark formal suit jacket over a white shirt and dark tie.",
    "No formal suit jacket over a white shirt and dark tie.",
  ])("cannot opt in from absent/uncertain formal evidence: %s", clothing => {
    expect(preserveObservedFormalSuit(savedPlan.outfitPlan, input(clothing))).toBe(savedPlan.outfitPlan);
  });

  it("keeps contrasting sleeves and explicit visible lower garments instead of copying a dark suit everywhere", () => {
    const a = input("A dark formal suit jacket over a white shirt with a dark tie. Green trousers.");
    a.visibleRegions.lowerBody = true;
    const old = structuredClone(savedPlan.outfitPlan);
    old.upper.leftSleeve.color = "#b53a35";
    old.upper.rightSleeve.color = "#467a50";
    const fixed = preserveObservedFormalSuit(old, a);
    expect(fixed.upper.leftSleeve.color).toBe("#b53a35");
    expect(fixed.upper.rightSleeve.color).toBe("#467a50");
    expect(fixed.formalSuit?.trouserColor).toBe("#467a50");
  });

  it("does not complete hidden trousers without evidence, or overwrite explicitly inferred blue trousers", () => {
    const a = input("A dark formal suit jacket over a white shirt and dark tie.");
    a.inferred.lowerBody = null; a.inferred.lowerBodyDesign = null;
    expect(preserveObservedFormalSuit(savedPlan.outfitPlan, a).lower.baseColor).toBe(savedPlan.outfitPlan.lower.baseColor);
    a.inferred.lowerBody = { value: "blue trousers", rationale: "explicit supplied completion" };
    expect(preserveObservedFormalSuit(savedPlan.outfitPlan, a).lower.baseColor).toBe("#416b9d");
  });

  it("uses the observed dark value class for visible trousers without claiming inferred evidence", () => {
    const a = input("A dark formal suit jacket over a white shirt with a dark tie. Dark trousers.");
    a.visibleRegions.lowerBody = true;
    const fixed = preserveObservedFormalSuit(savedPlan.outfitPlan, a);
    expect(fixed.lower.baseColor).toBe("#242326");
    expect(fixed.provenance.filter(p => p.target === "formalSuit.trouserColor")).toEqual([]);
  });

  it("reproduces the actual -004 PNG before the fix, then saves a fresh outfit-only atlas comparison", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const style: FaceStyle = trace.injectedParameters.faceStyle;
      const design: ReferenceStylePlan = trace.referenceStyle.design;
      const beforeSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, savedPlan)!;
      const before = composeReferenceStyleAtlas(beforeSource, savedPlan, design, style);
      const planIdentity = JSON.stringify(savedPlan);
      const oldTorso = withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(beforeSource, savedPlan, design, style));
      const intentionalTorsoMaterialPixels = assertTorsoMaterialBoundary(before.atlas, oldTorso.atlas, savedPlan.outfitPlan);
      const historical = withHistoricalMouthBudget(() => withHistoricalTorsoMaterial(() =>
        composeReferenceStyleAtlas(beforeSource, savedPlan, design, style)));
      const intentionalRetainedMouthPixels = assertRetainedMouthBoundary(oldTorso.atlas, historical.atlas, savedPlan);
      expect(intentionalRetainedMouthPixels).toHaveLength(1);
      expect(JSON.stringify(savedPlan)).toBe(planIdentity);
      const disk = await decodePng(fs.readFileSync(path.join(root, "skin.png")));
      expect(sha(historical.atlas.rgba)).toBe(sha(disk.rgba));
      const fixedPlan = structuredClone(savedPlan);
      fixedPlan.outfitPlan = preserveObservedFormalSuit(savedPlan.outfitPlan, trace.renderAnalysis);
      const afterSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, fixedPlan)!;
      const after = composeReferenceStyleAtlas(afterSource, fixedPlan, design, style);
      expect(after.diagnostic.constraints.ok).toBe(true);
      const craft = validateReferenceAtlasCraft(after.atlas, afterSource, fixedPlan, style,
        buildReferenceCraftPlan(fixedPlan, design, after));
      expect(craft.ok, craft.problems.join(",")).toBe(true);
      expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
      expect(composeReferenceStyleAtlas(afterSource, fixedPlan, design, style).atlas.rgba).toEqual(after.atlas.rgba);
      for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT.head[layer]))
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
          const i = ((r.y + y) * 64 + r.x + x) * 4;
          expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
        }
      expect(cell(after.atlas, "body", "base", 0, 5)).not.toEqual(cell(before.atlas, "body", "base", 0, 5));
      expect(cell(after.atlas, "body", "base", 2, 4)).toEqual([238, 234, 225, 255]);
      expect(sha(after.atlas.rgba)).not.toBe(sha(before.atlas.rgba));
      const output = fs.mkdtempSync("evaluation-artifacts/real-app-formal-suit-material-offline-20261007-");
      for (const [name, atlas] of [["historical", historical.atlas], ["before", before.atlas], ["after", after.atlas]] as const) {
        fs.writeFileSync(path.join(output, `${name}.png`), await encodePng(atlas));
        const front = renderSkinViews(atlas).find(v => v.name === "front")!;
        fs.writeFileSync(path.join(output, `${name}-front.png`), await encodePng(scaleNearestNeighbor(front.image, 192, 384)));
      }
      fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ context: "same_run_saved_plan_parameters_fixed_family",
        runId: run.runId, sourceSummarySha256: sha(bytes), notFullAnalysisReconstruction: true,
        historicalMatchesActualLivePng: true, historicalRgbaSha256: sha(historical.atlas.rgba), intentionalTorsoMaterialPixels,
        intentionalRetainedMouthPixels,
        comparisonContext: "same_current_torso_material_before_and_after",
        beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba),
        formalSuit: fixedPlan.outfitPlan.formalSuit, headPixelDiff: 0, craftPass: craft.ok, atlasPass: true,
        sourceEvidenceUnchanged: true, providerCalls: 0, primaryMissedPartNotPatched: true }, null, 2));
      console.log("FORMAL_MATERIAL_OFFLINE", output);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
