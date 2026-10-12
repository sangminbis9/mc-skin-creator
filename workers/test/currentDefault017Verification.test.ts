import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-017";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies live 017 checkpoints, exact atlas replay and facial-hair/tan/surface-only/long-sleeve propagation", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(n => /\.(json|png)$/.test(n));
    const hashes = Object.fromEntries(names.map(n => [n, sha(readFileSync(`${root}/${n}`))]));
    const s = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = names.filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(s);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false, ownerResultFlushed: true,
      wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true,
      ownerExitObserved: true, ownerCloseObserved: true, wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const state = s.currentDefaultE2E, r = state.result;
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 400,
      providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true,
      strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull();
    expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: false,
      replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
    const primary = r.diagnostics.normalizedPrimary;
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...r.analysis,
      // Inference/free-text fields were not retained by the live allowlist.
      // Do not inject the helper's unrelated sweater/chino/scalp inference.
      inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = structuredClone(r.analysis.skinPlan) as SkinPlan;
    const style = buildFaceStyle(a, r.features, plan.hairPlan);
    expect(style.goateeHasMustache).toBe(true); expect(style.facialHair).toBe("goatee");
    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(actual.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const replay = buildProceduralFallbackAtlas(r.features, style, plan)!;
    const replayDiff = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== replay.rgba[p * 4 + c]))
      replayDiff.push({ x: p % 64, y: Math.floor(p / 64), actual: [...actual.rgba.slice(p * 4, p * 4 + 4)], replay: [...replay.rgba.slice(p * 4, p * 4 + 4)] });
    expect(replayDiff).toEqual([]);
    expect(sha(replay.rgba)).toBe(sha(actual.rgba));
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan);
    expect(craft.ok).toBe(true);
    const noMustache = buildProceduralFallbackAtlas(r.features, { ...style, goateeHasMustache: false }, plan)!;
    const mustacheDiff: { x: number; y: number }[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== noMustache.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16); mustacheDiff.push({ x: p % 64, y: Math.floor(p / 64) });
    }
    expect(mustacheDiff).toEqual(expect.arrayContaining([{ x: 10, y: 13 }, { x: 13, y: 13 }]));
    expect(plan.hairPlan.surfaceOnly).toBe(true);
    expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    const hairOuter = plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length;
    expect(hairOuter).toBe(0);
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
    expect(plan.outfitPlan.upper.rightSleeve.length).toBe("long");
    expect(plan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    let tanPixels = 0;
    for (let p = 16 * 64; p < 48 * 64; p++) if (actual.rgba[p * 4] === 197 && actual.rgba[p * 4 + 1] === 170
      && actual.rgba[p * 4 + 2] === 130 && actual.rgba[p * 4 + 3] === 255) tanPixels++;
    expect(tanPixels).toBeGreaterThan(0);
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCalls: 0, exactStoredPlanReplay: true,
      checkpointCount: checkpoints.length, png: state.png, craft, mustacheDiff, hairOuter,
      pattern: plan.outfitPlan.upper.pattern, tanPixels, sleeves: [plan.outfitPlan.upper.leftSleeve, plan.outfitPlan.upper.rightSleeve],
      limitations: "Live surfaceOnly is true but scalp_shadow material is absent. Mustache/tan/long sleeves retained. Navy absent in this response; multi-color branch is not exercised. Geometry absent; plaid remains provider interpretation." }, null, 2), { flag: "wx" });
    for (const [name, h] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(h);
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_017_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
