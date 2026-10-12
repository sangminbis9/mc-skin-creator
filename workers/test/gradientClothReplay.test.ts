import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, generateSkin } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { freshAuditOutput } from "./freshAuditOutput";
import { historicalLooseHairCollision } from "./historicalLooseHairCollision";
import { hairRibbonFootprint } from "../src/hairRibbonFootprint";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("preserves A001's four observed cloth colors without inventing checker blocks or reconstructing omitted primary context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-pastel-patch-20261011-001";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("2087712629e1f730296e371a0f522d1df0c41723b079bd7314e8d2ab6dbc92ec");
    expect(sha(png)).toBe("ffc0e7242d3a19042ad7328666f24edec6fdbc4b22d0b1b4caafb18079fa62d2");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters;
    const immutable = JSON.stringify(t), style = params.faceStyle, live = await decodePng(png);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(saved.outfitPlan.upper.pattern.kind).toBe("none");
    // Complete authored carrier tests the bounded observation parser only.
    // The full primary had omitted fields; never synthesize that whole record.
    const carrier = makeAnalysis();
    carrier.observed.clothing = t.primary.observed.clothing;
    carrier.visibleRegions.upperBody = t.primary.visibleRegions.upperBody;
    carrier.outfitPrompt = "";
    const pattern = buildOutfitPlan(carrier).upper.pattern;
    expect(pattern).toMatchObject({ kind: "color_panel", construction: "stepped_gradient",
      gradientColors: ["#d9a5af", "#e1c87d", "#a38cab", "#a9d5eb"] });
    carrier.fallbackFeatures.topAccentColor = "red"; carrier.outfitPrompt = "Black jacket with green squares";
    expect(buildOutfitPlan(carrier).upper.pattern).toEqual(pattern);
    const originalBase = buildProceduralSourceAtlas(params.features, style, saved)!;
    const historical = historicalLooseHairCollision();
    let ribbonMigrationPixels = 0;
    try {
      // A001 predates scale-aware ribbon paint. Preserve the immutable live
      // baseline under its former medium footprint, not today's small bow.
      expect(style.hairAccessoryScale).toBe("small");
      const oldStyle = { ...style, hairAccessoryScale: "medium" as const };
      const oldBase = buildProceduralSourceAtlas(params.features, oldStyle, saved)!;
      expect(composeReferenceStyleAtlas(oldBase, saved, d, oldStyle).atlas.rgba).toEqual(live.rgba);
      const replay = composeReferenceStyleAtlas(originalBase, saved, d, style);
      const small = hairRibbonFootprint(style.hairAccessorySide, "small");
      const removed = hairRibbonFootprint(style.hairAccessorySide, "medium")
        .filter(c => !small.some(s => s.face === c.face && s.x === c.x && s.y === c.y));
      const allowed = new Set(removed.map(c => {
        const r = CLASSIC_LAYOUT.head.overlay[c.face]; return (r.y + c.y) * 64 + r.x + c.x;
      }));
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => replay.atlas.rgba[i * 4 + ch] !== live.rgba[i * 4 + ch])) {
        expect(allowed.has(i), `unrelated ribbon migration:${i}`).toBe(true);
        expect(live.rgba[i * 4 + 3]).toBe(255);
        expect([...replay.atlas.rgba.slice(i * 4, i * 4 + 4)]).toEqual([0, 0, 0, 0]);
        ribbonMigrationPixels++;
      }
      expect(ribbonMigrationPixels).toBe(removed.length);
    }
    finally { historical.mockRestore(); }
    const before = composeReferenceStyleAtlas(originalBase, saved, d, style);
    const plan = structuredClone(saved); plan.outfitPlan.upper.pattern = pattern;
    const base = buildProceduralSourceAtlas(params.features, style, plan)!;
    const after = composeReferenceStyleAtlas(base, plan, d, style);
    const selected = selectReferenceStyleAtlas(base, plan, d, style).selected!;
    expect(selected).toBeTruthy(); expect(selected.composition.atlas.rgba).toEqual(after.atlas.rgba);
    expect(composeReferenceStyleAtlas(base, plan, d, style).atlas.rgba).toEqual(after.atlas.rgba);
    expect(validateReferenceAtlasCraft(after.atlas, base, plan, style, buildReferenceCraftPlan(plan, d, after)).ok).toBe(true);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    const allowed = new Set<number>();
    for (const part of ["body", "leftArm", "rightArm"] as const) {
      const end = part === "body" ? saved.outfitPlan.upper.hem!.endRow - 1
        : saved.outfitPlan.upper[part === "leftArm" ? "leftSleeve" : "rightSleeve"].terminationRow - 1;
      for (const face of ["front", "back", "left", "right"] as const) {
        const r = CLASSIC_LAYOUT[part].base[face];
        for (let y = 1; y < end; y++) for (let x = 0; x < r.w; x++) allowed.add((r.y + y) * 64 + r.x + x);
      }
    }
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.atlas.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++; expect(allowed.has(i), `outside upper cloth ${i}`).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
    const front = CLASSIC_LAYOUT.body.base.front, visibleColors = new Set<string>();
    for (let y = 1; y < saved.outfitPlan.upper.hem!.endRow - 1; y++) for (let x = 0; x < front.w; x++) {
      const i = ((front.y + y) * 64 + front.x + x) * 4;
      visibleColors.add("#" + [...after.atlas.rgba.subarray(i, i + 3)].map(v => v.toString(16).padStart(2, "0")).join(""));
    }
    for (const color of pattern.gradientColors!) expect(visibleColors.has(color), color).toBe(true);
    expect(after.diagnostic.looseHair).toEqual(before.diagnostic.looseHair);
    const out = freshAuditOutput("evaluation-artifacts/gradient-cloth-saved-plan-replay-20261011-");
    for (const [name, atlas] of [["live", live], ["before", before.atlas], ["after", after.atlas]] as const) {
      const encoded = await encodePng(atlas); expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot, runId: e.runId, sourceSummarySha256: sha(bytes),
      providerCalls: 0, fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      mode: "saved_plan_pattern_transfer", historicalPngExactReplay: true,
      historicalRibbonScale: "medium", currentRibbonScale: "small", ribbonMigrationPixels,
      firstLoss: "NORMALIZED_PRESERVED_PLAN_LOST", primaryPatternObservation: "gradient_not_checker_blocks",
      designPlacement: "vertical_list_order_not_measured_spatial_positions", pattern,
      namedColorsVisible: true, changedPixels: changed, unrelatedPixels: 0, craftPass: true, atlasPass: true,
      beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba) }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("GRADIENT_CLOTH_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("keeps the gradient through default generation with an authored primary result and no inference", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
  try {
    const a = makeAnalysis();
    a.observed.clothing = "Short-sleeved crop top with puff sleeves, featuring a pastel gradient of pink, yellow, purple, and light blue; white trousers";
    a.outfitPrompt = ""; a.renderHints.outerGarment = "none"; a.renderHints.garmentTexture = "plain";
    a.fallbackFeatures.topType = "tshirt"; a.fallbackFeatures.sleeveLength = "short";
    runPrimary.mockResolvedValue({ ok: true, analysis: a, neuronsSpent: 0, attempts: 1 });
    const aiRun = vi.fn(async () => { throw Error("UNEXPECTED_INFERENCE"); });
    const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
    const response = await generateSkin(env, `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`);
    expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
    const p = response.body.analysis!.skinPlan!;
    expect(p.outfitPlan.upper.pattern).toMatchObject({ construction: "stepped_gradient",
      gradientColors: ["#d9a5af", "#e1c87d", "#a38cab", "#a9d5eb"] });
    expect(response.body.analysis!.referenceStyle!.status).toBe("reference_style_accepted");
    const atlas = await decodePng(base64ToBytes(response.body.skinPngBase64!));
    expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
    expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  } finally { runPrimary.mockRestore(); network.mockRestore(); }
}, 60_000);
