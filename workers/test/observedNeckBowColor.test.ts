// Offline evidence replay only; never import the remote runner.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan, preserveObservedNeckBowColor } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-001";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const summaryBytes = readFileSync(`${root}/summary.json`);
const run = JSON.parse(summaryBytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;

function observed(clothing: string, accessories = "") {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.observed.accessories = accessories;
  a.visibleRegions.upperBody = true;
  a.renderHints.neckAccessory = "bow";
  a.fallbackFeatures.topAccentColor = "white";
  return a;
}

it.each([
  ["a pink bow at the center chest", "#c8798c"],
  ["a pink bow at the center of the neckline", "#c8798c"],
  ["a blue neck bow", "#416b9d"],
  ["a red satin bow on the collar", "#b53a35"],
  ["the chest bow is green", "#467a50"],
])("binds observed bow-local color in %s through the production planner", (clothing, expected) => {
  const a = observed(`a white blouse; ${clothing}`);
  const p = buildOutfitPlan(a);
  expect(p.accessories.find(x => x.kind === "bow")?.color).toBe(expected);
  expect(p.upper.baseColor).toBe("#eeeae1");
});

it.each([
  "a pink hair bow",
  "a pink bow on the shoe",
  "a pink bow on the thigh",
  "a pink shirt with a bow at the chest",
  "no pink bow at the chest",
  "a possibly pink bow at the chest",
  "the pink chest bow is occluded",
  "a pink and white bow at the chest",
  "a pink bow at the chest; a blue neck bow",
  "a pink shirt collar with an unknown bow",
  "a white neckline with a bow of unknown color",
  "a pink neckline with a white hair bow",
])("does not borrow or invent bow color from %s", clothing => {
  const a = observed(clothing);
  expect(preserveObservedNeckBowColor(saved.outfitPlan, a)).toBe(saved.outfitPlan);
});

it("keeps unrelated hair bows, hidden torsos, inferred prose and non-bow accessories separate", () => {
  const a = observed("a white top", "a small white bow on the viewer-left side of the hair, a pink bow centered on the chest");
  const fixed = preserveObservedNeckBowColor(saved.outfitPlan, a);
  expect(fixed.accessories.find(x => x.kind === "bow")?.color).toBe("#c8798c");
  expect(fixed.accessories.filter(x => x.kind !== "bow")).toEqual(saved.outfitPlan.accessories.filter(x => x.kind !== "bow"));
  a.visibleRegions.upperBody = false;
  expect(preserveObservedNeckBowColor(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true; a.observed.accessories = "";
  a.outfitPrompt = "a pink bow at the chest";
  expect(preserveObservedNeckBowColor(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  const noBow = { ...saved.outfitPlan, accessories: [] };
  expect(preserveObservedNeckBowColor(noBow, observed("a pink neck bow"))).toBe(noBow);
});

it("proves actual H normalized-to-plan color loss, then changes only existing bow pixels offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(trace.primary.observed.clothing).toContain("a pink bow at the center chest");
    expect(trace.renderAnalysis.observed.clothing).toContain("a pink bow at the center chest");
    expect(saved.outfitPlan.accessories.find(x => x.kind === "bow")?.color).toBe("#eeeae1");
    expect(trace.referenceStyle).toMatchObject({ status: "source_grammar_preserved", preservedReason: "unresolved_complex_head_grammar" });
    const frozen = JSON.stringify(trace);
    const actual = await decodePng(readFileSync(`${root}/skin.png`));
    const render = (plan: SkinPlan) => buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, plan)!;
    const before = render(saved);
    expect(sha(before.rgba)).toBe(run.png.decodedRgbaSha256);
    expect(before.rgba).toEqual(actual.rgba);
    const fixed = { ...saved, outfitPlan: preserveObservedNeckBowColor(saved.outfitPlan, trace.renderAnalysis) };
    expect(fixed.outfitPlan.accessories.find(x => x.kind === "bow")?.color).toBe("#c8798c");
    expect({ ...fixed.outfitPlan, accessories: saved.outfitPlan.accessories, provenance: saved.outfitPlan.provenance }).toEqual(saved.outfitPlan);
    const after = render(fixed);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    expect(render(fixed).rgba).toEqual(after.rgba);
    const r = CLASSIC_LAYOUT.body.overlay.front;
    const bowCells = [[2, 1], [3, 1], [5, 1], [2, 2], [3, 2], [4, 2], [5, 2], [3, 3], [4, 3]];
    const allowed = new Set(bowCells.map(([x, y]) => (r.y + y) * 64 + r.x + x));
    const changed: number[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
      expect(allowed.has(p), `unexpected_pixel:${p}`).toBe(true); changed.push(p);
    }
    expect(changed.length).toBeGreaterThan(0);
    expect(JSON.stringify(trace)).toBe(frozen);
    expect(readFileSync(`${root}/summary.json`)).toEqual(summaryBytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-neck-bow-color-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front.image, 192, 384)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ context: "saved_plan_counterfactual_not_new_live", sourceRun: run.runId,
      sourceSummarySha256: sha(summaryBytes), beforeMatchesLivePng: true, noFullAnalysisReconstruction: true,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_COLOR_LOST", beforeColor: "#eeeae1", afterColor: "#c8798c",
      changedPixels: changed, outsideExistingBowPixelDiff: 0, beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba),
      atlasValid: true, deterministic: true, providerCalls: 0 }, null, 2), { flag: "wx" });
  } finally { network.mockRestore(); }
}, 30_000);
