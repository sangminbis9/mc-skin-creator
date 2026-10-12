import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-022";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies actual 022 PNG, accepted crop/geometry, cues and clean teardown offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const summary = readFileSync(`${root}/summary.json`), s = JSON.parse(summary.toString()), e = s.currentDefaultE2E, r = e.result;
    const history = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-QMDV3f/verification.json", "utf8"));
    for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
    const checkpoints = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) { const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8")); expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256); }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(s);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      ownerResultFlushed: true, wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true, ownerExitObserved: true, ownerCloseObserved: true,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const productionChanges = Object.entries(e.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file);
    expect(productionChanges.map(file => file.replaceAll("\\", "/"))).toEqual(["src/identityPlans.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"]);
    const old = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-021/summary.json", "utf8")).currentDefaultE2E;
    for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(old.preprocessing[key]);
    expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary", "faceGeometry"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 400, providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    expect(e.cropReplay).toMatchObject({ geometryAttemptObserved: true, matchesActualWire: true, replayEligibility: { status: "eligible", reason: "localized_face_retained" } });
    const p = r.diagnostics.normalizedPrimary, plan = r.analysis.skinPlan;
    expect(p.sourceSelection.portraitRegion).not.toBeNull();
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p), faceIdentityGeometry: r.diagnostics.geometry.acceptedGeometry,
      inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
    const style = buildFaceStyle(a, r.features, plan.hairPlan);
    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect(sha(bytes)).toBe(e.png.sha256); expect(sha(actual.rgba)).toBe(e.png.decodedRgbaSha256); expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(buildProceduralFallbackAtlas(r.features, style, plan)!.rgba).toEqual(actual.rgba);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    expect(plan.hairPlan).toMatchObject({ surfaceOnly: true, lengthClass: "short" }); expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.outfitPlan.upper.pattern.crossedBandColors).toEqual(["#273954", "#c5aa82"]);
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
    const out = mkdtempSync("evaluation-artifacts/current-022-live-verification-20260928-");
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${out}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${out}/verification.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), pngSha256: sha(bytes), style, craft,
      exactStoredPlanReplay: true, checkpointCount: checkpoints.length, historicalFilesPreserved: Object.keys(history.preservedHashes).length, productionChanges,
      scalpMaterial: null, shortHairSurfaceOnly: true, outerHairGroups: 0, tanBands: plan.outfitPlan.upper.pattern.crossedBandColors, sleeves: "long",
      geometryAccepted: true, cropGate: e.cropReplay.replayEligibility, cropWireHashMatches: true,
      traceDiscrepancy: "Legacy localization marker diagnostic says MISSING while validated normalized portraitRegion and actual eligible crop are present; do not reinterpret as no dispatch.",
      limitation: "New wording does not exercise the -021 canonical-scalp or clean-shaven-scalp paths. Explicit visible scalp on close-cropped hair remains unconnected." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_022_VERIFICATION ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
