import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies actual 020 garment propagation, immutable checkpoints, exact atlas and teardown offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const s = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const historical = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-58Bb0w/verification.json", "utf8"));
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
    const productionChanges = Object.entries(state.fixedHashes)
      .filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file.replaceAll("\\", "/"));
    // First replay verified zero production delta. The later offline-only
    // checker-palette correction is not part of the captured live result.
    expect(productionChanges).toEqual(["src/facialHairEvidence.ts", "src/identityPlans.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"]);
    const previous = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019/summary.json", "utf8")).currentDefaultE2E;
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
    const plan = structuredClone(r.analysis.skinPlan) as SkinPlan;
    // Frozen exact replay captured before the later qualified-hair fix. Do not
    // use today's corrected style to mislabel the immutable live PNG.
    const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-020-qualified-hair-before-20260928-XOfeL5/baseline.json", "utf8"));
    expect(baseline.summarySha256).toBe(sha(readFileSync(`${root}/summary.json`)));
    const style = baseline.style;
    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(actual.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const replay = buildProceduralFallbackAtlas(r.features, style, plan)!;
    expect(sha(replay.rgba)).toBe(sha(actual.rgba));
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true);
    expect(primary.fallbackFeatures.topType).toBe("shirt");
    expect(primary.fallbackFeatures.sleeveLength).toBe("short");
    expect(plan.outfitPlan).toMatchObject({ upper: { garmentType: "shirt",
      leftSleeve: { length: "long", source: "observed" }, rightSleeve: { length: "long", source: "observed" },
      pattern: { kind: "checker_block", color: "#eeeae1" } }, lower: { garmentType: "pants", waistRow: 10 } });
    expect(primary.observed.clothing).toContain("tan/light brown squares");
    const output = mkdtempSync("evaluation-artifacts/current-020-live-verification-20260928-");
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCalls: 0, exactStoredPlanReplay: true,
      historicalFilesPreserved: Object.keys(historical.preservedHashes).length, productionChanges,
      checkpointCount: checkpoints.length, png: state.png, craft,
      shirtCategory: { actual: "shirt", contradictionOverrideExercised: false },
      sleeves: { fallback: "short", actual: "long", observedPropagation: true },
      pattern: { actual: "checker_block", observedTan: true, actualAccent: "#eeeae1", colorLoss: true },
      facialHair: style.facialHair, goateeHasMustache: style.goateeHasMustache,
      limitation: "Provider already supplied shirt, so the new contradictory-dress override was not exercised. Tan checker accent is lost before rendering; no rejected or missing geometry used." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_020_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
