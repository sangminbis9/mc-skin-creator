import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { generateSkin, buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { decodePng, encodePng, base64ToBytes, bytesToBase64 } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import type { Env } from "../src/types";
import { captureCurrentDefaultPropagation } from "./audit/currentDefaultPropagation";
import { boundedProjection, digest } from "./audit/currentDefaultE2E";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
function context(raw: primary.PhotoAnalysis) {
  const analysis = normalizeAnalysisForRendering(raw), source = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, source.hairPlan), baseline = buildProceduralFallbackAtlas(features, style, source);
  expect(baseline).not.toBeNull(); return { analysis, source, style, features, baseline: baseline! };
}
function env() {
  const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  // Offline binding test doubles, never remote Cloudflare credentials/config.
  return { AI: { run: aiRun }, MCSKIN_KV: kv } as unknown as Env;
}

describe("actual default primary -> reference-style PNG integration", () => {
  it("encodes the selected reference atlas for all twelve stored primary results without extra inference", async () => {
    const input = "evaluation-artifacts/generalization-20260905/annotations.json", frozenBytes = readFileSync(input);
    const fixtures: AnnotatedCase[] = JSON.parse(frozenBytes.toString());
    const root = mkdtempSync("evaluation-artifacts/reference-primary-integration-20261005-");
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis"), entries = [];
    try {
      const image = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`;
      for (const fixture of fixtures) {
        const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
        if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
        const b = context(raw), identity = hash(JSON.stringify(b.source)), measurements = hash(JSON.stringify(b.analysis.identityGeometry ?? null));
        const expected = selectReferenceStyleAtlas(b.baseline, b.source, buildReferenceStylePlan(b.analysis), b.style).selected!;
        expect(expected, fixture.id).not.toBeNull();
        runPrimary.mockClear(); runPrimary.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 123, attempts: 1 });
        const bindings = env(), started = performance.now(), result = await generateSkin(bindings, image);
        const localGenerationElapsedMs = Math.round((performance.now() - started) * 100) / 100;
        expect(result.status, fixture.id).toBe(200); expect(result.body.ok).toBe(true);
        expect(result.body.generationMode).toBe("procedural_fallback"); expect(result.body.fallbackReason).toBe("reliability_baseline");
        expect(result.neuronsSpent).toBe(123); expect(runPrimary).toHaveBeenCalledTimes(1);
        expect(bindings.AI!.run).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
        const decoded = await decodePng(base64ToBytes(result.body.skinPngBase64!));
        expect(decoded.rgba, `${fixture.id}: default must actually encode selected style, not the old baseline`).toEqual(expected.composition.atlas.rgba);
        expect(validateFinalAtlas(decoded).ok).toBe(true);
        expect(result.body.analysis!.skinPlan).toEqual(b.source);
        expect(hash(JSON.stringify(result.body.analysis!.skinPlan))).toBe(identity);
        expect(hash(JSON.stringify(result.body.analysis!.identityGeometry ?? null))).toBe(measurements);
        const summary = result.body.analysis!.referenceStyle!;
        expect(summary.status).toBe("reference_style_accepted"); expect(summary.provenance).toBe("template_design");
        expect(summary.craftValidation).toBe("pass"); expect(summary.sourceGeometryPreserved).toBe(true);
        expect(summary.constraints!.ok).toBe(true); expect(summary.renderAttempts).toBeLessThanOrEqual(27);
        expect(summary.design).toEqual(expected.design);
        const replay = await captureCurrentDefaultPropagation({ primary: raw, geometry: null,
          providerStage: "mocked_stored_validated_analysis", body: result.body,
          runId: "a".repeat(32), inputs: { analysisSha256: hash("offline-analysis"), generationSha256: hash("offline-generation") },
          verifyReplay: true }, boundedProjection, digest);
        expect(replay.parameterEvidence, fixture.id).toBe("verified_exact_same_run_replay");
        expect(replay.replay, fixture.id).toMatchObject({ scope: "observed_design_atlas",
          rankingRecomputed: false, acceptedCandidateCountRecomputed: false, finalAtlasMatch: true });
        expect(replay.injectedParameters, fixture.id).not.toBeNull();
        const craft = validateReferenceAtlasCraft(decoded, b.baseline, b.source, b.style, buildReferenceCraftPlan(b.source, expected.design, expected.composition));
        expect(craft.ok, fixture.id).toBe(true); expect(validateAtlasCraft(b.baseline, b.style, undefined, undefined, b.source).ok).toBe(true);
        const repeat = await generateSkin(bindings, image); // Local replay of the mocked stored result, NOT a provider retry.
        expect(repeat.body.skinPngBase64).toBe(result.body.skinPngBase64); expect(repeat.body.analysis).toEqual(result.body.analysis);
        expect(bindings.AI!.run).not.toHaveBeenCalled();
        writeFileSync(`${root}/${fixture.id}-default.png`, await encodePng(decoded), { flag: "wx" });
        for (const [label, atlas] of [["legacy", b.baseline], ["default", decoded]] as const) {
          const front = renderSkinViews(atlas).find(v => v.name === "front")!.image;
          writeFileSync(`${root}/${fixture.id}-${label}-front.png`, await encodePng(scaleNearestNeighbor(front, front.width * 4, front.height * 4)), { flag: "wx" });
        }
        entries.push({ caseId: fixture.id, calibrated: !!fixture.existing, sourcePlanHash: identity, geometryHash: measurements, legacyAtlasHash: hash(b.baseline.rgba), defaultAtlasHash: hash(decoded.rgba), expectedSelectedHash: hash(expected.composition.atlas.rgba), localGenerationElapsedMs, styleSummary: summary, craft, sourceContract: expected.quality, parameterReplay: replay.replay });
      }
      expect(entries).toHaveLength(12); expect(readFileSync(input)).toEqual(frozenBytes);
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, primaryStage: "mocked_stored_validated_analysis", annotationHash: hash(frozenBytes), defaultPathStyled: entries.length, cases: entries }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_PRIMARY_INTEGRATION ${root}`);
    } finally { runPrimary.mockRestore(); network.mockRestore(); }
  }, 180_000);
  it("does not relabel unresolved source grammar as a styled success", () => {
    const b = context(makeAnalysis()); b.source.headIdentityPlan.ownership!.execution = "preserve_existing_grammar";
    const result = renderReferencePrimaryAtlas(b.baseline, b.source, b.analysis, b.style);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preserved source grammar");
    expect(result.atlas).toBe(b.baseline); expect(result.craftPlan).toBeNull();
    expect(result.summary.status).toBe("source_grammar_preserved"); expect(result.summary.renderAttempts).toBe(0);
    expect(result.summary.design).toBeUndefined(); expect(result.summary.acceptedCandidates).toBe(0);
  });
  it("does not rescue an invalid source or rejected styled construction with a success label", () => {
    const b = context(makeAnalysis());
    const invalid = { width: 1, height: 1, rgba: new Uint8Array(4) };
    expect(renderReferencePrimaryAtlas(invalid, b.source, b.analysis, b.style)).toEqual({ ok: false, reason: "source_atlas_invalid", renderAttempts: 0 });
    const flat = { ...b.baseline, rgba: b.baseline.rgba.slice() };
    for (let i = 0; i < flat.rgba.length; i += 4) if (flat.rgba[i + 3]) flat.rgba.set([70, 70, 70], i);
    expect(renderReferencePrimaryAtlas(flat, b.source, b.analysis, b.style)).toMatchObject({ ok: false, reason: "source_craft_invalid" });
    // Legal authored source contract whose wrapped print and short/bare
    // surfaces lack sufficient material planes. A different source palette
    // alone is not invalid: garment rendering intentionally uses the source
    // plan. Here source-safe candidates must fail the unchanged craft floor,
    // not silently return the old baseline as a styled success.
    const outfit = b.source.outfitPlan;
    outfit.upper.baseColor = "#111111"; outfit.upper.colorBlocks = [];
    outfit.upper.pattern = { ...outfit.upper.pattern, kind: "horizontal_stripe", color: "#111111", placement: "wrap" };
    outfit.upper.leftSleeve.terminationRow = 0; outfit.upper.rightSleeve.terminationRow = 0;
    outfit.lower.baseColor = "#111111"; outfit.lower.shoeColor = "#111111";
    outfit.lower.garmentRows = 2;
    outfit.lower.pattern = { ...outfit.lower.pattern, kind: "horizontal_stripe", color: "#111111", placement: "wrap" };
    outfit.outerLayer.regions = []; outfit.accessories = [];
    expect(renderReferencePrimaryAtlas(b.baseline, b.source, b.analysis, b.style)).toMatchObject({ ok: false, reason: "reference_candidates_rejected" });
  });
});
