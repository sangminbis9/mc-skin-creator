import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-007";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies consumed 007 accounting, checkpoints and actual PNG without any new external call", async () => {
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
      productionConfigChanged: false, wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
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
    expect(result.diagnostics.geometry).toEqual({ providerShapePass: true, semanticPass: false,
      errors: ["geometry.directLowerFaceContour.cheek.boundary:outside_visible_face"], acceptedGeometry: null });
    expect(live.cropReplay.matchesActualWire).toBe(true);
    for (const [file, expected] of Object.entries(live.fixedHashes)) expect(sha(readFileSync(file))).toBe(expected);

    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(sha(bytes)).toBe(live.png.sha256); expect(sha(actual.rgba)).toBe(live.png.decodedRgbaSha256);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    const saved = result.diagnostics.normalizedPrimary, plan = result.analysis.skinPlan;
    expect(plan.facePixelPlan.source).toBe("semantic_fallback");
    // This is explicitly a partial-context replay, not recovered full provider output.
    const partial = normalizeAnalysisForRendering(makeAnalysis({ ...saved,
      identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing }));
    const style = buildFaceStyle(partial, result.features, plan.hairPlan);
    expect(style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    const replay = buildProceduralFallbackAtlas(result.features, style, plan);
    const chinOnly = buildProceduralFallbackAtlas(result.features, { ...style, goateeHasMustache: false }, plan);
    const whitePlan = structuredClone(plan); whitePlan.outfitPlan.upper.pattern.color = "#eeeae1";
    const whitePattern = buildProceduralFallbackAtlas(result.features, style, whitePlan);
    expect(replay).not.toBeNull(); expect(chinOnly).not.toBeNull(); expect(whitePattern).not.toBeNull();
    if (!replay || !chinOnly || !whitePattern) throw new Error("partial_replay_rejected");
    const differs = (a: Uint8Array, b: Uint8Array, p: number) => [0, 1, 2, 3].some(c => a[p * 4 + c] !== b[p * 4 + c]);
    const cells = (other: Uint8Array) => Array.from({ length: 4096 }, (_, p) => p)
      .filter(p => differs(replay.rgba, other, p)).map(p => ({ x: p % 64, y: Math.floor(p / 64),
        actualEqualsEnabledReplay: !differs(actual.rgba, replay.rgba, p), actualDiffersFromAblation: differs(actual.rgba, other, p) }));
    const mustacheCells = cells(chinOnly.rgba), tanPatternCells = cells(whitePattern.rgba);
    expect(mustacheCells.length).toBeGreaterThan(0); expect(tanPatternCells.length).toBeGreaterThan(0);
    expect(mustacheCells.every(c => c.actualEqualsEnabledReplay && c.actualDiffersFromAblation)).toBe(true);
    expect(tanPatternCells.every(c => c.actualEqualsEnabledReplay && c.actualDiffersFromAblation)).toBe(true);
    let outerTop = 0;
    const top = CLASSIC_LAYOUT.head.overlay.top;
    for (let y = top.y; y < top.y + top.h; y++) for (let x = top.x; x < top.x + top.w; x++)
      if (actual.rgba[(y * 64 + x) * 4 + 3]) outerTop++;
    expect(outerTop).toBe(0); expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.hairPlan.template).toBe("bald"); // Observed limitation, not proof of cropped-hair retention.
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ kind: "checker_block", construction: "crossed_bands", color: "#c5aa82" });
    const craft = validateAtlasCraft(actual, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(craft.ok, craft.problems.join(" / ")).toBe(true);
    const output = mkdtempSync(`${root}/verification-`);
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name))) {
      writeFileSync(`${output}/${view.name}-large.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      if (view.name === "front") writeFileSync(`${output}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    const replayMismatchPixels = Array.from({ length: 4096 }, (_, p) => p).filter(p => differs(actual.rgba, replay.rgba, p)).length;
    const evidence = { mode: "offline_verification_of_consumed_007", additionalProviderCalls: 0,
      checkpointsVerified: checkpoints.length, liveHashes: hashes, actualPngSha256: sha(bytes), craft,
      replayMismatchPixels, partialContextReplay: true, mustacheCells, tanPatternCells,
      hair: { observed: saved.observed.hair, template: plan.hairPlan.template, surfaceOnly: plan.hairPlan.surfaceOnly === true,
        outerTop, outerGroups: plan.headIdentityPlan.outerHairGroupIds },
      outfit: { pattern: plan.outfitPlan.upper.pattern, sleeves: [plan.outfitPlan.upper.leftSleeve.length, plan.outfitPlan.upper.rightSleeve.length] },
      geometry: result.diagnostics.geometry, finalFacePlanSource: plan.facePixelPlan.source,
      limitation: "Fresh provider evidence and analysis JPEG differ from -006; no causal code-only comparison. Partial-context replay does not restore missing rich fields." };
    writeFileSync(`${output}/delivery.json`, JSON.stringify(evidence, null, 2), { flag: "wx" });
    for (const [name, expected] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(expected);
    expect(network).not.toHaveBeenCalled();
    console.info(`007_VERIFIED ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
