// Offline material propagation, not a new provider response reconstruction.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan, preserveObservedSleeveColor } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { FACE_STYLE_TEMPLATES } from "../src/referenceStyleTemplates";
import type { FaceStyleFamily } from "../src/referenceStyleTemplates";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
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
  a.fallbackFeatures.topType = "tshirt"; a.fallbackFeatures.topColor = "white";
  a.fallbackFeatures.topAccentColor = "white"; a.fallbackFeatures.sleeveLength = "short";
  a.outfitPrompt = "a white top"; a.renderHints.outerGarment = "none";
  return a;
}

it.each([
  ["a white cropped top with short, puffed pink sleeves", "#c8798c"],
  ["a white blouse with blue puff sleeves", "#416b9d"],
  ["a white shirt whose sleeves are dark green", "#284c38"],
  ["a white top with sleeves in red", "#b53a35"],
  ["a white top with green sleeves and a pink bow", "#467a50"],
])("binds sleeve-local observed material: %s", (clothing, expected) => {
  const a = input(clothing), plan = buildOutfitPlan(a);
  expect(plan.upper.leftSleeve.color).toBe(expected);
  expect(plan.upper.rightSleeve.color).toBe(expected);
  expect(plan.upper.baseColor).toBe("#eeeae1");
  expect(plan.upper.leftSleeve.terminationRow).toBe(4);
  expect(plan.provenance).toContainEqual(expect.objectContaining({ target: "upper.sleeves.color", source: "observed" }));
  expect(buildOutfitPlan(a)).toEqual(plan);
});

it.each([
  "a white top with pink cuffs",
  "a pink top with white collar and unknown sleeves",
  "a white top with a pink bow and sleeves",
  "a white top with sleeves and pink shorts",
  "a white top with pink and white sleeves",
  "a white top with pink/white sleeves",
  "a white top with pink striped sleeves",
  "a white top with pink floral sleeves",
  "a white top with possibly pink sleeves",
  "a white top without pink sleeves",
  "a white top with hidden pink sleeves",
  "a white top with one pink sleeve",
  "a white top with left pink sleeves",
  "a white jacket over a blue shirt with pink sleeves",
  "a white top with pink sleeves and sleeves in blue",
  "a white top with pink sleeves. The sleeves are blue",
])("does not borrow cuff/pattern/layer/uncertain material: %s", clothing => {
  expect(preserveObservedSleeveColor(saved.outfitPlan, input(clothing))).toBe(saved.outfitPlan);
});

it("does not add sleeves or use inferred/accessory/hidden-region evidence", () => {
  const a = input("a white top with pink sleeves"); a.visibleRegions.upperBody = false;
  expect(preserveObservedSleeveColor(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true; a.observed.clothing = "a white top";
  a.outfitPrompt = "a white top with pink sleeves"; a.observed.accessories = "pink sleeves";
  expect(preserveObservedSleeveColor(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.observed.clothing = "a white top with pink sleeves";
  const sleeveless = structuredClone(saved.outfitPlan); sleeveless.upper.leftSleeve.length = "sleeveless";
  expect(preserveObservedSleeveColor(sleeveless, a)).toBe(sleeveless);
});

it("bounds the reviewed historical eye migration, then changes only observed sleeve material through final reference PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(trace.primary.observed.clothing).toContain("puffed pink sleeves");
    expect(trace.renderAnalysis.observed.clothing).toContain("puffed pink sleeves");
    expect(saved.outfitPlan.upper.leftSleeve.color).toBe("#eeeae1");
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const render = (p: SkinPlan) => {
      const baseline = buildProceduralSourceAtlas(features, style, p)!;
      const result = renderReferencePrimaryAtlas(baseline, p, a, style);
      if (!result.ok) throw new Error(result.reason);
      return result.atlas;
    };
    const before = render(saved);
    const historicalBytes = readFileSync(`${root}/skin.png`), historical = await decodePng(historicalBytes);
    expect(sha(historicalBytes)).toBe("cda6e9fe2741aba6d43eadaded1fccb3f725f9835a3dab3468e77b043b87df64");
    expect(sha(historical.rgba)).toBe("965485841d04dd27094d87ed2e79e8fd86b8879eef9dae4743ef6f54a863db1b");
    // This live PNG predates two separately tested source-eye presentation
    // edits: paired singleton pigment and categorical upper catches. License
    // their exact four cells/colors, not a generic face-area exception.
    const face = saved.facePixelPlan, front = CLASSIC_LAYOUT.head.base.front;
    expect(face.layout.geometryUsage.eyes).toBe(false);
    expect(face.layout.eyeTopology).toBe("readable_iris");
    expect(face.layout.eyeFootprintTopology).toBe("medium");
    expect(face.glassesPlan.topology).toBe("none");
    expect(face.layout.measurementTrace!.eyeOpenness.value).toBe("normal");
    const eyes = face.pixels.filter(p => p.role === "iris" && ["left_eye", "right_eye"].includes(p.cluster));
    expect(eyes.map(p => [p.x, p.y])).toEqual([[2, 4], [5, 4]]);
    const eye: number[] = [1, 3, 5].map(i => Number.parseInt(style.eyeColor.slice(i, i + 2), 16));
    const strength = FACE_STYLE_TEMPLATES[trace.referenceStyle.design.face.family as FaceStyleFamily].irisGlint;
    const expected = new Map<number, number[]>();
    for (const p of eyes) {
      expected.set((front.y + p.y) * 64 + front.x + p.x, eye);
      expected.set((front.y + p.y - 1) * 64 + front.x + p.x,
        eye.map((v, ch) => Math.round(v * (1 - strength) + [248, 246, 240][ch] * strength)));
    }
    const eyeMigration = [];
    for (let i = 0; i < 4096; i++) {
      expect(before.rgba[i * 4 + 3]).toBe(historical.rgba[i * 4 + 3]);
      if (expected.has(i)) {
        expect([...before.rgba.slice(i * 4, i * 4 + 3)]).toEqual(expected.get(i));
        eyeMigration.push({ x: i % 64, y: Math.floor(i / 64),
          before: [...historical.rgba.slice(i * 4, i * 4 + 4)], after: [...before.rgba.slice(i * 4, i * 4 + 4)] });
      } else expect(before.rgba.slice(i * 4, i * 4 + 4), `unrelated_historical_delta:${i}`).toEqual(historical.rgba.slice(i * 4, i * 4 + 4));
    }
    expect(eyeMigration).toHaveLength(4);
    const fixed = { ...saved, outfitPlan: preserveObservedSleeveColor(saved.outfitPlan, a) };
    expect(fixed.outfitPlan.upper.leftSleeve.color).toBe("#c8798c");
    expect(fixed.outfitPlan.upper.rightSleeve.color).toBe("#c8798c");
    const after = render(fixed);
    expect(render(fixed).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    const allowed = new Set<number>();
    for (const arm of ["rightArm", "leftArm"] as const) for (const rect of Object.values(CLASSIC_LAYOUT[arm].base))
      for (let y = 0; y < (rect.h === 12 ? 4 : rect.h); y++) for (let x = 0; x < rect.w; x++)
        if (rect !== CLASSIC_LAYOUT[arm].base.bottom) allowed.add((rect.y + y) * 64 + rect.x + x);
    const changed: number[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
      expect(allowed.has(p), `outside_sleeve:${p}`).toBe(true); changed.push(p);
    }
    expect(changed.length).toBeGreaterThan(0);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-sleeve-color-offline-20261010-");
    for (const [name, image] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(image), { flag: "wx" });
      for (const view of renderSkinViews(image)) writeFileSync(`${output}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ sourceRunId: run.runId, sourceSummarySha256: sha(bytes),
      scope: "saved_plan_color_counterfactual_not_live", missingPromptReconstructed: false,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_COLOR_LOST", beforeMatchesLive: false,
      historicalPngSha256: sha(historicalBytes), intentionalEyeMigration: eyeMigration, unrelatedHistoricalPixelDiff: 0,
      beforeColor: "#eeeae1", afterColor: "#c8798c", changedPixels: changed.length, outsideSleeveDiff: 0,
      beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba), atlasValid: true, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`OBSERVED_SLEEVE_COLOR ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
