// Read-only recovery of the consumed run; no runner imports or primary reconstruction.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-003";
const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");

it("recovers G003's real PNG, preserved material/construction and exact provider accounting", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("9e79a62d9c40ff90938ec6b59035370a6bdb88d29f24d90a17c8fbb4a16fe32d");
    expect(sha(png)).toBe("7505bb31f992f25d83da5afb60a75b9819a1e4f42d93feddc19f24e5119d1b8f");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    expect(versions).toHaveLength(67);
    for (const [i, file] of versions.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === versions.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(e).toMatchObject({ runId: "14a64f1394a5b4a07fea7f48e150e4ca", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 82948, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts[0]).toMatchObject({ completion: "threw", elapsedMs: 45000, httpStatus: null });
    expect(r.bindingAttempts[1]).toMatchObject({ completion: "returned", elapsedMs: 34063, httpStatus: null });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", relationshipFailure: "both_ratios" });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
      productionConfigChanged: false, cleanupFailed: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(t.primary.observed.hair).toContain("dyed-pink hair");
    expect(t.injectedParameters.features.hairColor).toBe("#e58bb6");
    expect(t.primary.renderHints.hairAccessoryScale).toBe("small");
    expect(t.renderAnalysis.renderHints.hairAccessoryScale).toBe("small");
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, { features, faceStyle } = t.injectedParameters;
    expect(p.outfitPlan.upper.colorBlocks.map((b: { id: string }) => b.id)).toEqual(["upper_base", "inner_panel", "opening"]);
    // Historical code painted one medium footprint regardless of its small
    // parameter. Reproduce that version only for immutable evidence recovery.
    const legacyStyle = { ...faceStyle, hairAccessoryScale: "medium" as const };
    const atlas = await decodePng(png), base = buildProceduralSourceAtlas(features, legacyStyle, p)!;
    const composed = composeReferenceStyleAtlas(base, p, d, legacyStyle);
    expect(composed.atlas.rgba).toEqual(atlas.rgba);
    expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(atlas, base, p, legacyStyle, buildReferenceCraftPlan(p, d, composed)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-pastel-cardigan-003-review-20261011-");
    for (const view of renderSkinViews(atlas)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/verification.json`, JSON.stringify({ liveRoot: root, runId: e.runId,
      exactSavedPlanReplay: true, atlasValid: true, craftValid: true, providerCallsInReplay: 0,
      liveProviderCalls: { gemini: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      confirmed: ["dyed_pink_hair_material", "small_head_bow_scale", "open_cardigan_inner_white_panel"],
      remaining: ["primary_did_not_observe_skirt_color_or_short_endpoint", "primary_short_sleeve_category", "no_explicit_front_lock_drape_observation", "invalid_localization"],
      pngHash: sha(png), rgbaHash: sha(atlas.rgba), checkpointCount: versions.length,
      productionConfigUnchanged: true, gracefulCleanupPass: true }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled(); console.info(`G003_REVIEW ${out}`);
  } finally { network.mockRestore(); }
}, 30000);
