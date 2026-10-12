import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { buildFacePixelPlanVariants, buildIdentityPixelPlans, measureFacePixelPlanCost } from "../src/identityPlans";
import * as quantization from "../src/identityQuantization";

const file = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-022/summary.json";
it("confirms frozen baseline equality and separates older eye-axis snapshot drift from this quantizer fix", async () => {
  const beforeRoot = "evaluation-artifacts/current-010-scalp-close-20260927-mSXJ0e";
  const afterRoot = "evaluation-artifacts/current-010-scalp-close-20260927-q6fz6B";
  const oldRoot = "evaluation-artifacts/eye-axis-retention-20260927-zZif8t";
  const before = JSON.parse(readFileSync(`${beforeRoot}/results.json`, "utf8"));
  const after = JSON.parse(readFileSync(`${afterRoot}/results.json`, "utf8"));
  const rows = [];
  for (const entry of before.cases.filter((c: { id: string }) => c.id !== "live-010-replay")) {
    const current = after.cases.find((c: { id: string }) => c.id === entry.id);
    expect(current.planHash).toBe(entry.planHash); expect(current.rgbaHash).toBe(entry.rgbaHash);
    expect(current.craft.ok).toBe(true);
    const old = await decodePng(readFileSync(`${oldRoot}/${entry.id}.png`));
    const pre = await decodePng(readFileSync(`${beforeRoot}/${entry.id}.png`));
    const oldDrift = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => old.rgba[i * 4 + c] !== pre.rgba[i * 4 + c])) oldDrift.push({ x: i % 64, y: Math.floor(i / 64) });
    rows.push({ id: entry.id, calibrated: entry.calibrated, currentPlanDiff: false, currentAtlasDiff: false, olderSnapshotDrift: oldDrift });
  }
  expect(rows).toHaveLength(12); expect(rows.filter(r => r.calibrated)).toHaveLength(5);
  expect(rows.some(r => r.olderSnapshotDrift.length > 0)).toBe(true);
  const out = mkdtempSync("evaluation-artifacts/current-022-geometry-frozen-equality-20260928-");
  writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, afterRoot, oldRoot, rows,
    limitation: "Older eye-axis snapshot failure predates this change; no baseline/validator updated to conceal it." }, null, 2), { flag: "wx" });
  console.info(`GEOMETRY_FROZEN_EQUALITY ${out}`);
});
function input() {
  const live = JSON.parse(readFileSync(file, "utf8")).currentDefaultE2E.result, p = live.diagnostics.normalizedPrimary;
  return { live, analysis: normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair,
    outfitPrompt: p.observed.clothing, negativePrompt: "", faceIdentityGeometry: structuredClone(live.diagnostics.geometry.acceptedGeometry) })) };
}
it.each([false, true])("preserves signed width order with the unchanged contract (mirror=%s)", mirror => {
  const { analysis } = input(), g = analysis.faceIdentityGeometry!;
  if (mirror) [g.eyes.leftWidth, g.eyes.rightWidth] = [g.eyes.rightWidth, g.eyes.leftWidth];
  const before = structuredClone(g), plans = buildFacePixelPlanVariants(analysis, 99);
  expect(plans.length).toBeGreaterThan(0); expect(plans.length).toBeLessThanOrEqual(3);
  for (const plan of plans) {
    expect(plan.candidateCost.violations).toEqual([]);
    expect(Math.sign(plan.layout.leftEyeWidth - plan.layout.rightEyeWidth)).toBe(mirror ? -1 : 1);
    expect(plan.layout.leftEyeRow).toBe(plan.layout.rightEyeRow);
    expect(plan.layout.eyeOpenness).toBe("readable");
    for (const cluster of ["left_eye", "right_eye"]) expect(plan.pixels.filter(p => p.cluster === cluster && p.role === "iris")).toHaveLength(1);
  }
  expect(g).toEqual(before);
});
it.each(["low-confidence", "symmetric", "sub-contract-width"])("does not invent width asymmetry for %s", mode => {
  const { analysis } = input(), g = analysis.faceIdentityGeometry!;
  if (mode === "low-confidence") g.confidence.eyes = 0.74;
  else g.eyes.leftWidth = mode === "symmetric" ? g.eyes.rightWidth : g.eyes.rightWidth + 0.02;
  const p = buildFacePixelPlanVariants(analysis, 1)[0]; expect(p).toBeDefined();
  expect(p.layout.renderContract.eyes?.preserveAsymmetry).toBe(false);
  expect(p.layout.leftEyeWidth).toBe(p.layout.rightEyeWidth);
});
it("renders accepted geometry without dropping it and isolates changes to head pixels", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const { analysis, live } = input(), primaryOnly = { ...analysis, faceIdentityGeometry: undefined };
    // Keep the actual saved body/inference plan. Only rebuild identity parts
    // from the recorded fields; omitted rich inference is never fabricated.
    const beforePlan = { ...structuredClone(live.analysis.skinPlan), ...buildIdentityPixelPlans(primaryOnly) };
    const afterPlan = { ...structuredClone(live.analysis.skinPlan), ...buildIdentityPixelPlans(analysis) };
    expect(afterPlan.facePixelPlan.layout.geometryUsage.eyes).toBe(true);
    expect(afterPlan.facePixelPlan.candidateCost.violations).toEqual([]);
    expect(afterPlan.outfitPlan).toEqual(beforePlan.outfitPlan); expect(afterPlan.hairPlan).toEqual(beforePlan.hairPlan);
    const out = mkdtempSync("evaluation-artifacts/current-022-geometry-retained-20260928-");
    const images = [];
    for (const [name, a, plan] of [["primary-only", primaryOnly, beforePlan], ["accepted-geometry", analysis, afterPlan]] as const) {
      const style = buildFaceStyle(a, live.features, plan.hairPlan), atlas = buildProceduralFallbackAtlas(live.features, style, plan);
      expect(atlas).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan); expect(craft.ok, JSON.stringify(craft)).toBe(true);
      images.push(atlas);
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    let changed = 0;
    for (let i = 0; i < 4096; i++) {
      expect(images[0].rgba[i * 4 + 3]).toBe(images[1].rgba[i * 4 + 3]);
      if ([0, 1, 2].some(c => images[0].rgba[i * 4 + c] !== images[1].rgba[i * 4 + c])) { expect(Math.floor(i / 64)).toBeLessThan(16); changed++; }
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, changedHeadPixels: changed, bodyDiff: 0, alphaDiff: 0,
      geometryUsage: afterPlan.facePixelPlan.layout.geometryUsage, layout: afterPlan.facePixelPlan.layout,
      candidateCost: afterPlan.facePixelPlan.candidateCost, craftPass: true,
      limitation: "Stored accepted geometry with fixed synthetic context for omitted rich fields. Offline render, not a new live result." }, null, 2), { flag: "wx" });
    console.info(`GEOMETRY_022_RETAINED ${out}`); expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 30_000);
it("retains required 022 width asymmetry without accepting a contract-violating plan", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const bytes = readFileSync(file), live = JSON.parse(bytes.toString()).currentDefaultE2E.result, p = live.diagnostics.normalizedPrimary;
  const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair,
    outfitPrompt: p.observed.clothing, negativePrompt: "", faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry }));
  try {
    const layouts = quantization.buildQuantizedLayoutVariants(a, 3);
    const actual = buildFacePixelPlanVariants(a, 3);
    const rows = layouts.map(variant => {
      // Diagnostic-only ablation exposes pixels to score with the ORIGINAL
      // contract below. It is never returned as an accepted production plan.
      const probe = vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([
        { ...structuredClone(variant), layout: { ...structuredClone(variant.layout), renderContract: {} } },
      ]);
      try {
        const raw = buildFacePixelPlanVariants(a, 1)[0];
        return { variant, pixelStageReached: !!raw, originalCost: raw
          ? measureFacePixelPlanCost({ ...raw, layout: { ...raw.layout, renderContract: variant.layout.renderContract } }) : null,
          pixels: raw?.pixels ?? null };
      } finally { probe.mockRestore(); }
    });
    const out = mkdtempSync("evaluation-artifacts/current-022-geometry-admissibility-20260928-");
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, acceptedCandidateCount: actual.length,
      summarySha256: createHash("sha256").update(bytes).digest("hex"), rows,
      limitation: "Audit-only contract ablation exposes rejection cost; never an accepted render or validation bypass." }, null, 2), { flag: "wx" });
    expect(readFileSync(file)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`GEOMETRY_022_REJECTION ${out}`);
    expect(actual.length).toBeGreaterThan(0); expect(actual.length).toBeLessThanOrEqual(3);
    for (const plan of actual) {
      expect(plan.layout.renderContract.eyes?.preserveAsymmetry).toBe(true);
      expect(plan.layout.leftEyeWidth).toBeGreaterThan(plan.layout.rightEyeWidth);
      expect(plan.layout.eyeTopology).toBe("asymmetric");
      expect(plan.layout.eyeOpenness).toBe("readable");
      expect(plan.candidateCost.violations).toEqual([]);
    }
  } finally { network.mockRestore(); }
});
