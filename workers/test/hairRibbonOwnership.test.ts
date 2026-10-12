// Offline only. Historical H data stays immutable; no live runner import.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { hairRibbonFootprint } from "../src/hairRibbonFootprint";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { verifyLegwearRedesign } from "./savedLegwearRendererEvidence";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const pixel = (rgba: Uint8Array, p: { face: keyof typeof CLASSIC_LAYOUT.head.overlay; x: number; y: number }) => {
  const r = CLASSIC_LAYOUT.head.overlay[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
  return [...rgba.slice(i, i + 4)];
};

it.each(["left", "right", "center"] as const)("shares the unchanged clipped legacy ribbon footprint for %s", side => {
  const expected: ReturnType<typeof hairRibbonFootprint> = [];
  const add = (face: "front" | "left" | "right", cx: number) => {
    for (const [dx, y, pigment] of [[-1, 2, "ribbon"], [1, 2, "ribbon"], [0, 2, "knot"], [-2, 1, "light"], [2, 1, "shade"]] as const)
      if (cx + dx >= 0 && cx + dx < 8) expected.push({ face, x: cx + dx, y, pigment });
  };
  add("front", side === "center" ? 3 : side === "left" ? 1 : 6);
  if (side !== "center") add(side === "left" ? "right" : "left", side === "left" ? 6 : 1);
  expected.push({ face: "top", x: side === "center" ? 3 : side === "left" ? 1 : 6, y: 6, pigment: "ribbon" });
  expect(hairRibbonFootprint(side)).toEqual(expected);
});

it.each(["left", "right", "center"] as const)("makes %s ribbon scale change the actual bounded footprint", side => {
  const sizes = (["small", "medium", "large"] as const).map(scale => hairRibbonFootprint(side, scale));
  expect(sizes[0].length).toBeLessThan(sizes[1].length);
  expect(sizes[1].length).toBeLessThan(sizes[2].length);
  for (const cells of sizes) {
    expect(new Set(cells.map(c => `${c.face}:${c.x}:${c.y}`)).size).toBe(cells.length);
    expect(cells.every(c => c.x >= 0 && c.x < 8 && c.y >= 0 && c.y < 8)).toBe(true);
  }
  expect(hairRibbonFootprint(side)).toEqual(sizes[1]);
});

function input(side: "left" | "right" | "center", scale: "small" | "medium" | "large" = "small") {
  const a = makeAnalysis();
  a.observed.hair = `long straight brown hair with a ${scale} white hair bow`;
  a.observed.accessories = "a white hair bow";
  a.renderHints.hairAccessory = "bow"; a.renderHints.hairAccessorySide = side;
  a.renderHints.hairAccessoryColor = "white"; a.renderHints.hairAccessoryScale = scale;
  a.renderHints.overallHairLength = "chest"; a.renderHints.hairBackShape = "long";
  a.renderHints.hairTexture = "straight"; a.fallbackFeatures.hairstyle = "long";
  a.inferred.hairBack.value = "long brown hair continuing down the back";
  return a;
}

const sizedSides = (["left", "right", "center"] as const).flatMap(side =>
  (["small", "medium", "large"] as const).map(scale => ({ side, scale })));
it.each(sizedSides)("resolves and paints only $side/$scale ribbon cells without invented braids", ({ side, scale }) => {
  const a = input(side, scale), plan = buildSkinPlan(a), head = plan.headIdentityPlan.ownership!;
  expect(head.execution).toBe("resolved");
  const reserved = head.cells.filter(c => c.sourceGroupId === "head-ribbon-footprint");
  expect(reserved.map(c => `${c.face}:${c.x}:${c.y}`).sort()).toEqual(hairRibbonFootprint(side, scale).map(c => `${c.face}:${c.x}:${c.y}`).sort());
  expect(head.cells.some(c => c.sourceGroupId === "head-accessory-region")).toBe(false);
  expect(buildReferenceStylePlan(a).hair.family).not.toBe("twin_braids");
  const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, colors, plan.hairPlan), baseline = buildProceduralSourceAtlas(colors, style, plan)!;
  const result = renderReferencePrimaryAtlas(baseline, plan, a, style);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.summary.status).toBe("reference_style_accepted");
  for (const cell of reserved) expect(pixel(result.atlas.rgba, cell)).toEqual(pixel(baseline.rgba, cell));
  expect(validateFinalAtlas(result.atlas).ok).toBe(true);
});

it.each(["flower", "clip"] as const)("does not label unresolved %s as resolved ribbon", ornament => {
  const a = input("left"); a.observed.accessories = `a ${ornament} in the hair`;
  a.renderHints.hairAccessory = ornament;
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
});

it("does not resolve an additional unmodeled ornament, or a prose-only bow", () => {
  const a = input("left"); a.observed.accessories = "a bow and flower in the hair";
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
  a.observed.accessories = "a bow in the hair"; a.renderHints.hairAccessory = "none";
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
});

it("does not let the ribbon claim an actual eye window or glasses frame", () => {
  const a = input("left"), plan = buildSkinPlan(a);
  const face = structuredClone(plan.facePixelPlan);
  const eye = face.pixels.find(p => p.cluster === "left_eye" && p.role !== "brow")!;
  expect(eye).toBeTruthy();
  face.pixels.push({ ...eye, x: 2, y: 2 });
  let head = resolveHeadOwnership(a, plan.hairPlan, face);
  expect(head.cells.find(p => p.layer === "outer" && p.face === "front" && p.x === 2 && p.y === 2))
    .toMatchObject({ owner: "clear", sourceGroupId: "face-window" });
  // A frame spanning the same high temple cell still takes priority.
  face.glassesPlan.topology = "rectangular_thin";
  face.glassesPlan.framePixels = [{ face: "front", x: 2, y: 2, role: "rim_mid" }];
  head = resolveHeadOwnership(a, plan.hairPlan, face);
  expect(head.cells.find(p => p.layer === "outer" && p.face === "front" && p.x === 2 && p.y === 2))
    .toMatchObject({ owner: "glasses", sourceGroupId: "glasses-frame" });
});

it("replays saved H without missing-prompt reconstruction and records styled output separately", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-001";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
    const original = JSON.stringify(trace), style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    // This consumed run predates scale-aware ribbon paint. Medium reproduces
    // that single legacy footprint; do not pretend it is today's small bow.
    const old = buildProceduralSourceAtlas(features, { ...style, hairAccessoryScale: "medium" }, saved)!;
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    verifyLegwearRedesign(historical, old, saved.outfitPlan);
    // Resolver/selector consume only persisted observed/canonical/hint/fallback
    // fields. This is NOT a full primary-response or prompt reconstruction.
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const fixed = structuredClone(saved);
    fixed.headIdentityPlan.ownership = resolveHeadOwnership(a, saved.hairPlan, saved.facePixelPlan);
    expect(fixed.headIdentityPlan.ownership.execution).toBe("resolved");
    const baseline = buildProceduralSourceAtlas(features, style, fixed)!;
    const result = renderReferencePrimaryAtlas(baseline, fixed, a, style);
    if (!result.ok) {
      const selection = selectReferenceStyleAtlas(baseline, fixed, buildReferenceStylePlan(a), style);
      throw new Error(JSON.stringify({ reason: result.reason, candidates: selection.candidates.map(c => ({ quality: c.quality, foundation: c.foundation })) }));
    }
    expect(result.summary.status).toBe("reference_style_accepted");
    expect(result.summary.design!.hair.family).not.toBe("twin_braids");
    for (const p of hairRibbonFootprint(style.hairAccessorySide, style.hairAccessoryScale)) {
      expect(pixel(baseline.rgba, p)).toEqual(pixel(old.rgba, p));
      expect(pixel(result.atlas.rgba, p)).toEqual(pixel(old.rgba, p));
    }
    expect(validateFinalAtlas(result.atlas)).toEqual({ ok: true, problems: [] });
    expect(renderReferencePrimaryAtlas(baseline, fixed, a, style)).toEqual(result);
    expect(JSON.stringify(trace)).toBe(original); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/hair-ribbon-ownership-offline-20261010-");
    for (const [name, atlas] of [["historical", historical], ["current-renderer-before", old], ["resolved-source", baseline], ["styled", result.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ sourceRunId: run.runId, sourceSummarySha256: sha(bytes),
      scope: "saved_plan_ownership_counterfactual_not_live", missingPromptReconstructed: false,
      historicalMatchesLive: true, historicalRgba: sha(historical.rgba), currentRendererBeforeRgba: sha(old.rgba), resolvedSourceRgba: sha(baseline.rgba), styledRgba: sha(result.atlas.rgba),
      retainedRibbonPixelDiff: 0, intendedScaleFootprintChange: true, inventedBraids: false, oldReservation: saved.headIdentityPlan.ownership!.cells.filter(c => c.sourceGroupId === "head-accessory-region").length,
      newReservation: fixed.headIdentityPlan.ownership.cells.filter(c => c.sourceGroupId === "head-ribbon-footprint").length,
      result: result.summary, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`HAIR_RIBBON_OWNERSHIP ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);

it("delivers G003's stored small scale to paint without changing its body or eyes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-003";
    const bytes = readFileSync(`${root}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, { features, faceStyle: style } = t.injectedParameters;
    expect(style.hairAccessoryScale).toBe("small");
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    const legacyStyle = { ...style, hairAccessoryScale: "medium" as const };
    const oldBase = buildProceduralSourceAtlas(features, legacyStyle, saved)!;
    const old = composeReferenceStyleAtlas(oldBase, saved, t.referenceStyle.design, legacyStyle).atlas;
    verifyLegwearRedesign(historical, old, saved.outfitPlan);
    // Resolver consumes only persisted observation/canonical/category context.
    // No absent prompt or full primary response is reconstructed here.
    const projected = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const fixed = structuredClone(saved);
    fixed.headIdentityPlan.ownership = resolveHeadOwnership(projected, saved.hairPlan, saved.facePixelPlan);
    const base = buildProceduralSourceAtlas(features, style, fixed)!;
    const after = composeReferenceStyleAtlas(base, fixed, t.referenceStyle.design, style);
    const headCells = new Set<number>();
    for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT.head[layer]))
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) headCells.add((r.y + y) * 64 + r.x + x);
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => old.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      expect(headCells.has(i), `body changed at ${i}`).toBe(true); changed++;
    }
    expect(changed).toBeGreaterThan(0);
    for (const c of saved.facePixelPlan.pixels.filter(c => ["iris", "sclera"].includes(c.role))) {
      const r = CLASSIC_LAYOUT.head.base.front, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      expect(after.atlas.rgba.slice(i, i + 4)).toEqual(old.rgba.slice(i, i + 4));
    }
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, base, fixed, style,
      buildReferenceCraftPlan(fixed, t.referenceStyle.design, after)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(base, fixed, t.referenceStyle.design, style).atlas.rgba).toEqual(after.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/hair-ribbon-scale-g003-offline-20261011-");
    for (const [name, atlas] of [["live-legacy", historical], ["current-renderer-before", old], ["offline-small", after.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const v = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(v, v.width * 6, v.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/verification.json`, JSON.stringify({ scope: "current_renderer_saved_G003_scale_ownership_counterfactual_not_new_live", historicalRendererByteEqualityRequired: false,
      sourceSummarySha256: sha(bytes), observedScale: "small", legacyRenderedFootprint: "medium",
      changedHeadCells: changed, unrelatedBodyCells: 0, irisScleraUnchanged: true, craftValid: true, atlasValid: true,
      deterministic: true, providerCalls: 0, oldRgba: sha(old.rgba), afterRgba: sha(after.atlas.rgba) }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`G003_RIBBON_SCALE ${out}`);
  } finally { network.mockRestore(); }
}, 30000);
