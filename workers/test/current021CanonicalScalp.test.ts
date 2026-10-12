import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021";
const summary = readFileSync(`${root}/summary.json`), live = JSON.parse(summary.toString()).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-021-live-verification-20260928-mhdYLf/verification.json", "utf8"));
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function input() {
  const p = live.diagnostics.normalizedPrimary;
  return normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p),
    inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
    identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
}
it("connects a high-confidence visible-scalp hair feature only to corroborated scalp-length observation", () => {
  const a = input(), original = structuredClone(a);
  expect(observedShavedScalpHairShadow(a)).toBe(true);
  expect(buildIdentityPixelPlans(a).hairPlan).toMatchObject({ surfaceOnly: true, surfaceMaterial: "scalp_shadow", lengthClass: "short" });
  expect(a).toEqual(original);
});
it.each(["low", "medium", "face", "no_feature", "no_evidence", "uncertain", "negated", "part", "sides", "bare_crown"])(
  "does not promote unsupported canonical scalp evidence: %s", mode => {
    const a = input(), feature = a.canonicalIdentity.features.find(f => f.category === "hair")!;
    if (mode === "low" || mode === "medium") feature.confidence = mode;
    if (mode === "face") feature.category = "face";
    if (mode === "no_feature") a.canonicalIdentity.features = a.canonicalIdentity.features.filter(f => f.category !== "hair");
    if (mode === "no_evidence") feature.evidence = "short hair texture";
    if (mode === "uncertain") feature.evidence = "possibly visible scalp and very short hair texture";
    if (mode === "negated") feature.evidence = "no visible scalp";
    if (mode === "part") feature.evidence = "visible scalp along a part";
    if (mode === "sides") feature.evidence = "visible scalp only on sides";
    if (mode === "bare_crown") a.canonicalIdentity.mustPreserve.push("bare crown");
    expect(observedShavedScalpHairShadow(a)).toBe(false);
  });
it.each([
  "Very short buzz cut.", "Short hair.", "Long scalp-length hair.",
  "Possibly extremely short scalp-length buzz cut.", "No extremely short scalp-length hair.",
  "Extremely short scalp-length buzz cut with no visible scalp.",
  "Extremely short scalp-length buzz cut on sides only.",
  "Extremely short scalp-length buzz cut with thinning patches.",
  "Extremely short scalp-length buzz cut with visible parting.",
  "Extremely short scalp-length buzz cut on temples.",
  "Extremely short scalp-length buzz cut hidden by a hat.",
])("requires affirmative whole-scalp observation rather than canonical override: %s", observation => {
  const a = input(); a.observed.hair = observation;
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});
it.each(["No visible scalp", "Scalp hidden by longer hair", "Possibly visible scalp"])("keeps a conflicting independent hair feature: %s", evidence => {
  const a = input();
  a.canonicalIdentity.features.push({ category: "hair", feature: "Scalp visibility", evidence, confidence: "high", priority: 5, targetRegions: ["head.top"] });
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});
it.each(["visibility", "hat", "accessory", "geometry", "volume", "length", "fringe", "sides"])("preserves the %s contract gate", mode => {
  const a = input();
  if (mode === "visibility") a.visibleRegions.hair = false;
  if (mode === "hat") a.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") a.renderHints.hairAccessory = "bow";
  if (mode === "geometry") a.identityGeometry = makeIdentityGeometry();
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "length") a.renderHints.overallHairLength = "shoulder";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "sides") a.renderHints.sideHairLength = "short";
  expect(observedShavedScalpHairShadow(a)).toBe(false);
});
it("isolates canonical scalp material to head pixels; preserves face, tan, outfit, masks and ownership", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    expect(sha(summary)).toBe(baseline.summarySha256);
    const a = input(), original = live.analysis.skinPlan, parts = buildIdentityPixelPlans(a);
    const expectedHair = structuredClone(original.hairPlan); expectedHair.surfaceMaterial = "scalp_shadow";
    expect(parts.hairPlan).toEqual(expectedHair);
    expect(parts.headIdentityPlan).toEqual(original.headIdentityPlan);
    expect(parts.facePixelPlan).toEqual(original.facePixelPlan);
    const plan = structuredClone(original); plan.hairPlan = parts.hairPlan;
    // Material-only isolation retains the captured facial style and features.
    // Full strict normalization/category propagation is tested by the handler.
    const style = baseline.style;
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, original)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas(live.features, style, plan)!;
    let changed = 0;
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) { expect(Math.floor(p / 64)).toBeLessThan(16); changed++; }
    }
    expect(changed).toBeGreaterThan(0);
    for (const cell of original.facePixelPlan.pixels) {
      const i = ((8 + cell.y) * 64 + 8 + cell.x) * 4;
      expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
    }
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-021-canonical-scalp-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), changedHeadPixels: changed,
      material: plan.hairPlan.surfaceMaterial, facePixelDiff: 0, alphaDiff: 0, bodyDiff: 0, maskDiff: 0, ownershipDiff: 0,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba), craft,
      limitation: "Offline existing-material connection from accepted canonical evidence; no new density estimate or live result." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`CANONICAL_SCALP_021 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
