// Offline contract and immutable same-run replay. No live runner imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan, outfitPlanSignature } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(clothing: string, visible = true) {
  const a = makeAnalysis();
  return makeAnalysis({ observed: { ...a.observed, clothing, accessories: "none" }, outfitPrompt: "",
    visibleRegions: { ...a.visibleRegions, upperBody: visible },
    renderHints: { ...a.renderHints, garmentTexture: "knit", outerGarment: "none" },
    fallbackFeatures: { ...a.fallbackFeatures, topType: "hoodie" } });
}
it.each(["hoodie", "shirt", "sweater"])("keeps independent block ground and chest ink on a %s", garment => {
  const a = input(`Oversized ${garment} with pastel pixelated blocks (pink, lilac, yellow, cyan, white) and a central dark pixel face graphic on the chest, white ribbed cuffs; white pants`);
  const immutable = JSON.stringify(a), p = buildOutfitPlan(a).upper.pattern;
  expect(p).toMatchObject({ kind: "checker_block", construction: "pixel_blocks", placement: "wrap",
    frontGraphic: { color: "#242326", anchor: "center", source: "observed" } });
  expect(p.blockColors).toEqual(["#d9a5af", "#cdbfd9", "#e1c87d", "#82cec6", "#f2eee6"]);
  expect(p.frontGraphic!.evidence).not.toContain("cuffs");
  expect(JSON.stringify(a)).toBe(immutable);
});
it.each([
  "Hoodie with pixelated blocks (red and cream) and a central blue graphic",
  "Shirt with a blocky pattern in red and cream and a centered blue logo on the chest",
  "Sweater with a pixelated pattern consisting of red and cream blocks with a central blue graphic",
])("composes an existing palette carrier with a separate motif: %s", text => {
  const p = buildOutfitPlan(input(text)).upper.pattern;
  expect(p.blockColors).toEqual(["#b53a35", "#ded2b6"]);
  expect(p.frontGraphic?.color).toBe("#416b9d");
});
it.each([
  "Hoodie with no pixelated blocks (red and blue) and a central dark graphic",
  "Possibly a hoodie with pixelated blocks (red and blue) and a central dark graphic",
  "Hoodie with pixelated blocks (red and unknown) and a central dark graphic",
  "Hoodie with pixelated blocks (red and red) and a central dark graphic",
  "Hoodie with pixelated blocks (red, green, blue, pink, white and yellow) and a central dark graphic",
  "Hoodie with pixelated blocks (red and blue) on one sleeve and a central dark graphic",
  "Hoodie with a scarf with pixelated blocks (red and blue) and a central dark graphic",
  "Hoodie with a pixelated logo (red and blue) and a central dark graphic",
  "Plain hoodie; pants with pixelated blocks (red and blue) and a central dark graphic",
  "Hoodie over a shirt with pixelated blocks (red and blue) and a central dark graphic",
  "Hoodie with pixelated blocks (red and blue) and no central dark graphic",
  "Hoodie with pixelated blocks (red and blue) and a central mystery graphic",
  "Hoodie with pixelated blocks (red and blue) and a central dark graphic on the back",
  "Hoodie with pixelated blocks (red and blue) and a central dark graphic, possibly white cuffs",
  "Hoodie with pixelated blocks (red and blue) and a central dark graphic, striped cuffs",
])("does not bypass ownership, uncertainty or complete-palette guards: %s", text => {
  const p = buildOutfitPlan(input(text)).upper.pattern;
  expect(p.construction).not.toBe("pixel_blocks"); expect(p.frontGraphic).toBeUndefined();
});
it("does not synthesize a motif from cloth or borrow hidden/prompt-only evidence", () => {
  const text = "Hoodie with pixelated blocks (red and cream)";
  expect(buildOutfitPlan(input(text)).upper.pattern.frontGraphic).toBeUndefined();
  expect(buildOutfitPlan(input(text, false)).upper.pattern.blockColors).toBeUndefined();
  const a = input("Plain hoodie"); a.outfitPrompt = text;
  expect(buildOutfitPlan(a).upper.pattern.blockColors).toBeUndefined();
  const aPlan = buildOutfitPlan(input(`${text} and a central blue graphic`));
  const bPlan = buildOutfitPlan(input(`${text} and a central green graphic`));
  expect(aPlan.upper.pattern.blockColors).toEqual(bPlan.upper.pattern.blockColors);
  expect(outfitPlanSignature(aPlan)).not.toBe(outfitPlanSignature(bPlan));
});

it("repairs only D020's observed cloth/graphic plan, retaining all other same-run parameters", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, plan = structuredClone(saved);
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" };
    const immutable = JSON.stringify(t);
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    const pattern = buildOutfitPlan(a).upper.pattern;
    expect(pattern.blockColors).toHaveLength(5); expect(pattern.frontGraphic?.color).toBe("#242326");
    // Only this observed contract is transferable; missing prompt/analysis
    // context is unavailable and may not rebuild any unrelated plan field.
    plan.outfitPlan.upper.pattern = pattern;
    const restored = structuredClone(plan); restored.outfitPlan.upper.pattern = saved.outfitPlan.upper.pattern;
    expect(restored).toEqual(saved);
    const render = (p: SkinPlan) => {
      const base = buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, p)!;
      const r = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, t.injectedParameters.faceStyle);
      expect(validateFinalAtlas(r.atlas)).toEqual({ ok: true, problems: [] });
      const craft = validateReferenceAtlasCraft(r.atlas, base, p, t.injectedParameters.faceStyle,
        buildReferenceCraftPlan(p, t.referenceStyle.design, r));
      expect(craft.ok, JSON.stringify(craft)).toBe(true);
      return r.atlas;
    };
    const before = render(saved), after = render(plan), actual = await decodePng(png);
    expect(before.rgba).toEqual(actual.rgba); expect(render(plan).rgba).toEqual(after.rgba);
    const noGraphic = structuredClone(plan); delete noGraphic.outfitPlan.upper.pattern.frontGraphic;
    const groundOnly = render(noGraphic), front = CLASSIC_LAYOUT.body.base.front;
    const graphicCells: Array<{ x: number; y: number }> = [], changedCells: Array<{ x: number; y: number }> = [];
    const cloth = ["body", "rightArm", "leftArm"] as const;
    const rects = cloth.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      const x = i % 64, y = Math.floor(i / 64);
      if ([0, 1, 2].some(ch => after.rgba[i * 4 + ch] !== before.rgba[i * 4 + ch])) {
        changedCells.push({ x, y });
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), `cloth only ${x},${y}`).toBe(true);
      }
      if ([0, 1, 2].some(ch => after.rgba[i * 4 + ch] !== groundOnly.rgba[i * 4 + ch])) {
        graphicCells.push({ x: x - front.x, y: y - front.y });
        expect(x >= front.x && x < front.x + front.w && y >= front.y && y < front.y + front.h).toBe(true);
      }
    }
    expect(changedCells.length).toBeGreaterThan(100);
    expect(graphicCells).toEqual([{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 2, y: 5 }, { x: 3, y: 5 }, { x: 4, y: 5 }]);
    const visiblePalette = pattern.blockColors!.map(hex => {
      const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let count = 0;
      for (const part of cloth) {
        const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
        for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
          const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
          const at = after.rgba[oi + 3] ? oi : bi;
          if (rgb.every((c, i) => after.rgba[at + i] === c)) count++;
        }
      }
      expect(count, hex).toBeGreaterThan(0); return { color: hex, visibleFrontPixels: count };
    });
    const out = freshAuditOutput("evaluation-artifacts/block-cloth-graphic-replay-20261011-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      const encoded = await encodePng(atlas); expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back"].includes(v.name)))
        writeFileSync(`${out}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_same_run_pattern_only_replay", providerCalls: 0,
      sourceRoot: root, sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), actualBaselineExact: true,
      beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba), pattern, visiblePalette, graphicCells,
      changedPixels: changedCells.length, unrelatedPixelsChanged: 0, alphaChanges: 0, craftPass: true, atlasPass: true,
      providerContractChanged: false, otherPlanParametersChanged: false, freshLiveDeliveryVerified: false,
      nextBoundary: "visual_review_and_frozen_regression", unresolved: ["eye_readability", "front_hair_length", "cuff_color", "invalid_localization"] }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("BLOCK_CLOTH_GRAPHIC_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
