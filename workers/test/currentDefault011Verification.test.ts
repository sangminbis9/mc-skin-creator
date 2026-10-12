import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import type { SkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-011";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies the immutable 011 production output and distinguishes unexercised fixes from retention", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const names = readdirSync(root).filter(n => /\.(json|png)$/.test(n));
    const hashes = Object.fromEntries(names.map(n => [n, sha(readFileSync(`${root}/${n}`))]));
    const summary = JSON.parse(readFileSync(`${root}/summary.json`, "utf8"));
    const checkpoints = names.filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    for (const [i, name] of checkpoints.entries()) {
      const record = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
      expect(record.sequence).toBe(i + 1);
      expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${root}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
      health: { status: "passed", httpStatus: 200 }, qSentCount: 1, cleanupFailed: false,
      ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false, wrapperExitObserved: true, wrapperCloseObserved: true,
      ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0, wranglerGracefulTeardownPathCompleted: true });
    const state = summary.currentDefaultE2E, live = state.result;
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
      accounting: "known", diskRecovery: true });
    expect(live).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(live.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "faceGeometry"]);
    expect(live.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true,
      strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(live.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: true, matchesActualWire: true,
      replayEligibility: { status: "eligible", reason: "localized_face_retained" } });
    // Historical PNG is not rewritten after the isolated scalp-shadow fix.
    const postLiveSourceChanges = [];
    for (const [file, expected] of Object.entries(state.fixedHashes)) {
      const current = sha(readFileSync(file));
      if (current !== expected) {
        expect(["src/identityPlans.ts", "src/scalpCloseHairEvidence.ts", "src/skinPack.ts", "src/outfitIdentity.ts", "src/outfitRenderer.ts"]).toContain(file.replaceAll("\\", "/"));
        postLiveSourceChanges.push({ file, liveHash: expected, currentHash: current });
      }
    }
    const bytes = readFileSync(`${root}/skin.png`), png = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(png.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([png.width, png.height]).toEqual([64, 64]); expect(validateFinalAtlas(png).ok).toBe(true);
    const primary = live.diagnostics.normalizedPrimary;
    // Unsaved rich fields use explicit helper context; stored plan and PNG are authoritative.
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...live.analysis,
      fallbackFeatures: primary.fallbackFeatures, identityGeometry: live.diagnostics.geometry.acceptedGeometry,
      identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = live.analysis.skinPlan as SkinPlan;
    const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
    expect(plan.hairPlan.template).toBe("bald");
    expect(plan.hairPlan.surfaceOnly).toBeUndefined();
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(primary.observed.clothing.toLowerCase()).not.toMatch(/\btan\b/);
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ kind: "horizontal_stripe", color: "#273954" });
    expect(plan.facePixelPlan.layout.geometryUsage.eyes).toBe(true);
    const replay = buildProceduralFallbackAtlas(live.features, style, plan);
    expect(replay).not.toBeNull(); if (!replay) throw new Error("offline_replay_rejected");
    const differences = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => replay.rgba[p * 4 + c] !== png.rgba[p * 4 + c]))
      differences.push({ x: p % 64, y: Math.floor(p / 64) });
    const craft = validateAtlasCraft(png, style, undefined, undefined, plan);
    const hair = plan.headIdentityPlan.ownership.cells.filter(c => c.owner === "hair_base" || c.owner === "hair_outer");
    const palettePixels: Record<string, number> = {};
    for (let p = 0; p < 4096; p++) if (png.rgba[p * 4 + 3] === 255) {
      const color = `#${Array.from(png.rgba.slice(p * 4, p * 4 + 3)).map(v => v.toString(16).padStart(2, "0")).join("")}`;
      palettePixels[color] = (palettePixels[color] ?? 0) + 1;
    }
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(png).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    const report = { offlineProviderCalls: 0, liveSummarySha256: hashes["summary.json"], checkpointCount: checkpoints.length,
      workingTree: state.workingTree, legacyTopLevelHeadIsStale: summary.head !== state.workingTree.head,
      productionHashesUnchanged: postLiveSourceChanges.length === 0, postLiveSourceChanges,
      png: state.png, craft, liveProviderCalls: 2,
      geometry: { accepted: true, actualWireMatchesReplay: true, eligibility: state.cropReplay.replayEligibility,
        usage: plan.facePixelPlan.layout.geometryUsage },
      hair: { evidence: primary.observed.hair, feature: live.features.hairstyle,
        template: plan.hairPlan.template, surfaceOnly: false, outerGroups: 0,
        baseOwnershipCells: hair.filter(c => c.owner === "hair_base").length,
        outerOwnershipCells: hair.filter(c => c.owner === "hair_outer").length,
        conclusion: "Bald classification propagated; no volumetric outer hair. New short-shaved surfaceOnly branch was not exercised." },
      outfit: { evidence: primary.observed.clothing, upper: plan.outfitPlan.upper,
        tanPalettePixelCount: palettePixels["#c5aa82"] ?? 0,
        conclusion: "Fresh primary omitted tan and crossed plaid; tan paired-direction correction was not exercised. No proof of live tan fix." },
      replayDifferenceCount: differences.length, replayDifferences: differences,
      palettePixels, limitation: "Fresh provider semantics differ from 010; not a controlled before/after. Helper context is not recovered provider data." };
    writeFileSync(`${output}/verification.json`, JSON.stringify(report, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled();
    expect(differences).toHaveLength(0);
    expect(craft.ok, craft.problems.join(";")).toBe(true);
    console.info(`LIVE_011_VERIFICATION ${output}; replayDiff=${differences.length}; tanPixels=${report.outfit.tanPalettePixelCount}`);
  } finally { network.mockRestore(); }
}, 30_000);
