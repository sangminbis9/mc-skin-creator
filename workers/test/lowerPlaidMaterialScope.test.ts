import { expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { makeAnalysis } from "./helpers";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { verifyLegwearRedesign } from "./savedLegwearRendererEvidence";

const observation = "a cream-colored knit cardigan worn open over a white collared shirt with a large pink fabric bow at the neck; a short pleated skirt with a brown and tan plaid pattern.";
function plan(clothing: string, visible = true, prompt = clothing) {
  const a = makeAnalysis();
  a.observed.clothing = clothing; a.outfitPrompt = prompt;
  a.visibleRegions.lowerBody = visible;
  a.fallbackFeatures.topAccentColor = "white";
  a.renderHints.bottomPattern = "plaid";
  return buildOutfitPlan(a);
}

it("keeps the actual observed skirt pigment instead of the white shirt accent", () => {
  const p = plan(observation);
  expect(p.lower).toMatchObject({ garmentType: "skirt", baseColor: "#684b38",
    pattern: { kind: "checker_block", color: "#c5aa82", source: "observed" } });
  expect(p.upper.accentColor).toBe("#eeeae1");
});

it.each([
  ["A black shirt; a navy skirt with a plaid pattern in navy and beige.", "#c5aa82"],
  ["A white blouse; brown pants with brown and green checkered pattern.", "#467a50"],
  ["a cream cardigan over a white shirt; a brown and beige plaid pleated skirt; white socks", "#c5aa82"],
  ["a white shirt; brown and green checkered trousers", "#467a50"],
])("binds a visible lower pattern palette to that garment: %s", (text, expected) => {
  expect(plan(text).lower.pattern.color).toBe(expected);
});

it.each([
  "A shirt with a brown and tan plaid pattern; a plain skirt.",
  "A brown skirt with possibly a brown and tan plaid pattern.",
  "A brown skirt without a brown and tan plaid pattern.",
  "A brown skirt with a hidden brown and tan plaid pattern.",
  "A brown skirt; a scarf with a brown and tan plaid pattern.",
  "A brown skirt; a brown and beige plaid scarf.",
  "A brown and beige plaid shirt; a plain skirt.",
])("does not borrow unsupported or other-material pattern pigment: %s", text => {
  expect(plan(text).lower.pattern.color).toBe("#eeeae1");
});

it("retains conservative hidden-lower and prompt-only boundaries", () => {
  expect(plan(observation, false).lower.pattern.color).toBe("#eeeae1");
  expect(plan("A cream cardigan; a brown skirt.", true, observation).lower.pattern.color).toBe("#eeeae1");
});

it("replays the accepted G002 plan with only its observed plaid pigment repaired", async () => {
  const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-002";
  const evidence = readFileSync(`${root}/summary.json`);
  const s = JSON.parse(evidence.toString()), t = s.currentDefaultE2E.result.propagationTrace;
  const p = t.skinPlan.skinPlan, d = t.referenceStyle.design;
  const { features } = t.injectedParameters;
  // Isolate plaid material using the consumed run's pre-scale ribbon paint.
  const faceStyle = { ...t.injectedParameters.faceStyle, hairAccessoryScale: "medium" as const };
  const actual = await decodePng(readFileSync(`${root}/skin.png`));
  const baseline = buildProceduralSourceAtlas(features, faceStyle, p)!;
  const currentBefore = composeReferenceStyleAtlas(baseline, p, d, faceStyle).atlas;
  verifyLegwearRedesign(actual, currentBefore, p.outfitPlan);
  // Resolve just the stored observed field in a test carrier; do not recover
  // absent primary fields or claim a fresh normalization of the live response.
  const correctedColor = plan(t.primary.observed.clothing).lower.pattern.color;
  expect(correctedColor).toBe("#c5aa82");
  const corrected = { ...p, outfitPlan: { ...p.outfitPlan, lower: { ...p.outfitPlan.lower,
    pattern: { ...p.outfitPlan.lower.pattern, color: correctedColor } } } };
  const afterBase = buildProceduralSourceAtlas(features, faceStyle, corrected)!;
  const after = composeReferenceStyleAtlas(afterBase, corrected, d, faceStyle);
  const permitted = new Set<number>();
  for (const part of ["body", "leftLeg", "rightLeg"] as const)
    for (const layer of ["base", "overlay"] as const)
      for (const face of ["top", "bottom", "front", "back", "left", "right"] as const) {
        const uv = CLASSIC_LAYOUT[part][layer][face];
        for (let y = 0; y < uv.h; y++) for (let x = 0; x < uv.w; x++) permitted.add((uv.y + y) * 64 + uv.x + x);
      }
  let changed = 0;
  for (let i = 0; i < 4096; i++) {
    expect(after.atlas.rgba[i * 4 + 3]).toBe(currentBefore.rgba[i * 4 + 3]);
    if ([0, 1, 2].some(c => after.atlas.rgba[i * 4 + c] !== currentBefore.rgba[i * 4 + c])) {
      expect(permitted.has(i), `unrelated cell ${i}`).toBe(true); changed++;
    }
  }
  expect(changed).toBeGreaterThan(0);
  expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
  expect(validateReferenceAtlasCraft(after.atlas, afterBase, corrected, faceStyle,
    buildReferenceCraftPlan(corrected, d, after)).ok).toBe(true);
  expect(composeReferenceStyleAtlas(afterBase, corrected, d, faceStyle).atlas.rgba).toEqual(after.atlas.rgba);
  const out = freshAuditOutput("evaluation-artifacts/lower-plaid-material-replay-20261011-");
  writeFileSync(`${out}/offline-after.png`, await encodePng(after.atlas), { flag: "wx" });
  writeFileSync(`${out}/verification.json`, JSON.stringify({ runId: s.currentDefaultE2E.runId,
    scope: "current_renderer_saved_plan_lower_pattern_color_only", historicalRendererByteEqualityRequired: false, changedRgbCells: changed, unrelatedCells: 0,
    alphaChanges: 0, oldColor: p.outfitPlan.lower.pattern.color, newColor: correctedColor,
    atlasValid: true, craftValid: true, deterministic: true, providerCalls: 0,
    liveSummarySha256: createHash("sha256").update(evidence).digest("hex") }, null, 2), { flag: "wx" });
  expect(readFileSync(`${root}/summary.json`)).toEqual(evidence);
  console.info(`LOWER_PLAID_REPLAY ${out}`);
}, 30000);

it("recovers G004's accepted same-run sleeve delivery and isolates its next plaid material loss", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-004";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
    expect(hash(bytes)).toBe("d9dda0a10e6f27c357b25b6ed44cc05960a7fcfd3ef38177dd4112a505c8712e");
    expect(hash(png)).toBe("bf8eb757b49676010b830b50e77edc5b54e051cc35c9ee193d9d00fde6cbddcc");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, t = e.result.propagationTrace;
    expect(e).toMatchObject({ runId: "293718f4cdb078574fa69bbbacc24fc7", generationPosts: 1,
      httpStatus: 200, elapsedMs: 48579, accounting: "known", providerRetry: 0 });
    expect(e.result.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(e.result.bindingAttempts[0]).toMatchObject({ completion: "returned", httpStatus: 503, elapsedMs: 7021 });
    expect(e.result.bindingAttempts[1]).toMatchObject({ completion: "returned", elapsedMs: 37950 });
    expect(e.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(e.result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.result.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1, wrapperExitObserved: true,
      wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false, cleanupFailed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    const saved = t.skinPlan.skinPlan, { features, faceStyle } = t.injectedParameters, design = t.referenceStyle.design;
    expect(saved.outfitPlan.upper.leftSleeve).toMatchObject({ length: "long", source: "conservative" });
    expect(saved.outfitPlan.upper.rightSleeve).toMatchObject({ length: "long", source: "conservative" });
    expect(faceStyle.hairAccessoryScale).toBe("small");
    const before = await decodePng(png), base = buildProceduralSourceAtlas(features, faceStyle, saved)!;
    const currentBefore = composeReferenceStyleAtlas(base, saved, design, faceStyle);
    const legwearChanges = verifyLegwearRedesign(before, currentBefore.atlas, saved.outfitPlan);
    expect(legwearChanges).toBeGreaterThan(0);
    // No white legwear cue may conceal the observed skirt rows or invent a
    // checker print on the plain stockings. The saved plan itself is untouched.
    const legwearCells = currentBefore.diagnostic.surfaces.filter(c => c.owner === "garment" && c.layer === "overlay" && c.part.endsWith("Leg"));
    expect(legwearCells.length).toBeGreaterThan(0);
    expect(validateFinalAtlas(currentBefore.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(currentBefore.atlas, base, saved, faceStyle, buildReferenceCraftPlan(saved, design, currentBefore)).ok).toBe(true);
    const fixed = structuredClone(saved);
    // Only the stored clothing field is resolved in a test carrier. No absent
    // prompt/full primary context is reconstructed or substituted into plans.
    fixed.outfitPlan.lower.pattern.color = plan(t.primary.observed.clothing).lower.pattern.color;
    expect(fixed.outfitPlan.lower.pattern.color).toBe("#c5aa82");
    const source = buildProceduralSourceAtlas(features, faceStyle, fixed)!;
    const after = composeReferenceStyleAtlas(source, fixed, design, faceStyle);
    const legs = [CLASSIC_LAYOUT.leftLeg, CLASSIC_LAYOUT.rightLeg].flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => currentBefore.atlas.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++;
      expect(legs.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
      expect(after.atlas.rgba[i * 4 + 3]).toBe(currentBefore.atlas.rgba[i * 4 + 3]);
    }
    expect(changed).toBeGreaterThan(0);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, source, fixed, faceStyle, buildReferenceCraftPlan(fixed, design, after)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(source, fixed, design, faceStyle).atlas.rgba).toEqual(after.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/reference-pastel-cardigan-004-legwear-review-20261011-");
    for (const [name, atlas] of [["actual-live", before], ["offline-legwear-after", currentBefore.atlas], ["offline-plaid-after", after.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const v = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(v, v.width * 6, v.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/verification.json`, JSON.stringify({ sourceSummarySha256: hash(bytes), liveRoot: root,
      liveHttpStatus: 200, liveSleeveDeliveryConfirmed: true, liveProviderCalls: { gemini: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      exactSavedPlanInput: true, historicalRendererByteEqualityRequired: false, legwearRedesignChangedCells: legwearChanges,
      earliestLegwearLoss: "PLAN_PRESERVED_ATLAS_LOST", earliestLoss: "PRIMARY_OBSERVED_PLAN_LOST", changedSkirtCells: changed,
      unrelatedCells: 0, alphaChanges: 0, oldPatternColor: saved.outfitPlan.lower.pattern.color,
      newPatternColor: fixed.outfitPlan.lower.pattern.color, craftValid: true, atlasValid: true, deterministic: true,
      providerCallsInReplay: 0, freshPlaidLiveDeliveryVerified: false, gracefulCleanupPass: true,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`G004_REVIEW ${out}`);
  } finally { network.mockRestore(); }
}, 30000);
