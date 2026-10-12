import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import type { SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-012";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("verifies consumed 012 accounting, immutable production PNG and observed propagation", async () => {
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
      wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
    const state = summary.currentDefaultE2E, live = state.result;
    expect(state).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200,
      accounting: "known", diskRecovery: true });
    expect(live).toMatchObject({ ok: true, contract: "primary_compact_v3_legacy_suffix", generationMode: "procedural_fallback" });
    expect(live.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(live.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
      fallbackEligible: true, fallbackReason: "provider_failed_precondition" }));
    expect(live.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true,
      strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(live.diagnostics.geometry).toBeNull();
    expect(state.cropReplay).toMatchObject({ geometryAttemptObserved: false, actualWireCropSha256: null,
      replayEligibility: { status: "coverage_unknown", reason: "localized_face_unavailable" } });
    const postLiveSourceChanges = [];
    for (const [file, expected] of Object.entries(state.fixedHashes)) {
      const current = sha(readFileSync(file));
      if (current !== expected) {
        expect(["src/facialHairEvidence.ts", "src/outfitIdentity.ts", "src/scalpCloseHairEvidence.ts"]).toContain(file.replaceAll("\\", "/"));
        postLiveSourceChanges.push({ file, liveHash: expected, currentHash: current });
      }
    }
    const bytes = readFileSync(`${root}/skin.png`), png = await decodePng(bytes);
    expect(sha(bytes)).toBe(state.png.sha256); expect(sha(png.rgba)).toBe(state.png.decodedRgbaSha256);
    expect([png.width, png.height]).toEqual([64, 64]); expect(validateFinalAtlas(png).ok).toBe(true);
    const primary = live.diagnostics.normalizedPrimary;
    // Only helper context fills unsaved fields. Stored plan and actual PNG are authoritative.
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...live.analysis,
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const plan = structuredClone(live.analysis.skinPlan) as SkinPlan;
    // Historical audit projection cut this array at 512, not a renderer loss.
    // Re-execute the unchanged resolver using saved inputs and require that
    // the complete retained prefix and all other ownership fields match.
    const ownership = resolveHeadOwnership(analysis, plan.hairPlan, plan.facePixelPlan);
    expect(plan.headIdentityPlan.ownership!.cells).toHaveLength(512);
    expect(ownership.cells.slice(0, 512)).toEqual(plan.headIdentityPlan.ownership!.cells);
    expect({ ...ownership, cells: [] }).toEqual({ ...plan.headIdentityPlan.ownership, cells: [] });
    plan.headIdentityPlan.ownership = ownership;
    const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
    expect(plan.hairPlan.surfaceOnly).toBe(true);
    expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("long");
    expect(plan.outfitPlan.upper.pattern).toMatchObject({ kind: "checker_block", construction: "crossed_bands", color: "#eeeae1" });
    expect(primary.observed.clothing).toMatch(/\btan\b/);
    expect(plan.facePixelPlan.layout.geometryUsage.eyes).toBe(false);
    const replay = buildProceduralFallbackAtlas(live.features, style, plan);
    expect(replay).not.toBeNull(); if (!replay) throw new Error("offline_replay_rejected");
    const differences = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => replay.rgba[p * 4 + c] !== png.rgba[p * 4 + c]))
      differences.push({ x: p % 64, y: Math.floor(p / 64), replay: [...replay.rgba.slice(p * 4, p * 4 + 4)], actual: [...png.rgba.slice(p * 4, p * 4 + 4)] });
    const craft = validateAtlasCraft(png, style, undefined, undefined, plan);
    const hair = plan.headIdentityPlan.ownership.cells.filter(c => c.owner === "hair_base" || c.owner === "hair_outer");
    const output = mkdtempSync(`${root}/offline-verification-`);
    for (const view of renderSkinViews(png).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      writeFileSync(`${output}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${output}/verification.json`, JSON.stringify({ providerCallsThisVerification: 0,
      liveSummarySha256: hashes["summary.json"], checkpointCount: checkpoints.length,
      actualHead: state.workingTree.head, legacyTopLevelHeadIsStale: summary.head !== state.workingTree.head,
      productionHashesUnchanged: postLiveSourceChanges.length === 0, postLiveSourceChanges,
      ownershipRecovery: { method: "deterministic_resolver_from_saved_inputs", storedCellCount: 512,
        reconstructedCellCount: ownership.cells.length, retainedPrefixExact: true },
      png: state.png, craft, replayDifferenceCount: differences.length, differences, replayStyle: style,
      hair: { evidence: primary.observed.hair, template: plan.hairPlan.template, surfaceOnly: true,
        surfaceMaterial: plan.hairPlan.surfaceMaterial ?? null, outerGroups: plan.headIdentityPlan.outerHairGroupIds.length,
        baseOwnershipCells: hair.filter(c => c.owner === "hair_base").length,
        outerOwnershipCells: hair.filter(c => c.owner === "hair_outer").length },
      outfit: { evidence: primary.observed.clothing, upper: plan.outfitPlan.upper,
        conclusion: "Tan is observed but plan uses legacy white accent; live tan retention is not established." },
      geometry: { actualCalls: 0, replayEligibility: state.cropReplay.replayEligibility },
      limitation: "Different provider and semantics from 011; not a controlled renderer before/after." }, null, 2), { flag: "wx" });
    for (const [name, hash] of Object.entries(hashes)) expect(sha(readFileSync(`${root}/${name}`))).toBe(hash);
    expect(network).not.toHaveBeenCalled(); expect(differences).toHaveLength(0);
    expect(craft.ok, craft.problems.join(";")).toBe(true);
    console.info(`LIVE_012_VERIFICATION ${output}; replayDiff=${differences.length}`);
  } finally { network.mockRestore(); }
}, 30_000);
