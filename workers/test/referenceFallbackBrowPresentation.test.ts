import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { resolveHeadOwnership } from "../src/headOwnership";
import { referenceEyePresentation } from "../src/referenceFaceFinish";
import { FACE_STYLE_TEMPLATES, type FaceStyleFamily } from "../src/referenceStyleTemplates";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
const bytes = readFileSync(`${root}/summary.json`);
function context() {
  const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
  const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
  const plan: SkinPlan = structuredClone(t.skinPlan.skinPlan);
  plan.headIdentityPlan.ownership = resolveHeadOwnership(a, plan.hairPlan, plan.facePixelPlan);
  const hatColor = refineFeatureColorsFromAnalysis(a, t.injectedParameters.features).hatColor;
  const style = { ...t.injectedParameters.faceStyle, hatColor };
  const baseline = buildProceduralSourceAtlas({ ...t.injectedParameters.features, hatColor }, style, plan)!;
  const design = t.referenceStyle.design;
  const eye = [1, 3, 5].map(i => Number.parseInt(style.eyeColor.slice(i, i + 2), 16));
  return { a, plan, style, baseline, design, eye };
}
it("simplifies only paired unmeasured subtle default brows for existing categorical singleton eyes", () => {
  const c = context(), original = JSON.stringify(c.plan);
  const p = referenceEyePresentation(c.plan.facePixelPlan, c.design, c.eye, [], c.baseline);
  expect(p.kind).toBe("paired_upper_catch_unmeasured_brow");
  expect(p.cells.map(p => [p.x, p.y])).toEqual([[2, 3], [5, 3]]);
  expect(JSON.stringify(c.plan)).toBe(original);
});
it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("%s derives fallback presentation from pigment and positions, not source identity", family => {
  const c = context(), f = c.plan.facePixelPlan;
  c.design.face.family = family;
  // Synthetic contract variants, not new observations about the saved photo.
  for (const eye of [[74, 55, 40], [38, 73, 104], [156, 181, 198]]) for (const y of [4, 5]) {
    f.pixels = [
      { x: 2, y, role: "iris", cluster: "left_eye" }, { x: 5, y, role: "iris", cluster: "right_eye" },
      { x: 2, y: y - 1, role: "brow", cluster: "left_eye" }, { x: 5, y: y - 1, role: "brow", cluster: "right_eye" },
    ];
    const before = JSON.stringify(f), strength = FACE_STYLE_TEMPLATES[family].irisGlint;
    expect(referenceEyePresentation(f, c.design, eye, [], c.baseline)).toEqual({
      kind: "paired_upper_catch_unmeasured_brow", cells: [2, 5].map(x => ({ x, y: y - 1,
        color: eye.map((v, ch) => Math.round(v * (1 - strength) + [248, 246, 240][ch] * strength)) })),
    });
    expect(JSON.stringify(f)).toBe(before);
  }
});
it.each(["measured", "distance", "slope", "nonzero_confidence", "missing_trace", "semantic_salience", "strong", "extra_brow",
  "one_brow", "other_cluster", "glasses", "hair", "outer", "protected_eye"] as const)("does not replace %s evidence or manufacture a half-pair", kind => {
  const c = context(), f = c.plan.facePixelPlan, l = f.layout;
  const protectedCells: { x: number; y: number }[] = [];
  if (kind === "measured") l.geometryUsage.brows = true;
  if (kind === "distance") l.measurementTrace!.browEyeDistance = { ...l.measurementTrace!.browEyeDistance, value: "normal", selected: "categorical_grammar" };
  if (kind === "slope") l.measurementTrace!.browSlope = { ...l.measurementTrace!.browSlope, value: "straight", provenance: "observed_categorical" };
  if (kind === "nonzero_confidence") l.measurementTrace!.browSlope.confidence = 0.2;
  if (kind === "missing_trace") l.measurementTrace = undefined;
  if (kind === "semantic_salience") l.salience.tertiary.find(c => c.axis === "brow_position")!.score = 0.2;
  if (kind === "strong") l.browThickness = "strong";
  if (kind === "extra_brow") f.pixels.push({ x: 3, y: 2, cluster: "left_eye", role: "brow" });
  if (kind === "one_brow") f.pixels = f.pixels.filter(p => p.role !== "brow" || p.cluster === "left_eye");
  if (kind === "other_cluster") f.pixels.push({ x: 2, y: 3, cluster: "fringe", role: "hair_mid" });
  if (kind === "glasses") f.glassesPlan.topology = "rectangular_thin";
  if (kind === "hair") protectedCells.push({ x: 2, y: 3 });
  if (kind === "outer") { const r = CLASSIC_LAYOUT.head.overlay.front; c.baseline.rgba[((r.y + 3) * 64 + r.x + 2) * 4 + 3] = 255; }
  if (kind === "protected_eye") f.protectedGeometry.push("eye_layout");
  expect(referenceEyePresentation(f, c.design, c.eye, protectedCells, c.baseline)).toEqual({ kind: "retain_source", cells: [] });
});
it("changes only D's two fallback-brow presentation cells, with validated source/PNG and forged-paint rejection", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const c = context(), original = JSON.stringify([c.a, c.plan]);
    const result = renderReferencePrimaryAtlas(c.baseline, c.plan, c.a, c.style);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok || !result.summary.design) throw Error("render_not_accepted");
    const composition = composeReferenceStyleAtlas(c.baseline, c.plan, result.summary.design, c.style);
    expect(composition.atlas.rgba).toEqual(result.atlas.rgba);
    const presentation = composition.diagnostic.faceFinish.eyePresentation;
    expect(presentation.kind).toBe("paired_upper_catch_unmeasured_brow");
    const r = CLASSIC_LAYOUT.head.base.front, offsets = presentation.cells.map(p => ((r.y + p.y) * 64 + r.x + p.x) * 4);
    const before = await decodePng(readFileSync("evaluation-artifacts/teal-hat-eye-boundary-offline-20261010-aMCalj/current.png"));
    for (let i = 0; i < result.atlas.rgba.length; i += 4) {
      expect(result.atlas.rgba[i + 3]).toBe(before.rgba[i + 3]);
      if (!offsets.includes(i)) expect(result.atlas.rgba.slice(i, i + 4), `unrelated:${i}`).toEqual(before.rgba.slice(i, i + 4));
    }
    for (const kind of ["paint", "diagnostic", "false_evidence"] as const) {
      const bad = structuredClone(composition), plan = structuredClone(c.plan);
      if (kind === "paint") bad.atlas.rgba[offsets[0]] = 0;
      if (kind === "diagnostic") bad.diagnostic.faceFinish.eyePresentation = { kind: "retain_source", cells: [] };
      if (kind === "false_evidence") plan.facePixelPlan.layout.measurementTrace!.browSlope.value = "straight";
      expect(measureReferenceRenderedQuality(bad, c.baseline, plan, result.summary.design, c.style).violations.length).toBeGreaterThan(0);
    }
    const png = await encodePng(result.atlas); expect((await decodePng(png)).rgba).toEqual(result.atlas.rgba);
    expect(JSON.stringify([c.a, c.plan])).toBe(original);
    const out = freshAuditOutput("evaluation-artifacts/fallback-brow-presentation-offline-20261010-");
    for (const [name, image] of [["before", before], ["after", result.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(image), { flag: "wx" });
      const front = renderSkinViews(image).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, scope: "offline_saved_D005_not_live",
      presentation, changedPixels: 2, unrelatedPixelDiff: 0, sourcePlanUnchanged: true, craft: result.summary.craftValidation,
      forgedPaintAndEvidenceRejected: true, otherQualityDefectsRemain: true }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled(); console.info("FALLBACK_BROW", out);
  } finally { network.mockRestore(); }
}, 60_000);
