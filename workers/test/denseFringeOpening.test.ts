import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { PixelRenderHints } from "../src/analysis";
import * as opening from "../src/semanticFringeOpening";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

function authored(hints: Partial<PixelRenderHints> = {}) {
  const raw = makeAnalysis();
  raw.observed.hair = "straight jaw-length gray hair with dense bangs and a small visible central fringe opening";
  raw.observed.accessories = "none";
  raw.identityPrompt = raw.observed.hair;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair];
  raw.canonicalIdentity.features = [];
  Object.assign(raw.fallbackFeatures, { hairstyle: "medium", hat: "none", glasses: "none", facialHair: "none" });
  Object.assign(raw.renderHints, { overallHairLength: "jaw", sideHairLength: "jaw", hairTexture: "straight",
    hairSilhouette: "tousled", hairVolume: "full", bangs: "straight", bangsLength: "eye", bangsDensity: "dense",
    fringeEdge: "staggered", fringeOpening: "center", hairPart: "none", hairAccessory: "none", ...hints });
  const analysis = normalizeAnalysisForRendering(raw);
  return { analysis, plan: buildSkinPlan(analysis) };
}

it("preserves a central opening without turning unparted dense straight fringe into a two-column split", () => {
  const { analysis, plan } = authored();
  expect(analysis.renderHints).toMatchObject({ bangsDensity: "dense", fringeOpening: "center", hairPart: "none" });
  expect(plan.facePixelPlan.layout.geometryUsage.hairline).toBe(false);
  expect(plan.facePixelPlan.layout.hairlineDepthByColumn).toEqual([3, 3, 3, 0, 3, 3, 3, 3]);
  expect(plan.hairPlan.structure.fringe.openingColumns).toEqual([3]);
  expect(plan.hairPlan.structure.groups.some(g => g.kind === "fringe" && g.points.some(p => p.layer === "base" && p.x === 4 && p.y === 2))).toBe(true);
});

it.each([
  { bangsDensity: "balanced" }, { bangsDensity: "sparse" }, { bangs: "curtain" },
  { hairPart: "center" }, { hairPart: "left" }, { bangsLength: "short" },
] satisfies Array<Partial<PixelRenderHints>>)("keeps the established opening for unsupported density/part/length %j", hints => {
  const { plan } = authored(hints);
  expect(plan.facePixelPlan.layout.hairlineDepthByColumn.slice(3, 5)).toEqual([0, 0]);
  expect(plan.hairPlan.structure.fringe.openingColumns).toEqual([3, 4]);
});

it("never infers an opening from dense fringe alone", () => {
  const { plan } = authored({ fringeOpening: "none" });
  expect(plan.facePixelPlan.layout.hairlineDepthByColumn).toEqual(Array(8).fill(3));
  expect(plan.hairPlan.structure.fringe.openingColumns).toEqual([]);
});

it("preserves measured hairline plans byte-for-byte", () => {
  const raw = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
  Object.assign(raw.renderHints, { bangs: "straight", bangsDensity: "dense", bangsLength: "eye", fringeOpening: "center", hairPart: "none" });
  const after = buildSkinPlan(raw);
  expect(after.facePixelPlan.layout.geometryUsage.hairline).toBe(true);
  const old = vi.spyOn(opening, "narrowDenseSemanticOpening").mockReturnValue(false);
  try { expect(buildSkinPlan(raw)).toEqual(after); } finally { old.mockRestore(); }
});

it("records authored before/after PNGs and isolates the intended unmeasured fringe change", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
  try {
    const out = freshAuditOutput("evaluation-artifacts/dense-fringe-opening-offline-20261011-");
    const render = () => {
      const b = authored(), { analysis, plan } = b;
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
      const base = buildProceduralSourceAtlas(features, style, plan)!;
      return { ...b, base, style, design, composed: composeReferenceStyleAtlas(base, plan, design, style) };
    };
    const after = render();
    const old = vi.spyOn(opening, "narrowDenseSemanticOpening").mockReturnValue(false);
    let before: ReturnType<typeof render>;
    try { before = render(); } finally { old.mockRestore(); }
    expect(after.analysis).toEqual(before.analysis);
    expect(after.plan.facePixelPlan.pixels.filter(p => p.cluster !== "fringe"))
      .toEqual(before.plan.facePixelPlan.pixels.filter(p => p.cluster !== "fringe"));
    const results = [];
    for (const [name, b] of [["before", before], ["after", after]] as const) {
      const atlas = b.composed.atlas;
      expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(atlas, b.base, b.plan, b.style, buildReferenceCraftPlan(b.plan, b.design, b.composed)).ok).toBe(true);
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ name, provenance: "authored_design_unit_not_reconstructed_live_analysis", rgbaSha256: sha(atlas.rgba),
        layoutDepths: b.plan.facePixelPlan.layout.hairlineDepthByColumn, openingColumns: b.plan.hairPlan.structure.fringe.openingColumns });
    }
    let changedHead = 0, changedBody = 0;
    for (let i = 0; i < before.composed.atlas.rgba.length; i += 4) {
      if (before.composed.atlas.rgba.slice(i, i + 4).some((v, c) => v !== after.composed.atlas.rgba[i + c])) {
        if (Math.floor(i / 4 / 64) < 16) changedHead++; else changedBody++;
      }
    }
    expect(changedHead).toBeGreaterThan(0); expect(changedBody).toBe(0);
    writeFileSync(`${out}/summary.json`, JSON.stringify({ results, changedHead, changedBody, providerCalls: 0,
      sourceCategoriesUnchanged: true, nonFringeFacePixelsUnchanged: true, atlasPass: true, referenceCraftPass: true,
      freshLiveFixVerified: false }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("DENSE_FRINGE_OPENING", out);
  } finally { network.mockRestore(); }
});
