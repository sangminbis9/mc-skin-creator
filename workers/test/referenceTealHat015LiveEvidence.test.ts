// Immutable same-run evidence only; no remote runner/source payload access.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-015";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D015's bounded V3 success and records actual downstream material losses without filling missing hair evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("9dcc542526cbec51f4fcf9f9e0a71f9037f62df23e376e3c527a8892cb026086");
    const files = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(files).toHaveLength(57);
    for (const [i, f] of files.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
    }
    const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
    expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
    expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED", startupAttempts: 1,
      healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
      wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true,
      ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
      ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    const e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    expect(e).toMatchObject({ runId: "63f574aa02545d15b736529ede323975", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 47021, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toEqual([
      { stage: "geminiPrimary", started: true, completion: "returned", elapsedMs: 1548, httpStatus: 400,
        deadlineMs: 45000, schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" },
      { stage: "gemmaPrimary", started: true, completion: "returned", elapsedMs: 41529, httpStatus: null,
        deadlineMs: 60000, schemaSha256: "498a0ad85e255bf3f518deb216abdc18af2f45fa15a45a5a58954abb2a73a4d6" },
    ]);
    expect(r.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
      provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
      fallbackEligible: true, fallbackReason: "provider_failed_precondition" }));
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true,
      pngDiskMatch: true, atlasDiskMatch: true });
    const prev = JSON.parse(readFileSync(root.replace(/015$/, "014") + "/summary.json", "utf8")).currentDefaultE2E;
    expect(e.preprocessing).toEqual(prev.preprocessing);
    expect(Object.keys(e.fixedHashes).filter(k => e.fixedHashes[k] !== prev.fixedHashes[k]).map(k => k.replaceAll("\\", "/")))
      .toEqual(["src/observedFrontHairDrape.ts", "src/outfitIdentity.ts"]);
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.accessories).toBe("large, light blue, soft-textured plush hat");
    expect(t.primary.fallbackFeatures.hatColor).toBe("black");
    expect(t.injectedParameters.features.hatColor).toBe("#22201e");
    expect(t.primary.observed.clothing).toContain("pastel pixelated/blocky pattern");
    expect(t.skinPlan.skinPlan.outfitPlan.upper.pattern.blockColors).toEqual(["#c8798c", "#755386", "#416b9d", "#d5af3f"]);
    expect(t.referenceStyle.design.drape.eligible).toBe(false);
    const p = t.skinPlan.skinPlan, st = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
    const local = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, st);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("b8b1b3e88d659a5cb3b84bc0216fb42021084e1586d89c5678def86c3b509f0b");
    expect(local.atlas.rgba).toEqual(actual.rgba); expect([actual.width, actual.height]).toEqual([64, 64]);
    expect(sha(actual.rgba)).toBe("30081669bbe46f657674992b18868bf2dba9a2f3ebe8d2a431c0a3922fe2954d");
    expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(validateReferenceAtlasCraft(actual, base, p, st, buildReferenceCraftPlan(p, t.referenceStyle.design, local)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-015-evidence-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_immutable_live_evidence_review", sourceRoot: root,
      sourceSummarySha256: sha(bytes), runId: e.runId, checkpointIntegrity: true, checkpoints: 57,
      actualPngExactReplay: true, pngSha256: sha(png), craftPass: true, atlasPass: true,
      startup: 1, health: 1, post: 1, liveGeminiPrimary: 1, liveGemmaPrimary: 1, liveGeometry: 0, retry: 0,
      offlineProviderCalls: 0, elapsedMs: e.elapsedMs, gracefulCleanup: true,
      sourceAndDerivativesUnchanged: true, productionConfigUnchanged: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
      materialBoundaries: { observedAccessories: t.primary.observed.accessories,
        primaryCategoricalHatColor: t.primary.fallbackFeatures.hatColor, injectedHatColor: st.hatColor,
        observedClothing: t.primary.observed.clothing, savedPattern: p.outfitPlan.upper.pattern,
        headwear: "NORMALIZED_PROSE_PRESERVED_COLOR_PARAMETER_UNRESOLVED",
        pastel: "NORMALIZED_PRESERVED_PALETTE_MODIFIER_LOST" },
      hairBoundary: { observed: t.primary.observed.hair, drape: t.referenceStyle.design.drape,
        frontPointCount: local.diagnostic.looseHair.points.filter(c => c.face === "front").length,
        explicitChestFrontEndpointObserved: false, priorRunEndpointNotImported: true },
      latestHairBranchLiveDelivery: "not_exercised_by_current_observation", qualityGoalComplete: false,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D015_EVIDENCE_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("isolates D015 headwear and pastel transfer against its exact production PNG, without rebuilding missing analysis", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    expect(sha(bytes)).toBe("9dcc542526cbec51f4fcf9f9e0a71f9037f62df23e376e3c527a8892cb026086");
    const t = s.currentDefaultE2E.result.propagationTrace, immutable = JSON.stringify(t);
    // Empty omitted prompts only allow invoking the observed-only resolvers.
    // Never replace the saved plan/family with a reconstruction of missing context.
    const retained = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
    const refined = refineFeatureColorsFromAnalysis(retained, t.injectedParameters.features);
    const pattern = buildOutfitPlan(retained).upper.pattern;
    expect(refined.hatColor).toBe("#7fc3e8");
    expect(pattern.blockColors).toEqual(["#d9a5af", "#a38cab", "#819cba", "#e1c87d"]);
    const saved: SkinPlan = t.skinPlan.skinPlan, png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-015-material-transfer-20261011-");
    const rows = [];
    for (const [name, hat, pastel] of [["actual", false, false], ["hat-only", true, false], ["pastel-only", false, true], ["combined-offline", true, true]] as const) {
      const p = structuredClone(saved), d = structuredClone(t.referenceStyle.design);
      if (pastel) p.outfitPlan.upper.pattern = pattern;
      const f = { ...t.injectedParameters.features }, st = { ...t.injectedParameters.faceStyle };
      if (hat) { f.hatColor = refined.hatColor; st.hatColor = refined.hatColor; }
      const base = buildProceduralSourceAtlas(f, st, p)!, result = composeReferenceStyleAtlas(base, p, d, st);
      if (name === "actual") expect(result.atlas.rgba).toEqual(actual.rgba);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      expect(validateReferenceAtlasCraft(result.atlas, base, p, st, buildReferenceCraftPlan(p, d, result)).ok).toBe(true);
      expect(composeReferenceStyleAtlas(base, p, d, st).atlas.rgba).toEqual(result.atlas.rgba);
      const clothParts = ["body", "leftArm", "rightArm"] as const;
      const clothRects = pastel ? clothParts.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base)) : [];
      const covering = new Set(result.diagnostic.surfaces.filter(c => c.owner === "covering").map(c => {
        const r = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return (r.y + c.y) * 64 + r.x + c.x;
      }));
      let changedPixels = 0, changedCoveringPixels = 0;
      for (let i = 0; i < 4096; i++) {
        expect(result.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if (![0, 1, 2].some(ch => result.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) continue;
        changedPixels++;
        if (hat && covering.has(i)) { changedCoveringPixels++; continue; }
        expect(clothRects.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h), `${name}:unrelated:${i}`).toBe(true);
      }
      if (hat || pastel) expect(changedPixels).toBeGreaterThan(0);
      if (hat) expect(changedCoveringPixels).toBeGreaterThan(0);
      expect(p.hairPlan).toEqual(saved.hairPlan); expect(p.facePixelPlan).toEqual(saved.facePixelPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      expect({ ...p.outfitPlan.upper, pattern: saved.outfitPlan.upper.pattern }).toEqual(saved.outfitPlan.upper);
      expect(d).toEqual(t.referenceStyle.design);
      const visiblePalette = (pastel ? pattern.blockColors! : []).map(hex => {
        const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let count = 0;
        for (const part of clothParts) {
          const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
            const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
            const at = result.atlas.rgba[oi + 3] === 255 ? oi : bi;
            if (rgb.every((v, ch) => result.atlas.rgba[at + ch] === v)) count++;
          }
        }
        expect(count).toBeGreaterThan(0); return { color: hex, visibleFrontPixels: count };
      });
      const encoded = await encodePng(result.atlas); expect((await decodePng(encoded)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      rows.push({ name, changedPixels, changedCoveringPixels, unrelatedPixelDiff: 0, alphaUnchanged: true,
        craftPass: true, atlasPass: true, visiblePalette, rgbaSha256: sha(result.atlas.rgba) });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_same_run_material_ablation_not_live", providerCalls: 0,
      sourceRoot: root, sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), runId: t.runId,
      actualPngExactBaseline: true, observedAccessories: t.primary.observed.accessories,
      beforeHatColor: t.injectedParameters.features.hatColor, afterHatColor: refined.hatColor,
      observedClothing: t.primary.observed.clothing, beforePattern: saved.outfitPlan.upper.pattern, afterPattern: pattern,
      missingPromptsNotReconstructed: true, hairEvidenceNotSupplemented: true, freshLiveDeliveryVerified: false, rows,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("D015_MATERIAL_TRANSFER", out);
  } finally { network.mockRestore(); }
}, 60_000);
