import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import type { SkinPlan } from "../src/skinPlan";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-018";
const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
const live = JSON.parse(bytes.toString()).currentDefaultE2E.result;
const primary = live.diagnostics.normalizedPrimary;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hair = primary.observed.hair) {
  const a = makeAnalysis({ ...structuredClone(primary), inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: hair,
    outfitPrompt: primary.observed.clothing, negativePrompt: "" });
  a.observed.hair = hair;
  return normalizeAnalysisForRendering(a);
}

it.each([primary.observed.hair,
  "Very short dark cropped hair that follows the scalp contour closely.",
  "Very short cropped hair. No distinct fringe or parting visible.",
  "Very short cropped hair. No visible fringe or distinct parting.",
  "Extremely short blond cropped hair following the head contour closely.",
  "Extremely short, almost shaved hair following the contour of the head.",
])("honors explicit cropped scalp-following silhouette: %s", hair => {
  const plan = buildIdentityPixelPlans(input(hair));
  expect(plan.hairPlan.surfaceOnly).toBe(true);
  expect(plan.hairPlan.surfaceMaterial).toBeUndefined(); // No claim of visible skin or density.
  expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  expect(plan.facePixelPlan).toEqual(live.analysis.skinPlan.facePixelPlan);
});

it.each([
  "Very short dark cropped hair.",
  "Very short dark cropped hair following the scalp contour.",
  "Very short dark cropped hair following the scalp contour closely. No distinct fringe or scalp visible.",
  "Very short dark cropped hair following the scalp contour closely. No visible crown.",
  "Very short dark cropped hair on the sides following the scalp contour closely.",
  "Possibly very short dark cropped hair following the scalp contour closely.",
  "Very short dark cropped hair following the scalp contour closely. No distinct fringe or beard.",
  "Very short, nearly shaved beard and black hair following the scalp contour.",
  "Very short, nearly shaved sides and long hair following the scalp contour.",
  "Very short, nearly shaved eyebrows and black hair following the scalp contour.",
  "Possibly very short, nearly shaved black hair following the scalp contour.",
  "Not very short, nearly shaved black hair following the scalp contour.",
  "Very short, nearly shaved black hair hidden by a hat, following the scalp contour.",
  "Very short, nearly shaved black hair clipped at the scalp contour.",
  "Very short, nearly shaved black hair with no visible crown, following the scalp contour.",
  "Nearly shaved black hair following the scalp contour.",
  "Very short black hair following the scalp contour.",
  "Very short, nearly shaved black hair.",
  "Very short, nearly shaved sides, but full hair on the crown following the scalp contour.",
])("does not infer full scalp-following silhouette from confounded evidence: %s", hair => {
  expect(buildIdentityPixelPlans(input(hair)).hairPlan.surfaceOnly).toBeUndefined();
});

it.each(["hidden", "volume", "length", "fringe", "sides", "covering", "accessory"])("preserves %s gate", mode => {
  const a = input();
  if (mode === "hidden") a.visibleRegions.hair = false;
  if (mode === "volume") a.renderHints.hairVolume = "full";
  if (mode === "length") a.renderHints.overallHairLength = "shoulder";
  if (mode === "fringe") a.renderHints.bangs = "straight";
  if (mode === "sides") a.renderHints.sideHairLength = "short";
  if (mode === "covering") a.fallbackFeatures.hat = "headscarf";
  if (mode === "accessory") a.renderHints.hairAccessory = "bow";
  expect(buildIdentityPixelPlans(a).hairPlan.surfaceOnly).toBeUndefined();
});

it("isolates scalp-close occupancy from exact 018 production PNG, preserving beard/tan/body", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = input(), built = buildIdentityPixelPlans(a);
    const before = structuredClone(live.analysis.skinPlan) as SkinPlan;
    const after = structuredClone(before);
    expect(built.facePixelPlan).toEqual(before.facePixelPlan);
    after.hairPlan = built.hairPlan; after.headIdentityPlan = built.headIdentityPlan;
    expect(after.hairPlan.surfaceOnly).toBe(true);
    const beforeStyle = buildFaceStyle(a, live.features, before.hairPlan);
    const afterStyle = buildFaceStyle(a, live.features, after.hairPlan);
    expect(afterStyle.facialHair).toBe(beforeStyle.facialHair);
    const oldAtlas = buildProceduralFallbackAtlas(live.features, beforeStyle, before)!;
    const newAtlas = buildProceduralFallbackAtlas(live.features, afterStyle, after)!;
    const actual = await decodePng(png);
    expect(sha(oldAtlas.rgba)).toBe(sha(actual.rgba));
    const changes = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => oldAtlas.rgba[p * 4 + c] !== newAtlas.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16); changes.push({ x: p % 64, y: Math.floor(p / 64) });
    }
    for (const p of before.facePixelPlan.pixels) {
      const at = ((p.y + 8) * 64 + p.x + 8) * 4;
      expect(newAtlas.rgba.slice(at, at + 4)).toEqual(oldAtlas.rgba.slice(at, at + 4));
    }
    expect(changes.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(newAtlas, afterStyle, undefined, undefined, after);
    expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(newAtlas).ok).toBe(true);
    const output = mkdtempSync("evaluation-artifacts/current-018-scalp-contour-20260928-");
    for (const [name, atlas] of [["before", oldAtlas], ["after", newAtlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, liveSummarySha256: sha(bytes),
      livePngSha256: sha(png), exactBaselineReplay: true, changes, bodyDiff: 0, faceFeatureDiff: 0,
      beforeOuterHairCells: before.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length,
      afterOuterHairCells: after.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length,
      craft, afterRgbaSha256: sha(newAtlas.rgba), scalpMaterial: after.hairPlan.surfaceMaterial ?? null,
      limitation: "Offline occupancy correction; no new live PNG or skin-transparency/density evidence." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`SCALP_CONTOUR ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
