// Read-only recovery of the consumed live run. No remote runner or source-image reads.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-009";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());

it("verifies D009's durable success and binding ledger independently of the local test exit", () => {
  expect(sha(bytes)).toBe("e2d9d4f7cbdcdf65d55923c9c719ae1b8e661d591c00174dceb5971ca283330c");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(57);
  for (const [i, file] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  const r = s.currentDefaultE2E;
  expect(r).toMatchObject({ runId: "a82e9e2cc90d0d4733626c5d6a059787", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 42280, accounting: "known", diskRecovery: true });
  expect(r.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 1222 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 37410 }),
  ]);
  expect(r.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
  expect(r.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(r.result.diagnostics.geometry).toBeNull(); expect(r.cropReplay.geometryAttemptObserved).toBe(false);
  expect(r.result.diagnostics.localization).toMatchObject({ status: "MALFORMED", numericParse: "failed" });
  expect(r.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
    healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  expect(s.shutdownLatch.phase).toBe("finalized");
  const old = JSON.parse(readFileSync(root.replace(/009$/, "008") + "/summary.json", "utf8"));
  expect(r.preprocessing.browserRuntime).toContain("Chrome/155.0.0.0");
  expect(old.currentDefaultE2E.preprocessing.browserRuntime).toContain("Chrome/154.0.0.0");
  expect({ ...r.preprocessing, browserRuntime: null })
    .toEqual({ ...old.currentDefaultE2E.preprocessing, browserRuntime: null });
  const delta = Object.keys(r.fixedHashes).filter(f => r.fixedHashes[f] !== old.currentDefaultE2E.fixedHashes[f])
    .map(f => f.replaceAll("\\", "/"));
  expect(delta).toEqual(["src/referenceOutfitRetention.ts", "src/referenceStyleConstraints.ts"]);
});

it("replays the actual same-run PNG and proves observed four-color blocks survive to visible cloth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const r = s.currentDefaultE2E, t = r.result.propagationTrace, p = t.skinPlan.skinPlan;
    expect(t.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(t.replay).toMatchObject({ scope: "plan_features_only", atlasReplay: "deferred_local",
      renderAnalysisMatch: true, sourcePlanMatch: true, featuresMatch: true });
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, p)!;
    const local = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, t.injectedParameters.faceStyle);
    const pngBytes = readFileSync(`${root}/skin.png`), actual = await decodePng(pngBytes);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(sha(pngBytes)).toBe("9d5c5cbccce20de6964b035fc64a33f02d59d8188138648f334aea9108db50dd");
    expect(local.atlas.rgba).toEqual(actual.rgba);
    expect(sha(actual.rgba)).toBe(t.finalPng.rgbaSha256);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateReferenceAtlasCraft(local.atlas, base, p, t.injectedParameters.faceStyle,
      buildReferenceCraftPlan(p, t.referenceStyle.design, local));
    expect(craft.ok, JSON.stringify(craft)).toBe(true);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain("pixelated/blocky pattern in pastel shades of pink, purple, blue, and yellow");
    expect(p.outfitPlan.upper.pattern).toMatchObject({ kind: "checker_block", construction: "pixel_blocks",
      source: "observed", blockColors: ["#d9a5af", "#a38cab", "#819cba", "#e1c87d"] });
    expect(p.outfitPlan.upper.leftSleeve.length).toBe("long");
    expect(p.outfitPlan.lower.baseColor).toBe("#eeeae1");
    const visiblePalette = p.outfitPlan.upper.pattern.blockColors.map((hex: string) => {
      const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let count = 0;
      for (const part of ["body", "leftArm", "rightArm"] as const) {
        const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
        for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
          const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
          const at = actual.rgba[oi + 3] === 255 ? oi : bi;
          if (rgb.every((c, i) => actual.rgba[at + i] === c)) count++;
        }
      }
      expect(count, `visible:${hex}`).toBeGreaterThan(0); return { color: hex, visibleFrontPixels: count };
    });
    // Do not conceal this run's next actual loss behind the pattern success.
    expect(Object.hasOwn(r.result.diagnostics.providerAppearance, "fallbackFeatures")).toBe(false);
    expect(t.primary.observed.accessories).toContain("light-blue hat");
    expect(t.renderAnalysis.observed.accessories).toBe(t.primary.observed.accessories);
    expect(t.injectedParameters.features.hat).toBe("none");
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-009-offline-review-20261010-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_exact_replay", sourceRoot: root,
      sourceSummarySha256: sha(bytes), runId: r.runId, localExactAtlasMatch: true,
      pngSha256: sha(pngBytes), rgbaSha256: sha(actual.rgba), pngDimensions: [64, 64],
      craftPass: true, finalAtlasPass: true, selectedFamilies: t.selectedFamilies, visiblePalette,
      patternLiveDeliveryVerified: true, sleevePlan: "long", lowerBase: p.outfitPlan.lower.baseColor,
      observedHatPreservedInAnalysis: true, injectedHat: "none", providerOptionalCachePresent: false,
      hatLossBoundary: "OBSERVED_HAT_OPTIONAL_CACHE_RECONSTRUCTION_NONE",
      livePrimaryCalls: 2, liveGeometryCalls: 0, newProviderCalls: 0,
      missingPromptsReconstructed: false, checkpointIntegrity: true, gracefulCleanup: true,
      edgeResourceRegressionResolvedForThisRunOnly: true, edgeCpuOrMemoryCausalityProven: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled(); console.info("D009_EXACT_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("preserves generic-hat reconstruction on authored current V3 inputs without reconstructing missing D009 prompts", () => {
  // Controlled contract units, not reconstructed provider payloads.
  for (const [noun, expected] of [["hat", "cap"], ["beanie", "beanie"], ["cap", "cap"]] as const) {
    const a = makeAnalysis(); a.observed.accessories = `A large light-blue ${noun} covering the crown.`;
    const wire = wireFixture(a); delete wire.fallbackFeatures;
    const immutable = JSON.stringify(wire);
    const result = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
    if (!result.ok) throw Error("authored_contract_invalid");
    expect(result.analysis.observed.accessories).toBe(a.observed.accessories);
    expect(result.analysis.fallbackFeatures.hat).toBe(expected);
    expect(JSON.stringify(wire)).toBe(immutable);
  }
});
