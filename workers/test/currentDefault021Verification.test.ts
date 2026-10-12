import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies actual 021 cue propagation, exact PNG, accounting and durable cleanup offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const summary = readFileSync(`${root}/summary.json`), s = JSON.parse(summary.toString());
    const state = s.currentDefaultE2E, r = state.result, plan = r.analysis.skinPlan;
    const history = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-nslJQt/verification.json", "utf8"));
    for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
    const checkpoints = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, file] of checkpoints.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(s);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false, ownerResultFlushed: true,
      wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true,
      ownerExitObserved: true, ownerCloseObserved: true, wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const productionChanges = Object.entries(state.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file);
    expect(productionChanges.map(file => file.replaceAll("\\", "/"))).toEqual(["src/facialHairEvidence.ts", "src/identityPlans.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"]);
    const old = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020/summary.json", "utf8")).currentDefaultE2E;
    for (const key of ["analysis", "generation"]) expect(state.preprocessing[key]).toEqual(old.preprocessing[key]);
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(r.diagnostics.localization.status).toBe("MISSING");
    expect(state.cropReplay.replayEligibility).toEqual({ status: "coverage_unknown", reason: "localized_face_unavailable" });
    const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-021-live-verification-20260928-mhdYLf/verification.json", "utf8"));
    expect(baseline.summarySha256).toBe(sha(summary));
    const style = baseline.style; // Preserve actual pre-fix live style, not today's counterfactual.
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe(state.png.sha256); expect(sha(actual.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(buildProceduralFallbackAtlas(r.features, style, plan)!.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true);
    expect(plan.hairPlan).toMatchObject({ lengthClass: "short", surfaceOnly: true });
    expect(plan.hairPlan.surfaceMaterial).toBeUndefined(); expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ color: "#c5aa82", construction: "crossed_bands" });
    const white = structuredClone(plan); white.outfitPlan.upper.pattern.color = "#eeeae1";
    const withoutTan = buildProceduralFallbackAtlas(r.features, style, white)!;
    let tanPixels = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => actual.rgba[i * 4 + c] !== withoutTan.rgba[i * 4 + c])) {
      expect(Math.floor(i / 64)).toBeGreaterThanOrEqual(16); tanPixels++;
    }
    expect(tanPixels).toBeGreaterThan(0);
    const output = mkdtempSync("evaluation-artifacts/current-021-live-verification-20260928-");
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ mode: "offline_verification_of_actual_live", providerCalls: 0,
      summarySha256: sha(summary), pngSha256: sha(png), style, exactStoredPlanReplay: true, craft,
      historicalFilesPreserved: Object.keys(history.preservedHashes).length, productionChanges, checkpointCount: checkpoints.length,
      tanPixels, shortHairSurfaceOnly: true, outerHairGroups: 0, scalpMaterial: null,
      scalpEvidenceBoundary: "canonical hair feature says visible scalp; material resolver reads observed.hair only",
      limitation: "Tan and scalp-close occupancy reached actual PNG; canonical scalp-material evidence did not. No geometry was accepted or dispatched." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_021_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
