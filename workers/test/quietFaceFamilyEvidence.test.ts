// Offline: actual -004 fields needed by the selector, never a reconstructed
// full provider response, live selector or new observation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { referenceMouthPresentation } from "../src/referenceFaceFinish";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { buildProceduralSourceAtlas } from "../src/generate";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";
import { assertRetainedMouthBoundary, withHistoricalMouthBudget } from "./historicalHairMaterial";

const liveRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004";
const bytes = fs.readFileSync(path.join(liveRoot, "summary.json"));
const run = JSON.parse(bytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

// The trace intentionally is not a complete PhotoAnalysis. The selector's
// only fallback-cache read is the baldness flag. Use its actual same-run
// recorded hairstyle, corroborated by the injected style; invent no cache.
function savedSelectorInput() {
  expect(trace.primary.fallbackFeatures.hairstyle).toBe(trace.injectedParameters.faceStyle.hairstyle);
  return { ...trace.renderAnalysis, fallbackFeatures: { hairstyle: trace.primary.fallbackFeatures.hairstyle } };
}

function source(face: string) {
  const a = makeAnalysis();
  a.observed.face = face; a.observed.clothing = "dark formal jacket";
  a.canonicalIdentity.features = [];
  a.renderHints.faceShape = "oval"; a.renderHints.eyeShape = "almond"; a.renderHints.eyeSize = "average";
  return a;
}

describe("source-supported quiet face family eligibility", () => {
  it.each(["soft jaw", "soft jawline", "clean-shaven smooth complexion"])("accepts existing observed construction: %s", face => {
    const a = source(face), before = JSON.stringify(a);
    const design = buildReferenceStylePlan(a);
    expect(design.face.family).toBe("clean_masculine_soft");
    expect(design.face.cost).toBe(6);
    expect(JSON.stringify(a)).toBe(before);
  });

  it("accepts the actual high-confidence face feature without borrowing evidence from clothing", () => {
    const evidence = trace.renderAnalysis.canonicalIdentity.features.find((f: { category: string; feature: string }) =>
      f.category === "face" && f.feature.includes("soft jawline"));
    expect(evidence).toMatchObject({ confidence: "high", category: "face" });
    const a = source("ordinary oval face"); a.canonicalIdentity.features = [evidence];
    expect(buildReferenceStylePlan(a).face.family).toBe("clean_masculine_soft");
    a.canonicalIdentity.features[0] = { ...evidence, confidence: "low" };
    expect(buildReferenceStylePlan(a).candidates.face.some(c => c.family === "clean_masculine_soft")).toBe(false);
    a.canonicalIdentity.features[0] = { ...evidence, category: "hair" };
    expect(buildReferenceStylePlan(a).candidates.face.some(c => c.family === "clean_masculine_soft")).toBe(false);
  });

  it.each(["no soft jawline", "unknown soft jawline", "soft jawline absent", "soft jawline-shaped collar"])("does not opt into an unsupported construction: %s", face => {
    // The compound collar case is deliberately a wrong-category claim, not a
    // made-up limitation on the observed face grammar.
    const a = source(face.includes("collar") ? "ordinary face" : face);
    if (face.includes("collar")) a.observed.clothing = face;
    expect(buildReferenceStylePlan(a).candidates.face.some(c => c.family === "clean_masculine_soft")).toBe(false);
  });

  it("enrolls and actually selects the quiet family on exact saved -004 context, without changing costs or landmarks", () => {
    const sourcePlan: SkinPlan = structuredClone(trace.skinPlan.skinPlan);
    sourcePlan.outfitPlan = preserveObservedFormalSuit(sourcePlan.outfitPlan, trace.renderAnalysis);
    const style: FaceStyle = trace.injectedParameters.faceStyle;
    const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, sourcePlan)!;
    const design = buildReferenceStylePlan(savedSelectorInput());
    const selected = selectReferenceStyleAtlas(baseline, sourcePlan, design, style).selected;
    expect(selected).not.toBeNull();
    expect(selected!.design.face.family).toBe("clean_masculine_soft");
    expect(selected!.design.face.cost).toBe(6);
    expect(selected!.quality.mouthPresentation).toBe("omit_neutral");
    expect(selected!.composition.diagnostic.faceFinish.mouthPresentation).toBe("omit_neutral");
    expect(selected!.quality.metrics.accidentalEyeOcclusionCells).toBe(0);
    expect(selected!.quality.metrics.visibleIrisCells).toBeGreaterThan(0);
    expect(sourcePlan.facePixelPlan).toEqual(trace.skinPlan.skinPlan.facePixelPlan);
  });

  it("continues to retain expressive/protected mouths even when soft jawline makes the clean family eligible", () => {
    const plan: SkinPlan = trace.skinPlan.skinPlan;
    const design = buildReferenceStylePlan(savedSelectorInput());
    const clean = design.candidates.face.find(c => c.family === "clean_masculine_soft");
    expect(clean).toBeDefined();
    const choice: ReferenceStylePlan = { ...design, face: clean! };
    const style: FaceStyle = trace.injectedParameters.faceStyle;
    expect(referenceMouthPresentation(plan.facePixelPlan, choice, { ...style, expression: "smile" }, [])).toBe("retain_source");
    expect(referenceMouthPresentation(plan.facePixelPlan, choice, { ...style, lipColor: "red" }, [])).toBe("retain_source");
    const protectedPlan = structuredClone(plan.facePixelPlan); protectedPlan.renderContract.mouth!.protected = true;
    expect(referenceMouthPresentation(protectedPlan, choice, style, [])).toBe("retain_source");
  });

  it("writes a fresh three-stage replay and changes neither garment/hair materials nor source plans for face presentation", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const originalPlan: SkinPlan = trace.skinPlan.skinPlan;
      const style: FaceStyle = trace.injectedParameters.faceStyle;
      const historicalDesign: ReferenceStylePlan = trace.referenceStyle.design;
      const originalSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, originalPlan)!;
      const original = composeReferenceStyleAtlas(originalSource, originalPlan, historicalDesign, style);
      // The immutable live PNG predates torso material and mouth retention.
      // Reproduce it exactly, then bound each independent migration;
      // the face-family comparison below remains on the current renderer.
      const planIdentity = JSON.stringify(originalPlan);
      const oldTorso = withHistoricalTorsoMaterial(() =>
        composeReferenceStyleAtlas(originalSource, originalPlan, historicalDesign, style));
      const intentionalTorsoMaterialPixels = assertTorsoMaterialBoundary(
        original.atlas, oldTorso.atlas, originalPlan.outfitPlan);
      const historical = withHistoricalMouthBudget(() => withHistoricalTorsoMaterial(() =>
        composeReferenceStyleAtlas(originalSource, originalPlan, historicalDesign, style)));
      const intentionalRetainedMouthPixels = assertRetainedMouthBoundary(oldTorso.atlas, historical.atlas, originalPlan);
      expect(intentionalRetainedMouthPixels).toHaveLength(1);
      expect(JSON.stringify(originalPlan)).toBe(planIdentity);
      const disk = await decodePng(fs.readFileSync(path.join(liveRoot, "skin.png")));
      expect(sha(historical.atlas.rgba)).toBe(sha(disk.rgba));
      const plan = structuredClone(originalPlan); plan.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
      const unchanged = JSON.stringify(plan), evidence = JSON.stringify(trace.renderAnalysis);
      const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, plan)!;
      const outfitOnly = composeReferenceStyleAtlas(baseline, plan, historicalDesign, style);
      // Formal sleeve construction has a separately tested, intentional repair.
      // Compare face selection against the SAME current outfit plan below;
      // an obsolete whole-atlas hash would conflate the two migrations.
      expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
      expect(plan.outfitPlan.upper.rightSleeve.length).toBe("long");
      const selection = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(savedSelectorInput()), style);
      const after = selection.selected!;
      // A categorical part topology fix must not invent the part missed by
      // this real same-run primary. The source plan/hair pixels remain exact.
      expect(after).not.toBeNull(); expect(after.design.face.family).toBe("clean_masculine_soft");
      expect(after.design.hair.family).toBe(historicalDesign.hair.family);
      expect(after.design.outfit.family).toBe(historicalDesign.outfit.family);
      expect(after.quality.mouthPresentation).toBe("omit_neutral");
      expect(validateFinalAtlas(after.composition.atlas)).toEqual({ ok: true, problems: [] });
      const craft = validateReferenceAtlasCraft(after.composition.atlas, baseline, plan, style,
        buildReferenceCraftPlan(plan, after.design, after.composition));
      expect(craft.ok, craft.problems.join(",")).toBe(true);
      const front = CLASSIC_LAYOUT.head.base.front;
      const faceChanges = new Set([...after.composition.diagnostic.faceFinish.changedCells,
        ...after.composition.diagnostic.faceFinish.skinWindowCells,
        ...after.composition.diagnostic.faceFinish.irisPigmentCells,
        ...after.composition.diagnostic.faceFinish.irisGlintCells,
        ...plan.facePixelPlan.pixels.filter(p => p.cluster === "mouth")]
        .map(p => ((front.y + p.y) * 64 + front.x + p.x) * 4));
      for (let i = 0; i < 16384; i += 4) {
        expect(after.composition.atlas.rgba[i + 3]).toBe(outfitOnly.atlas.rgba[i + 3]);
        if ([0, 1, 2].some(ch => after.composition.atlas.rgba[i + ch] !== outfitOnly.atlas.rgba[i + ch]))
          expect(faceChanges.has(i), `quiet face changed unrelated pixel:${i}`).toBe(true);
      }
      for (const part of Object.keys(CLASSIC_LAYOUT) as (keyof typeof CLASSIC_LAYOUT)[]) {
        if (part === "head") continue;
        for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT[part][layer]))
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            const i = ((r.y + y) * 64 + r.x + x) * 4;
            expect(after.composition.atlas.rgba.slice(i, i + 4)).toEqual(outfitOnly.atlas.rgba.slice(i, i + 4));
          }
      }
      // Keep every source hair-owned pixel, rather than a whole-head hash that
      // would reject the deliberately changed mouth/face presentation.
      for (const c of plan.headIdentityPlan.ownership!.cells.filter(c => ["hair_base", "tied_hair", "covering"].includes(c.owner))) {
        const r = CLASSIC_LAYOUT.head[c.layer === "outer" ? "overlay" : "base"][c.face];
        const i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
        expect(after.composition.atlas.rgba.slice(i, i + 4)).toEqual(outfitOnly.atlas.rgba.slice(i, i + 4));
      }
      expect(JSON.stringify(plan)).toBe(unchanged); expect(JSON.stringify(trace.renderAnalysis)).toBe(evidence);
      const output = fs.mkdtempSync("evaluation-artifacts/real-app-quiet-face-family-offline-20261007-");
      for (const [name, atlas] of [["actual-live", historical.atlas], ["current-material", original.atlas], ["outfit-only", outfitOnly.atlas], ["after", after.composition.atlas]] as const) {
        fs.writeFileSync(path.join(output, `${name}.png`), await encodePng(atlas));
        const front = renderSkinViews(atlas).find(v => v.name === "front")!;
        fs.writeFileSync(path.join(output, `${name}-front.png`), await encodePng(scaleNearestNeighbor(front.image, 192, 384)));
      }
      fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ context: "saved_exact_selector_fields_plan_and_parameters",
        runId: run.runId, sourceSummarySha256: sha(bytes), notFullAnalysisReconstruction: true,
        originalLiveRgbaSha256: sha(historical.atlas.rgba), currentMaterialRgbaSha256: sha(original.atlas.rgba),
        intentionalTorsoMaterialPixels, intentionalRetainedMouthPixels, historicalMatchesActualLivePng: true,
        comparisonContext: "same_current_torso_material_before_and_after_face_selection",
        outfitOnlyRgbaSha256: sha(outfitOnly.atlas.rgba),
        afterRgbaSha256: sha(after.composition.atlas.rgba), selectedFamilies: { face: after.design.face.family,
          hair: after.design.hair.family, outfit: after.design.outfit.family }, mouthPresentation: after.quality.mouthPresentation,
        sourcePlanUnchanged: true, sourceEvidenceUnchanged: true, nonHeadPixelDiff: 0, hairOwnedPixelDiff: 0,
        craftPass: craft.ok, atlasPass: true, selectionCandidates: selection.candidates.map(c => ({ id: c.id,
          score: c.quality?.score ?? null, mouthPresentation: c.quality?.mouthPresentation ?? null, rejection: c.rejection })),
        providerCalls: 0, primaryMissedPartNotPatched: true }, null, 2));
      console.info("QUIET_FAMILY_OFFLINE", output);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
