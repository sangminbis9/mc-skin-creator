import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex,
  normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";

const source = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008/summary.json";
const sourceBytes = readFileSync(source);
const live = JSON.parse(sourceBytes.toString()).currentDefaultE2E.result;
const saved = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

function input() {
  // Explicit fixed context for missing rich fields, not a reconstructed provider response.
  return makeAnalysis({ ...structuredClone(saved), identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, negativePrompt: "" });
}
function styleOf(analysis: ReturnType<typeof input>) {
  return buildFaceStyle(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
}

it.each(["", ".", ";", "\n"])("does not manufacture long hair at an observed/prompt field boundary (%j)", delimiter => {
  const analysis = input();
  analysis.observed.hair += delimiter; analysis.identityPrompt += delimiter;
  expect(styleOf(analysis).hairstyle).toBe("bald");
});

it.each(["long-sleeve", "long-sleeved", "long sleeve", "long sleeves"])("does not borrow a %s garment adjective for hair in the same clause", sleeve => {
  const analysis = input();
  analysis.observed.hair = `bald scalp with no hair above a ${sleeve} shirt`;
  analysis.identityPrompt = analysis.observed.hair;
  expect(styleOf(analysis).hairstyle).toBe("bald");
});

it.each(["mustPreserve", "featureEvidence"])("preserves canonical atomic field boundaries (%s)", location => {
  const analysis = input();
  analysis.observed.hair = "bald scalp.";
  analysis.identityPrompt = "bald scalp.";
  analysis.observed.clothing = "plaid shirt."; analysis.outfitPrompt = "plaid shirt.";
  analysis.canonicalIdentity.mustPreserve = ["bald scalp."];
  analysis.canonicalIdentity.features = [];
  if (location === "mustPreserve") analysis.canonicalIdentity.mustPreserve.push("no side hair", "long-sleeve shirt");
  else analysis.canonicalIdentity.features.push({ category: "hair", feature: "no side hair", evidence: "long-sleeve shirt",
    priority: 3, confidence: "high", targetRegions: ["head"] });
  expect(styleOf(analysis).hairstyle).toBe("bald");
});

it.each(["Long straight hair.", "Hair is long and straight.", "Chest-length dark hair.", "Waist-length hair.", "Hip-length straight hair."])("retains actual affirmative long hair: %s", hair => {
  const analysis = input();
  analysis.observed.hair = hair; analysis.identityPrompt = hair;
  analysis.canonicalIdentity = { overallImpression: "Person with distinct hair and shirt.",
    mustPreserve: [hair], features: [] };
  expect(styleOf(analysis).hairstyle).toBe("long");
});

it.each(["bun", "ponytail", "twintails"])("preserves tied category %s despite real long strands", hairstyle => {
  const analysis = input();
  analysis.observed.hair = "Long straight hair tied back."; analysis.identityPrompt = analysis.observed.hair;
  analysis.canonicalIdentity = { overallImpression: "Tied hair.", mustPreserve: [], features: [] };
  analysis.fallbackFeatures.hairstyle = hairstyle as typeof analysis.fallbackFeatures.hairstyle;
  expect(styleOf(analysis).hairstyle).toBe(hairstyle);
});

it("renders unaltered saved 008 hair evidence in both fixed contexts without changing source data", async () => {
  const before = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008/offline-recovery-SDsefS/verification.json", "utf8"));
  const root = mkdtempSync("evaluation-artifacts/hair-text-boundary-20260927-");
  const rows = [];
  for (const enriched of [false, true]) {
    const raw = input();
    if (enriched) raw.faceIdentityGeometry = structuredClone(live.diagnostics.geometry.acceptedGeometry);
    const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
    const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
    const style = buildFaceStyle(analysis, features, plan.hairPlan);
    const baseline = before.rows.find((r: { enriched: boolean; diagnosticFieldDelimiter: boolean }) => r.enriched === enriched && !r.diagnosticFieldDelimiter);
    expect(style.hairstyle).toBe("bald");
    expect(plan.hairPlan).toEqual(baseline.hairPlan);
    expect(plan.facePixelPlan).toEqual(baseline.facePixelPlan);
    const atlas = buildProceduralFallbackAtlas(features, style, plan);
    expect(atlas).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
    const craft = validateAtlasCraft(atlas, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(atlas).ok).toBe(true);
    const id = enriched ? "accepted-geometry-context" : "semantic-context";
    writeFileSync(`${root}/${id}.png`, await encodePng(atlas), { flag: "wx" });
    const front = renderSkinViews(atlas).find(view => view.name === "front")!;
    writeFileSync(`${root}/${id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(front), 256, 256)), { flag: "wx" });
    rows.push({ id, plan, features, style, craft, atlasHash: sha(atlas.rgba), planHash: sha(JSON.stringify(plan)) });
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, sourceSha256: sha(sourceBytes), rows,
    limitation: "Offline partial-context replay, not a new live PNG or correction of primary baldness classification." }, null, 2), { flag: "wx" });
  expect(readFileSync(source)).toEqual(sourceBytes);
  console.info(`HAIR_BOUNDARY_ROOT ${root}`);
}, 30_000);
