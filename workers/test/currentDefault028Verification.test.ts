import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-028";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("verifies actual 028 checkpoint, teardown, facial-hair delivery and tan delivery without network", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result;
    const history = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-LKXxn6/verification.json", "utf8"));
    for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
    const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of files.entries()) { const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8")); expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256); }
    expect(JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8")).snapshot).toEqual(s);
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
      ownerResultFlushed: true, wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true, ownerExitObserved: true, ownerCloseObserved: true,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const changes = Object.entries(e.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash).map(([file]) => file.replaceAll("\\", "/"));
    expect(changes).toEqual(["src/generate.ts"]);
    const prior = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-027/summary.json", "utf8")).currentDefaultE2E;
    for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(prior.preprocessing[key]);
    expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(r).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 503, providerStatus: "UNAVAILABLE", fallbackEligible: true });
    expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.replayEligibility.reason).toBe("localized_face_unavailable");
    const p = r.diagnostics.normalizedPrimary, plan = r.analysis.skinPlan;
    const a = normalizeAnalysisForRendering(makeAnalysis({ ...structuredClone(p), inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
      identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" }));
    const style = buildFaceStyle(a, r.features, plan.hairPlan), png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe(e.png.sha256); expect(sha(actual.rgba)).toBe(e.png.decodedRgbaSha256); expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(buildProceduralFallbackAtlas(r.features, style, plan)!.rgba).toEqual(actual.rgba);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan); expect(craft.ok).toBe(true); expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(style.facialHair).toBe("goatee"); expect(plan.hairPlan.template).toBe("bald"); expect(plan.hairPlan.surfaceOnly).toBeUndefined(); expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    expect(plan.outfitPlan.upper.pattern.color).toBe("#c5aa82"); expect(style.goateeHasMustache).toBe(true);
    const withoutTan = structuredClone(plan); withoutTan.outfitPlan.upper.pattern.color = "#eeeae1";
    withoutTan.outfitPlan.upper.pattern.crossedBandColors = plan.outfitPlan.upper.pattern.crossedBandColors.map((c: string) => c === "#c5aa82" ? "#eeeae1" : c);
    const control = buildProceduralFallbackAtlas(r.features, style, withoutTan)!;
    let tanAffectedPixels = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2].some(c => actual.rgba[i * 4 + c] !== control.rgba[i * 4 + c])) { expect(Math.floor(i / 64)).toBeGreaterThanOrEqual(16); tanAffectedPixels++; }
    expect(tanAffectedPixels).toBeGreaterThan(0);
    const withoutBeard = buildProceduralFallbackAtlas(r.features, { ...style, facialHair: "none", goateeHasMustache: false }, plan)!;
    let beardAffectedPixels = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2].some(c => actual.rgba[i * 4 + c] !== withoutBeard.rgba[i * 4 + c])) { expect(Math.floor(i / 64)).toBeLessThan(16); beardAffectedPixels++; }
    expect(beardAffectedPixels).toBeGreaterThan(0);
    const out = mkdtempSync("evaluation-artifacts/current-028-live-verification-20260928-");
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${out}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    writeFileSync(`${out}/verification.json`, JSON.stringify({ providerCalls: 0, summarySha256: sha(bytes), pngSha256: sha(png), style, craft,
      exactStoredPlanReplay: true, checkpointCount: files.length, historicalFilesPreserved: Object.keys(history.preservedHashes).length, postRunProductionChanges: changes,
      tanAffectedPixels, beardAffectedPixels, liveAccounting: { startup: 1, health: 1, post: 1, gemini: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      limitation: "Actual goatee/mustache and tan affect final PNG pixels. Bald/shaved observation and canonical bald evidence do not qualify for short scalp material; no short-hair live claim. Missing localization prevents live geometry-retention verification. Provider wording differs from 027, so this is current-path delivery evidence, not a controlled live causal comparison." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_028_VERIFICATION ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
