// Offline only. No live runner imports and no reconstructed missing prompts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { hairFlowerFootprint } from "../src/hairFlowerFootprint";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const cellKey = (p: { face: string; x: number; y: number }) => `${p.face}:${p.x}:${p.y}`;
const pixel = (rgba: Uint8Array, p: { face: keyof typeof CLASSIC_LAYOUT.head.overlay; x: number; y: number }) => {
  const r = CLASSIC_LAYOUT.head.overlay[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
  return [...rgba.slice(i, i + 4)];
};
function input(side: "left" | "right" | "center", scale: "small" | "medium" | "large") {
  const a = makeAnalysis();
  a.observed.hair = "Long wavy brown hair with a white daisy hair clip";
  a.observed.accessories = "White flower hair clip";
  a.renderHints.hairAccessory = "flower"; a.renderHints.hairAccessorySide = side;
  a.renderHints.hairAccessoryScale = scale; a.renderHints.hairAccessoryColor = "white";
  a.renderHints.overallHairLength = "chest"; a.renderHints.hairBackShape = "long";
  a.renderHints.hairTexture = "wavy"; a.fallbackFeatures.hairstyle = "long";
  a.inferred.hairBack.value = "Long brown wavy hair continuing down back";
  return a;
}

const variants = (["left", "right", "center"] as const).flatMap(side => (["small", "medium", "large"] as const).map(scale => ({ side, scale })));
it.each(variants)("resolves exact existing flower footprint: $side/$scale", ({ side, scale }) => {
  const a = input(side, scale), p = buildSkinPlan(a), head = p.headIdentityPlan.ownership!;
  expect(head.execution).toBe("resolved");
  const footprint = hairFlowerFootprint(side, scale), keys = new Set(footprint.map(cellKey));
  expect(keys.size).toBe(footprint.length);
  expect(footprint.every(p => Number.isInteger(p.x) && p.x >= 0 && p.x < 8 && Number.isInteger(p.y) && p.y >= 0 && p.y < 8)).toBe(true);
  expect(head.cells.some(c => c.sourceGroupId === "head-accessory-region")).toBe(false);
  const reserved = head.cells.filter(c => c.sourceGroupId === "head-flower-footprint");
  expect(reserved.length).toBeGreaterThan(0);
  expect(reserved.every(c => keys.has(cellKey(c)) && c.owner === "other_p5" && c.retain)).toBe(true);
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, features, p.hairPlan);
  const legacyPlan = structuredClone(p); legacyPlan.headIdentityPlan.ownership!.execution = "preserve_existing_grammar";
  const legacy = buildProceduralSourceAtlas(features, style, legacyPlan)!;
  const baseline = buildProceduralSourceAtlas(features, style, p)!;
  for (const c of reserved) expect(pixel(baseline.rgba, c), cellKey(c)).toEqual(pixel(legacy.rgba, c));
  const result = renderReferencePrimaryAtlas(baseline, p, a, style);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.summary.status).toBe("reference_style_accepted");
  for (const c of reserved) expect(pixel(result.atlas.rgba, c), cellKey(c)).toEqual(pixel(legacy.rgba, c));
  expect(validateFinalAtlas(result.atlas).ok).toBe(true);
});

it.each(["a white flower and ribbon in the hair", "a white flower and headband", "a flower. A separate hair clip", "a flower and bow", "a flower and a separate hair clip", "a flower with clips"])("preserves unresolved combined accessories: %s", evidence => {
  const a = input("left", "small"); a.observed.accessories = evidence;
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
});

it("does not resolve a prose-only flower or treat an ordinary clip as a flower", () => {
  const a = input("left", "small"); a.renderHints.hairAccessory = "none";
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
  a.renderHints.hairAccessory = "clip";
  expect(buildSkinPlan(a).headIdentityPlan.ownership!.execution).toBe("preserve_existing_grammar");
});

it("gives actual eyes and frames priority over flower cells", () => {
  const a = input("left", "small"), p = buildSkinPlan(a), face = structuredClone(p.facePixelPlan);
  const iris = face.pixels.find(c => c.role === "iris")!;
  expect(iris).toBeTruthy(); face.pixels.push({ ...iris, x: 1, y: 2 });
  let head = resolveHeadOwnership(a, p.hairPlan, face);
  expect(head.cells.find(c => c.layer === "outer" && c.face === "front" && c.x === 1 && c.y === 2))
    .toMatchObject({ owner: "clear", sourceGroupId: "face-window" });
  face.glassesPlan.topology = "rectangular_thin";
  face.glassesPlan.framePixels = [{ face: "front", x: 1, y: 2, role: "rim_mid" }];
  head = resolveHeadOwnership(a, p.hairPlan, face);
  expect(head.cells.find(c => c.layer === "outer" && c.face === "front" && c.x === 1 && c.y === 2))
    .toMatchObject({ owner: "glasses", sourceGroupId: "glasses-frame" });
});

it.each(["curly", "coily"] as const)("retains a bounded flower on source-derived %s material", texture => {
  const a = input("left", "small");
  a.observed.hair = `Jaw length full ${texture} hair with a white flower hair clip`;
  a.renderHints.hairTexture = texture; a.renderHints.hairVolume = "full";
  a.renderHints.overallHairLength = "jaw"; a.renderHints.sideHairLength = "jaw";
  a.renderHints.hairSilhouette = "rounded"; a.renderHints.sideHairShape = "flared";
  const p = buildSkinPlan(a);
  expect(p.headIdentityPlan.ownership!.execution).toBe("resolved");
  const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
  const style = buildFaceStyle(a, features, p.hairPlan), baseline = buildProceduralSourceAtlas(features, style, p)!;
  const result = renderReferencePrimaryAtlas(baseline, p, a, style);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
  expect(result.summary.status).toBe("reference_style_accepted");
  for (const c of p.headIdentityPlan.ownership!.cells.filter(c => c.sourceGroupId === "head-flower-footprint"))
    expect(pixel(result.atlas.rgba, c)).toEqual(pixel(baseline.rgba, c));
  expect(result.summary.metrics!.accidentalEyeOcclusionCells).toBe(0);
});

it("replays consumed C and preserves the observed flower while enabling source-specific reference composition", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
    const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
    const original = JSON.stringify(trace), style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const old = buildProceduralSourceAtlas(features, style, saved)!;
    expect(old.rgba).toEqual((await decodePng(readFileSync(`${root}/skin.png`))).rgba);
    // These pure consumers use persisted observed/canonical/hint/fallback fields
    // only. Missing prompts are neither reconstructed nor supplied to a validator.
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const fixed = structuredClone(saved);
    fixed.headIdentityPlan.ownership = resolveHeadOwnership(a, saved.hairPlan, saved.facePixelPlan);
    fixed.outfitPlan = preserveObservedScarfBeltColors(saved.outfitPlan, a);
    expect(fixed.headIdentityPlan.ownership.execution).toBe("resolved");
    const baseline = buildProceduralSourceAtlas(features, style, fixed)!;
    const selection = selectReferenceStyleAtlas(baseline, fixed, buildReferenceStylePlan(a), style);
    const result = renderReferencePrimaryAtlas(baseline, fixed, a, style);
    if (!result.ok) throw new Error(JSON.stringify({ reason: result.reason, candidates: selection.candidates.map(c => ({ id: c.id, quality: c.quality?.violations, foundation: c.foundation, rejection: c.rejection })) }));
    expect(result.summary.status).toBe("reference_style_accepted");
    const beforeIris = await decodePng(readFileSync("evaluation-artifacts/hair-flower-ownership-offline-20261010-3JLTuB/styled.png"));
    expect(sha(beforeIris.rgba)).toBe("c6b971023ea03710edb0333c8560ccb4431adcfa2cb6e6ad641c98f725f4c7d8");
    // Isolate the later, independently tested hanging-tail semantic migration.
    // Pin its existing grammar and pigment before projecting those ten cells
    // back for this read-only historical iris/flower comparison.
    const irisProjection = structuredClone(result.atlas), tailRect = CLASSIC_LAYOUT.body.base.front;
    const tailColor = fixed.outfitPlan.accessories.find(a => a.kind === "scarf")!.color;
    expect(tailColor).toBe("#ded2b6");
    const rgb = [1, 3, 5].map(i => Number.parseInt(tailColor.slice(i, i + 2), 16));
    const intentionalScarfPixels = [];
    for (let y = 3; y < 8; y++) for (const x of [3, 4]) {
      const i = ((tailRect.y + y) * 64 + tailRect.x + x) * 4;
      expect([...result.atlas.rgba.slice(i, i + 4)]).toEqual([...rgb.map(c => Math.round(c * (y === 7 ? 0.72 : x === 3 ? 0.90 : 0.84))), 255]);
      irisProjection.rgba.set(beforeIris.rgba.slice(i, i + 4), i);
      intentionalScarfPixels.push(i / 4);
    }
    // Subsequent presentation adds only this paired upper catch. Assert its
    // exact paint before projecting it out of the historical pigment boundary.
    const catchRect = CLASSIC_LAYOUT.head.base.front;
    const intentionalEyePresentationPixels = [2, 5].map(x => ((catchRect.y + 3) * 64 + catchRect.x + x));
    for (const p of intentionalEyePresentationPixels) {
      expect(result.summary.design?.face.family).toBe("dark_stylish");
      expect([...result.atlas.rgba.slice(p * 4, p * 4 + 4)]).toEqual([199, 193, 184, 255]);
      irisProjection.rgba.set(beforeIris.rgba.slice(p * 4, p * 4 + 4), p * 4);
    }
    const intentionalIrisPixels = assertSingletonPigmentBoundary(irisProjection, beforeIris, fixed, style);
    expect(intentionalIrisPixels).toHaveLength(2);
    const incorrectPigment = structuredClone(irisProjection);
    incorrectPigment.rgba[intentionalIrisPixels[0] * 4] = 255;
    expect(() => assertSingletonPigmentBoundary(incorrectPigment, beforeIris, fixed, style)).toThrow();
    const unrelatedChange = structuredClone(irisProjection); unrelatedChange.rgba[0] = 255;
    expect(() => assertSingletonPigmentBoundary(unrelatedChange, beforeIris, fixed, style)).toThrow();
    const reserved = fixed.headIdentityPlan.ownership.cells.filter(c => c.sourceGroupId === "head-flower-footprint");
    expect(reserved.map(cellKey).sort()).toEqual(hairFlowerFootprint("left", "small").map(cellKey).sort());
    for (const p of reserved) {
      expect(pixel(baseline.rgba, p), cellKey(p)).toEqual(pixel(old.rgba, p));
      expect(pixel(result.atlas.rgba, p), cellKey(p)).toEqual(pixel(old.rgba, p));
    }
    expect(validateFinalAtlas(result.atlas)).toEqual({ ok: true, problems: [] });
    const tampered = structuredClone(selection.selected!.composition), flower = reserved[0];
    const flowerRect = CLASSIC_LAYOUT.head.overlay[flower.face];
    tampered.atlas.rgba.fill(0, ((flowerRect.y + flower.y) * 64 + flowerRect.x + flower.x) * 4,
      ((flowerRect.y + flower.y) * 64 + flowerRect.x + flower.x) * 4 + 4);
    expect(measureReferenceRenderedQuality(tampered, baseline, fixed, selection.selected!.design, style).violations)
      .toContain("source_head_accessory_changed");
    expect(renderReferencePrimaryAtlas(baseline, fixed, a, style)).toEqual(result);
    expect(JSON.stringify(trace)).toBe(original); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/hair-flower-ownership-offline-20261010-");
    for (const [name, atlas] of [["historical", old], ["resolved-source", baseline], ["styled", result.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    const faceRect = CLASSIC_LAYOUT.head.base.front;
    const facePixel = (x: number, y: number) => {
      const i = ((faceRect.y + y) * 64 + faceRect.x + x) * 4;
      return [...result.atlas.rgba.slice(i, i + 4)];
    };
    const eyeReadability = fixed.facePixelPlan.pixels.filter(p => p.role === "iris").map(p => ({
      x: p.x, y: p.y, rgba: facePixel(p.x, p.y), overlay: pixel(result.atlas.rgba, { ...p, face: "front" }),
      horizontalNeighbors: [-1, 1].map(dx => ({ x: p.x + dx, rgba: facePixel(p.x + dx, p.y) })),
    }));
    writeFileSync(`${output}/summary.json`, JSON.stringify({ sourceRunId: run.runId, sourceSummarySha256: sha(bytes),
      scope: "saved_plan_counterfactual_not_live", missingPromptReconstructed: false, historicalMatchesLive: true,
      historicalRgba: sha(old.rgba), resolvedSourceRgba: sha(baseline.rgba), styledRgba: sha(result.atlas.rgba),
      hairAccessoryPixelDiff: 0, oldReservation: saved.headIdentityPlan.ownership!.cells.filter(c => c.sourceGroupId === "head-accessory-region").length,
      newReservation: reserved.length, intentionalIrisPixels, intentionalScarfPixels, intentionalEyePresentationPixels, eyeReadability, result: result.summary, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`HAIR_FLOWER_OWNERSHIP ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
