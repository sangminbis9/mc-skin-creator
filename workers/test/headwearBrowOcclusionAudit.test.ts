// Offline ownership ablation, not a production policy or recovered observation.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { headwearFootprint, categoricalHeadwearBrowOcclusion } from "../src/headwearFootprint";
import { resolveHeadOwnership } from "../src/headOwnership";
import { measureFacePixelPlanCost } from "../src/identityPlans";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality, selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

it("isolates categorical brow instructions puncturing the observed headwear footprint", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    expect(sha(png)).toBe("da9c4621e73baaa871b76db9338140864de5c83c1c42eaa1c3ba09dbced2a73c");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const original: SkinPlan = t.skinPlan.skinPlan, plan: SkinPlan = structuredClone(original);
    const immutable = JSON.stringify([a, original]);
    expect(a.fallbackFeatures.hat).toBe("beanie");
    expect(plan.facePixelPlan.layout.geometryUsage.brows).toBe(false);
    const hat = new Set(headwearFootprint(a.fallbackFeatures.hat).filter(p => p.face === "front").map(p => `${p.x}:${p.y}`));
    const clashes = plan.facePixelPlan.pixels.filter(p => p.role === "brow" && hat.has(`${p.x}:${p.y}`));
    expect(categoricalHeadwearBrowOcclusion(a.fallbackFeatures.hat, plan.facePixelPlan.pixels, plan.facePixelPlan.layout)).toEqual(clashes.map(({ x, y }) => ({ x, y })));
    expect(clashes.map(p => [p.x, p.y])).toEqual([[1, 1], [2, 1], [6, 1], [5, 1]]);
    for (const p of clashes) {
      expect(original.headIdentityPlan.ownership!.cells.find(c => c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)?.owner).toBe("face");
      expect(original.headIdentityPlan.ownership!.cells.find(c => c.face === "front" && c.layer === "outer" && c.x === p.x && c.y === p.y)?.owner).toBe("clear");
    }
    // Study only: remove the collided paint instructions, never their source
    // observations/layout. Recompute ownership using the unchanged resolver.
    plan.facePixelPlan.pixels = plan.facePixelPlan.pixels.filter(p => !clashes.some(c => c.x === p.x && c.y === p.y));
    plan.headIdentityPlan.baseFace = plan.facePixelPlan;
    plan.headIdentityPlan.ownership = resolveHeadOwnership(a, plan.hairPlan, plan.facePixelPlan);
    expect(plan.facePixelPlan.layout).toEqual(original.facePixelPlan.layout);
    expect(plan.facePixelPlan.pixels.filter(p => p.role === "iris")).toEqual(original.facePixelPlan.pixels.filter(p => p.role === "iris"));
    const cost = measureFacePixelPlanCost(plan.facePixelPlan);
    expect(cost.violations).toEqual([]);
    for (const p of clashes) expect(plan.headIdentityPlan.ownership.cells.find(c => c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)?.owner).toBe("covering");
    const st = t.injectedParameters.faceStyle, features = t.injectedParameters.features, design = t.referenceStyle.design;
    const beforeBase = buildProceduralSourceAtlas(features, st, original)!;
    const before = composeReferenceStyleAtlas(beforeBase, original, design, st);
    expect(before.atlas.rgba).toEqual((await decodePng(png)).rgba);
    const afterBase = buildProceduralSourceAtlas(features, st, plan)!;
    const after = composeReferenceStyleAtlas(afterBase, plan, design, st);
    const quality = measureReferenceRenderedQuality(after, afterBase, plan, design, st);
    const craft = validateReferenceAtlasCraft(after.atlas, afterBase, plan, st, buildReferenceCraftPlan(plan, design, after));
    expect(quality.violations).toEqual([]); expect(craft.ok, JSON.stringify(craft)).toBe(true);
    const combinedPlan = structuredClone(plan), currentDesign = buildReferenceStylePlan(a);
    combinedPlan.outfitPlan.upper.pattern = buildOutfitPlan(a).upper.pattern;
    const combinedDesign = { ...design, eyeBoundaryPolicy: currentDesign.eyeBoundaryPolicy, drape: currentDesign.drape };
    const combinedBase = buildProceduralSourceAtlas(features, st, combinedPlan)!;
    const combined = selectReferenceStyleAtlas(combinedBase, combinedPlan, combinedDesign, st).selected!;
    expect(combined).not.toBeNull();
    expect(combined.composition.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_lower_pigment");
    expect(validateReferenceAtlasCraft(combined.composition.atlas, combinedBase, combinedPlan, st,
      buildReferenceCraftPlan(combinedPlan, combined.design, combined.composition)).ok).toBe(true);
    const head = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    const changed = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => before.atlas.rgba[i * 4 + c] !== after.atlas.rgba[i * 4 + c])) {
      const x = i % 64, y = Math.floor(i / 64);
      expect(head.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      changed.push({ x, y, before: [...before.atlas.rgba.slice(i * 4, i * 4 + 4)], after: [...after.atlas.rgba.slice(i * 4, i * 4 + 4)] });
    }
    const out = freshAuditOutput("evaluation-artifacts/headwear-brow-occlusion-audit-20261011-");
    for (const [name, image] of [["before", before.atlas], ["ablation", after.atlas], ["combined", combined.composition.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(image), { flag: "wx" });
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(renderSkinViews(image)[0].image, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_design_study_not_production_fix", providerCalls: 0,
      sourceSummarySha256: sha(bytes), historicalPngExact: true, clashes, geometryBrowsUsed: false,
      beforeRgba: sha(before.atlas.rgba), ablationRgba: sha(after.atlas.rgba), changed,
      combinedRgba: sha(combined.composition.atlas.rgba), combinedCraftPass: true,
      sourceAnalysisAndLayoutUnchanged: true, originalIrisInstructionsUnchanged: true,
      candidateViolations: cost.violations, craftPass: craft.ok, qualityViolations: quality.violations,
      earliestBoundary: "categorical_brow_paint_instructions_ignore_headwear_footprint",
      downstreamBoundary: "face_window_unconditionally_overrides_headwear_then_final_face_repaint",
      productionHelperVerified: true, fullFreshPlanReplay: false, freshLiveVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify([a, original])).toBe(immutable);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("HEADWEAR_BROW_AUDIT", out);
  } finally { network.mockRestore(); }
}, 60_000);
