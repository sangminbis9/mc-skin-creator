import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { referenceEyePresentation } from "../src/referenceFaceFinish";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
const b = CLASSIC_LAYOUT.head.base.front, o = CLASSIC_LAYOUT.head.overlay.front;
const at = (x: number, y: number, r = b) => ((r.y + y) * 64 + r.x + x) * 4;
function context() {
  const bytes = readFileSync(`${root}/summary.json`);
  expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
  const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
  const plan: SkinPlan = structuredClone(t.skinPlan.skinPlan), historical: ReferenceStylePlan = t.referenceStyle.design;
  const design = { ...historical, eyeBoundaryPolicy: buildReferenceStylePlan({ ...t.primary, ...t.renderAnalysis }).eyeBoundaryPolicy };
  const st = t.injectedParameters.faceStyle, base = buildProceduralSourceAtlas(t.injectedParameters.features, st, plan)!;
  const material = plan.headIdentityPlan.ownership!.cells.filter(c => c.face === "front" && c.layer === "base"
    && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
  return { bytes, t, plan, historical, design, st, base, material, eye: [74, 55, 40] };
}

it.each([[74, 55, 40], [38, 73, 104], [156, 181, 198]])("retains source pigment in a bounded lower pair: %j", (...eye) => {
  const c = context(), before = JSON.stringify(c.plan);
  const p = referenceEyePresentation(c.plan.facePixelPlan, c.design, eye, c.material, c.base);
  expect(p.kind).toBe("paired_lower_pigment");
  expect(p.cells.map(p => [p.x, p.y])).toEqual([[2, 3], [2, 4], [5, 3], [5, 4]]);
  expect(p.cells.filter(p => p.y === 4).every(p => JSON.stringify(p.color) === JSON.stringify(eye))).toBe(true);
  expect(JSON.stringify(c.plan)).toBe(before);
});

it.each(["historical", "measured", "protected", "asymmetric", "unknown", "compact", "glasses", "one_eye", "tilt",
  "one_upper_material", "hairline_only", "lower_hair", "lower_beard", "lower_mouth", "lower_brow", "mouth_row",
  "lower_outer", "iris_outer", "lower_transparent", "invalid_coordinate", "anonymous_material", "nonhair_material", "iris_inside_hairline"] as const)("retains source when %s blocks bounded presentation", reason => {
  const c = context(), f = c.plan.facePixelPlan;
  let material: Array<{ x: number; y: number; owner?: string }> = c.material;
  if (reason === "anonymous_material") material = material.map(({ x, y }) => ({ x, y }));
  if (reason === "nonhair_material") material = material.map(p => ({ ...p, owner: "other_p5" }));
  if (reason === "historical") delete c.design.eyeBoundaryPolicy;
  if (reason === "measured") f.layout.geometryUsage.eyes = true;
  if (reason === "protected") f.protectedGeometry.push("eye_layout");
  if (reason === "asymmetric") f.renderContract.eyes!.preserveAsymmetry = true;
  if (reason === "unknown") f.layout.measurementTrace!.eyeOpenness.value = "unknown";
  if (reason === "compact") f.layout.eyeOpenness = "compact";
  if (reason === "glasses") f.glassesPlan.topology = "rectangular_thin";
  if (reason === "one_eye") f.pixels = f.pixels.filter(p => p.cluster !== "left_eye");
  if (reason === "tilt") f.pixels.find(p => p.role === "iris")!.y++;
  if (reason === "one_upper_material") material = material.filter(p => p.x !== 2 || p.y !== 2);
  if (reason === "hairline_only") material = [];
  if (reason === "iris_inside_hairline") f.layout.hairlineDepthByColumn[2] = 3;
  if (reason === "lower_hair" || reason === "lower_beard") material = [...material, { x: 2, y: 4 }];
  if (reason === "lower_mouth") f.pixels.push({ x: 2, y: 4, cluster: "mouth", role: "lip" });
  if (reason === "lower_brow") f.pixels.push({ x: 2, y: 4, cluster: "left_eye", role: "brow" });
  if (reason === "mouth_row") {
    f.pixels.filter(p => p.role === "iris").forEach(p => { p.y = 4; });
    for (const x of [2, 5]) f.layout.hairlineDepthByColumn[x] = 3;
    material = [...material, { x: 2, y: 3, owner: "covering" }, { x: 5, y: 3, owner: "covering" }];
  }
  if (reason === "lower_outer") c.base.rgba[at(2, 4, o) + 3] = 255;
  if (reason === "iris_outer") c.base.rgba[at(2, 3, o) + 3] = 255;
  if (reason === "lower_transparent") c.base.rgba[at(2, 4) + 3] = 0;
  if (reason === "invalid_coordinate") f.pixels.find(p => p.role === "iris")!.x = 2.5;
  expect(referenceEyePresentation(f, c.design, c.eye, material, c.base)).toEqual({ kind: "retain_source", cells: [] });
});

it("delivers the declared four-cell design, protects all other pixels and rejects forged alternatives", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const c = context(), immutable = JSON.stringify([c.plan, c.t]), png = readFileSync(`${root}/skin.png`);
    const before = composeReferenceStyleAtlas(c.base, c.plan, c.historical, c.st);
    expect(before.atlas.rgba).toEqual((await decodePng(png)).rgba);
    const after = composeReferenceStyleAtlas(c.base, c.plan, c.design, c.st);
    expect(after.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_lower_pigment");
    const allowed = new Set([at(2, 3), at(2, 4), at(5, 3), at(5, 4)]); let changed = 0;
    for (let i = 0; i < before.atlas.rgba.length; i += 4) {
      expect(after.atlas.rgba[i + 3]).toBe(before.atlas.rgba[i + 3]);
      if (![0, 1, 2].some(ch => before.atlas.rgba[i + ch] !== after.atlas.rgba[i + ch])) continue;
      changed++; expect(allowed.has(i)).toBe(true);
    }
    expect(changed).toBe(4);
    const quality = measureReferenceRenderedQuality(after, c.base, c.plan, c.design, c.st);
    expect(quality.violations).toEqual([]);
    expect(validateReferenceAtlasCraft(after.atlas, c.base, c.plan, c.st, buildReferenceCraftPlan(c.plan, c.design, after)).ok).toBe(true);
    const selected = selectReferenceStyleAtlas(c.base, c.plan, c.design, c.st).selected!;
    expect(selected).not.toBeNull(); expect(selected.composition.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_lower_pigment");
    // Independent accumulated fixes are transferred only through their tested
    // contracts. Missing historical prompt context remains unavailable.
    const a = { ...c.t.primary, ...c.t.renderAnalysis }, combinedPlan = structuredClone(c.plan);
    combinedPlan.outfitPlan.upper.pattern = buildOutfitPlan(a).upper.pattern;
    const combinedDesign = { ...c.design, drape: buildReferenceStylePlan(a).drape };
    const combinedBase = buildProceduralSourceAtlas(c.t.injectedParameters.features, c.st, combinedPlan)!;
    const combined = selectReferenceStyleAtlas(combinedBase, combinedPlan, combinedDesign, c.st).selected!;
    expect(combined).not.toBeNull();
    expect(combined.composition.diagnostic.looseHair.frontEvidence).toBe("observed_front_lock_endpoint");
    expect(combined.composition.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_lower_pigment");
    expect(validateReferenceAtlasCraft(combined.composition.atlas, combinedBase, combinedPlan, c.st,
      buildReferenceCraftPlan(combinedPlan, combined.design, combined.composition)).ok).toBe(true);
    for (const kind of ["paint", "diagnostic", "overlay"] as const) {
      const bad = structuredClone(after);
      if (kind === "paint") bad.atlas.rgba[at(2, 4)] = 0;
      if (kind === "diagnostic") bad.diagnostic.faceFinish.eyePresentation.cells[1].color[0] = 0;
      if (kind === "overlay") bad.atlas.rgba[at(2, 4, o) + 3] = 255;
      expect(measureReferenceRenderedQuality(bad, c.base, c.plan, c.design, c.st).constructionValid).toBe(false);
    }
    const out = freshAuditOutput("evaluation-artifacts/bounded-lower-pigment-20261011-");
    for (const [name, result] of [["before", before], ["after", after], ["selected", selected.composition], ["combined", combined.composition]] as const) {
      const encoded = await encodePng(result.atlas); expect((await decodePng(encoded)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      const view = renderSkinViews(result.atlas)[0].image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, sourceSummarySha256: sha(c.bytes), historicalPngExact: true,
      beforeRgba: sha(before.atlas.rgba), afterRgba: sha(after.atlas.rgba), selectedRgba: sha(selected.composition.atlas.rgba),
      changedPixels: changed, unrelatedChangedPixels: 0, alphaChanges: 0, sourcePlanUnchanged: true,
      presentation: after.diagnostic.faceFinish.eyePresentation, selectedFace: selected.design.face.family,
      combinedRgba: sha(combined.composition.atlas.rgba), combinedCraftPass: true,
      craftPass: true, contractPass: true, freshLiveVerified: false }, null, 2), { flag: "wx" });
    expect(JSON.stringify([c.plan, c.t])).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(c.bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("BOUNDED_LOWER_PIGMENT", out);
  } finally { network.mockRestore(); }
}, 60_000);
