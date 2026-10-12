// Offline: reuse accepted same-run evidence without reconstructing model prompts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan, preserveObservedWristCuffs } from "../src/outfitIdentity";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { measureReferenceAccessoryRetention } from "../src/referenceOutfitRetention";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { assertHistoricalSingletonEyePresentation } from "./historicalSingletonEyePresentation";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-003";
const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing: string) {
  const a = makeAnalysis(); a.observed.clothing = clothing; a.observed.accessories = "";
  a.visibleRegions.upperBody = true;
  return a;
}

it.each(["pink wrist cuffs", "blue ruffled wrist cuffs", "wrist cuffs are white"])(
  "preserves observed detached cuffs independently of sleeves: %s", text => {
    const a = input(`A sleeveless white top; ${text}.`);
    const p = buildOutfitPlan(a), cuff = p.accessories.find(c => c.kind === "wrist_cuff");
    expect(cuff).toMatchObject({ source: "observed", side: "center" });
    expect(cuff?.color).toBe(text.includes("pink") ? "#c8798c" : text.includes("blue") ? "#416b9d" : "#eeeae1");
    expect(p.upper.leftSleeve.length).toBe("sleeveless");
    expect(p.upper.rightSleeve.length).toBe("sleeveless");
    expect(p.salience.secondary).toContainEqual(expect.objectContaining({ id: "accessory_wrist_cuff", targets: ["arm.left", "arm.right"] }));
    expect(preserveObservedWristCuffs(p, a)).toBe(p);
  });

it.each([
  "pink cuffs at the shorts leg openings", "a pink neck bow", "pink long sleeves", "white sleeves with pink cuffs",
  "no pink wrist cuffs", "pink wrist cuffs are absent", "possibly pink wrist cuffs", "hidden pink wrist cuffs",
  "pink wrist cuff", "one pink wrist cuff", "pink wrist cuffs on viewer-left", "pink and blue wrist cuffs",
  "pink/blue wrist cuffs", "pink patterned wrist cuffs", "pink wrist cuffs. Blue wrist cuffs.",
  "pink wrist cuffs with blue stripes", "pink wrist cuffs with white checks",
  "pink wrist cuffs. Wrist cuffs of unknown color.", "pink bow and wrist cuffs",
])("does not invent paired cuffs or steal another item's palette: %s", text => {
  expect(preserveObservedWristCuffs(saved.outfitPlan, input(text))).toBe(saved.outfitPlan);
});

it("requires visible observed evidence, not inferred prompt or hidden completion", () => {
  const a = input("pink wrist cuffs"); a.visibleRegions.upperBody = false;
  expect(preserveObservedWristCuffs(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true; a.observed.clothing = "a white top"; a.outfitPrompt = "pink wrist cuffs";
  expect(preserveObservedWristCuffs(saved.outfitPlan, a)).toBe(saved.outfitPlan);
});

it("keeps dark-blue value class and accepts accessory observations without borrowing nearby color", () => {
  const a = input("a white sleeveless top with pink shoes"); a.observed.accessories = "dark blue wrist cuffs";
  expect(preserveObservedWristCuffs(saved.outfitPlan, a).accessories.at(-1)).toMatchObject({ color: "#273954", kind: "wrist_cuff" });
});

it("paints only finite wrist wraps, not sleeve length or hands", () => {
  const p = preserveObservedWristCuffs(saved.outfitPlan, input("pink wrist cuffs"));
  const blank = (): RawImage => ({ width: 64, height: 64, rgba: new Uint8Array(16384) });
  const before = blank(), after = blank();
  applyOutfitPlan(before, saved.outfitPlan, "#f2d6c0"); applyOutfitPlan(after, p, "#f2d6c0");
  const allowed = new Set<number>();
  for (const part of ["leftArm", "rightArm"] as const) for (const face of ["front", "back", "left", "right"] as const) {
    const r = CLASSIC_LAYOUT[part].overlay[face];
    for (let x = 0; x < r.w; x++) allowed.add((r.y + r.h - 3) * 64 + r.x + x);
  }
  const changed = [...Array(4096).keys()].filter(p => [0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c]));
  expect(new Set(changed)).toEqual(allowed); expect(changed).toHaveLength(32);
});

it("replays the actual omission and retains cuffs through default reference composition and PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    expect(a.observed.clothing).toContain("pink wrist cuffs");
    expect(saved.outfitPlan.accessories.some(c => c.kind === "wrist_cuff")).toBe(false);
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    const render = (plan: SkinPlan) => {
      const baseline = buildProceduralSourceAtlas(features, style, plan)!;
      const result = renderReferencePrimaryAtlas(baseline, plan, a, style);
      if (!result.ok) throw new Error(result.reason);
      expect(result.summary.craftValidation).toBe("pass");
      if (plan === saved) {
        expect(result.summary.design).toBeDefined();
        // Current eye presentation intentionally differs from this older PNG.
        // Validate exact old/new colors at four declared cells and byte equality
        // everywhere else; do not rewrite the golden or mask the entire head.
        assertHistoricalSingletonEyePresentation(result.atlas, historical, baseline, plan, style, result.summary.design!);
      }
      return result.atlas;
    };
    const before = render(saved);
    const fixed = { ...saved, outfitPlan: preserveObservedWristCuffs(saved.outfitPlan, a) };
    expect(fixed.outfitPlan.upper).toEqual(saved.outfitPlan.upper);
    expect(fixed.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
    const after = render(fixed);
    expect(render(fixed).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    const retention = measureReferenceAccessoryRetention(after, fixed.outfitPlan, features.skinColor);
    expect(retention.valid, retention.violations.join(",")).toBe(true);
    const allowed = new Set<number>();
    for (const part of ["leftArm", "rightArm"] as const) for (const layer of ["base", "overlay"] as const)
      for (const face of ["front", "back", "left", "right"] as const) {
        const r = CLASSIC_LAYOUT[part][layer][face];
        for (let x = 0; x < r.w; x++) allowed.add((r.y + r.h - 3) * 64 + r.x + x);
      }
    const changed = [...Array(4096).keys()].filter(p => [0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c]));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every(p => allowed.has(p))).toBe(true);
    const erased = { ...after, rgba: after.rgba.slice() };
    for (const p of changed) erased.rgba.set(before.rgba.slice(p * 4, p * 4 + 4), p * 4);
    expect(measureReferenceAccessoryRetention(erased, fixed.outfitPlan, features.skinColor).valid).toBe(false);
    const encoded = await encodePng(after); expect((await decodePng(encoded)).rgba).toEqual(after.rgba);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-wrist-cuffs-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_plan_counterfactual_not_live", sourceRun: run.runId,
      sourceSummarySha256: sha(bytes), beforeMatchesLive: false, historicalEyePresentationChangedCells: 4,
      historicalEqualityOutsideEyePresentation: true, missingPromptReconstructed: false,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", cue: "observed paired wrist cuffs", providerCalls: 0,
      changedPixels: changed.length, outsideWristDiff: 0, beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba),
      sleeveLengthUnchanged: true, accessoryRetention: retention, atlasValid: true, craftPass: true }, null, 2), { flag: "wx" });
    console.info(`OBSERVED_WRIST_CUFFS ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
