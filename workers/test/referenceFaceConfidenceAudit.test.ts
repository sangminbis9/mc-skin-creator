/** Authored confidence counterfactuals; primary is mocked, never inferred. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { validatePhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import type { Env } from "../src/types";
import { makeAnalysis, makeIdentityGeometry, makeSyntheticAtlas } from "./helpers";
import { buildFaceIdentitySaliencePlan } from "../src/faceIdentitySalience";
import { buildFaceStyle, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import * as selection from "../src/referenceStyleSelection";
import { measureFaceRenderContract } from "../src/identityRenderContract";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function differences(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return [path];
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .flatMap(k => differences(left[k], right[k], `${path}.${k}`));
}
function base() {
  const a = makeAnalysis();
  a.observed.face = "oval face with straight eyebrows and closed neutral lips";
  a.renderHints.faceShape = "oval"; a.renderHints.eyebrowShape = "straight";
  a.renderHints.mouthShape = "small"; a.renderHints.mouthOpening = "closed";
  a.fallbackFeatures.expression = "neutral";
  a.canonicalIdentity.features = a.canonicalIdentity.features.map(f => f.category === "face"
    ? { ...f, feature: a.observed.face, evidence: "clearly visible oval contour and neutral lips", priority: 3 } : f);
  a.canonicalIdentity.overallImpression = "Oval neutral face, short side-swept black hair and silver glasses";
  a.canonicalIdentity.mustPreserve[0] = "oval neutral face";
  a.identityPrompt = a.canonicalIdentity.overallImpression;
  return a;
}
function snapshot(a: PhotoAnalysis) {
  const normalized = normalizeAnalysisForRendering(a), plan = buildSkinPlan(normalized);
  const colors = refineFeatureColorsFromAnalysis(normalized,
    fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  return { hints: normalized.renderHints, features: normalized.fallbackFeatures,
    style: buildFaceStyle(normalized, colors, plan.hairPlan), layout: plan.facePixelPlan.layout,
    facePixels: plan.facePixelPlan.pixels, contract: plan.facePixelPlan.renderContract,
    hair: plan.hairPlan, ownership: plan.headIdentityPlan.ownership };
}

it.each([false, true])("does not suppress structured source cues or accepted geometry when a weak claim is added (geometry=%s)", geometry => {
  const a = base();
  a.renderHints.faceShape = "angular";
  a.renderHints.mouthShape = "wide";
  a.renderHints.eyeSize = "large";
  if (geometry) a.identityGeometry = makeIdentityGeometry();
  const frozen = JSON.stringify(a), expected = snapshot(a), salience = buildFaceIdentitySaliencePlan(a);
  const weak = structuredClone(a);
  weak.canonicalIdentity.features.push({ category: "face", feature: "small mouth, narrow eyes, round face",
    confidence: "low", priority: 5, evidence: "authored uncertain contradictory claim", targetRegions: ["head.front"] });
  expect(snapshot(weak)).toEqual(expected);
  expect(buildFaceIdentitySaliencePlan(weak)).toEqual(salience);
  expect(JSON.stringify(a)).toBe(frozen);
  expect(weak.canonicalIdentity.features.at(-1)?.confidence).toBe("low");
  expect(expected.hints.mouthShape).toBe("wide");
  expect(expected.style.faceShape).toBe("angular");
});

it("retains observed appearance despite weak face/silhouette claims while preserving reliable differences", async () => {
  const root = mkdtempSync("evaluation-artifacts/reference-face-confidence-audit-20261009-");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
  const originalSelect = selection.selectReferenceStyleAtlas;
  type SelectionTrace = Array<{ id: string; rejection: string | null; violations: string[];
    faceContract: selection.ReferenceRenderedQuality["faceContract"] | null }>;
  let candidateTrace: SelectionTrace = [];
  let sourceAtlasContract: ReturnType<typeof measureFaceRenderContract> | null = null;
  const selectSpy = vi.spyOn(selection, "selectReferenceStyleAtlas").mockImplementation((...args) => {
    sourceAtlasContract = measureFaceRenderContract(args[0], args[1].facePixelPlan);
    const result = originalSelect(...args);
    candidateTrace = result.candidates.map(c => ({ id: c.id, rejection: c.rejection,
      violations: c.quality?.violations ?? [], faceContract: c.quality?.faceContract ?? null }));
    return result;
  });
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  const env = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
  const original = base(), baselineSnapshot = snapshot(original);
  const cases: Array<{ id: string; a: PhotoAnalysis }> = [{ id: "baseline", a: original }];
  for (const shape of ["full", "wide"] as const) {
    const a = structuredClone(original);
    a.renderHints.mouthShape = shape;
    cases.push({ id: `structured-${shape}-mouth`, a });
  }
  for (const [id, category, feature] of [
    ["angular", "face", "angular defined jawline"],
    ["mature-smile", "face", "older face with broad smile"],
    ["arched-brows", "face", "arched eyebrows"],
    ["wide-mouth", "face", "wide mouth"],
    ["bald-silhouette", "silhouette", "bald scalp with large crown volume"],
    ["covering-silhouette", "silhouette", "blue headscarf covering the head"],
  ] as const) {
    for (const confidence of ["low", "medium", "high"] as const) {
      const a = structuredClone(original);
      a.canonicalIdentity.features.push({ category, feature, confidence, priority: 5,
        evidence: "authored confidence counterfactual", targetRegions: ["head.front", "head.back"] });
      cases.push({ id: `${confidence}-${id}`, a });
    }
  }
  const rows = [];
  let baseline: Awaited<ReturnType<typeof decodePng>> | undefined;
  try {
    const input = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
    for (const { id, a } of cases) {
      expect(validatePhotoAnalysis(a).ok, id).toBe(true);
      const before = JSON.stringify(a), stages = snapshot(a);
      candidateTrace = [];
      sourceAtlasContract = null;
      runPrimary.mockResolvedValue({ ok: true, analysis: a, neuronsSpent: 0, attempts: 1 });
      const result = await generateSkin(env, input);
      const changed = Object.fromEntries(Object.keys(stages).map(k => [k,
        differences(baselineSnapshot[k as keyof typeof stages], stages[k as keyof typeof stages])]));
      if (result.status !== 200) {
        expect(JSON.stringify(a)).toBe(before);
        rows.push({ id, status: result.status, pngSha256: null, changedPixels: [], changed, stages,
          sourceAtlasContract, candidateTrace, selectedStyle: result.body.analysis?.referenceStyle, deterministic: null, inputUnchanged: true });
        continue;
      }
      const png = base64ToBytes(result.body.skinPngBase64!), atlas = await decodePng(png);
      expect(validateFinalAtlas(atlas).ok, id).toBe(true);
      expect(result.body.analysis?.referenceStyle?.craftValidation, id).toBe("pass");
      expect((await generateSkin(env, input)).body.skinPngBase64, id).toBe(result.body.skinPngBase64);
      expect(JSON.stringify(a)).toBe(before);
      baseline ??= atlas;
      const changedPixels: number[] = [];
      for (let p = 0; p < 4096; p++) if (!atlas.rgba.slice(p * 4, p * 4 + 4).every((v, c) => v === baseline!.rgba[p * 4 + c])) changedPixels.push(p);
      writeFileSync(`${root}/${id}.png`, png, { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${id}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      rows.push({ id, status: result.status, pngSha256: hash(png), changedPixels, changed, stages,
        sourceAtlasContract, candidateTrace, selectedStyle: result.body.analysis?.referenceStyle, deterministic: true, inputUnchanged: true });
    }
    expect(network).not.toHaveBeenCalled(); expect(aiRun).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ scope: "authored_mocked_primary_confidence_counterfactuals",
      providerCalls: 0, networkCalls: 0, rows }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_FACE_CONFIDENCE_AUDIT ${root}`);
    console.info(JSON.stringify(rows.map(r => ({ id: r.id, status: r.status, pixels: r.pngSha256 ? r.changedPixels.length : null,
      changes: Object.fromEntries(Object.entries(r.changed).map(([k, v]) => [k, v.length])) }))));
    // A confidently observed wide closed mouth must survive the reference
    // finish, not cause every candidate to be rejected and return HTTP 500.
    const wide = rows.find(r => r.id === "high-wide-mouth")!;
    expect(wide.status).toBe(200);
    expect(wide.candidateTrace.some(c => c.rejection === null)).toBe(true);
    expect(wide.candidateTrace.flatMap(c => c.violations).filter(v => v.includes("mouth perceptual width"))).toEqual([]);
    for (const row of rows.filter(r => r.id.startsWith("low-"))) {
      expect(row.status, row.id).toBe(200);
      expect(row.pngSha256, `${row.id}: speculative claim cannot repaint the source`).toBe(rows[0].pngSha256);
      expect(row.changed.style, `${row.id}: late style override`).toEqual([]);
      expect(row.changed.facePixels, `${row.id}: pixel plan`).toEqual([]);
      expect(row.changed.contract, `${row.id}: protected contract`).toEqual([]);
    }
    for (const row of rows.filter(r => /^(medium|high)-/.test(r.id))) {
      expect(row.status, row.id).toBe(200);
      expect(row.pngSha256, `${row.id}: reliable distinction remains`).not.toBe(rows[0].pngSha256);
    }
    for (const row of rows.filter(r => r.id.startsWith("structured-"))) {
      expect(row.stages.contract.mouth?.protected, row.id).toBe(false);
      expect(row.status, `${row.id}: retained structured width must survive style finishing`).toBe(200);
      expect(row.candidateTrace.some(c => c.rejection === null), row.id).toBe(true);
      expect(row.candidateTrace.flatMap(c => c.violations).filter(v => v.includes("mouth perceptual width")), row.id).toEqual([]);
    }
  } finally { runPrimary.mockRestore(); network.mockRestore(); selectSpy.mockRestore(); }
}, 120_000);
