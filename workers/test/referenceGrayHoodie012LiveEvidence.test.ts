// Recover the consumed live run, then isolate its observed hair-material loss offline.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it.each([
  { suffix: "012", summarySha: "0bd86f7068ce2e98cd3f05ab7b4e291017624ce488f76cbd05e200217ec39b93",
    pngSha: "38381b9ac5e97430b372456ebd360516679b7ba122b7679d358ce71cc233a9ec", versions: 67,
    elapsed: 84060, geminiCompletion: "threw", geminiElapsed: 45000, gemmaElapsed: 35532, localization: "MALFORMED", materialCorrect: false },
  { suffix: "014", summarySha: "fad723e933053d111d8ebc9f43c154fb73fd4b2ff0f6747cdafa66bcd7221cbf",
    pngSha: "2a62143a054e93271ad54455d3e2f32fea3e5a0ea2e8efa1fc428f1348ce050a", versions: 67,
    elapsed: 17968, geminiCompletion: "returned", geminiElapsed: 3708, gemmaElapsed: 10929, localization: "INVALID_REGION", materialCorrect: false },
  { suffix: "015", summarySha: "d07e7e349cd44db92d05918bbdd47e86e999fe115f67eae964f7eda5f85860a4",
    pngSha: "4a03a7d65452019710123e863babb132e4944b304602d2809d372ab107bcca92", versions: 65,
    elapsed: 25323, geminiCompletion: "returned", geminiElapsed: 21974, gemmaElapsed: null, localization: "INVALID_REGION", materialCorrect: true },
])("recovers $suffix delivery and verifies observed gray material without reconstructing missing context", async evidence => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = `evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-${evidence.suffix}`;
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe(evidence.summarySha);
    expect(sha(png)).toBe(evidence.pngSha);
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(versions).toHaveLength(evidence.versions);
    for (const [i, f] of versions.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === versions.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitCode: 0, wrapperCloseObserved: true, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(e).toMatchObject({ httpStatus: 200, elapsedMs: evidence.elapsed, generationPosts: 1, providerRetry: 0, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(evidence.gemmaElapsed === null ? 1 : 2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: evidence.geminiCompletion, elapsedMs: evidence.geminiElapsed });
    if (evidence.gemmaElapsed !== null)
      expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: evidence.gemmaElapsed });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization.status).toBe(evidence.localization); expect(r.diagnostics.geometry).toBeNull();
    expect(Object.values(s.prohibited).every(v => v === 0)).toBe(true);
    expect(Object.values(e.propagationLink).every(v => v === true)).toBe(true);
    expect(t.primary.observed.hair).toBe(t.renderAnalysis.observed.hair);
    expect(t.primary.renderHints.overallHairLength).toBe("jaw"); expect(t.renderAnalysis.renderHints.overallHairLength).toBe("jaw");
    expect(t.selectedFamilies.hair).toBe("medium_layered");
    const plan = t.skinPlan.skinPlan, params = t.injectedParameters, design = t.referenceStyle.design;
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", source: "observed" });
    if (evidence.suffix !== "015") expect(plan.outfitPlan.upper.pattern.graphicShape).toBe("cross");
    else {
      expect(plan.outfitPlan.upper.pattern.graphicShape).toBeUndefined();
      expect(t.primary.observed.clothing).toContain("centered tonal dark gothic cross graphic on the chest and front kangaroo pocket");
    }
    if (evidence.suffix === "014") {
      expect(plan.outfitPlan.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
      expect(plan.outfitPlan.upper.rightSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
      expect(plan.outfitPlan.upper.pattern.evidence).toContain("graphic of a stylized cross");
    }
    expect(params.faceStyle.hairColor).toBe(evidence.materialCorrect ? "#9a9a9a" : "#3b2a1e");
    if (evidence.materialCorrect) expect(params.features.hairColor).toBe("#9a9a9a");
    // Only the actually recorded observed.hair field is passed to the existing
    // material resolver. This carrier is not reconstructed live PhotoAnalysis.
    const carrier = makeAnalysis(); carrier.observed.hair = t.primary.observed.hair;
    carrier.fallbackFeatures.hairColor = t.primary.fallbackFeatures.hairColor;
    const recovered = refineFeatureColorsFromAnalysis(carrier, fallbackFeaturesToHex(carrier.fallbackFeatures)).hairColor;
    expect(recovered).toBe("#9a9a9a");
    const actual = await decodePng(png), out = freshAuditOutput(`evaluation-artifacts/reference-gray-hoodie-${evidence.suffix}-material-review-20261011-`);
    const results = [];
    for (const mode of ["actual-live", "offline-material-after"] as const) {
      const features = { ...params.features, hairColor: mode === "actual-live" ? params.features.hairColor : recovered };
      const style = { ...params.faceStyle, hairColor: features.hairColor };
      const base = buildProceduralSourceAtlas(features, style, plan)!;
      const composition = composeReferenceStyleAtlas(base, plan, design, style);
      expect(selectReferenceStyleAtlas(base, plan, design, style).selected!.composition.atlas.rgba).toEqual(composition.atlas.rgba);
      if (mode === "actual-live") expect(composition.atlas.rgba).toEqual(actual.rgba);
      let changed = 0;
      const head = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => actual.rgba[i * 4 + c] !== composition.atlas.rgba[i * 4 + c])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(head.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)).toBe(true);
        expect(composition.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      }
      if (mode !== "actual-live") {
        if (evidence.materialCorrect) expect(changed).toBe(0);
        else expect(changed).toBeGreaterThan(0);
      }
      expect(validateFinalAtlas(composition.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composition.atlas, base, plan, style, buildReferenceCraftPlan(plan, design, composition)).ok).toBe(true);
      writeFileSync(`${out}/${mode}.png`, await encodePng(composition.atlas), { flag: "wx" });
      for (const v of renderSkinViews(composition.atlas)) writeFileSync(`${out}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed, rgbaSha256: sha(composition.atlas.rgba), atlasPass: true, craftPass: true });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, sourceSummarySha256: sha(bytes), runId: e.runId,
      liveHttpStatus: 200, liveElapsedMs: e.elapsedMs, liveGeminiPrimary: 1, liveGemmaPrimary: Number(evidence.gemmaElapsed !== null), liveGeometry: 0, retry: 0,
      checkpointIntegrity: true, actualPngExactReplay: true, lengthAndEmblemLiveDelivered: evidence.suffix !== "015",
      materialClassification: evidence.materialCorrect ? "OBSERVED_MATERIAL_LIVE_DELIVERED" : "NORMALIZED_PRESERVED_PARAMETER_LOST", observedMaterial: t.primary.observed.hair,
      originalParameter: params.features.hairColor, recoveredParameter: recovered, fullAnalysisReconstructed: false,
      savedPlansUnchanged: true, alphaChanges: 0, nonHeadChanges: 0, offlineProviderCalls: 0,
      newMaterialFixLiveVerified: evidence.materialCorrect, results }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`F${evidence.suffix}_MATERIAL_REVIEW`, out);
  } finally { network.mockRestore(); }
}, 60_000);
