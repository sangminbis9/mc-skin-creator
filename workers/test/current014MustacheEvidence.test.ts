import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-014";
const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input() {
  return normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(primary), identityPrompt: primary.observed.hair,
    outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
}
function select(a = input()) { return buildFaceStyle(a, live.features, live.analysis.skinPlan.hairPlan).goateeHasMustache === true; }

it("preserves independently observed and high-confidence canonical face-feature combination", () => {
  const a = input();
  expect(a.canonicalIdentity.mustPreserve.some(x => /mustache/.test(x))).toBe(false);
  expect(a.canonicalIdentity.features.some(f => f.category === "face" && f.evidence === "dark goatee and mustache")).toBe(true);
  expect(select(a)).toBe(true);
});
it.each(["moustache", "mustache"])("accepts ordinary %s spelling through canonical evidence", token => {
  const a = input();
  a.observed.face = `A groomed goatee and ${token}.`;
  const f = a.canonicalIdentity.features.find(f => /goatee/.test(f.evidence))!;
  f.feature = "Facial hair"; f.evidence = `A dark goatee and ${token}`;
  expect(select(a)).toBe(true);
});
it.each(["absent", "low", "medium", "wrong_category", "wrong_region", "no_observation", "hidden_face",
  "negated", "uncertain", "conflicting_feature", "conflicting_preserve", "inferred_only"])("does not promote %s evidence", mode => {
  const a = input(), f = a.canonicalIdentity.features.find(f => /goatee/.test(f.evidence))!;
  if (mode === "absent") a.canonicalIdentity.features = a.canonicalIdentity.features.filter(v => v !== f);
  if (mode === "low" || mode === "medium") f.confidence = mode;
  if (mode === "wrong_category") f.category = "clothing";
  if (mode === "wrong_region") f.targetRegions = ["torso.front"];
  if (mode === "no_observation") a.observed.face = "A dark goatee.";
  if (mode === "hidden_face") a.visibleRegions.face = false;
  if (mode === "negated") f.evidence = "A goatee without a mustache";
  if (mode === "uncertain") f.evidence = "Possibly a goatee and mustache";
  if (mode === "conflicting_feature") a.canonicalIdentity.features.push({ ...f, feature: "Upper lip", evidence: "No mustache" });
  if (mode === "conflicting_preserve") a.canonicalIdentity.mustPreserve.push("No mustache");
  if (mode === "inferred_only") { f.evidence = "Goatee"; a.inferred.hairBack = { value: "Goatee and mustache", rationale: "unseen" }; }
  expect(select(a)).toBe(false);
});
it("retains legacy corroboration and bare goatees without creating new categories", () => {
  const a = input(); a.canonicalIdentity.features = [];
  expect(select(a)).toBe(false);
  a.canonicalIdentity.mustPreserve.push("Goatee and mustache"); expect(select(a)).toBe(true);
  a.observed.face = "Goatee"; expect(select(a)).toBe(false);
});
it("passes strict normalization without changing the normalized category or plans", () => {
  const a = input();
  a.sourceSelection.portraitEvidence = "Offline contract fixture context, no localization marker.";
  const wire = wireFixture(a); delete (wire.sourceSelection as Record<string, unknown>).portraitRegion;
  const normalized = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
  expect(normalized.ok).toBe(true); if (!normalized.ok) throw new Error("strict_failed");
  expect(normalized.analysis.fallbackFeatures.facialHair).toBe("goatee");
  expect(select(normalized.analysis)).toBe(true);
  const before = structuredClone(normalized.analysis);
  before.canonicalIdentity.features = before.canonicalIdentity.features.filter(f => !/goatee/.test(f.evidence));
  const beforePlan = buildSkinPlan(before), afterPlan = buildSkinPlan(normalized.analysis);
  expect(afterPlan.facePixelPlan).toEqual(beforePlan.facePixelPlan);
  expect(afterPlan.hairPlan).toEqual(beforePlan.hairPlan);
  expect(afterPlan.outfitPlan).toEqual(beforePlan.outfitPlan);
});
it("changes only the existing mustache footprint from exact live 014 baseline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = input(), plan = live.analysis.skinPlan as SkinPlan;
    const afterStyle = buildFaceStyle(a, live.features, plan.hairPlan);
    expect(afterStyle.goateeHasMustache).toBe(true);
    const beforeStyle = { ...afterStyle, goateeHasMustache: false };
    const before = buildProceduralFallbackAtlas(live.features, beforeStyle, plan)!;
    const after = buildProceduralFallbackAtlas(live.features, afterStyle, plan)!;
    expect(sha(before.rgba)).toBe(sha((await decodePng(png)).rgba));
    const changes = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(x).toBeGreaterThanOrEqual(8); expect(x).toBeLessThan(16);
        expect(y).toBeGreaterThanOrEqual(8); expect(y).toBeLessThan(16); changes.push({ x, y });
      }
    }
    const featureColorChanges = [];
    for (const p of plan.facePixelPlan.pixels) {
      const at = ((p.y + 8) * 64 + p.x + 8) * 4;
      if (after.rgba.slice(at, at + 4).some((v, c) => v !== before.rgba[at + c])) {
        // Existing localContrast darkens iris pixels against new adjacent
        // mustache pigment. This is not an identity-coordinate overwrite.
        expect(p.role).toBe("iris");
        for (let c = 0; c < 3; c++) expect(after.rgba[at + c]).toBeLessThanOrEqual(before.rgba[at + c]);
        featureColorChanges.push({ x: p.x, y: p.y, role: p.role,
          before: [...before.rgba.slice(at, at + 3)], after: [...after.rgba.slice(at, at + 3)] });
      }
    }
    expect(changes.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, afterStyle, undefined, undefined, plan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-014-mustache-evidence-20260927-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, exactLiveBaseline: true,
      liveSummarySha256: sha(bytes), livePngSha256: sha(png), changes, craft,
      bodyDiff: 0, identityTopologyDiff: 0, featureColorChanges, alphaDiff: 0, afterRgbaSha256: sha(after.rgba),
      provenance: { observation: primary.observed.face, feature: primary.canonicalIdentity.features.find((f: { evidence: string }) => /goatee/.test(f.evidence)) },
      limitation: "Offline combination selection, not new geometry or live provider evidence." }, null, 2), { flag: "wx" });
    const built = buildSkinPlan(a), combinedPlan = structuredClone(plan);
    expect(built.facePixelPlan).toEqual(plan.facePixelPlan);
    combinedPlan.hairPlan = built.hairPlan; combinedPlan.headIdentityPlan = built.headIdentityPlan;
    const combinedStyle = buildFaceStyle(a, live.features, built.hairPlan);
    const combined = buildProceduralFallbackAtlas(live.features, combinedStyle, combinedPlan)!;
    expect(validateAtlasCraft(combined, combinedStyle, undefined, undefined, combinedPlan).ok).toBe(true);
    expect(validateFinalAtlas(combined).ok).toBe(true);
    expect(combined.rgba.slice(16 * 64 * 4)).toEqual(before.rgba.slice(16 * 64 * 4));
    writeFileSync(`${output}/combined.png`, await encodePng(combined), { flag: "wx" });
    for (const view of renderSkinViews(combined).filter(v => ["front", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/combined-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/combined-results.json`, JSON.stringify({ providerCalls: 0,
      mustache: combinedStyle.goateeHasMustache, surfaceOnly: built.hairPlan.surfaceOnly,
      material: built.hairPlan.surfaceMaterial ?? null, bodyDiff: 0,
      rgbaSha256: sha(combined.rgba), craft: true, finalAtlas: true,
      limitation: "Offline combined output; actual historical skin.png remains unchanged." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`MUSTACHE_EVIDENCE ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
