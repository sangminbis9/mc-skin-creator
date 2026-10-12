import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-014";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies actual 014 PNG and distinguishes retained beard/tan from missed scalp-close evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(n => /\.(json|png)$/.test(n));
    const hashes = Object.fromEntries(names.map(n => [n, sha(readFileSync(`${root}/${n}`))]));
    const s = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = names.filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) {
      const r = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(r.sequence).toBe(i + 1); expect(sha(JSON.stringify(r.snapshot))).toBe(r.snapshotSha256);
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
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = structuredClone(r.analysis.skinPlan) as SkinPlan;
    const style = buildFaceStyle(a, r.features, plan.hairPlan);
    // Immutable live -014 predates canonical-feature combination selection.
    // Freeze only that diagnosed flag for historical replay; the new behavior
    // is checked independently in current014MustacheEvidence.test.ts.
    style.goateeHasMustache = false;
    const actualBytes = readFileSync(`${root}/skin.png`), actual = await decodePng(actualBytes);
    expect(sha(actualBytes)).toBe(state.png.sha256);
    expect(sha(actual.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([actual.width, actual.height]).toEqual([64, 64]);
    const replay = buildProceduralFallbackAtlas(r.features, style, plan)!;
    expect(sha(replay.rgba)).toBe(sha(actual.rgba));
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const craft = validateAtlasCraft(actual, style, undefined, undefined, plan);
    expect(craft.ok).toBe(true);
    expect(primary.fallbackFeatures.facialHair).toBe("goatee"); expect(style.facialHair).toBe("goatee");
    const withoutBeard = buildProceduralFallbackAtlas({ ...r.features, facialHair: "none" }, { ...style, facialHair: "none" }, plan)!;
    const beardPixels = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2].some(c => actual.rgba[p * 4 + c] !== withoutBeard.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16); beardPixels.push({ x: p % 64, y: Math.floor(p / 64) });
    }
    expect(beardPixels.length).toBeGreaterThan(0);
    expect(plan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    let tanPixels = 0;
    for (let p = 16 * 64; p < 48 * 64; p++) if (actual.rgba[p * 4] === 197 && actual.rgba[p * 4 + 1] === 170
      && actual.rgba[p * 4 + 2] === 130 && actual.rgba[p * 4 + 3] === 255) tanPixels++;
    expect(tanPixels).toBeGreaterThan(0);
    expect(plan.hairPlan.surfaceOnly).toBeUndefined();
    expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
    const outerHairCells = plan.headIdentityPlan.ownership!.cells.filter(c => c.owner === "hair_outer").length;
    expect(outerHairCells).toBeGreaterThan(0);
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(actual).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCallsThisVerification: 0,
      liveSummarySha256: hashes["summary.json"], checkpointCount: checkpoints.length, actualPng: state.png,
      actualBaselineReplayExact: true, craft, beard: { category: style.facialHair, changedByAblation: beardPixels },
      tan: { patternColor: plan.outfitPlan.upper.pattern.color, exactPixels: tanPixels },
      scalp: { observation: primary.observed.hair, surfaceOnly: false, material: null, outerHairCells,
        conclusion: "Nearly-shaved observation did not select scalp-close surface; not a successful scalp fix confirmation." },
      limitations: "Stored plan is authoritative. Missing rich free-text helper context is not recovered provider output. New provider semantics differ from 012; not a controlled live before/after." }, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled(); console.info(`LIVE_014_VERIFICATION ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
