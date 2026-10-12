import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan, outfitPlanSignature } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { resolveHeadOwnership } from "../src/headOwnership";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { decodePng, encodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const clothing = "a long-sleeved hoodie featuring a pixelated, blocky pattern in pastel shades of pink, lavender, and light blue";
it.each(["in", "consisting of", "featuring"])("keeps a complete pixelated patchwork palette after %s", connector => {
  const p = buildOutfitPlan(input(`Oversized hoodie with a pastel pixelated patchwork pattern ${connector} pink, lavender, light blue, and yellow squares; white pants`)).upper.pattern;
  expect(p).toMatchObject({ construction: "pixel_blocks", placement: "wrap", source: "observed" });
  expect(p.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#a9d5eb", "#e1c87d"]);
});
it.each(["squares", "blocks", ""])("preserves checker list morphology without inventing colors: %s", suffix => {
  const p = buildOutfitPlan(input(`Shirt with a checkered pattern consisting of red and cream ${suffix}`)).upper.pattern;
  expect(p.blockColors).toEqual(["#b53a35", "#ded2b6"]);
});
it.each([
  "Plain hoodie; pants with a pastel pixelated patchwork pattern consisting of pink and blue squares",
  "Hoodie with a scarf with a pastel pixelated patchwork pattern consisting of pink and blue squares",
  "Hoodie with a pastel pixelated patchwork logo consisting of pink and blue squares",
  "Hoodie with no pastel pixelated patchwork pattern consisting of pink and blue squares",
  "Hoodie with possibly a pastel pixelated patchwork pattern consisting of pink and blue squares",
  "Hoodie with a pastel pixelated patchwork pattern consisting of pink and mystery squares",
  "Hoodie with a pastel pixelated patchwork pattern consisting of pink and pink squares",
  "Hoodie with a pastel pixelated patchwork pattern consisting of red, green, blue, pink, white and yellow squares",
  "Hoodie with a pastel pixelated patchwork pattern consisting of pink and blue squares on one sleeve",
])("rejects unowned, uncertain or incomplete patchwork palettes: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it.each(["checkered/pixelated", "checkered / pixelated", "checked/pixelated", "checkerboard/pixelated"])(
  "preserves pastel across bounded checker/pixelated compounds: %s", descriptor => {
    const p = buildOutfitPlan(input(`A loose-fitting hoodie with a pastel ${descriptor} pattern in shades of pink, lavender, and yellow; plain white pants`)).upper.pattern;
    expect(p.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#e1c87d"]);
  });
it.each([
  "Hoodie with pastel buttons and a checkered/pixelated pattern in pink and blue",
  "Hoodie with a checkered/pixelated pattern in pink and blue; pastel pants",
])("does not borrow pastel from another owner across checker compounds: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.blockColors).toEqual(["#c8798c", "#416b9d"]);
});
it.each([
  "Hoodie with possibly a pastel checkered/pixelated pattern in pink and blue",
  "Hoodie with a scarf with a pastel checkered/pixelated pattern in pink and blue",
  "Hoodie with a pastel checkered/pixelated pattern in pink and mystery",
])("keeps checker-compound uncertainty and palette guards: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
function input(text: string, visible = true) {
  const a = makeAnalysis();
  return makeAnalysis({ observed: { ...a.observed, clothing: text, accessories: "none" }, outfitPrompt: "",
    renderHints: { ...a.renderHints, garmentTexture: "knit", outerGarment: "none" },
    fallbackFeatures: { ...a.fallbackFeatures, topType: "hoodie" }, visibleRegions: { ...a.visibleRegions, upperBody: visible } });
}
it.each(["pixelated/blocky", "pixelated / blocky", "pixelated, blocky", "pixelated blocky"])(
  "preserves the pastel modifier of a compound pattern: %s", pattern => {
    const p = buildOutfitPlan(input(`Oversized hoodie with a colorful pastel ${pattern} pattern in shades of pink, purple, blue, and yellow; plain white pants`)).upper.pattern;
    expect(p.blockColors).toEqual(["#d9a5af", "#a38cab", "#819cba", "#e1c87d"]);
  });
it.each([
  "Hoodie with pastel buttons and a pixelated/blocky pattern in shades of pink and blue",
  "Hoodie with a pixelated/blocky pattern in shades of pink and blue; pastel pants",
])("does not transfer an unrelated pastel modifier to compound patterns: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.blockColors).toEqual(["#c8798c", "#416b9d"]);
});
it.each([
  "Hoodie with possibly a pastel pixelated/blocky pattern in pink and blue",
  "Hoodie with a scarf with a pastel pixelated/blocky pattern in pink and blue",
  "Hoodie with a pastel pixelated/blocky pattern in pink and mystery",
])("retains scope and complete-palette guards for compound patterns: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it.each([clothing, "Blue shirt with a blocky pattern in red, cream and blue", "Sweater with a pixelated pattern in green and yellow"])("preserves garment-bound block construction and explicit palette: %s", text => {
  const a = input(text), original = JSON.stringify(a), p = buildOutfitPlan(a).upper.pattern;
  expect(p.construction).toBe("pixel_blocks"); expect(p.kind).toBe("checker_block");
  expect(p.blockColors!.length).toBeGreaterThanOrEqual(2);
  expect(p.source).toBe("observed"); expect(JSON.stringify(a)).toBe(original);
});
it.each([
  "Plain hoodie", "Hoodie with no blocky pattern in pink and blue", "Hoodie with possibly a blocky pattern in pink and blue",
  "Hoodie with an unknown blocky pattern in pink and blue", "Hoodie with a blocky pattern in pink and mystery",
  "Hoodie with a blocky pattern in pink", "Hoodie with a blocky logo in pink and blue",
  "Plain hoodie; pants with a blocky pattern in pink and blue", "Plain hoodie with a scarf with a blocky pattern in pink and blue",
  "Hoodie over a shirt with a blocky pattern in pink and blue", "Hoodie with a blocky pattern on one sleeve in pink and blue",
  "Hoodie with a blocky pattern in pink and pink", "Hoodie with a blocky pattern in red, green, blue, yellow, pink and white",
])("does not invent whole-garment block evidence: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it.each([
  "Hoodie with a geometric block pattern in pink, purple, lavender, yellow, and light blue",
  "Shirt with an abstract geometric block pattern in red and cream",
  "Hoodie with a blocky pattern in red, green, blue, yellow and pink",
])("preserves complete bounded geometric palettes: %s", text => {
  const p = buildOutfitPlan(input(text)).upper.pattern;
  expect(p.construction).toBe("pixel_blocks");
  expect(p.blockColors).toHaveLength(text.includes("cream") ? 2 : 5);
});
it("binds pastel to the observed garment, not another garment or trim", () => {
  const phrase = "hoodie with a large, abstract geometric block pattern in shades of pink, purple, lavender, yellow, and light blue";
  const base = buildOutfitPlan(input(phrase)).upper.pattern;
  expect(base.blockColors).toEqual(["#c8798c", "#755386", "#b6a2cc", "#d5af3f", "#7fc3e8"]);
  const pastel = buildOutfitPlan(input(`A pastel-colored oversized ${phrase}. White trousers.`)).upper.pattern;
  expect(pastel.blockColors).toEqual(["#d9a5af", "#a38cab", "#cdbfd9", "#e1c87d", "#a9d5eb"]);
  expect(buildOutfitPlan(input(`${phrase}. Pastel-colored trousers.`)).upper.pattern.blockColors).toEqual(base.blockColors);
  expect(buildOutfitPlan(input(`A ${phrase.replace("with a large,", "with pastel-colored buttons and a large,")}`)).upper.pattern.blockColors).toEqual(base.blockColors);
});
it.each([
  "Hoodie with no geometric block pattern in pink and blue",
  "Hoodie with possibly a geometric block pattern in pink and blue",
  "Hoodie with a geometric block pattern in pink and mystery",
  "Plain hoodie; trousers with a geometric block pattern in pink and blue",
  "Hoodie with a scarf with a geometric block pattern in pink and blue",
  "Hoodie over a shirt with a geometric block pattern in pink and blue",
  "Hoodie with a geometric block pattern on one sleeve in pink and blue",
])("does not broaden geometric block ownership: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it("keeps explicit color order and source-specific palettes distinct within the same construction", () => {
  const a = buildOutfitPlan(input("Blue hoodie with a blocky pattern in red, cream and blue"));
  const b = buildOutfitPlan(input("Blue hoodie with a blocky pattern in green, yellow and blue"));
  expect(a.upper.pattern.blockColors).toEqual(["#b53a35", "#ded2b6", "#416b9d"]);
  expect(b.upper.pattern.blockColors).toEqual(["#467a50", "#d5af3f", "#416b9d"]);
  expect(outfitPlanSignature(a)).not.toBe(outfitPlanSignature(b));
});
it("does not use hidden or prompt-only block evidence", () => {
  expect(buildOutfitPlan(input(clothing, false)).upper.pattern.construction).not.toBe("pixel_blocks");
  const a = input("Plain hoodie"); a.outfitPrompt = clothing;
  expect(buildOutfitPlan(a).upper.pattern.construction).not.toBe("pixel_blocks");
});
it.each([
  "Oversized pastel color-block hoodie with pixel/Minecraft creeper-like motif in pink, lavender, mint, and yellow blocks with white cuffs",
  "A pastel colour-block sweater in pink, lavender, mint and yellow blocks",
])("keeps a garment-owned block list distinct from trim: %s", text => {
  const p = buildOutfitPlan(input(text)).upper.pattern;
  expect(p).toMatchObject({ construction: "pixel_blocks", placement: "wrap", source: "observed" });
  expect(p.blockColors).toHaveLength(4);
  const plain = buildOutfitPlan(input("Color-block hoodie in pink, lavender, mint and yellow blocks")).upper.pattern;
  expect(p.blockColors).not.toEqual(plain.blockColors);
  expect(p.blockColors).toEqual(buildOutfitPlan(input(text.replace(/ with white cuffs$/, ""))).upper.pattern.blockColors);
});
it.each([
  "Hoodie with a color-block logo in pink and blue blocks",
  "Color-block scarf with pink and blue blocks over a plain hoodie",
  "Plain hoodie; color-block trousers in pink and blue blocks",
  "Possibly a color-block hoodie in pink and blue blocks",
  "Color-block hoodie in pink and mystery blocks with white cuffs",
  "Color-block hoodie in pink and pink blocks with white cuffs",
  "Color-block hoodie in red, green, blue, yellow, pink and white blocks",
  "Color-block hoodie with a front motif in pink and blue blocks",
  "Color-block hoodie with a sleeve motif in pink and blue blocks",
  "Color-block hoodie in pink and blue blocks with mystery cuffs",
  "Hoodie with pink and blue cuffs",
])("does not widen block ownership or fill an incomplete palette: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it.each([
  "a loose-fitting hoodie with a pastel checkered pattern in shades of pink, lavender, yellow, and blue",
  "A shirt with a pastel checkerboard pattern in pink, lavender, yellow and blue",
])("keeps complete pastel checker palettes: %s", text => {
  const p = buildOutfitPlan(input(text)).upper.pattern;
  expect(p.construction).toBe("pixel_blocks");
  expect(p.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#e1c87d", "#819cba"]);
});
it("preserves a non-pastel checker palette without borrowing a lower garment modifier", () => {
  const p = buildOutfitPlan(input("A shirt with a checked pattern in red and cream. Pastel trousers.")).upper.pattern;
  expect(p.blockColors).toEqual(["#b53a35", "#ded2b6"]);
});
it.each([
  "Plain hoodie; pants with a pastel checkered pattern in pink and blue",
  "Hoodie with a scarf with a pastel checkered pattern in pink and blue",
  "Hoodie with no pastel checkered pattern in pink and blue",
  "Hoodie with possibly a pastel checkered pattern in pink and blue",
  "Hoodie with a pastel checkered pattern in pink and mystery",
  "Hoodie with a pastel checkered pattern in pink and pink",
  "Hoodie with a pastel checkered pattern in red, green, blue, yellow, pink and white",
  "Hoodie with plaid checkered pattern in red and cream",
  "Hoodie with crossed stripes and a checkered pattern in red and cream",
])("does not promote ambiguous or unowned checker evidence: %s", text => {
  expect(buildOutfitPlan(input(text)).upper.pattern.construction).not.toBe("pixel_blocks");
});
it("replays only saved D005 block evidence through the production renderer and PNG, without touching head or legs", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
    const bytes = readFileSync(`${root}/summary.json`), t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
    const saved: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    saved.headIdentityPlan.ownership = resolveHeadOwnership(a, saved.hairPlan, saved.facePixelPlan);
    const plan = structuredClone(saved), pattern = buildOutfitPlan(a).upper.pattern;
    expect(pattern.construction).toBe("pixel_blocks");
    // Preserve omitted prompt-derived context; transfer only the observed pattern.
    plan.outfitPlan.upper.pattern = pattern;
    const features = refineFeatureColorsFromAnalysis(a, t.injectedParameters.features);
    const style = { ...t.injectedParameters.faceStyle, hatColor: features.hatColor };
    const render = (p: SkinPlan) => {
      const result = renderReferencePrimaryAtlas(buildProceduralSourceAtlas(features, style, p)!, p, a, style);
      expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error("reference_render_failed");
      return result;
    };
    const before = render(saved), after = render(plan);
    const allowed = ["body", "leftArm", "rightArm"] as const;
    const rects = allowed.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
    let changed = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.atlas.rgba[i * 4 + 3]).toBe(before.atlas.rgba[i * 4 + 3]);
      if (after.atlas.rgba.slice(i * 4, i * 4 + 4).some((v, ch) => v !== before.atlas.rgba[i * 4 + ch])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), `non_cloth:${x},${y}`).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(0); expect(render(plan).atlas.rgba).toEqual(after.atlas.rgba);
    const visiblePalette = pattern.blockColors!.map(hex => {
      const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
      let count = 0;
      for (const part of allowed) {
        const base = CLASSIC_LAYOUT[part].base.front, overlay = CLASSIC_LAYOUT[part].overlay.front;
        for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
          const b = ((base.y + y) * 64 + base.x + x) * 4, o = ((overlay.y + y) * 64 + overlay.x + x) * 4;
          const at = after.atlas.rgba[o + 3] === 255 ? o : b;
          if (rgb.every((c, i) => after.atlas.rgba[at + i] === c)) count++;
        }
      }
      expect(count, `visible_named_palette:${hex}`).toBeGreaterThan(0);
      return { color: hex, visibleFrontPixels: count };
    });
    const out = freshAuditOutput("evaluation-artifacts/observed-block-pattern-offline-20261010-");
    for (const [name, result] of [["before", before], ["after", after]] as const) {
      const png = await encodePng(result.atlas); expect((await decodePng(png)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, png, { flag: "wx" });
      const front = renderSkinViews(result.atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_D005_pattern_only_not_live", providerCalls: 0,
      pattern, visiblePalette, changed, unrelatedPixelDiff: 0, alphaUnchanged: true, craft: after.summary.craftValidation,
      historicalArtifactsUnchanged: true, missingPromptsNotReconstructed: true }, null, 2), { flag: "wx" });
    console.info("BLOCK_PATTERN", out); expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
}, 60_000);
