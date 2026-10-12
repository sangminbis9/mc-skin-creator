import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const origins = { top: [8, 0], bottom: [16, 0], right: [0, 8], front: [8, 8], left: [16, 8], back: [24, 8] };
function offset(cell: { face: keyof typeof origins; layer: string; x: number; y: number }) {
  const [x, y] = origins[cell.face];
  return ((y + cell.y) * 64 + x + cell.x + (cell.layer === "outer" ? 32 : 0)) * 4;
}

it("verifies consumed 009 live PNG, hair ownership, checkpoints and a no-network stored-plan replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(name => /\.(?:json|png)$/.test(name));
    const originalHashes = Object.fromEntries(names.map(name => [name, sha(readFileSync(`${root}/${name}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const versions = names.filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name)).sort();
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
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
      accounting: "known", diskRecovery: true });
    expect(state.e2eGateTrace).toMatchObject({ failureStage: "none", failureCode: "none",
      handlerInvocationStarted: true, handlerInvocationReturned: true, providerAttemptIntent: 3, providerAttemptStarted: 3 });
    expect(live).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(live.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary", "faceGeometry"]);
    expect(live.diagnostics.primaryDiagnostic.providerAttempts.find((a: { outcome: string }) => a.outcome === "failed"))
      .toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    expect(live.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true,
      normalizationPass: true, richValidationPass: true });
    expect(live.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    const postLiveSourceChanges = [];
    for (const [file, expected] of Object.entries(state.fixedHashes)) {
      const current = sha(readFileSync(file));
      if (current !== expected) {
        // The consumed live run predates the subsequent explicit sclera,
        // coordinated pattern-palette, crop-eligibility and shaved-hair evidence corrections.
        // Do not relabel it as having run the current renderer. All contracts
        // outside the listed correction files remain exactly the live hashes. Replaying
        // its saved plan here intentionally does not call the new input gate.
        expect(["src/skinPack.ts", "src/outfitIdentity.ts", "src/generate.ts", "src/identityPlans.ts", "src/scalpCloseHairEvidence.ts", "src/outfitRenderer.ts"]).toContain(file.replaceAll("\\", "/"));
        postLiveSourceChanges.push({ file, liveHash: expected, currentHash: current });
      }
    }
    const bytes = readFileSync(`${root}/skin.png`), png = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(png.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([png.width, png.height]).toEqual([64, 64]); expect(validateFinalAtlas(png).ok).toBe(true);

    // Use the actual returned plan/features. Unsaved rich fields are explicit
    // helper context, not a recovered raw provider response or localization.
    const primary = live.diagnostics.normalizedPrimary;
    const analysis = makeAnalysis({ ...primary, ...live.analysis,
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "",
      faceIdentityGeometry: live.diagnostics.geometry.acceptedGeometry });
    const plan = live.analysis.skinPlan as SkinPlan;
    expect(primary.observed.hair).toContain("very short, cropped");
    expect(plan.hairPlan).toMatchObject({ surfaceOnly: true, lengthClass: "short", texture: "coily", fringe: "none" });
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.hairPlan.structure.groups.every(group => group.points.every(point => point.layer === "base"))).toBe(true);
    const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
    expect(style.hairstyle).toBe("buzz");
    const cells = plan.headIdentityPlan.ownership.cells;
    const hair = cells.filter(cell => cell.owner === "hair_base");
    const outer = cells.filter(cell => cell.layer === "outer");
    expect(hair.length).toBeGreaterThan(0); expect(outer).toHaveLength(384);
    const ownershipPixels = hair.map(cell => ({ ...cell, rgba: [...png.rgba.slice(offset(cell), offset(cell) + 4)] }));
    expect(ownershipPixels.every(cell => cell.rgba[3] === 255)).toBe(true);
    expect(outer.every(cell => cell.owner === "clear" && png.rgba[offset(cell) + 3] === 0)).toBe(true);
    const stages: { stage: string; differingHairPixels: number; hairPixels: number }[] = [];
    const replay = buildProceduralFallbackAtlas(live.features, style, plan, (stage: string, atlas: RawImage) => {
      stages.push({ stage, hairPixels: hair.length, differingHairPixels: hair.filter(cell => {
        const i = offset(cell); return [0, 1, 2, 3].some(c => atlas.rgba[i + c] !== png.rgba[i + c]);
      }).length });
    });
    expect(replay).not.toBeNull(); if (!replay) throw new Error("offline_replay_rejected");
    expect(stages.find(row => row.stage === "after_authoritative_head")?.differingHairPixels).toBe(0);
    expect(stages.find(row => row.stage === "final_head")?.differingHairPixels).toBe(0);
    const craft = validateAtlasCraft(png, style, undefined, undefined, plan);
    expect(craft.ok, craft.problems.join(";")).toBe(true);
    const changed: { x: number; y: number }[] = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => replay.rgba[p * 4 + c] !== png.rgba[p * 4 + c]))
      changed.push({ x: p % 64, y: Math.floor(p / 64) });
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(png).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name))) {
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      if (view.name === "front") writeFileSync(`${output}/head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCalls: 0, liveSummarySha256: originalHashes["summary.json"],
      checkpointCount: versions.length, png: state.png, postLiveSourceChanges, hairEvidence: primary.observed.hair,
      hairPlan: { template: plan.hairPlan.template, surfaceOnly: plan.hairPlan.surfaceOnly, length: plan.hairPlan.lengthClass,
        texture: plan.hairPlan.texture, structureGroups: plan.hairPlan.structure.groups.length,
        legacyMaskCoordinateSpace: plan.hairPlan.headMask.coordinateSpace }, styleHairstyle: style.hairstyle,
      baseHairOwnershipCount: hair.length, outerClearCount: outer.length, ownershipPixels, stages, craft,
      replayDifferences: { total: changed.length, head: changed.filter(p => p.y < 16).length, pixels: changed },
      limitation: "Live PNG and returned ownership/plan are authoritative. Replay uses explicit helper context for unsaved rich fields; it is not a new live response." }, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(originalHashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled();
    console.info(`LIVE_009_OFFLINE_VERIFICATION ${output}; replayDiff=${changed.length}; stages=${JSON.stringify(stages)}`);
  } finally { network.mockRestore(); }
}, 30_000);
