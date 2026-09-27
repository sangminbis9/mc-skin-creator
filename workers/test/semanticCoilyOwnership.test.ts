import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, fallbackFeaturesToHex, normalizeAnalysisForRendering, buildProceduralFallbackAtlas } from "../src/generate";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { encodePng, type RawImage } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { buildHairStructurePlan } from "../src/headStructure";

const saved = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json", "utf8")).currentDefaultE2E.result.diagnostics.normalizedPrimary;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

it("compares resolved semantic coily ownership with the preserved legacy grammar offline", async () => {
  const guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const base = makeAnalysis();
    // Retain only saved observations/hints/cache. Unsaved context is explicitly
    // synthetic and this is not a reconstruction of the whole live analysis.
    const analysis = normalizeAnalysisForRendering(makeAnalysis({
      observed: saved.observed, renderHints: saved.renderHints,
      fallbackFeatures: saved.fallbackFeatures,
      canonicalIdentity: saved.canonicalIdentity,
      identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing,
      inferred: base.inferred,
    }));
    const plan = buildSkinPlan(analysis);
    // Freeze the earlier controlled outfit while isolating hair. The separate
    // plaid regression exercises current outfit planning and combined output.
    plan.outfitPlan.upper.baseColor = "#416b9d";
    plan.outfitPlan.upper.leftSleeve.color = "#416b9d";
    plan.outfitPlan.upper.rightSleeve.color = "#416b9d";
    plan.outfitPlan.upper.collarColor = plan.outfitPlan.upper.accentColor;
    plan.outfitPlan.upper.colorBlocks.find(b => b.id === "upper_base")!.color = "#416b9d";
    plan.outfitPlan.upper.pattern = { ...plan.outfitPlan.upper.pattern, kind: "horizontal_stripe", color: plan.outfitPlan.upper.accentColor, frequency: 3 };
    plan.outfitPlan.upper.neckline.innerVisible = true;
    if (!plan.outfitPlan.upper.colorBlocks.some(b => b.id === "inner_panel")) plan.outfitPlan.upper.colorBlocks.push({ id: "inner_panel", region: "front_center", color: plan.outfitPlan.upper.accentColor, source: "observed", priority: 0.95 });
    if (!plan.outfitPlan.upper.colorBlocks.some(b => b.id === "stripe_band")) plan.outfitPlan.upper.colorBlocks.push({ id: "stripe_band", region: "horizontal_band", color: plan.outfitPlan.upper.accentColor, source: "observed", priority: 0.88 });
    const beforePlan = structuredClone(plan), afterPlan = structuredClone(plan);
    expect(plan.hairPlan.surfaceOnly).toBe(true);
    expect(plan.headIdentityPlan.ownership.execution).toBe("resolved");
    expect(plan.hairPlan.texture).toBe("coily");
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.headIdentityPlan.ownership.cells.filter(p => p.layer === "outer" && p.owner === "hair_outer")).toEqual([]);
    // Explicit historical ablation; only remove the new internal depth flag
    // and restore the unprojected groups using the unchanged group builder.
    delete beforePlan.hairPlan.surfaceOnly;
    beforePlan.hairPlan.structure = buildHairStructurePlan(analysis, plan.facePixelPlan.layout, plan.hairPlan.headMask, plan.hairPlan.salience);
    beforePlan.headIdentityPlan.ownership.execution = "preserve_existing_grammar";
    const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone), skinTone: "#633a23" };
    const style = buildFaceStyle(analysis, features);
    // Use the real deterministic packer but retain a rejected candidate for
    // diagnostic images. Acceptance below still uses unmodified craft rules.
    const render = (p: typeof plan) => {
      let candidate: RawImage | undefined;
      const accepted = buildProceduralFallbackAtlas(features, style, p, (stage, atlas) => {
        if (stage === "final_head") candidate = { ...atlas, rgba: atlas.rgba.slice() };
      });
      if (!candidate) throw new Error("no_deterministic_candidate");
      return accepted ?? candidate;
    };
    const before = render(beforePlan), after = render(afterPlan);
    expect(sha(before.rgba)).toBe("8c5e2190600f030a0c29425122f2b7e83d8f64b34b793b8bb04d347e24fe1b72");
    const verdict = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    const root = mkdtempSync("evaluation-artifacts/semantic-coily-ownership-20260926-");
    const changed = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) {
        writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
        if (view.name === "front") writeFileSync(`${root}/${name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
      }
    }
    const protectedCells = plan.facePixelPlan.pixels.filter(p => p.cluster !== "fringe");
    const front = CLASSIC_LAYOUT.head.base.front;
    const identityDiff = protectedCells.filter(p => {
      const at = ((front.y + p.y) * 64 + front.x + p.x) * 4;
      return !before.rgba.slice(at, at + 4).every((v, i) => v === after.rgba[at + i]);
    });
    writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_ownership_ablation_not_new_live", providerCalls: 0,
      beforeHash: sha(before.rgba), afterHash: sha(after.rgba), changed, identityDiff,
      craft: verdict, finalAtlas: validateFinalAtlas(after), defaultExecution: plan.headIdentityPlan.ownership.execution,
      productionRendererAcceptsCandidate: buildProceduralFallbackAtlas(features, style, afterPlan) !== null,
    }, null, 2), { flag: "wx" });
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every(p => p.y < 16)).toBe(true);
    expect(identityDiff).toEqual([]);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(validateFinalAtlas(after).ok).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  } finally { guard.mockRestore(); }
});

it.each(["measured", "headscarf", "ornament", "hidden"] as const)("does not override %s context with semantic surface-only hair", mode => {
  const base = makeAnalysis();
  const input = makeAnalysis({
    observed: { ...base.observed, hair: "very short cropped black hair" },
    renderHints: { ...saved.renderHints },
    fallbackFeatures: { ...base.fallbackFeatures, hat: mode === "headscarf" ? "headscarf" : "none" },
  });
  if (mode === "measured") input.identityGeometry = makeIdentityGeometry();
  if (mode === "ornament") input.renderHints.hairAccessory = "bow";
  if (mode === "hidden") input.visibleRegions.hair = false;
  expect(buildSkinPlan(input).hairPlan.surfaceOnly).toBeUndefined();
});

it.each([
  ["very short cropped black hair", "full", "cropped", "none"],
  ["coily hair", "flat", "cropped", "none"],
  ["not close-cropped hair", "flat", "cropped", "none"],
  ["very short cropped black hair", "flat", "ear", "none"],
  ["very short cropped black hair", "flat", "cropped", "short"],
  ["very short cropped locs", "flat", "cropped", "none"],
] as const)("does not infer surface-only depth from incomplete/conflicting evidence: %s/%s/%s/%s", (hair, volume, length, side) => {
  const base = makeAnalysis();
  const input = makeAnalysis({ observed: { ...base.observed, hair }, renderHints: { ...base.renderHints, hairTexture: "coily", hairVolume: volume, overallHairLength: length, sideHairLength: side, bangs: "none" } });
  expect(buildSkinPlan(input).hairPlan.surfaceOnly).toBeUndefined();
});
