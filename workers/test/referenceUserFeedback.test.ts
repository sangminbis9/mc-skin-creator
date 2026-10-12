import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas, referenceBaseHairColor } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { referenceEyeRowOffset, referencePresentedFaceContract } from "../src/referenceFaceFinish";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

function fixture() {
  const raw = makeAnalysis();
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "none";
  raw.fallbackFeatures.topType = "jacket";
  raw.observed.clothing = "Charcoal formal suit jacket over a white collared shirt with a striped navy necktie.";
  raw.observed.accessories = "none";
  raw.renderHints.neckAccessory = "tie";
  raw.renderHints.outerGarment = "open_jacket";
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan);
  const atlas = buildProceduralSourceAtlas(features, style, plan)!;
  return { analysis, plan, style, atlas, design: buildReferenceStylePlan(analysis) };
}

it("keeps source observations immutable while omitting mouth and lowering a complete eye pair", () => {
  const b = fixture(), original = JSON.stringify(b.plan);
  const result = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
  expect(result.diagnostic.faceFinish.mouthPresentation).toBe("omit_style");
  expect(result.diagnostic.faceFinish.eyeRowOffset).toBe(1);
  const quality = measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, b.style);
  expect(quality.violations).toEqual([]);
  expect(quality.faceContract.eyesPresent).toBe(true);
  const displayed = referencePresentedFaceContract(b.plan.facePixelPlan, b.design, b.style, []);
  expect(displayed.renderContract.mouth).toBeUndefined();
  expect(displayed.pixels.filter(p => p.cluster === "mouth")).toHaveLength(0);
  expect(JSON.stringify(b.plan)).toBe(original);
  const iris = b.plan.facePixelPlan.pixels.find(p => p.role === "iris")!;
  const r = CLASSIC_LAYOUT.head.base.front;
  result.atlas.rgba.set([255, 0, 255], ((r.y + iris.y + 1) * 64 + r.x + iris.x) * 4);
  expect(measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, b.style).constructionValid).toBe(false);
});

it("derives side/back hair from one source material, not the old dark nape band", () => {
  const b = fixture();
  const historical = { ...b.design, materialDetailPolicy: undefined };
  const front = referenceBaseHairColor([80, 60, 40], { x: 2, y: 4, face: "front" }, b.plan, historical, b.style);
  const back = referenceBaseHairColor([12, 9, 6], { x: 2, y: 4, face: "back" }, b.plan, historical, b.style);
  const side = referenceBaseHairColor([22, 18, 13], { x: 2, y: 4, face: "left" }, b.plan, historical, b.style);
  expect(front).toEqual(back); expect(front).toEqual(side);
  // New material varies with physical position, never the legacy side pigment.
  for (const face of ["front", "right", "back", "left", "top"] as const)
    expect(referenceBaseHairColor([80, 60, 40], {x: 2, y: 4, face}, b.plan, b.design, b.style))
      .toEqual(referenceBaseHairColor([12, 9, 6], {x: 2, y: 4, face}, b.plan, b.design, b.style));
});

it("preserves eyewear and protected material instead of translating an incomplete eye pair", () => {
  const b = fixture(), pixels = structuredClone(b.plan.facePixelPlan);
  expect(referenceEyeRowOffset(pixels, b.design, [])).toBe(1);
  const iris = pixels.pixels.find(p => p.role === "iris")!;
  expect(referenceEyeRowOffset(pixels, b.design, [{ x: iris.x, y: iris.y + 1 }])).toBe(0);
  pixels.glassesPlan.topology = "rectangular_thin";
  expect(referenceEyeRowOffset(pixels, b.design, [])).toBe(0);
});

it("omits the authored mouth across expressions without modifying source evidence", () => {
  const b = fixture();
  for (const expression of ["neutral", "smile", "serious", "open_mouth"] as const) {
    const style = { ...b.style, expression };
    const source = JSON.stringify(b.plan);
    const displayed = referencePresentedFaceContract(b.plan.facePixelPlan, b.design, style, []);
    expect(displayed.renderContract.mouth).toBeUndefined();
    expect(JSON.stringify(b.plan)).toBe(source);
    const result = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, style);
    expect(result.diagnostic.faceFinish.mouthPresentation).toBe("omit_style");
    expect(measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, style).violations).toEqual([]);
  }
});

it("connects tie knot/blade and tapers an unspecified formal front without claiming it was buttoned", () => {
  const b = fixture(), p = b.plan.outfitPlan, image = makeSyntheticAtlas(64);
  expect(p.formalSuit).toMatchObject({ construction: "connected_tie_tapered_front", frontDrape: "tapered", jacketOpening: "open" });
  applyOutfitPlan(image, p, "#e8b98f");
  const r = CLASSIC_LAYOUT.body.overlay.front;
  for (let y = 1; y < 7; y++) for (const x of [3, 4]) expect(image.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3]).toBe(255);
  const base = CLASSIC_LAYOUT.body.base.front;
  const pixel = (x: number, y: number) => [...image.rgba.slice(((base.y + y) * 64 + base.x + x) * 4, ((base.y + y) * 64 + base.x + x) * 4 + 3)];
  expect(pixel(2, 3)).not.toEqual(pixel(2, 6));
  expect(pixel(3, 9)).toEqual(pixel(1, 9));
  const open = structuredClone(b.analysis);
  open.observed.clothing = "An open charcoal formal suit jacket over a white shirt and navy tie.";
  expect(buildSkinPlan(open).outfitPlan.formalSuit?.frontDrape).toBe("straight_open");
});

it("writes a new four-view comparison from stored same-source evidence, not invented screenshot analysis", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const input = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-010/summary.json";
    const bytes = readFileSync(input), trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const oldPlan: SkinPlan = trace.skinPlan.skinPlan, oldDesign: ReferenceStylePlan = trace.referenceStyle.design;
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const plan = structuredClone(oldPlan);
    plan.outfitPlan = preserveObservedFormalSuit(plan.outfitPlan, trace.renderAnalysis);
    const design: ReferenceStylePlan = { ...oldDesign, faceLayoutPolicy: "mouthless_lower_eyes", hairPalettePolicy: "continuous_material" };
    const oldBase = buildProceduralSourceAtlas(features, style, oldPlan)!;
    const newBase = buildProceduralSourceAtlas(features, style, plan)!;
    const before = composeReferenceStyleAtlas(oldBase, oldPlan, oldDesign, style);
    const after = composeReferenceStyleAtlas(newBase, plan, design, style);
    const quality = measureReferenceRenderedQuality(after, newBase, plan, design, style);
    expect(quality.violations).toEqual([]);
    expect(validateFinalAtlas(after.atlas).ok).toBe(true);
    const root = mkdtempSync("evaluation-artifacts/reference-user-feedback-20261011-");
    for (const [name, image] of [["before", before.atlas], ["after", after.atlas]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(image), { flag: "wx" });
      for (const view of renderSkinViews(image)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    const views = [before, after].flatMap(v => renderSkinViews(v.atlas).filter(v => ["front", "back", "left", "right"].includes(v.name)));
    const width = views.reduce((n, v) => n + v.image.width, 0), height = Math.max(...views.map(v => v.image.height));
    const strip: RawImage = { width, height, rgba: new Uint8Array(width * height * 4) }; let start = 0;
    for (const v of views) { for (let y = 0; y < v.image.height; y++) for (let x = 0; x < v.image.width; x++) strip.rgba.set(v.image.rgba.slice((y * v.image.width + x) * 4, (y * v.image.width + x) * 4 + 4), (y * width + start + x) * 4); start += v.image.width; }
    writeFileSync(`${root}/comparison.png`, await encodePng(scaleNearestNeighbor(strip, width * 6, height * 6)), { flag: "wx" });
    writeFileSync(`${root}/results.json`, JSON.stringify({ evidence: "stored_010_replay_not_linked_to_new_screenshot", sourceEvidenceSha256: sha(bytes), providerCalls: 0, quality, facePresentation: after.diagnostic.faceFinish, outfit: plan.outfitPlan.formalSuit, before: sha(before.atlas.rgba), after: sha(after.atlas.rgba) }, null, 2), { flag: "wx" });
    expect(readFileSync(input)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`USER_FEEDBACK_ARTIFACT ${root}`);
  } finally { network.mockRestore(); }
}, 60_000);
