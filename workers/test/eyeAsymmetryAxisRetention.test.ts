import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";

const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json", "utf8")).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
const beforeRoot = "evaluation-artifacts/eye-axis-retention-20260927-zZif8t";
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

it("does not turn stored readable openness into unilateral open-eye pixels", () => {
  const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry }));
  const plan = buildSkinPlan(analysis).facePixelPlan;
  expect(plan.layout.eyeOpenness).toBe("readable");
  expect(plan.layout.eyeTopology).toBe("asymmetric");
  expect(plan.layout.leftEyeWidth).not.toBe(plan.layout.rightEyeWidth);
  expect(plan.pixels.filter(p => p.role === "iris" && p.cluster === "left_eye")).toHaveLength(1);
  expect(plan.pixels.filter(p => p.role === "iris" && p.cluster === "right_eye")).toHaveLength(1);
});

it("records exact eye-axis plan/pixel changes and frozen twelve craft", async () => {
  const fixtures: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const subjects = fixtures.map(f => {
    const { analysis } = strictBoundaryAnalysisFromAnnotation(f);
    if (f.existing) analysis.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${f.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
    return { id: f.id, analysis, calibrated: !!f.existing };
  });
  subjects.push({ id: "current-geometry-fixed-context", calibrated: false,
    analysis: makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing,
      faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry }) });
  const baselineBytes = beforeRoot ? readFileSync(`${beforeRoot}/results.json`) : null;
  const previous = baselineBytes ? JSON.parse(baselineBytes.toString()) : null;
  const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
  const root = mkdtempSync("evaluation-artifacts/eye-axis-retention-20260927-");
  const cases = [];
  for (const subject of subjects) {
    const analysis = normalizeAnalysisForRendering(subject.analysis), plan = buildSkinPlan(analysis);
    const features = subject.id === "current-geometry-fixed-context" ? live.features : refineFeatureColorsFromAnalysis(analysis,
      fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, plan.hairPlan);
    const atlas = buildProceduralFallbackAtlas(features, style, plan);
    expect(atlas, subject.id).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
    const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(craft.ok, `${subject.id} ${JSON.stringify(craft)}`).toBe(true);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const changed = [];
    if (previous) {
      const before = previous.cases.find((r: { id: string }) => r.id === subject.id);
      expect(plan.hairPlan, subject.id).toEqual(before.plan.hairPlan);
      expect(plan.outfitPlan, subject.id).toEqual(before.plan.outfitPlan);
      const { eyeTiltOffset: afterTilt, mouthRow: afterMouthRow, ...afterLayout } = plan.facePixelPlan.layout;
      const { eyeTiltOffset: beforeTilt, mouthRow: beforeMouthRow, ...beforeLayout } = before.plan.facePixelPlan.layout;
      expect(afterLayout, subject.id).toEqual(beforeLayout);
      if (afterMouthRow !== beforeMouthRow) {
        expect(before.plan.facePixelPlan.mouthCollisionResolution).toEqual({ fromRow: afterMouthRow, toRow: beforeMouthRow, reason: "eye_pixel_collision" });
        expect(plan.facePixelPlan.mouthCollisionResolution).toBeUndefined();
      }
      expect(afterTilt).toBe(plan.facePixelPlan.layout.geometryUsage.eyes ? 0 : beforeTilt);
      const old = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
      let alphaDifferences = 0;
      for (let p = 0; p < 4096; p++) {
        if (atlas.rgba[p * 4 + 3] !== old.rgba[p * 4 + 3]) alphaDifferences++;
        if ([0, 1, 2].some(c => atlas.rgba[p * 4 + c] !== old.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
          expect(x >= 8 && x < 16 && y >= 8 && y < 16, subject.id).toBe(true);
        }
      }
      expect(alphaDifferences).toBe(0);
      if (!plan.facePixelPlan.layout.geometryUsage.eyes) {
        expect(plan).toEqual(before.plan); expect(changed).toEqual([]);
      }
    }
    cases.push({ id: subject.id, calibrated: subject.calibrated, plan, style, features,
      planHash: sha(JSON.stringify(plan)), atlasHash: sha(atlas.rgba), craft, changed });
    writeFileSync(`${root}/${subject.id}.png`, await encodePng(atlas), { flag: "wx" });
    const view = renderSkinViews(atlas).find(v => v.name === "front")!;
    writeFileSync(`${root}/${subject.id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, cases,
    limitation: "Current geometry replay uses partial saved primary plus fixed synthetic helper context; not fresh live evidence." }, null, 2), { flag: "wx" });
  if (baselineBytes) expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(baselineBytes);
  console.info(`EYE_AXIS_ROOT ${root}`);
}, 60_000);

it.each(["width-left", "width-right", "row-left", "row-right"])("keeps openness independent of %s", axis => {
  for (const openness of [0.2, 0.5, 0.8]) {
    const base = makeAnalysis(), g = makeIdentityGeometry();
    const width = axis.startsWith("width"), left = axis.endsWith("left");
    const leftY = !width && left ? 0.36 : 0.53, rightY = !width && !left ? 0.36 : 0.53;
    const input = makeAnalysis({ observed: { ...base.observed, accessories: "no glasses" }, negativePrompt: "no glasses",
      fallbackFeatures: { ...base.fallbackFeatures, glasses: "none", expression: "neutral" },
      identityGeometry: makeIdentityGeometry({ glasses: null,
        // Isolate eye axes from the separate raised-smile/eye collision grammar.
        mouth: { ...g.mouth, centerY: 0.8, leftCornerY: 0.8, rightCornerY: 0.8, opening: "closed", width: 0.16 },
        eyes: { ...g.eyes, openness, leftWidth: width ? left ? 0.20 : 0.10 : 0.15,
          rightWidth: width ? left ? 0.10 : 0.20 : 0.15,
          leftCenterY: leftY, rightCenterY: rightY, verticalAsymmetry: rightY - leftY },
        confidence: { ...g.confidence, eyes: 0.95 } }) });
    const variants = buildFacePixelPlanVariants(input, 3);
    expect(variants.length).toBeGreaterThan(0); expect(variants.length).toBeLessThanOrEqual(3);
    for (const plan of variants) {
      expect(plan.layout.eyeTopology).toBe("asymmetric");
      if (width) expect(plan.layout.leftEyeWidth).not.toBe(plan.layout.rightEyeWidth);
      else expect(plan.layout.leftEyeRow).not.toBe(plan.layout.rightEyeRow);
      for (const cluster of ["left_eye", "right_eye"] as const) {
        const iris = plan.pixels.filter(p => p.role === "iris" && p.cluster === cluster);
        expect(iris.length, `${axis}/${openness}/${cluster}/${plan.variantId}`).toBe(openness >= 0.68 ? 2 : 1);
      }
      expect(plan.candidateCost.violations).toEqual([]);
    }
  }
});
