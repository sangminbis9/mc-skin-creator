import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { normalizeAnalysisForRendering, buildFaceStyle, fallbackFeaturesToHex, buildProceduralFallbackAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis } from "./helpers";

const live = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json", "utf8")).currentDefaultE2E;
const saved = live.result.diagnostics.normalizedPrimary;

function fixture(hair: string) {
  const base = makeAnalysis();
  // Only the hair observation/hints are retained evidence; this is a controlled
  // component fixture, not reconstruction of unsaved live analysis context.
  return makeAnalysis({
    observed: { ...base.observed, hair, accessories: "none" },
    identityPrompt: hair,
    inferred: { ...base.inferred, hairBack: { value: "short tapered back", rationale: "short sides" } },
    renderHints: { ...saved.renderHints },
  });
}

it("reproduces the live cropped-to-ear loss and retains the explicit endpoint", () => {
  expect(saved.renderHints.overallHairLength).toBe("cropped");
  expect(live.result.analysis.renderHints.overallHairLength).toBe("ear");
  const input = fixture(saved.observed.hair);
  const normalized = normalizeAnalysisForRendering(input);
  expect(normalized.renderHints.overallHairLength).toBe("cropped");
  expect(buildSkinPlan(normalized).hairPlan.headMask.semanticSilhouette?.endpointCue).toBe("cropped");
});

it.each(["Close-cropped black hair", "Buzzed hair", "Very short cropped hair"])("keeps %s cropped", hair => {
  expect(normalizeAnalysisForRendering(fixture(hair)).renderHints.overallHairLength).toBe("cropped");
});

it("does not turn merely short tapered hair into a buzz cut", () => {
  expect(normalizeAnalysisForRendering(fixture("Short neat hair")).renderHints.overallHairLength).toBe("ear");
});

it("keeps focused portrait endpoint precedence", () => {
  const input = fixture("Cropped hair. Focused portrait crop confirms ear-length hair.");
  expect(normalizeAnalysisForRendering(input).renderHints.overallHairLength).toBe("ear");
});

it("retains an explicit surface-only cropped plan through the actual atlas", async () => {
  const afterInput = normalizeAnalysisForRendering(fixture(saved.observed.hair));
  const beforeInput = { ...afterInput, renderHints: { ...afterInput.renderHints, overallHairLength: "ear" as const } };
  const render = (input: typeof afterInput) => {
    const plan = buildSkinPlan(input);
    const features = fallbackFeaturesToHex(input.fallbackFeatures, input.renderHints.skinUndertone);
    const style = buildFaceStyle(input, features);
    const stages: Record<string, string> = {};
    const atlas = buildProceduralFallbackAtlas(features, style, plan,
      (stage, image) => { stages[stage] = createHash("sha256").update(image.rgba).digest("hex"); })!;
    expect(atlas).not.toBeNull();
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    expect(validateAtlasCraft(atlas, style, undefined, undefined, plan).ok).toBe(true);
    return { plan, atlas, stages };
  };
  const before = render(beforeInput), after = render(afterInput);
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.atlas.rgba[p * 4 + c] !== after.atlas.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(p => p.y < 16)).toBe(true);
  expect(after.plan.outfitPlan).toEqual(before.plan.outfitPlan);
  expect(after.plan.facePixelPlan).toEqual(before.plan.facePixelPlan);
  const count = (plan: typeof after.plan) => Object.values(plan.hairPlan.headMask.faces).reduce((n, points) => n + points.length, 0);
  expect(count(after.plan)).toBeLessThan(count(before.plan));
  expect(after.plan.hairPlan.headMask.endpointRows).toEqual(before.plan.hairPlan.headMask.endpointRows);
  const root = mkdtempSync("evaluation-artifacts/cropped-hair-endpoint-20260926-");
  for (const [name, output] of [["before", before], ["after", after]] as const) {
    const head = extractRenderedHeadView(renderSkinViews(output.atlas).find(v => v.name === "front")!);
    writeFileSync(`${root}/${name}-head.png`, await encodePng(scaleNearestNeighbor(head, 192, 192)), { flag: "wx" });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "controlled_endpoint_replay_not_reconstructed_live_output", providerCalls: 0,
    beforeEndpoint: "ear", afterEndpoint: "cropped", beforeMaskPixels: count(before.plan), afterMaskPixels: count(after.plan),
    changed, visibleSilhouetteFixed: true, surfaceOnly: after.plan.hairPlan.surfaceOnly,
    beforeStages: before.stages, afterStages: after.stages,
    facePlanEqual: true, outfitPlanEqual: true, craft: true, finalAtlas: true,
    beforeHash: createHash("sha256").update(before.atlas.rgba).digest("hex"), afterHash: createHash("sha256").update(after.atlas.rgba).digest("hex"),
  }, null, 2), { flag: "wx" });
});
