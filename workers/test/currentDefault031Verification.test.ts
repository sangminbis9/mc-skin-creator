import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it.each([
  { id: "031", prior: "030", inventory: "8ABYaW", facialHair: "goatee", changed: ["src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"] },
  { id: "032", prior: "031", inventory: "CYrElK", facialHair: "beard", changed: ["src/outfitIdentity.ts"] },
  { id: "033", prior: "032", inventory: "CBeQel", facialHair: "goatee", changed: [] },
])("verifies actual $id PNG, crop/geometry, immutable evidence and clean teardown offline", async run => {
  const root = `evaluation-artifacts/current-default-v3-e2e-baseline-20260928-${run.id}`;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const summary = readFileSync(`${root}/summary.json`), s = JSON.parse(summary.toString()), e = s.currentDefaultE2E, r = e.result;
    const history = JSON.parse(readFileSync(`evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-${run.inventory}/verification.json`, "utf8"));
    for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
    const checkpoints = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) { const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8")); expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256); }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(s);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      ownerResultFlushed: true, wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true, ownerExitObserved: true, ownerCloseObserved: true,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const productionChanges = Object.entries(e.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file);
    expect(productionChanges.map(file => file.replaceAll("\\", "/"))).toEqual(run.changed);
    const old = JSON.parse(readFileSync(`evaluation-artifacts/current-default-v3-e2e-baseline-20260928-${run.prior}/summary.json`, "utf8")).currentDefaultE2E;
    for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(old.preprocessing[key]);
    expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(run.id === "033" ? ["geminiPrimary", "gemmaPrimary"] : ["geminiPrimary", "faceGeometry"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    if (run.id === "033") {
      expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 503, fallbackEligible: true });
      expect(r.diagnostics.geometry).toBeNull();
      expect(e.cropReplay).toMatchObject({ geometryAttemptObserved: false, matchesActualWire: null, replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
    } else {
      expect(r.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
      expect(e.cropReplay).toMatchObject({ geometryAttemptObserved: true, matchesActualWire: true, replayEligibility: { status: "eligible", reason: "localized_face_retained" } });
    }
    const p = r.diagnostics.normalizedPrimary, plan = r.analysis.skinPlan;
    if (run.id === "033") expect(p.sourceSelection.portraitRegion).toBeNull();
    else expect(p.sourceSelection.portraitRegion).not.toBeNull();
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p), faceIdentityGeometry: r.diagnostics.geometry?.acceptedGeometry,
      inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null }, identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
    const style = buildFaceStyle(a, r.features, plan.hairPlan);
    const bytes = readFileSync(`${root}/skin.png`), actual = await decodePng(bytes);
    expect(sha(bytes)).toBe(e.png.sha256); expect(sha(actual.rgba)).toBe(e.png.decodedRgbaSha256); expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(buildProceduralFallbackAtlas(r.features, style, plan)!.rgba).toEqual(actual.rgba);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(r.features.eyeColor).toBe("#4a3728");
    expect(style.facialHair).toBe(run.facialHair);
    expect(plan.hairPlan).toMatchObject(run.id === "033" ? { template: "coily_volume", lengthClass: "short", surfaceOnly: true } : { template: "bald", lengthClass: "none" });
    expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.outfitPlan.upper.collarColor).toBe("#273954");
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
    if (run.id === "033") {
      expect(style.goateeHasMustache).toBe(true);
      expect(plan.outfitPlan.upper.pattern).toMatchObject({ construction: "crossed_bands", color: "#c5aa82" });
      expect(Object.values(plan.facePixelPlan.layout.geometryUsage).every(value => value === false)).toBe(true);
    }
    const out = mkdtempSync(`evaluation-artifacts/current-${run.id}-live-verification-20260928-`);
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${out}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${out}/verification.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(summary), pngSha256: sha(bytes), style, craft,
      exactStoredPlanReplay: true, checkpointCount: checkpoints.length, historicalFilesPreserved: Object.keys(history.preservedHashes).length, productionChanges,
      geometryAccepted: run.id !== "033", cropGate: e.cropReplay.replayEligibility, cropWireHashMatches: e.cropReplay.matchesActualWire,
      irisColor: r.features.eyeColor, collarColor: plan.outfitPlan.upper.collarColor,
      hair: { observed: p.observed.hair, template: plan.hairPlan.template, material: plan.hairPlan.surfaceMaterial ?? null },
      pattern: plan.outfitPlan.upper.pattern,
      limitation: run.id === "033" ? "Short surface-only hair, tan pattern, long sleeves and goatee/mustache delivered. Scalp transparency not explicitly observed; no new scalp-shadow material. PortraitRegion absent; production gate correctly skips geometry. Latest striped-pattern-in parser branch is not exercised by this new wording."
        : run.id === "031"
        ? "Bald enum coexists with explicit observed head stubble. Historical bald plan loses that material. New wording does not independently prove the button-down-only collar fix. Tan is not independently preserved in the brown palette."
        : "Observed buzz cut/bald plus canonical smooth scalp are conflicting material evidence. The 031 visible-stubble fix is not exercised; do not coerce this response. Brown/tan mixed palette does not demonstrate independent tan retention." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_${run.id}_VERIFICATION ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
