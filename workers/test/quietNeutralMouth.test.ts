// Offline only. Saved same-run parameters/plans, not reconstructed analysis.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { referenceMouthPresentation, referencePresentedFaceContract } from "../src/referenceFaceFinish";
import { measureFaceRenderContract } from "../src/identityRenderContract";
import { buildProceduralSourceAtlas } from "../src/generate";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";
import { assertRetainedMouthBoundary, withHistoricalMouthBudget } from "./historicalHairMaterial";

const liveRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002";
const summaryBytes = fs.readFileSync(`${liveRoot}/summary.json`);
const trace = JSON.parse(summaryBytes.toString()).currentDefaultE2E.result.propagationTrace;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const front = CLASSIC_LAYOUT.head.base.front;
const index = (p: { x: number; y: number }) => ((front.y + p.y) * 64 + front.x + p.x) * 4;
function context() {
  const plan: SkinPlan = structuredClone(trace.skinPlan.skinPlan);
  const style: FaceStyle = structuredClone(trace.injectedParameters.faceStyle);
  const design: ReferenceStylePlan = structuredClone(trace.referenceStyle.design);
  design.version = "reference_style_v2";
  const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, plan)!;
  return { plan, style, design, baseline };
}

describe("clean family quiet neutral presentation", () => {
  it("separates presentation from immutable source identity and the unchanged general validator", () => {
    const { plan, style, design } = context(), source = JSON.stringify(plan);
    const face = plan.facePixelPlan;
    expect(trace.primary.faceMeasurementEvidence.cues.expression).toMatchObject({ value: "neutral", provenance: "observed_categorical" });
    expect(referenceMouthPresentation(face, design, style, [])).toBe("omit_neutral");
    const projected = referencePresentedFaceContract(face, design, style, []);
    expect(projected.pixels).toBe(face.pixels);
    expect(projected.renderContract.eyes).toBe(face.renderContract.eyes);
    expect(projected.renderContract.mouth).toBeUndefined();
    expect(face.renderContract.mouth).toBeDefined();
    expect(JSON.stringify(plan)).toBe(source);
  });

  it.each([
    ["missing style", "missing"], ["smile", "smile"], ["serious", "serious"],
    ["open", "open"], ["full lips", "full"], ["lip color", "color"], ["wide", "wide"],
    ["protected cue", "protected"], ["protected geometry", "geometry"],
    ["teeth", "teeth"], ["source opening", "opening"], ["corners", "corners"],
    ["asymmetry", "asymmetry"], ["material collision", "material"], ["legacy", "legacy"],
    ["missing lip context", "missingLip"], ["wide source layout", "layoutWidth"], ["wide source contract", "contractWidth"],
  ])("retains the source mouth for %s", (_label, kind) => {
    const { plan, style, design } = context(), face = plan.facePixelPlan;
    const material: { x: number; y: number }[] = [];
    if (kind === "smile" || kind === "serious") style.expression = kind;
    if (kind === "open") style.mouthOpening = "slightly_open";
    if (kind === "full") style.lipFullness = "full";
    if (kind === "color") style.lipColor = "red";
    if (kind === "wide") style.mouthShape = "wide";
    if (kind === "protected") face.renderContract.mouth!.protected = true;
    if (kind === "geometry") face.protectedGeometry.push("mouth");
    if (kind === "teeth") face.pixels.find(p => p.cluster === "mouth")!.role = "teeth";
    if (kind === "opening") face.layout.mouthOpening = "open";
    if (kind === "corners") face.layout.mouthCornerOffsets = [-1, 0];
    if (kind === "asymmetry") face.renderContract.mouth!.preserveAsymmetry = true;
    if (kind === "material") material.push(face.pixels.find(p => p.cluster === "mouth")!);
    if (kind === "legacy") design.version = "reference_style_v1";
    if (kind === "missingLip") delete style.lipColor;
    if (kind === "layoutWidth") face.layout.mouthWidth = 4;
    if (kind === "contractWidth") face.renderContract.mouth!.minimumPerceptualWidth = 4;
    expect(referenceMouthPresentation(face, design, kind === "missing" ? undefined : style, material)).toBe("retain_source");
    if (kind !== "missing") expect(referencePresentedFaceContract(face, design, style, material)).toBe(face);
  });

  it.each(["soft_feminine_doll", "cute_pastel", "cool_androgynous", "dark_stylish"] as const)("retains the mouth for %s", family => {
    const { plan, style, design } = context(); design.face.family = family;
    expect(referenceMouthPresentation(plan.facePixelPlan, design, style, [])).toBe("retain_source");
    const legacy = { ...design, version: "reference_style_v1" as const };
    expect(composeReferenceStyleAtlas(context().baseline, plan, design, style).atlas.rgba)
      .toEqual(composeReferenceStyleAtlas(context().baseline, plan, legacy, style).atlas.rgba);
  });

  it("rejects an unauthorized mouth/eye/skin mutation, even with rewritten paint diagnostics", () => {
    const { plan, style, design, baseline } = context();
    const valid = composeReferenceStyleAtlas(baseline, plan, design, style);
    expect(measureReferenceRenderedQuality(valid, baseline, plan, design, style).constructionValid).toBe(true);
    const forged = structuredClone(valid); forged.diagnostic.faceFinish.mouthPresentation = "retain_source";
    expect(measureReferenceRenderedQuality(forged, baseline, plan, design, style).violations).toContain("mouth_presentation_contract_changed");
    for (const p of [plan.facePixelPlan.pixels.find(p => p.cluster === "mouth")!, plan.facePixelPlan.pixels.find(p => p.role === "iris")!]) {
      const mutant = structuredClone(valid);
      mutant.atlas.rgba.set([250, 10, 200, 255], index(p));
      for (const d of mutant.diagnostic.facePixels) if (d.x === p.x && d.y === p.y) d.color = [250, 10, 200];
      const quality = measureReferenceRenderedQuality(mutant, baseline, plan, design, style);
      expect(quality.constructionValid).toBe(false);
      expect(quality.violations).toContain(p.cluster === "mouth" ? "source_face_finish_changed" : "source_eye_brow_changed");
    }
    const protectedPlan = structuredClone(plan); protectedPlan.facePixelPlan.renderContract.mouth!.protected = true;
    const quality = measureReferenceRenderedQuality(valid, baseline, protectedPlan, design, style);
    expect(quality.constructionValid).toBe(false);
    expect(quality.violations).toContain("face_contract:mouth landmark missing");
    const erased = structuredClone(valid);
    for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++) erased.atlas.rgba.set([242, 214, 192, 255], index({ x, y }));
    expect(measureReferenceRenderedQuality(erased, baseline, plan, design, style).constructionValid).toBe(false);
  });

  it("keeps actual selected families and delivers the quiet mouth through bounded candidate selection", () => {
    const { plan, style, design, baseline } = context();
    plan.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
    const selection = selectReferenceStyleAtlas(baseline, plan, design, style);
    expect(selection.selected).not.toBeNull();
    const selected = selection.selected!;
    expect([selected.design.face.family, selected.design.hair.family, selected.design.outfit.family])
      .toEqual([trace.selectedFamilies.face, trace.selectedFamilies.hair, trace.selectedFamilies.outfit]);
    expect(selected.quality.mouthPresentation).toBe("omit_neutral");
    expect(selected.composition.atlas.rgba).toEqual(composeReferenceStyleAtlas(baseline, plan, design, style).atlas.rgba);
    expect(selection.renderAttempts).toBeLessThanOrEqual(27);
  }, 30_000);

  it("replays the exact historical PNG then changes only eligible mouth cells beside the suit fix", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const { plan, style, design, baseline } = context(), identity = JSON.stringify(plan);
      const legacy = { ...design, version: "reference_style_v1" as const };
      const historical = withHistoricalMouthBudget(() => withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(baseline, plan, legacy, style)));
      const saved = await decodePng(fs.readFileSync(`${liveRoot}/skin.png`));
      expect(historical.atlas.rgba).toEqual(saved.rgba);
      const currentMaterial = withHistoricalMouthBudget(() => composeReferenceStyleAtlas(baseline, plan, legacy, style));
      const torsoMaterialChanged = assertTorsoMaterialBoundary(currentMaterial.atlas, historical.atlas, plan.outfitPlan);
      const retained = composeReferenceStyleAtlas(baseline, plan, legacy, style);
      const retainedMouthChanged = assertRetainedMouthBoundary(retained.atlas, currentMaterial.atlas, plan);
      expect(retainedMouthChanged).toHaveLength(1);
      expect(JSON.stringify(plan)).toBe(identity);
      plan.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
      const fixedIdentity = JSON.stringify(plan), before = composeReferenceStyleAtlas(baseline, plan, legacy, style);
      const after = composeReferenceStyleAtlas(baseline, plan, design, style);
      const mouth = plan.facePixelPlan.pixels.filter(p => p.cluster === "mouth");
      const allowed = new Set(mouth.map(p => index(p))), changed = [];
      for (let i = 0; i < 16384; i += 4) if (!after.atlas.rgba.slice(i, i + 4).every((v, ch) => v === before.atlas.rgba[i + ch])) {
        expect(allowed.has(i)).toBe(true); changed.push(i);
      }
      // The retained source contract has three cells. The later width fix
      // keeps all three; neutral presentation may still explicitly omit them.
      expect(mouth).toHaveLength(3);
      expect(changed.length).toBe(3);
      for (const p of mouth) expect([...after.atlas.rgba.slice(index(p), index(p) + 4)]).toEqual([242, 214, 192, 255]);
      expect(after.diagnostic.faceFinish.mouthPresentation).toBe("omit_neutral");
      expect(JSON.stringify(plan)).toBe(fixedIdentity);
      expect(JSON.stringify(plan.facePixelPlan)).toBe(JSON.stringify(JSON.parse(identity).facePixelPlan));
      const quality = measureReferenceRenderedQuality(after, baseline, plan, design, style);
      expect(quality.constructionValid, quality.violations.join(",")).toBe(true);
      expect(quality.faceContract.eyesPresent).toBe(true);
      // Source visibility validator is deliberately unchanged, not relaxed.
      expect(measureFaceRenderContract(after.atlas, plan.facePixelPlan).violations).toContain("mouth landmark missing");
      const craft = validateReferenceAtlasCraft(after.atlas, baseline, plan, style, buildReferenceCraftPlan(plan, design, after));
      expect(craft.ok, craft.problems.join(",")).toBe(true);
      const root = fs.mkdtempSync("evaluation-artifacts/real-app-quiet-mouth-offline-20261007-");
      for (const [name, atlas] of [["historical", historical.atlas], ["suit-fixed", before.atlas], ["after", after.atlas]] as const) {
        fs.writeFileSync(path.join(root, `${name}.png`), await encodePng(atlas), { flag: "wx" });
        const view = renderSkinViews(atlas).find(v => v.name === "front")!.image;
        fs.writeFileSync(path.join(root, `${name}-front.png`), await encodePng(scaleNearestNeighbor(view, 192, 384)), { flag: "wx" });
      }
      fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({ liveEvidenceRunId: trace.runId,
        evidenceSummarySha256: sha(summaryBytes), context: "saved_plan_parameters_fixed_selected_family",
        notFullAnalysisReconstruction: true, historicalMatchesLivePng: true, historicalRgbaSha256: sha(saved.rgba),
        historicalTorsoMaterialProjection: true, boundedTorsoMaterialChangedPixels: torsoMaterialChanged.length,
        historicalMouthBudgetProjection: true, boundedRetainedMouthChangedPixels: retainedMouthChanged,
        suitFixedRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba),
        sourceFacePlanSha256: sha(JSON.stringify(plan.facePixelPlan)), sourceFacePlanUnchanged: true,
        family: design.face.family, presentationVersion: design.version, mouthPresentation: quality.mouthPresentation,
        primaryExpression: trace.primary.faceMeasurementEvidence.cues.expression,
        mouthCellsChanged: changed.length, otherAtlasPixelDiff: 0, eyesPreserved: true, hairPreserved: true,
        craftPass: craft.ok, providerCalls: 0, newLiveDeliveryVerified: false }, null, 2), { flag: "wx" });
      expect(fs.readFileSync(`${liveRoot}/summary.json`)).toEqual(summaryBytes);
      expect(network).not.toHaveBeenCalled();
      console.info(`QUIET_MOUTH_OFFLINE ${root}`);
    } finally { network.mockRestore(); }
  }, 60_000);
});
