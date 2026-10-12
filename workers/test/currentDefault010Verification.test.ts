import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import type { SkinPlan } from "../src/skinPlan";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-010";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const origins = { top: [8, 0], bottom: [16, 0], right: [0, 8], front: [8, 8], left: [16, 8], back: [24, 8] };
function offset(cell: { face: keyof typeof origins; layer: string; x: number; y: number }) {
  const [x, y] = origins[cell.face];
  return ((y + cell.y) * 64 + x + cell.x + (cell.layer === "outer" ? 32 : 0)) * 4;
}
const frontOffset = (p: { x: number; y: number }) => ((8 + p.y) * 64 + 8 + p.x) * 4;
const rgba = (atlas: RawImage, i: number) => Array.from(atlas.rgba.slice(i, i + 4));

it("verifies consumed 010 and records partial likeness propagation without another request or repair", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(name => /\.(?:json|png)$/.test(name));
    const originalHashes = Object.fromEntries(names.map(name => [name, sha(readFileSync(`${root}/${name}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const versions = names.filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name)).sort();
    expect(versions.length).toBeGreaterThan(0);
    for (const [i, name] of versions.entries()) {
      const record = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(record.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${versions.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
      health: { status: "passed", httpStatus: 200 }, qSentCount: 1, cleanupFailed: false,
      ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false, wrapperExitObserved: true, wrapperCloseObserved: true,
      ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0, wranglerGracefulTeardownPathCompleted: true });
    const state = summary.currentDefaultE2E, live = state.result;
    expect(state.workingTree).toMatchObject({ branch: "main", head: "94f02b19a7efb1e3205b47545ab68fe20a9420c2" });
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
      accounting: "known", diskRecovery: true });
    expect(state.e2eGateTrace).toMatchObject({ failureStage: "none", failureCode: "none",
      handlerInvocationStarted: true, handlerInvocationReturned: true, providerAttemptIntent: 2, providerAttemptStarted: 2 });
    expect(live).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(live.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(live.diagnostics.primaryDiagnostic.providerAttempts.find((a: { outcome: string }) => a.outcome === "failed"))
      .toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(live.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true,
      normalizationPass: true, richValidationPass: true });
    expect(live.diagnostics.geometry).toBeNull();
    expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: false, actualWireCropSha256: null,
      replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" },
      diagnostics: { cropMode: "center_fallback", faceBox: null } });
    // This consumed run predates the offline shaved-hair and directional-palette corrections.
    // Its actual PNG/plan remains immutable and is never relabeled as fixed.
    const postLiveSourceChanges = [];
    for (const [file, expected] of Object.entries(state.fixedHashes)) {
      const current = sha(readFileSync(file));
      if (current !== expected) {
        expect(["src/identityPlans.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts", "src/skinPack.ts", "src/outfitRenderer.ts"]).toContain(file.replaceAll("\\", "/"));
        postLiveSourceChanges.push({ file, liveHash: expected, currentHash: current });
      }
    }
    const bytes = readFileSync(`${root}/skin.png`), png = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(png.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([png.width, png.height]).toEqual([64, 64]); expect(validateFinalAtlas(png).ok).toBe(true);

    // Saved primary is allowlisted, not raw provider output. Unsaved fields use
    // explicit helper context. Returned plan and actual PNG remain authoritative.
    const primary = live.diagnostics.normalizedPrimary;
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...live.analysis,
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = live.analysis.skinPlan as SkinPlan;
    expect(primary.observed.hair).toContain("Extremely short, shaved hair");
    expect(plan.hairPlan.surfaceOnly).toBeUndefined();
    expect(plan.hairPlan).toMatchObject({ template: "coily_volume", lengthClass: "short", texture: "coily", fringe: "none" });
    expect(plan.headIdentityPlan.outerHairGroupIds).toHaveLength(8);
    expect(primary.observed.clothing).toContain("navy blue, tan, and dark blue horizontal and vertical stripes");
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ construction: "crossed_bands", color: "#eeeae1", source: "observed" });
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
    expect(plan.outfitPlan.upper.rightSleeve.length).toBe("long");
    expect(Object.values(plan.facePixelPlan.layout.geometryUsage).every(v => v === false)).toBe(true);
    const measurements = Object.values(plan.facePixelPlan.layout.measurementTrace);
    expect(measurements).toHaveLength(8);
    expect(measurements.every(v => v.provenance === "observed_categorical" && v.selected === "categorical_grammar")).toBe(true);
    const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
    expect(style.facialHair).toBe("goatee");
    const hair = plan.headIdentityPlan.ownership.cells.filter(c => c.owner === "hair_base" || c.owner === "hair_outer");
    expect(hair.filter(c => c.owner === "hair_outer")).toHaveLength(122);
    const transparentHairCells = hair.filter(c => png.rgba[offset(c) + 3] !== 255);
    // This texture uses the preserved existing grammar: ownership reservations
    // are not a guarantee that every reserved outer cell must be opaque.
    expect(plan.headIdentityPlan.ownership.execution).toBe("preserve_existing_grammar");
    expect(transparentHairCells).toHaveLength(36);
    expect(transparentHairCells.every(c => c.owner === "hair_outer" && c.layer === "outer")).toBe(true);
    const stages: { stage: string; differingHairPixels: number }[] = [];
    const replay = buildProceduralFallbackAtlas(live.features, style, plan, (stage: string, atlas: RawImage) => {
      stages.push({ stage, differingHairPixels: hair.filter(c => rgba(atlas, offset(c)).join() !== rgba(png, offset(c)).join()).length });
    });
    expect(replay).not.toBeNull(); if (!replay) throw new Error("offline_replay_rejected");
    expect(stages.find(s => s.stage === "after_authoritative_head")?.differingHairPixels).toBe(0);
    expect(stages.find(s => s.stage === "final_head")?.differingHairPixels).toBe(0);
    const facePixels = plan.facePixelPlan.pixels.map(p => ({ ...p, rgba: rgba(png, frontOffset(p)) }));
    for (const p of facePixels) expect(rgba(replay, frontOffset(p))).toEqual(p.rgba);
    const skin = [1, 3, 5].map(i => parseInt(live.features.skinTone.slice(i, i + 2), 16));
    const expectedSclera = [236, 232, 218].map((v, i) => Math.round(skin[i] * 0.28 + v * 0.72));
    const sclera = facePixels.filter(p => p.role === "sclera");
    expect(sclera).toHaveLength(2);
    for (const p of sclera) expect(p.rgba).toEqual([...expectedSclera, 255]);
    const beard = [{ x: 3, y: 7 }, { x: 4, y: 7 }].map(p => ({ ...p, rgba: rgba(png, frontOffset(p)) }));
    for (const p of beard) expect(rgba(replay, frontOffset(p))).toEqual(p.rgba);
    const craft = validateAtlasCraft(png, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true);
    const changed: { x: number; y: number }[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => replay.rgba[p * 4 + c] !== png.rgba[p * 4 + c]))
      changed.push({ x: p % 64, y: Math.floor(p / 64) });
    expect(changed).toHaveLength(0);
    expect(changed.filter(p => p.y >= 16)).toHaveLength(0);
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(png).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name))) {
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      if (view.name === "front") writeFileSync(`${output}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCalls: 0, liveSummarySha256: originalHashes["summary.json"],
      checkpointCount: versions.length, workingTreeAtLive: state.workingTree,
      legacyTopLevelHeadIsStale: summary.head !== state.workingTree.head,
      png: state.png, productionHashesUnchanged: postLiveSourceChanges.length === 0, postLiveSourceChanges,
      cropGate: state.cropReplay.replayEligibility,
      geometryAttemptObserved: false, facePixels, beard, measurements, stages, craft,
      hair: { sourceEvidence: primary.observed.hair, template: plan.hairPlan.template,
        surfaceOnly: plan.hairPlan.surfaceOnly ?? false, baseHairPixels: hair.filter(c => c.owner === "hair_base").length,
        plannedOuterHairCells: 122, actualOpaqueOuterHairCells: 122 - transparentHairCells.length,
        ownershipExecution: plan.headIdentityPlan.ownership.execution,
        transparentHairCells, outerGroups: 8, propagation: "scalp_close_intent_lost_before_ownership",
        earliestLoss: "identityPlans.ts:affirmativeScalpCloseHair excludes extremely short, shaved wording" },
      outfit: { sourceEvidence: primary.observed.clothing, upper: plan.outfitPlan.upper,
        propagation: "long_sleeves_and_crossed_bands_preserved_tan_palette_lost",
        earliestLoss: "outfitIdentity.ts:observedPatternColor does not match horizontal and vertical direction sequence" },
      replayDifferences: { total: changed.length, pixels: changed, body: 0 },
      limitation: "Observed live output defects are recorded, not repaired. Stored-plan replay has helper context for unsaved rich fields and is not a new live response or a controlled 009-to-010 comparison." }, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(originalHashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled();
    console.info(`LIVE_010_OFFLINE_VERIFICATION ${output}; replayDiff=${changed.length}`);
  } finally { network.mockRestore(); }
}, 30_000);
