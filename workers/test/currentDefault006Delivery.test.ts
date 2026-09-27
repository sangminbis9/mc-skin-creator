import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies consumed 006 checkpoints, budgets, actual PNG and bounded delivery evidence offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const files = readdirSync(root).filter(n => n.endsWith(".json") || n.endsWith(".png"));
    const hashes = Object.fromEntries(files.map(n => [n, sha(readFileSync(`${root}/${n}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = files.filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) {
      const row = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(row.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(row.snapshot))).toBe(row.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, cleanupFailed: false, wranglerGracefulTeardownPathCompleted: true,
      ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false });
    const live = summary.currentDefaultE2E, result = live.result;
    expect(live).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(live.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
      failureStage: "none", failureCode: "none", providerAttemptIntent: 3, providerAttemptStarted: 3 });
    expect(result).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(result.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary", "faceGeometry"]);
    expect(result.diagnostics.primaryDiagnostic.providerAttempts.find((p: { outcome: string }) => p.outcome === "failed"))
      .toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(result.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true,
      normalizationPass: true, richValidationPass: true });
    expect(result.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    const pngBytes = readFileSync(`${root}/skin.png`);
    const actual = await decodePng(pngBytes);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(sha(pngBytes)).toBe(live.png.sha256);
    expect(sha(actual.rgba)).toBe(live.png.decodedRgbaSha256);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    const saved = result.diagnostics.normalizedPrimary;
    const plan = result.analysis.skinPlan;
    // Stored rich analysis is a partial allowlist. Helper defaults are NOT provider evidence.
    // Any replay claim below is conditional on pixel equality with the actual live PNG.
    const partial = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing });
    const style = buildFaceStyle(partial, result.features);
    expect(style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    const replay = buildProceduralFallbackAtlas(result.features, style, plan);
    const chinOnly = buildProceduralFallbackAtlas(result.features, { ...style, goateeHasMustache: false }, plan);
    const mustacheCells = [];
    let replayMismatchPixels: number | null = null;
    if (replay) {
      replayMismatchPixels = 0;
      for (let p = 0; p < 4096; p++) {
        const differs = (a: Uint8Array, b: Uint8Array) => [0, 1, 2, 3].some(c => a[p * 4 + c] !== b[p * 4 + c]);
        if (differs(replay.rgba, actual.rgba)) replayMismatchPixels++;
        if (chinOnly && differs(replay.rgba, chinOnly.rgba)) mustacheCells.push({ x: p % 64, y: Math.floor(p / 64),
          actualEqualsEnabledReplay: !differs(actual.rgba, replay.rgba), actualDiffersFromChinOnly: differs(actual.rgba, chinOnly.rgba) });
      }
    }
    const top = CLASSIC_LAYOUT.head.overlay.top;
    let actualOpaqueOuterTopPixels = 0;
    for (let y = top.y; y < top.y + top.h; y++) for (let x = top.x; x < top.x + top.w; x++)
      if (actual.rgba[(y * 64 + x) * 4 + 3]) actualOpaqueOuterTopPixels++;
    const output = `${root}/verification`;
    expect(existsSync(output)).toBe(false);
    mkdirSync(output);
    for (const view of renderSkinViews(actual).filter(v => ["front", "front_left_three_quarter"].includes(v.name))) {
      writeFileSync(`${output}/${view.name}-large.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      if (view.name === "front") writeFileSync(`${output}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    const evidence = { mode: "offline_verification_of_consumed_006", additionalProviderCalls: 0,
      checkpointsVerified: checkpoints.length, liveHashes: hashes, actualPngSha256: sha(pngBytes),
      finalAtlas: validateFinalAtlas(actual), replayMismatchPixels, partialContextReplayAccepted: Boolean(replay),
      mustacheCells, hair: { sourceObserved: saved.observed.hair, renderHints: {
        texture: saved.renderHints.hairTexture, length: saved.renderHints.overallHairLength, volume: saved.renderHints.hairVolume },
        planSurfaceOnly: plan.hairPlan.surfaceOnly === true, outerGroupIds: plan.headIdentityPlan.outerHairGroupIds,
        actualOpaqueOuterTopPixels },
      outfit: { observed: saved.observed.clothing, upper: plan.outfitPlan.upper },
      geometry: { validationPassed: true, finalFacePlanSource: plan.facePixelPlan.source,
        localization: result.diagnostics.localization, cropReplay: live.cropReplay },
      caution: "No causal -005/-006 code-only comparison: fresh provider evidence and browser analysis JPEG bytes differ. Partial-context replay is not a recovered full rich response."
    };
    writeFileSync(`${output}/delivery.json`, JSON.stringify(evidence, null, 2), { flag: "wx" });
    for (const [name, expected] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(expected);
    expect(network).not.toHaveBeenCalled();
    console.info(`006_VERIFIED checkpoints=${checkpoints.length} replayMismatch=${replayMismatchPixels} outerTop=${actualOpaqueOuterTopPixels} mustacheCells=${mustacheCells.length}`);
  } finally { network.mockRestore(); }
});
