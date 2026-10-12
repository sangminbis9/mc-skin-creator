import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildOutfitPlan, preserveObservedKneeDistressing, outfitPlanSignature } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { encodePng, decodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { validateFinalAtlas } from "../src/skinPost";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001";
const bytes = readFileSync(`${root}/summary.json`);
const trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing: string) {
  const a = makeAnalysis(); a.observed.clothing = clothing;
  a.visibleRegions.lowerBody = true; a.fallbackFeatures.bottomType = "jeans";
  a.fallbackFeatures.bottomColor = "blue"; a.renderHints.bottomPattern = "plain";
  a.renderHints.legwear = "none"; a.inferred.lowerBodyDesign = undefined;
  return a;
}

it.each([
  ["blue jeans with ripped distressing on viewer's right knee", ["leftLeg"]],
  ["blue jeans with a hole at the viewer’s left knee", ["rightLeg"]],
  ["blue jeans with a torn right knee", ["rightLeg"]],
  ["blue jeans with left knee ripped", ["leftLeg"]],
  ["blue jeans with both knees ripped", ["leftLeg", "rightLeg"]],
  ["medium blue faded baggy denim jeans with distressed ripped knee detail on the viewer's right leg", ["leftLeg"]],
  ["blue jeans with torn knee detail on the viewer’s left leg", ["rightLeg"]],
  ["blue jeans with frayed knee detail on the wearer's right leg", ["rightLeg"]],
  ["blue jeans with ripped knee details on both legs", ["leftLeg", "rightLeg"]],
])("keeps explicitly located damage distinct from arbitrary mirrored decoration: %s", (text, parts) => {
  const plan = buildOutfitPlan(input(text as string));
  expect(plan.lower.kneeDistressing?.parts ?? []).toEqual(parts);
  if (parts.length) expect(plan.lower.kneeDistressing?.exposedSkin).toBe(false);
});

it.each([
  "plain blue jeans", "ripped blue jeans", "blue jeans with a hole on one knee",
  "blue jeans with a possibly ripped right knee", "blue jeans without rips on both knees",
  "blue jeans with rips on both knees printed on the material",
  "blue jeans with patched holes on both knees", "blue jeans with rips on both knees. The right knee is hidden",
  "a torn jacket with plain blue jeans", "blue jeans with a frayed hem", "blue jeans with rips on the back",
  "blue jeans with rips on right knee or left knee", "blue jeans and black jeans with rips on both knees",
  "blue jeans with rips on both knees. No rips are visible",
  "blue jeans with ripped detail on the viewer's right leg",
  "blue jeans with ripped knee detail on one leg",
  "blue jeans with possibly torn knee detail on the viewer's right leg",
  "blue jeans with printed ripped knee detail on the viewer's right leg",
  "blue jeans without ripped knee detail on the viewer's right leg",
  "blue jeans with frayed hem detail on the viewer's right leg",
  "blue jeans; torn knee detail on the viewer's right leg of black trousers",
  "plain blue jeans. Inferred ripped knee detail on the viewer's right leg",
])("does not fabricate a knee patch from %s", text => {
  expect(preserveObservedKneeDistressing(saved.outfitPlan, input(text))).toBe(saved.outfitPlan);
});

it("requires visible observed denim with available knee cloth; ignores inferred text", () => {
  const a = input("blue jeans with rips on both knees");
  a.visibleRegions.lowerBody = false;
  expect(preserveObservedKneeDistressing(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.lowerBody = true; a.observed.clothing = "plain blue jeans";
  a.outfitPrompt = "blue jeans with rips on both knees";
  expect(preserveObservedKneeDistressing(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.observed.clothing = a.outfitPrompt;
  for (const lower of [{ garmentRows: 5 }, { garmentRows: 8 }, { shoeRows: 4 }, { garmentType: "shorts" as const },
    { legwear: { ...saved.outfitPlan.lower.legwear, kind: "stockings" as const } }]) {
    const plan = { ...saved.outfitPlan, lower: { ...saved.outfitPlan.lower, ...lower } };
    expect(preserveObservedKneeDistressing(plan, a)).toBe(plan);
  }
});

it("uses explicit exposed skin only and confines deterministic paint to the selected six front cells", () => {
  for (const skin of ["#f2d6c0", "#895b40"]) for (const exposed of [false, true]) {
    const a = input(`blue jeans with rips on viewer's right knee${exposed ? " with visible skin through the rip" : ""}`);
    const plan = preserveObservedKneeDistressing(saved.outfitPlan, a);
    expect(plan.lower.kneeDistressing?.exposedSkin).toBe(exposed);
    const before: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    const after: RawImage = { ...before, rgba: before.rgba.slice() };
    applyOutfitPlan(before, saved.outfitPlan, skin); applyOutfitPlan(after, plan, skin);
    const rect = CLASSIC_LAYOUT.leftLeg.base.front;
    const changed = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2].some(c => before.rgba[i * 4 + c] !== after.rgba[i * 4 + c])) {
      expect([rect.x + 1, rect.x + 2]).toContain(i % 64);
      expect([rect.y + 5, rect.y + 6, rect.y + 7]).toContain(Math.floor(i / 64)); changed.push(i);
    }
    expect(changed).toHaveLength(6);
    for (let i = 3; i < 16384; i += 4) expect(after.rgba[i]).toBe(before.rgba[i]);
    const gap = [...after.rgba.slice(((rect.y + 6) * 64 + rect.x + 1) * 4, ((rect.y + 6) * 64 + rect.x + 1) * 4 + 3)];
    if (exposed) expect(gap).toEqual([1, 3, 5].map(i => parseInt(skin.slice(i, i + 2), 16)));
    expect(outfitPlanSignature(plan)).not.toBe(outfitPlanSignature(saved.outfitPlan));
  }
});

it("recovers the saved source-visible C cue and preserves it through actual reference selection and PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    expect(a.observed.clothing).toContain("ripped distressing on viewer's right knee");
    expect(saved.outfitPlan.lower.kneeDistressing).toBeUndefined();
    const plan = structuredClone(saved);
    plan.headIdentityPlan.ownership = resolveHeadOwnership(a, plan.hairPlan, plan.facePixelPlan);
    plan.outfitPlan = preserveObservedScarfBeltColors(plan.outfitPlan, a);
    const render = (p: SkinPlan) => {
      const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, p)!;
      const result = renderReferencePrimaryAtlas(baseline, p, a, trace.injectedParameters.faceStyle);
      if (!result.ok) throw new Error(result.reason);
      expect(result.summary.craftValidation).toBe("pass"); return result.atlas;
    };
    const before = render(plan);
    const afterPlan = { ...plan, outfitPlan: preserveObservedKneeDistressing(plan.outfitPlan, a) };
    expect(afterPlan.outfitPlan.lower.kneeDistressing).toMatchObject({ parts: ["leftLeg"], exposedSkin: false });
    const after = render(afterPlan), rect = CLASSIC_LAYOUT.leftLeg.base.front;
    const skinEvidence = { ...a, observed: { ...a.observed,
      clothing: a.observed.clothing.replace("right knee", "right knee with visible skin through the rip") } };
    const skinPlan = { ...plan, outfitPlan: preserveObservedKneeDistressing(plan.outfitPlan, skinEvidence) };
    expect(skinPlan.outfitPlan.lower.kneeDistressing?.exposedSkin).toBe(true);
    expect(validateFinalAtlas(render(skinPlan)).ok).toBe(true);
    const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, afterPlan)!;
    const selected = selectReferenceStyleAtlas(baseline, afterPlan, buildReferenceStylePlan(a), trace.injectedParameters.faceStyle).selected!;
    const erased = structuredClone(selected.composition);
    for (const x of [1, 2]) for (const y of [5, 6, 7]) {
      const i = ((rect.y + y) * 64 + rect.x + x) * 4;
      erased.atlas.rgba.set(before.rgba.slice(i, i + 4), i);
    }
    expect(measureReferenceRenderedQuality(erased, baseline, afterPlan, selected.design,
      trace.injectedParameters.faceStyle).violations.length).toBeGreaterThan(0);
    const changed: number[] = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.rgba[i * 4 + ch] !== after.rgba[i * 4 + ch])) {
      expect([rect.x + 1, rect.x + 2]).toContain(i % 64);
      expect([rect.y + 5, rect.y + 6, rect.y + 7]).toContain(Math.floor(i / 64)); changed.push(i);
    }
    expect(changed).toHaveLength(6);
    expect(validateFinalAtlas(after).ok).toBe(true);
    expect((await decodePng(await encodePng(after))).rgba).toEqual(after.rgba);
    expect(render(afterPlan).rgba).toEqual(after.rgba);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    const output = freshAuditOutput("evaluation-artifacts/observed-knee-distressing-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_saved_C_not_live", providerCalls: 0,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", cue: afterPlan.outfitPlan.lower.kneeDistressing,
      beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba), changedPixels: changed.length,
      unrelatedPixelDiff: 0, craft: "pass", finalAtlas: "pass", historicalEvidenceUnchanged: true }, null, 2), { flag: "wx" });
    console.info("KNEE_DISTRESSING_REPLAY", output);
  } finally { network.mockRestore(); }
}, 60000);
