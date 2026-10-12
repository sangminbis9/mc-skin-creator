import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-028";
const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
const savedStyle = JSON.parse(readFileSync("evaluation-artifacts/current-028-live-verification-20260928-NKL61L/verification.json", "utf8")).style;
function input(clothing = live.diagnostics.normalizedPrimary.observed.clothing) {
  const a = makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
  a.observed.clothing = clothing;
  return a;
}
it.each([live.diagnostics.normalizedPrimary.observed.clothing,
  "Navy button down shirt with thin white stripes.", "Navy button-up shirt with white lines."])(
  "uses shirt material for an observed button shirt collar without a separate contrast cue: %s", clothing => {
    const a = input(clothing), before = structuredClone(a), p = buildOutfitPlan(a);
    expect(p.upper.collar).toBe("paired"); expect(p.upper.collarColor).toBe(p.upper.baseColor);
    expect(p.upper.accentColor).toBe("#eeeae1"); expect(a).toEqual(before);
  });
it.each(["Navy button-down shirt with a white collar.", "Navy button-down shirt with a contrasting collar."])(
  "preserves explicit contrast collar: %s", clothing => {
    expect(buildOutfitPlan(input(clothing)).upper.collarColor).toBe("#eeeae1");
  });
it("keeps a contrasting tan collar and ordinary explicit same-material collar", () => {
  expect(buildOutfitPlan(input("Navy button-down shirt with a tan collar.")).upper.collarColor).toBe("#c5aa82");
  expect(buildOutfitPlan(input("Navy collared shirt with white stripes.")).upper.collarColor).toBe("#273954");
});
it("does not add a collar or change unspecified, outerwear, and inferred-only contracts", () => {
  const generic = input("Navy shirt with white stripes.");
  expect(buildOutfitPlan(generic).upper.collarColor).toBeUndefined();
  generic.outfitPrompt = "Navy button-down shirt.";
  expect(buildOutfitPlan(generic).upper.collarColor).toBeUndefined();
  const jacket = input("Navy button-down shirt underneath a jacket."); jacket.renderHints.outerGarment = "open_jacket";
  expect(buildOutfitPlan(jacket).upper.collar).toBe("lapel"); expect(buildOutfitPlan(jacket).upper.collarColor).toBeUndefined();
  const tee = input("Navy t-shirt with a button-down pattern."); tee.fallbackFeatures.topType = "tshirt"; tee.renderHints.neckAccessory = "none";
  expect(buildOutfitPlan(tee).upper.collar).toBe("none"); expect(buildOutfitPlan(tee).upper.collarColor).toBeUndefined();
});
it("does not borrow contrast color from another garment", () => {
  const p = buildOutfitPlan(input("Navy button-down shirt and white shoes."));
  expect(p.upper.collarColor).toBe("#273954");
});
it("isolates the material connection to six collar overlay cells in actual 028", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const plan = structuredClone(live.analysis.skinPlan), next = structuredClone(plan);
    expect(plan.outfitPlan.upper.collarColor).toBeUndefined();
    next.outfitPlan.upper.collarColor = buildOutfitPlan(input()).upper.collarColor;
    expect(next.outfitPlan.upper.collarColor).toBe("#273954");
    const actual = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, savedStyle, plan)!.rgba).toEqual(actual.rgba);
    const after = buildProceduralFallbackAtlas(live.features, savedStyle, next)!;
    const collar = CLASSIC_LAYOUT.body.overlay.front;
    const allowed = [[1, 0], [2, 0], [2, 1], [5, 0], [6, 0], [5, 1]].map(([x, y]) => `${collar.x + x},${collar.y + y}`);
    const changed = [];
    for (let p = 0; p < 4096; p++) {
      expect(actual.rgba[p * 4 + 3]).toBe(after.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => actual.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64); expect(allowed).toContain(`${x},${y}`); changed.push({ x, y });
      }
    }
    expect(changed).toHaveLength(6);
    const craft = validateAtlasCraft(after, savedStyle, undefined, undefined, next);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-028-button-collar-offline-20260928-");
    for (const [name, atlas] of [["before", actual], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas));
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)));
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, exactLiveReplay: true, changed,
      headDiff: 0, alphaDiff: 0, sleeveDiff: 0, patternDiff: 0, craft,
      collarColor: next.outfitPlan.upper.collarColor, rgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Offline single-property counterfactual, not a fresh production output. All missing inference and other plans preserved from the saved result." }, null, 2));
    expect(network).not.toHaveBeenCalled(); console.info(`BUTTON_COLLAR_028 ${out}`);
  } finally { network.mockRestore(); }
});
