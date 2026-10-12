// Offline only: consumed evidence is read-only; no remote runner imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan, preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { assertAccessoryPaletteBoundary } from "./historicalScarfBeltColors";

const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001";
const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function observed(clothing: string, accessories = "") {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.observed.accessories = accessories;
  a.visibleRegions.upperBody = true; a.visibleRegions.lowerBody = true;
  a.renderHints.neckAccessory = "scarf"; a.renderHints.bottomAccent = "belt";
  a.fallbackFeatures.topAccentColor = "beige";
  return a;
}

it.each([
  ["pink belt", "belt", "#c8798c"],
  ["blue leather belt", "belt", "#416b9d"],
  ["belt is red", "belt", "#b53a35"],
  ["white neck scarf", "scarf", "#eeeae1"],
  ["pale cream knitted scarf with fringed ends", "scarf", "#ded2b6"],
  ["knitted off-white fringed scarf wrapped around neck", "scarf", "#ded2b6"],
  ["dark blue wool scarf", "scarf", "#273954"],
  ["scarf in green", "scarf", "#467a50"],
])("binds %s through the production planner", (text, kind, expected) => {
  const a = observed(`brown cardigan; ${text}`), p = buildOutfitPlan(a);
  expect(p.accessories.find(x => x.kind === kind)?.color).toBe(expected);
  expect(p.upper.baseColor).toBe("#684b38");
  expect(p.upper.accentColor).toBe("#c5aa82");
});

it.each([
  "pink shirt with a belt", "pink belt buckle", "white scarf print on a shirt",
  "no pink belt", "possibly pink belt", "pink belt is hidden", "belt of unknown color",
  "pink and white belt", "pink/white belt", "pink-white belt", "pink, white belt", "belt is pink and white",
  "pink, white, and blue belt", "pink or white belt", "pink & white belt", "pink belt with blue stripes",
  "pink belt; blue belt", "pink belt; belt color unknown", "white patterned scarf",
  "white headscarf", "white scarf wrapped around the head", "white scarf covering hair",
  "no cream scarf", "cream and blue scarf", "scarf in cream/blue", "pink waistband",
])("does not invent or borrow material from %s", text => {
  expect(preserveObservedScarfBeltColors(saved.outfitPlan, observed(text))).toBe(saved.outfitPlan);
});

it("keeps accessory hues independent of each other and nearby hair/garment colors", () => {
  const a = observed("brown cardigan, pale cream knitted scarf, blue jeans", "white flower hair clip. Pink belt at the waistband. Off-white neck scarf.");
  const p = preserveObservedScarfBeltColors(saved.outfitPlan, a);
  expect(p.accessories.map(x => [x.kind, x.color])).toEqual([["scarf", "#ded2b6"], ["belt", "#c8798c"]]);
  expect(preserveObservedScarfBeltColors(p, a)).toBe(p);
  expect({ ...p, accessories: saved.outfitPlan.accessories, provenance: saved.outfitPlan.provenance }).toEqual(saved.outfitPlan);
});

it("does not create accessories, use inferred prose or recolor invisible/conservative material", () => {
  const a = observed("plain top");
  a.outfitPrompt = "pink belt and cream neck scarf";
  expect(preserveObservedScarfBeltColors(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.observed.accessories = "pink belt. cream neck scarf";
  const empty = { ...saved.outfitPlan, accessories: [] };
  expect(preserveObservedScarfBeltColors(empty, a)).toBe(empty);
  a.visibleRegions.upperBody = false; a.visibleRegions.lowerBody = false;
  expect(preserveObservedScarfBeltColors(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  a.visibleRegions.upperBody = true; a.visibleRegions.lowerBody = true;
  const hidden = { ...saved.outfitPlan, accessories: saved.outfitPlan.accessories.map(x => ({ ...x, source: "conservative" as const })) };
  expect(preserveObservedScarfBeltColors(hidden, a)).toBe(hidden);
});

it("repairs the consumed C plan palette with pixel deltas confined to existing scarf/belt stencils", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
    expect(trace.primary.observed).toEqual(trace.renderAnalysis.observed);
    const original = JSON.stringify(saved);
    const render = (p: SkinPlan) => buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, p)!;
    const before = render(saved), actual = await decodePng(readFileSync(`${root}/skin.png`));
    expect(sha(before.rgba)).toBe(sha(actual.rgba));
    const p = preserveObservedScarfBeltColors(saved.outfitPlan, trace.renderAnalysis);
    expect(p.accessories.map(x => [x.kind, x.color])).toEqual([["scarf", "#ded2b6"], ["belt", "#c8798c"]]);
    const after = render({ ...saved, outfitPlan: p });
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    expect(sha(render({ ...saved, outfitPlan: p }).rgba)).toBe(sha(after.rgba));
    const changed = assertAccessoryPaletteBoundary(before, after, { ...saved, outfitPlan: p }, trace.injectedParameters.features.skinTone);
    expect(changed.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).toBe(original);
    expect(sha(readFileSync(`${root}/summary.json`))).toBe(sha(bytes));
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/observed-scarf-belt-color-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front.image, front.image.width * 4, front.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ context: "saved_plan_counterfactual_not_live", sourceRun: run.runId,
      sourceSummarySha256: sha(bytes), earliestLoss: "NORMALIZED_PRESERVED_PLAN_COLOR_LOST", beforeMatchesLivePng: true,
      noFullAnalysisReconstruction: true, colors: p.accessories.map(({ kind, color }) => ({ kind, color })),
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba), changedPixels: changed,
      outsideExistingAccessoryDelta: 0, alphaDelta: 0, atlasValid: true, deterministic: true, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.log("SCARF_BELT_OFFLINE", output);
  } finally { network.mockRestore(); }
}, 30_000);
