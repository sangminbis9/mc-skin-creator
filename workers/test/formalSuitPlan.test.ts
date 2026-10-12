// Pure offline contract/replay tests. Never import a live audit selector.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import type { FaceStyle } from "../src/skinPack";
import { validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";
import { assertRetainedMouthBoundary, withHistoricalMouthBudget } from "./historicalHairMaterial";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const liveRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002";
const summary = JSON.parse(fs.readFileSync(path.join(liveRoot, "summary.json"), "utf8"));
const trace = summary.currentDefaultE2E.result.propagationTrace;
const oldPlan: SkinPlan = trace.skinPlan.skinPlan;

function synthetic(clothing: string) {
  const a = makeAnalysis();
  a.observed.clothing = clothing;
  a.outfitPrompt = clothing;
  a.visibleRegions.upperBody = true;
  a.renderHints.outerGarment = "open_jacket";
  a.renderHints.neckAccessory = "tie";
  return a;
}
function painted(plan: SkinPlan["outfitPlan"]): RawImage {
  const atlas = { width: 64, height: 64, rgba: new Uint8Array(16384) };
  applyOutfitPlan(atlas, plan, "#f2d6c0"); return atlas;
}
function at(image: RawImage, part: "body" | "rightLeg", layer: "base" | "overlay", x: number, y: number) {
  const rect = CLASSIC_LAYOUT[part][layer].front;
  const i = ((rect.y + y) * 64 + rect.x + x) * 4;
  return [...image.rgba.slice(i, i + 4)];
}

describe("observed formal suit construction", () => {
  it("restores formal construction and conservative completion without changing saved evidence", () => {
    const input = JSON.stringify(trace.renderAnalysis), original = JSON.stringify(oldPlan);
    const fixed = preserveObservedFormalSuit(oldPlan.outfitPlan, trace.renderAnalysis);
    expect(fixed.formalSuit).toEqual({ family: "formal_suit", construction: "connected_tie_tapered_front", frontDrape: "tapered", jacketColor: "#242326", shirtColor: "#eeeae1",
      tieColor: "#273954", tieAccent: null, lapelStyle: "notch", shirtOpening: 3,
      jacketOpening: "open", trouserColor: "#242326", shoeColor: oldPlan.outfitPlan.lower.shoeColor });
    expect(fixed.upper.colorBlocks.map(b => b.id)).toEqual(["upper_base", "inner_panel", "opening"]);
    expect(fixed.accessories.find(a => a.kind === "tie")?.color).toBe("#273954");
    expect(fixed.provenance).toContainEqual(expect.objectContaining({ target: "formalSuit.trouserColor", source: "conservative" }));
    // The historical short cache remains immutable; conventional formal sleeve
    // completion is now explicit conservative plan evidence, not an observation.
    expect(oldPlan.outfitPlan.upper.leftSleeve.length).toBe("short");
    expect(fixed.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11,
      source: "conservative", color: oldPlan.outfitPlan.upper.leftSleeve.color });
    expect(JSON.stringify(oldPlan)).toBe(original); expect(JSON.stringify(trace.renderAnalysis)).toBe(input);
  });

  it.each([
    "A blue casual jacket over a white shirt and red tie.",
    "No formal suit jacket; a white shirt is worn with a tie.",
    "Possibly a formal suit jacket over a white shirt and a red tie.",
    "A formal suit jacket, without a shirt, with a red tie.",
    "A formal suit jacket over an occluded shirt with a red tie.",
  ])("does not invent a formal shirt panel from %s", clothing => {
    const a = synthetic(clothing);
    expect(preserveObservedFormalSuit(oldPlan.outfitPlan, a)).toBe(oldPlan.outfitPlan);
  });
  it("cannot opt in from an invisible torso or a non-jacket plan", () => {
    const a = synthetic("A formal suit jacket over a white shirt with a red tie.");
    a.visibleRegions.upperBody = false;
    expect(preserveObservedFormalSuit(oldPlan.outfitPlan, a)).toBe(oldPlan.outfitPlan);
    a.visibleRegions.upperBody = true;
    const p = structuredClone(oldPlan.outfitPlan); p.upper.garmentType = "tshirt";
    expect(preserveObservedFormalSuit(p, a)).toBe(p);
  });
  it("uses garment-owned colors and named trim instead of cloning the source palette", () => {
    const a = synthetic("A blue formal suit jacket with peak lapels over a cream shirt and a red tie with white diagonal stripes. Green trousers and brown shoes.");
    a.visibleRegions.lowerBody = true; a.visibleRegions.feet = true;
    const plan = buildSkinPlan(a).outfitPlan;
    expect(plan.formalSuit).toMatchObject({ jacketColor: "#416b9d", shirtColor: "#ded2b6", tieColor: "#b53a35",
      tieAccent: "#eeeae1", lapelStyle: "peak", trouserColor: "#467a50", shoeColor: "#684b38" });
    const a2 = synthetic("A black formal suit jacket over a white shirt without a tie.");
    expect(buildSkinPlan(a2).outfitPlan.formalSuit?.tieColor).toBeNull();
  });
  it("connects opening, lapel and named tie trim parameters to pixels without touching head UV", () => {
    const open = preserveObservedFormalSuit(oldPlan.outfitPlan, trace.renderAnalysis);
    const closed = structuredClone(open); closed.formalSuit!.jacketOpening = "buttoned";
    closed.upper.colorBlocks = closed.upper.colorBlocks.filter(b => b.id !== "opening");
    expect(at(painted(open), "body", "base", 3, 6)).not.toEqual(at(painted(closed), "body", "base", 3, 6));
    const shortOpening = structuredClone(closed); shortOpening.formalSuit!.shirtOpening = 2;
    expect(at(painted(closed), "body", "base", 2, 2)).not.toEqual(at(painted(shortOpening), "body", "base", 2, 2));
    const peak = structuredClone(open); peak.formalSuit!.lapelStyle = "peak";
    const shawl = structuredClone(open); shawl.formalSuit!.lapelStyle = "shawl";
    expect(sha(painted(open).rgba)).not.toBe(sha(painted(peak).rgba));
    expect(sha(painted(open).rgba)).not.toBe(sha(painted(shawl).rgba));
    const trim = structuredClone(open); trim.formalSuit!.tieAccent = "#eeeae1";
    expect(at(painted(trim), "body", "overlay", 4, 3)).toEqual([238, 234, 225, 255]);
    expect(at(painted(open), "body", "base", 2, 4)).toEqual([238, 234, 225, 255]);
    expect(at(painted(open), "body", "overlay", 3, 2)).toEqual([39, 57, 84, 255]);
    expect(at(painted(open), "rightLeg", "base", 1, 3)).toEqual([36, 35, 38, 255]);
  });

  it("exactly reproduces the saved PNG before changing only OutfitPlan and writes a fresh offline comparison", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const style: FaceStyle = trace.injectedParameters.faceStyle;
      const design: ReferenceStylePlan = trace.referenceStyle.design;
      const features = trace.injectedParameters.features;
      const baseline = buildProceduralSourceAtlas(features, style, oldPlan);
      expect(baseline).not.toBeNull();
      const before = composeReferenceStyleAtlas(baseline!, oldPlan, design, style);
      const planIdentity = JSON.stringify(oldPlan);
      const oldTorso = withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(baseline!, oldPlan, design, style));
      const intentionalTorsoMaterialPixels = assertTorsoMaterialBoundary(before.atlas, oldTorso.atlas, oldPlan.outfitPlan);
      // This immutable PNG predates both material and retained-mouth fixes.
      // Reverse each independently; never replace its exact historical hash.
      const historical = withHistoricalMouthBudget(() => withHistoricalTorsoMaterial(() =>
        composeReferenceStyleAtlas(baseline!, oldPlan, design, style)));
      const intentionalRetainedMouthPixels = assertRetainedMouthBoundary(oldTorso.atlas, historical.atlas, oldPlan);
      expect(intentionalRetainedMouthPixels).toHaveLength(1);
      expect(JSON.stringify(oldPlan)).toBe(planIdentity);
      const saved = await decodePng(fs.readFileSync(path.join(liveRoot, "skin.png")));
      expect(sha(historical.atlas.rgba)).toBe(sha(saved.rgba));
      const plan = structuredClone(oldPlan);
      plan.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
      const after = composeReferenceStyleAtlas(baseline!, plan, design, style);
      expect(after.diagnostic.constraints.ok).toBe(true);
      const craft = validateReferenceAtlasCraft(after.atlas, baseline!, plan, style,
        buildReferenceCraftPlan(plan, design, after));
      expect(craft.ok, craft.problems.join(",")).toBe(true);
      expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
      expect(composeReferenceStyleAtlas(baseline!, plan, design, style).atlas.rgba).toEqual(after.atlas.rgba);
      for (const layer of ["base", "overlay"] as const) for (const rect of Object.values(CLASSIC_LAYOUT.head[layer]))
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          const i = ((rect.y + y) * 64 + rect.x + x) * 4;
          expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
        }
      expect(sha(after.atlas.rgba)).not.toBe(sha(before.atlas.rgba));
      const root = fs.mkdtempSync("evaluation-artifacts/real-app-formal-suit-outfit-plan-offline-20261007-");
      for (const [name, atlas] of [["historical", historical.atlas], ["before", before.atlas], ["after", after.atlas]] as const) {
        fs.writeFileSync(path.join(root, `${name}.png`), await encodePng(atlas));
        const front = renderSkinViews(atlas).find(v => v.name === "front")!;
        fs.writeFileSync(path.join(root, `${name}-front.png`), await encodePng(scaleNearestNeighbor(front.image, 192, 384)));
      }
      fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({ liveEvidenceRunId: trace.runId,
        context: "saved_plan_and_parameters_fixed_selected_design", notFullAnalysisReconstruction: true,
        historicalMatchesActualLivePng: true, historicalRgbaSha256: sha(historical.atlas.rgba), intentionalTorsoMaterialPixels,
        intentionalRetainedMouthPixels,
        comparisonContext: "same_current_torso_material_before_and_after",
        beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba),
        formalSuit: plan.outfitPlan.formalSuit, planConstraintsPass: after.diagnostic.constraints.ok,
        atlasPass: true, craftPass: craft.ok, headPixelDiff: 0, providerCalls: 0 }, null, 2));
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
