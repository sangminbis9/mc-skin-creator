// Offline only: preserve old live snapshots and never import a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan, outfitPlanSignature, preserveObservedCroppedHem, preserveObservedSleeveColor } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { referenceGarmentFoldPlan } from "../src/referenceGarmentFinish";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-002";
const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing: string) {
  const a = makeAnalysis(); a.observed.clothing = clothing; a.observed.accessories = "";
  a.visibleRegions.upperBody = true; a.visibleRegions.lowerBody = true;
  a.fallbackFeatures.topType = "tshirt"; a.fallbackFeatures.topColor = "white";
  a.fallbackFeatures.bottomType = "shorts"; a.fallbackFeatures.bottomColor = "gray";
  a.outfitPrompt = "a white top and gray shorts"; a.renderHints.outerGarment = "none";
  a.renderHints.neckAccessory = "none";
  return a;
}
const pixel = (a: RawImage, x: number, y: number) => [...a.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];

it.each(["a cropped white top and gray shorts", "a white crop top and blue jeans", "a white cropped blouse with a skirt"])(
  "terminates observed upper cloth without assuming exposed skin: %s", clothing => {
    const p = buildOutfitPlan(input(clothing));
    expect(p.upper.hem).toMatchObject({ endRow: 8, skinGapRows: 0, source: "observed" });
    expect(p.lower.waistRow).toBe(8);
    const a: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
    applyOutfitPlan(a, p, "#f2d6c0");
    const r = CLASSIC_LAYOUT.body.base.front;
    const lower = p.lower.baseColor.match(/[a-f0-9]{2}/gi)!.map(x => parseInt(x, 16));
    for (let y = 8; y < 12; y++) expect(pixel(a, r.x, r.y + y)).toEqual(lower);
    expect(referenceGarmentFoldPlan(p).filter(f => f.part === "body").every(f => f.y < 7)).toBe(true);
  });

it("uses an explicit exposed-midriff cue only, never cropped category alone", () => {
  const p = buildOutfitPlan(input("a white cropped top with a visible midriff and gray shorts"));
  expect(p.upper.hem).toMatchObject({ endRow: 8, skinGapRows: 1 });
  expect(p.lower.waistRow).toBe(9);
  const a: RawImage = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  applyOutfitPlan(a, p, "#f2d6c0");
  const r = CLASSIC_LAYOUT.body.base.front;
  expect(pixel(a, r.x, r.y + 8)).toEqual([242, 214, 192]);
  expect(pixel(a, r.x, r.y + 9)).not.toEqual([242, 214, 192]);
  expect(referenceGarmentFoldPlan(p).filter(f => f.part === "body").every(f => f.y < 7)).toBe(true);
  const covered = buildOutfitPlan(input("a white cropped top and high-waisted shorts. No visible midriff"));
  expect(covered.upper.hem?.skinGapRows).toBe(0);
});

it.each([
  "a white top and cropped gray pants",
  "cropped brown hair. a white top and gray shorts",
  "a possibly cropped white top and gray shorts",
  "a white top, not a cropped garment, and gray shorts",
  "a white cropped jacket over a black shirt and gray shorts",
  "a cropped white top under a sweater and gray shorts",
  "a cropped white top over thermal underwear and gray shorts",
  "a cropped white dress",
  "a longline white top and gray shorts",
])("does not invent a cropped construction from %s", clothing => {
  expect(preserveObservedCroppedHem(saved.outfitPlan, input(clothing))).toBe(saved.outfitPlan);
});

it("requires visible observed upper and lower construction, not inferred prompt text", () => {
  const a = input("a white cropped top and gray shorts"); a.visibleRegions.lowerBody = false;
  expect(preserveObservedCroppedHem(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.lowerBody = true; a.visibleRegions.upperBody = false;
  expect(preserveObservedCroppedHem(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true; a.observed.clothing = "a white top and gray shorts";
  a.outfitPrompt = "a cropped top and bare midriff";
  expect(preserveObservedCroppedHem(saved.outfitPlan, a)).toBe(saved.outfitPlan);
});

it("replays H exactly and changes only the finite torso hem/lower-material region", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const render = (p: SkinPlan) => {
      const baseline = buildProceduralSourceAtlas(features, style, p)!;
      const result = renderReferencePrimaryAtlas(baseline, p, a, style);
      if (!result.ok) throw new Error(result.reason);
      expect(result.summary.craftValidation).toBe("pass");
      return result.atlas;
    };
    const before = render(saved);
    expect(before.rgba).toEqual((await decodePng(readFileSync(`${root}/skin.png`))).rgba);
    const fixed = { ...saved, outfitPlan: preserveObservedCroppedHem(saved.outfitPlan, a) };
    expect(fixed.outfitPlan.upper.hem).toMatchObject({ endRow: 8, skinGapRows: 0 });
    expect(outfitPlanSignature(fixed.outfitPlan)).not.toBe(outfitPlanSignature(saved.outfitPlan));
    const after = render(fixed);
    const combined = render({ ...fixed, outfitPlan: preserveObservedSleeveColor(fixed.outfitPlan, a) });
    expect(validateFinalAtlas(combined)).toEqual({ ok: true, problems: [] });
    expect(render(fixed).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    const allowed = new Set<number>();
    for (const [face, rect] of Object.entries(CLASSIC_LAYOUT.body.base)) {
      if (face === "top") continue;
      for (let y = face === "bottom" ? 0 : 7; y < rect.h; y++) for (let x = 0; x < rect.w; x++)
        allowed.add((rect.y + y) * 64 + rect.x + x);
    }
    const changed: number[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
      expect(allowed.has(p), `outside_torso_hem:${p}`).toBe(true); changed.push(p);
    }
    expect(changed.length).toBeGreaterThan(0); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-cropped-hem-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after], ["combined-sleeve-and-hem", combined]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_plan_counterfactual_not_live", sourceRun: run.runId,
      sourceSummarySha256: sha(bytes), beforeMatchesLive: true, missingPromptReconstructed: false,
      earliestLoss: "PLAN_CROPPED_BOUNDARY_NOT_RENDERED", hem: fixed.outfitPlan.upper.hem, inventedSkinGap: false,
      changedPixels: changed.length, outsideTorsoHemDiff: 0, beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba),
      combinedSleeveAndHemRgba: sha(combined.rgba),
      atlasValid: true, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`OBSERVED_CROPPED_HEM ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
