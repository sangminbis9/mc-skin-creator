// Authored complete fixture + read-only live phrase audit, not reconstructed provider output.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import * as endpoint from "../src/hairEndpointEvidence";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it.each([
  { run: "010", hash: "561f8bd744066569d60e57c85727c8da13dac3202b843d93db662b9565ff1a01",
    phrase: "jaw/shoulder length", pattern: /\bshoulder[-\s]+(?:length|level)\b/,
    beforeLength: "shoulder", beforeFamily: "long_straight_with_bangs",
    classification: "AMBIGUOUS_PROSE_OVERRIDES_STRUCTURED_ENDPOINT" },
  { run: "011", hash: "7fc5628e3a5c1180f15a2031a15c924702fb709ff5cb782b109d3f0f94fd56a5",
    phrase: "tapered around ears", pattern: /\baround\s+(?:the\s+)?ears?\b/,
    // This authored fixture retains makeAnalysis's staggered fringe edge;
    // it is intentionally not presented as F011's complete missing analysis.
    beforeLength: "ear", beforeFamily: "short_shaggy_masculine",
    classification: "LOCAL_GROOMING_OVERRIDES_OVERALL_ENDPOINT" },
])("preserves the structured endpoint through family/plan/PNG: $classification", async scenario => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const path = `evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-${scenario.run}/summary.json`;
    const bytes = readFileSync(path), live = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    expect(sha(bytes)).toBe(scenario.hash);
    expect(live.primary.renderHints.overallHairLength).toBe("jaw");
    expect(live.renderAnalysis.renderHints.overallHairLength).toBe(scenario.beforeLength);
    const text = live.primary.observed.hair;
    expect(scenario.pattern.test(text)).toBe(true);
    expect(scenario.pattern.test(endpoint.unambiguousHairEndpointText(text))).toBe(false);
    // Complete authored input: no claim of recovering omitted live prompts.
    const raw = makeAnalysis();
    raw.observed.hair = `Straight gray hair with dense brow-length bangs. Hair is ${scenario.phrase}.`;
    raw.observed.accessories = "none";
    raw.identityPrompt = raw.observed.hair;
    raw.canonicalIdentity.overallImpression = raw.observed.hair;
    raw.canonicalIdentity.mustPreserve = [raw.observed.hair, raw.observed.clothing];
    raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "hair" && f.category !== "accessory");
    Object.assign(raw.fallbackFeatures, { hairstyle: "medium", hat: "none", glasses: "none", facialHair: "none" });
    Object.assign(raw.renderHints, { overallHairLength: "jaw", sideHairLength: "jaw", sideHairShape: "face_framing",
      hairBackShape: "tapered", bangs: "straight", bangsLength: "brow", bangsDensity: "dense", fringeOpening: "center", hairPart: "none" });
    const rawBefore = JSON.stringify(raw);
    const render = () => {
      const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
      const base = buildProceduralSourceAtlas(features, style, plan)!;
      const selected = selectReferenceStyleAtlas(base, plan, design, style).selected;
      expect(selected).not.toBeNull();
      return { analysis, plan, features, style, design: selected!.design, base, composition: selected!.composition, quality: selected!.quality };
    };
    const after = render(), old = vi.spyOn(endpoint, "unambiguousHairEndpointText").mockImplementation(v => v);
    let before: ReturnType<typeof render>;
    try { before = render(); } finally { old.mockRestore(); }
    expect(before.analysis.renderHints.overallHairLength).toBe(scenario.beforeLength);
    expect(after.analysis.renderHints.overallHairLength).toBe("jaw");
    expect(before.design.hair.family).toBe(scenario.beforeFamily);
    expect(after.design.hair.family).not.toBe(before.design.hair.family);
    expect(after.analysis.observed).toEqual(before.analysis.observed);
    expect(after.features).toEqual(before.features);
    expect(after.plan.outfitPlan).toEqual(before.plan.outfitPlan);
    expect(after.plan.facePixelPlan).toEqual(before.plan.facePixelPlan);
    expect(JSON.stringify(raw)).toBe(rawBefore);
    const out = freshAuditOutput("evaluation-artifacts/ambiguous-hair-endpoint-offline-20261011-");
    const cases = [];
    for (const [label, b] of [["before", before], ["after", after]] as const) {
      const atlas = b.composition.atlas;
      expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
      expect(b.quality.violations).toEqual([]);
      expect(validateReferenceAtlasCraft(atlas, b.base, b.plan, b.style, buildReferenceCraftPlan(b.plan, b.design, b.composition)).ok).toBe(true);
      writeFileSync(`${out}/${label}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${label}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      cases.push({ label, length: b.analysis.renderHints.overallHairLength, family: b.design.hair.family,
        rgbaSha256: sha(atlas.rgba), atlasPass: true, craftPass: true });
    }
    expect(cases[0].rgbaSha256).not.toBe(cases[1].rgbaSha256);
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceSummarySha256: sha(bytes),
      classification: scenario.classification, sourcePhrase: scenario.phrase,
      completeAuthoredFixture: true, fullLiveAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      providerCalls: 0, outfitPlanUnchanged: true, facePixelPlanUnchanged: true, paletteUnchanged: true, cases }, null, 2), { flag: "wx" });
    expect(readFileSync(path)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("AMBIGUOUS_HAIR_ENDPOINT", out);
  } finally { network.mockRestore(); }
}, 60000);
