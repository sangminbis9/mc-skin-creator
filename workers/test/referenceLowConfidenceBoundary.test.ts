/** Authored confidence counterfactuals, not provider output or source labels. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import * as primary from "../src/analysis";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { Env } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function differingPaths(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return [path];
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .flatMap(key => differingPaths(left[key], right[key], `${path}.${key}`));
}
function faceStyle(raw: PhotoAnalysis) {
  const analysis = normalizeAnalysisForRendering(raw);
  return buildFaceStyle(analysis,
    fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone),
    buildSkinPlan(analysis).hairPlan);
}
function withClaim(feature: string, confidence: "low" | "medium" | "high", category: PhotoAnalysis["canonicalIdentity"]["features"][number]["category"] = "hair") {
  const analysis = makeAnalysis();
  analysis.canonicalIdentity.features.push({ category, feature,
    evidence: "authored confidence counterfactual", confidence, priority: 5,
    targetRegions: ["head.front", "head.back"] });
  expect(validatePhotoAnalysis(analysis).ok).toBe(true);
  return analysis;
}

it.each([
  ["face", "blue eyes"],
  ["color", "dark brown skin"],
  ["outfit", "dusty pink sweater"],
  ["accessory", "blue headscarf"],
] as const)("does not recover a new palette from low-confidence %s: %s", (category, feature) => {
  const baseline = makeAnalysis(), uncertain = withClaim(feature, "low", category);
  const before = JSON.stringify(uncertain);
  const colors = (raw: PhotoAnalysis) => refineFeatureColorsFromAnalysis(raw,
    fallbackFeaturesToHex(raw.fallbackFeatures, raw.renderHints.skinUndertone));
  expect(differingPaths(colors(uncertain), colors(baseline))).toEqual([]);
  expect(JSON.stringify(uncertain)).toBe(before);
});

it.each(["medium", "high"] as const)("retains %s-confidence palette evidence and direct observations", confidence => {
  const colors = (raw: PhotoAnalysis) => refineFeatureColorsFromAnalysis(raw,
    fallbackFeaturesToHex(raw.fallbackFeatures, raw.renderHints.skinUndertone));
  const baseline = colors(makeAnalysis());
  for (const [category, feature, field] of [
    ["face", "blue eyes", "eyeColor"],
    ["color", "dark brown skin", "skinTone"],
    ["outfit", "dusty pink sweater", "topColor"],
    ["accessory", "blue headscarf", "hatColor"],
  ] as const) {
    expect(colors(withClaim(feature, confidence, category))[field], feature).not.toBe(baseline[field]);
    const observed = withClaim(feature, "low", category);
    if (category === "face" || category === "color") observed.observed.face = feature;
    else if (category === "outfit") observed.observed.clothing = feature;
    else observed.observed.accessories = feature;
    expect(colors(observed)[field], `direct: ${feature}`).not.toBe(baseline[field]);
  }
});

it.each(["bald scalp", "dreadlocks"])("does not promote a low-confidence %s claim over observed short straight hair", feature => {
  const baseline = makeAnalysis();
  const uncertain = structuredClone(baseline);
  uncertain.canonicalIdentity.features.push({ category: "hair", feature,
    evidence: "uncertain detail; not reliably visible", confidence: "low", priority: 5,
    targetRegions: ["head.front", "head.back"] });
  expect(validatePhotoAnalysis(uncertain).ok).toBe(true);
  const before = JSON.stringify(uncertain);
  const source = normalizeAnalysisForRendering(baseline);
  const candidate = normalizeAnalysisForRendering(uncertain);
  const expected = buildSkinPlan(source), actual = buildSkinPlan(candidate);
  expect(buildReferenceStylePlan(candidate)).toEqual(buildReferenceStylePlan(source));
  expect(actual.hairPlan.template).toBe(expected.hairPlan.template);
  expect(actual.hairPlan.lengthClass).toBe(expected.hairPlan.lengthClass);
  expect(actual.hairPlan.structure.grammar).toBe(expected.hairPlan.structure.grammar);
  expect(faceStyle(candidate)).toEqual(faceStyle(source));
  expect(JSON.stringify(uncertain)).toBe(before);
});

it.each(["medium", "high"] as const)("retains %s-confidence canonical baldness and locs", confidence => {
  const bald = buildSkinPlan(normalizeAnalysisForRendering(withClaim("bald scalp", confidence)));
  const locs = buildSkinPlan(normalizeAnalysisForRendering(withClaim("dreadlocks", confidence)));
  expect(bald.hairPlan.template).toBe("bald");
  expect(bald.hairPlan.lengthClass).toBe("none");
  expect(locs.hairPlan.structure.grammar).toBe("lock_groups");
  expect(faceStyle(withClaim("bald scalp", confidence)).hairstyle).toBe("bald");
  expect(faceStyle(withClaim("dreadlocks", confidence)).hairStructure).toBe("locs");
  const covering = withClaim("blue headscarf", confidence);
  expect(buildSkinPlan(covering).hairPlan.headMask.coveringTopology?.fit).toBe("fitted_headscarf");
  expect(buildSkinPlan(covering).headIdentityPlan.p5Contracts.headSilhouette?.protected).toBe(true);
  expect(faceStyle(covering).hat).toBe("headscarf");
  expect(faceStyle(withClaim("long shoulder-length hair", confidence)).hairstyle).toBe("long");
});

it.each(["bald scalp", "dreadlocks"])("retains directly observed %s independently of weak canonical claims", feature => {
  const raw = makeAnalysis();
  raw.observed.hair = feature;
  raw.canonicalIdentity.features = raw.canonicalIdentity.features.map(f => f.category === "hair" ? { ...f, confidence: "low" } : f);
  const plan = buildSkinPlan(normalizeAnalysisForRendering(raw));
  if (feature === "bald scalp") expect(plan.hairPlan.template).toBe("bald");
  else expect(plan.hairPlan.structure.grammar).toBe("lock_groups");
});

it("retains structured bald evidence and ignores unrelated-category identity text", () => {
  const raw = makeAnalysis(); raw.fallbackFeatures.hairstyle = "bald";
  expect(buildSkinPlan(raw).hairPlan.template).toBe("bald");
  const baseline = buildSkinPlan(makeAnalysis()).hairPlan;
  for (const feature of ["bald scalp", "dreadlocks"]) {
    expect(buildSkinPlan(withClaim(feature, "high", "outfit")).hairPlan).toEqual(baseline);
  }
});

it.each(["twin tails", "long braids", "blue headscarf", "long shoulder-length hair"])(
  "keeps low-confidence %s from changing head ownership or style", feature => {
    const baseline = normalizeAnalysisForRendering(makeAnalysis());
    const uncertain = normalizeAnalysisForRendering(withClaim(feature, "low"));
    expect(differingPaths(buildSkinPlan(uncertain).hairPlan, buildSkinPlan(baseline).hairPlan), "hairPlan").toEqual([]);
    expect(differingPaths(buildSkinPlan(uncertain).headIdentityPlan, buildSkinPlan(baseline).headIdentityPlan).slice(0, 30), "headIdentityPlan").toEqual([]);
    expect(faceStyle(uncertain)).toEqual(faceStyle(baseline));
  });

it("keeps a low-confidence accessory claim from manufacturing a head covering", () => {
  const baseline = normalizeAnalysisForRendering(makeAnalysis());
  const uncertain = normalizeAnalysisForRendering(withClaim("blue headscarf", "low", "accessory"));
  expect(differingPaths(buildSkinPlan(uncertain).hairPlan, buildSkinPlan(baseline).hairPlan)).toEqual([]);
  expect(differingPaths(buildSkinPlan(uncertain).headIdentityPlan, buildSkinPlan(baseline).headIdentityPlan)).toEqual([]);
  expect(faceStyle(uncertain)).toEqual(faceStyle(baseline));
});

it.each(["medium", "high"] as const)("retains %s-confidence accessory covering and direct observation", confidence => {
  const canonical = withClaim("blue headscarf", confidence, "accessory");
  // Accessory-only canonical prose currently supplies style/P5 evidence, not
  // the fitted hair-mask opt-in (which needs hair evidence or structured hat).
  expect(buildSkinPlan(canonical).headIdentityPlan.p5Contracts.headSilhouette?.protected).toBe(true);
  expect(faceStyle(canonical).hat).toBe("headscarf");
  const observed = withClaim("blue headscarf", "low", "accessory");
  observed.observed.accessories = "blue headscarf and thin silver-rimmed glasses";
  expect(faceStyle(observed).hat).toBe("headscarf");
  observed.fallbackFeatures.hat = "headscarf";
  expect(buildSkinPlan(observed).hairPlan.headMask.coveringTopology?.fit).toBe("fitted_headscarf");
});

it("preserves the observed hair through actual default generation, craft validation and PNG encoding", async () => {
  const root = mkdtempSync("evaluation-artifacts/reference-low-confidence-20261009-");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  // Offline binding doubles, with no credential or remote runtime.
  const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
  const cases: Array<{ id: string; raw: PhotoAnalysis }> = [
    { id: "observed-short-straight", raw: makeAnalysis() },
    { id: "uncertain-bald", raw: withClaim("bald scalp", "low") },
    { id: "uncertain-locs", raw: withClaim("dreadlocks", "low") },
    { id: "uncertain-headscarf", raw: withClaim("blue headscarf", "low") },
    { id: "uncertain-long", raw: withClaim("long shoulder-length hair", "low") },
    { id: "uncertain-eye-color", raw: withClaim("blue eyes", "low", "face") },
    { id: "uncertain-skin-color", raw: withClaim("dark brown skin", "low", "color") },
    { id: "uncertain-garment-color", raw: withClaim("dusty pink sweater", "low", "outfit") },
    { id: "uncertain-accessory-headscarf", raw: withClaim("blue headscarf", "low", "accessory") },
  ];
  const rows = [];
  let expectedPng: string | undefined;
  let expectedHair: ReturnType<typeof buildSkinPlan>["hairPlan"] | undefined;
  try {
    const image = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    for (const { id, raw } of cases) {
      const before = JSON.stringify(raw);
      runPrimary.mockClear();
      runPrimary.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
      const result = await generateSkin(env, image);
      expect(result.status, id).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(runPrimary).toHaveBeenCalledTimes(1);
      const analysis = result.body.analysis!;
      expect(analysis.referenceStyle?.craftValidation).toBe("pass");
      expect(analysis.referenceStyle?.constraints?.ok).toBe(true);
      expect(analysis.skinPlan!.hairPlan.template).toBe("short_cap");
      expect(analysis.skinPlan!.hairPlan.structure.grammar).toBe("straight_bands");
      const png = result.body.skinPngBase64!;
      const atlas = await decodePng(base64ToBytes(png));
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      if (expectedPng === undefined) {
        expectedPng = png; expectedHair = analysis.skinPlan!.hairPlan;
      } else {
        expect(analysis.skinPlan!.hairPlan, id).toEqual(expectedHair);
        expect(hash(base64ToBytes(png)), `${id}: speculative claim must not alter final pixels`).toBe(hash(base64ToBytes(expectedPng)));
      }
      const repeat = await generateSkin(env, image); // Mocked offline replay, not a provider retry.
      expect(hash(base64ToBytes(repeat.body.skinPngBase64!))).toBe(hash(base64ToBytes(png)));
      expect(JSON.stringify(raw)).toBe(before);
      expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
      writeFileSync(`${root}/${id}.png`, base64ToBytes(png), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) {
        writeFileSync(`${root}/${id}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      }
      rows.push({ id, hairTemplate: analysis.skinPlan!.hairPlan.template,
        grammar: analysis.skinPlan!.hairPlan.structure.grammar,
        hairPlanSha256: hash(JSON.stringify(analysis.skinPlan!.hairPlan)),
        pngSha256: hash(base64ToBytes(png)), rgbaSha256: hash(atlas.rgba),
        craftPass: true, atlasValid: true, deterministic: true, inputUnchanged: true });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "authored_confidence_counterfactuals",
      primaryStage: "mocked", providerCalls: 0, networkCalls: 0, rows }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_LOW_CONFIDENCE ${root}`);
  } finally { runPrimary.mockRestore(); network.mockRestore(); }
}, 60_000);
