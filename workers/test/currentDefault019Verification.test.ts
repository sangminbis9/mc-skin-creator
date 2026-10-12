import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies actual 019 short-hair ownership, exact PNG replay, immutable history and lifecycle", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const s = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const historical = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-mOVreV/verification.json", "utf8"));
    for (const [file, hash] of Object.entries(historical.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
    const checkpoints = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
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
    const postRunProductionChanges = Object.entries(state.fixedHashes)
      .filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file.replaceAll("\\", "/"));
    // The first verification captured zero changes before the subsequent
    // offline-only shirt-category fix. Never label that fix as live evidence.
    expect(postRunProductionChanges).toEqual(["src/facialHairEvidence.ts", "src/identityPlans.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"]);
    const previous = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-018/summary.json", "utf8")).currentDefaultE2E;
    for (const key of ["analysis", "generation"]) expect(state.preprocessing[key]).toEqual(previous.preprocessing[key]);
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull();
    expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: false, replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
    const primary = r.diagnostics.normalizedPrimary;
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...r.analysis,
      // Missing inference/free text is not reconstructed or used to rebuild the authoritative plan.
      inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = structuredClone(r.analysis.skinPlan) as SkinPlan;
    const style = buildFaceStyle(a, r.features, plan.hairPlan);
    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(actual.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const replay = buildProceduralFallbackAtlas(r.features, style, plan)!;
    expect(sha(replay.rgba)).toBe(sha(actual.rgba));
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true);
    expect(plan.hairPlan.surfaceOnly).toBe(true); expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    const hairOuter = plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length;
    expect(hairOuter).toBe(0); expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.outfitPlan.upper.pattern.crossedBandColors).toEqual(["#684b38", "#c5aa82"]);
    const counts = Object.fromEntries(["#273954", "#684b38", "#c5aa82"].map(hex => {
      const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); let count = 0;
      for (let p = 16 * 64; p < 48 * 64; p++) if (rgb.every((v, c) => actual.rgba[p * 4 + c] === v) && actual.rgba[p * 4 + 3] === 255) count++;
      return [hex, count];
    }));
    // Face/material shading need not retain each exact input RGB. Prove the
    // brown band reaches final pixels with an isolated diagnostic ablation.
    const withoutBrown = structuredClone(plan);
    withoutBrown.outfitPlan.upper.pattern.crossedBandColors = ["#c5aa82", "#c5aa82"];
    const ablated = buildProceduralFallbackAtlas(r.features, style, withoutBrown)!;
    let brownBandAffectedPixels = 0;
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== ablated.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeGreaterThanOrEqual(16); brownBandAffectedPixels++;
    }
    expect(brownBandAffectedPixels).toBeGreaterThan(0);
    expect(counts["#c5aa82"]).toBeGreaterThan(0);
    const output = mkdtempSync("evaluation-artifacts/current-019-live-verification-20260928-");
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCalls: 0, exactStoredPlanReplay: true,
      historicalFilesPreserved: Object.keys(historical.preservedHashes).length, postRunProductionChanges,
      checkpointCount: checkpoints.length, png: state.png, craft, hairOuter, surfaceOnly: true, surfaceMaterial: null,
      garmentPixelCounts: counts, brownBandAffectedPixels, facialHair: style.facialHair, goateeHasMustache: style.goateeHasMustache,
      limitation: "Provider omitted mustache/localization and supplied fallback dress despite explicit button-down shirt. Do not fabricate scalp visibility or source geometry." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_019_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
