// Immutable live evidence and isolated offline replay; no provider/source read.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { buildOutfitPlan } from "../src/outfitIdentity";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-014";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());

it("recovers D014 Gemini success, immutable checkpoints and graceful cleanup", () => {
  expect(sha(bytes)).toBe("973d331c6e59beb606ae607e2c4304e29b72ac504d23605e74dc186e72f3c77c");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(55);
  for (const [i, name] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s).toMatchObject({ classification: "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED",
    startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  const e = s.currentDefaultE2E, r = e.result;
  expect(e).toMatchObject({ runId: "f2b5b70b2f6092fdb8659eb9a17df856", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 19437, accounting: "known", diskRecovery: true });
  expect(r.bindingAttempts).toEqual([{ stage: "geminiPrimary", started: true, completion: "returned",
    elapsedMs: 15987, httpStatus: 200, deadlineMs: 45000,
    schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" }]);
  expect(r.diagnostics.primaryDiagnostic.attempts).toBe(1);
  expect(r.diagnostics.primaryDiagnostic.providerAttempts.filter((a: { outcome: string }) => a.outcome === "completed"))
    .toEqual([expect.objectContaining({ provider: "gemini", status: 200, elapsedMs: 15990,
      providerSchemaValidation: "passed", strictValidation: "passed" })]);
  expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
    strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
  expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  const old = JSON.parse(readFileSync(root.replace(/014$/, "013") + "/summary.json", "utf8")).currentDefaultE2E;
  expect(e.preprocessing).toEqual(old.preprocessing);
  expect(Object.keys(e.fixedHashes).filter(f => e.fixedHashes[f] !== old.fixedHashes[f]).map(f => f.replaceAll("\\", "/")))
    .toEqual(["src/observedFrontHairDrape.ts"]);
});

it("replays the exact D014 PNG and isolates supported front-lock endpoint delivery", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const e = s.currentDefaultE2E, t = e.result.propagationTrace, p = t.skinPlan.skinPlan;
    const f = t.injectedParameters.features, style = t.injectedParameters.faceStyle;
    const immutable = JSON.stringify(t), base = buildProceduralSourceAtlas(f, style, p)!;
    const before = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("a3f3f58857db0007f3f1a6363c2fce09d23442f774fe0b84cf8f026fe1da52ac");
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(before.atlas.rgba).toEqual(actual.rgba);
    expect(sha(actual.rgba)).toBe("bd92201382d0c1f8f29e636bdf30dfc8d13783b184782b069da9457995863f5b");
    expect(t.finalPng.rgbaSha256).toBe(sha(actual.rgba)); expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(t.primary.observed.hair).toContain("face-framing strands extending down past the bust/chest area");
    expect(t.renderAnalysis.observed.hair).toBe(t.primary.observed.hair);
    expect(t.referenceStyle.design.drape.eligible).toBe(false);
    expect(before.diagnostic.looseHair.points.filter(c => c.face === "front")).toEqual([]);
    // Recompute only the design permission from retained evidence. The complete
    // historical analysis is not reconstructed, nor are its plan/colors replaced.
    const design = structuredClone(t.referenceStyle.design);
    design.drape = buildReferenceStylePlan({ ...t.primary, ...t.renderAnalysis }).drape;
    expect(design.drape.eligible).toBe(true);
    const after = composeReferenceStyleAtlas(base, p, design, style);
    const front = after.diagnostic.looseHair.points.filter(c => c.face === "front");
    expect(front).toHaveLength(16); expect(after.diagnostic.looseHair.frontEvidence).toBe("observed_front_lock_endpoint");
    expect(after.diagnostic.looseHair.points.filter(c => c.face === "back"))
      .toEqual(before.diagnostic.looseHair.points.filter(c => c.face === "back"));
    const uv = CLASSIC_LAYOUT.body.base.front, overlay = CLASSIC_LAYOUT.body.overlay.front;
    const allowed = new Set(front.map(c => (uv.y + c.y) * 64 + uv.x + c.x));
    let changedPixels = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(c => after.atlas.rgba[i * 4 + c] !== actual.rgba[i * 4 + c])) continue;
      changedPixels++; expect(allowed.has(i), `unrelated:${i}`).toBe(true);
    }
    expect(changedPixels).toBe(16);
    const selected = selectReferenceStyleAtlas(base, p, design, style).selected!;
    expect(selected).not.toBeNull(); expect(selected.composition.atlas.rgba).toEqual(after.atlas.rgba);
    for (const [d, result] of [[t.referenceStyle.design, before], [design, after]] as const) {
      expect(validateReferenceAtlasCraft(result.atlas, base, p, style, buildReferenceCraftPlan(p, d, result)).ok).toBe(true);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
    }
    const occluded = front.filter(c => after.atlas.rgba[((overlay.y + c.y) * 64 + overlay.x + c.x) * 4 + 3] !== 0);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-014-offline-review-20261011-");
    for (const [name, result] of [["actual", before], ["offline-after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(result.atlas), { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), runId: e.runId,
      checkpointCount: 55, checkpointIntegrity: true, exactAtlasReplay: true, craftPass: true, atlasPass: true,
      pngSha256: sha(png), rgbaSha256: sha(actual.rgba), selectedFamilies: t.selectedFamilies,
      observedHair: t.primary.observed.hair, beforeDrape: t.referenceStyle.design.drape, afterDrape: design.drape,
      earliestLoss: "NORMALIZED_PRESERVED_SELECTION_LOST", beforeFrontPoints: 0, afterFrontPoints: front.length,
      changedPixels, unrelatedChangedPixels: 0, alphaUnchanged: true, sourcePlanUnchanged: true,
      visibleFrontCells: front.length - occluded.length, preservedOverlayOcclusion: occluded.map(c => [c.x, c.y]),
      afterRgbaSha256: sha(after.atlas.rgba), freshLiveDeliveryOfLatestFixVerified: false,
      otherObservedBoundary: { observedClothing: t.primary.observed.clothing, plannedPattern: p.outfitPlan.upper.pattern },
      liveGeminiCalls: 1, liveGemmaCalls: 0, liveGeometryCalls: 0, retry: 0, offlineProviderCalls: 0,
      elapsedMs: e.elapsedMs, productionSucceeded: true, gracefulCleanup: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("D014_EXACT_REPLAY_AND_ENDPOINT_FIX", out);
  } finally { network.mockRestore(); }
}, 60_000);

it("preserves D014's observed color blocks separately from cuffs in an isolated saved-plan replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const e = s.currentDefaultE2E, t = e.result.propagationTrace, saved = t.skinPlan.skinPlan;
    const immutable = JSON.stringify(t), png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(saved.outfitPlan.upper.pattern.kind).toBe("irregular_group");
    // Retain unavailable prompt-derived plan context. Resolve/transfer only
    // the observed block pattern, never reconstruct the full historical plan.
    const retained = { ...t.primary, ...t.renderAnalysis };
    const pattern = buildOutfitPlan(retained).upper.pattern;
    expect(pattern).toMatchObject({ construction: "pixel_blocks", placement: "wrap", source: "observed",
      blockColors: ["#d9a5af", "#cdbfd9", "#b4d7c6", "#e1c87d"] });
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-014-block-palette-20261011-");
    const rows = [];
    for (const [name, cloth, hair] of [["actual", false, false], ["pattern-only", true, false], ["combined-offline", true, true]] as const) {
      const p = structuredClone(saved), d = structuredClone(t.referenceStyle.design);
      if (cloth) p.outfitPlan.upper.pattern = pattern;
      if (hair) d.drape = buildReferenceStylePlan(retained).drape;
      const st = t.injectedParameters.faceStyle;
      const base = buildProceduralSourceAtlas(t.injectedParameters.features, st, p)!;
      const result = composeReferenceStyleAtlas(base, p, d, st);
      if (name === "actual") expect(result.atlas.rgba).toEqual(actual.rgba);
      expect(validateReferenceAtlasCraft(result.atlas, base, p, st, buildReferenceCraftPlan(p, d, result)).ok).toBe(true);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      expect(composeReferenceStyleAtlas(base, p, d, st).atlas.rgba).toEqual(result.atlas.rgba);
      const parts = ["body", "leftArm", "rightArm"] as const;
      const allowed = parts.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
      let changedPixels = 0;
      for (let i = 0; i < 4096; i++) {
        expect(result.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if (![0, 1, 2].some(ch => result.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) continue;
        changedPixels++;
        expect(allowed.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y
          && Math.floor(i / 64) < r.y + r.h), `outside_cloth:${name}:${i}`).toBe(true);
      }
      if (cloth) expect(changedPixels).toBeGreaterThan(0);
      expect(p.hairPlan).toEqual(saved.hairPlan); expect(p.facePixelPlan).toEqual(saved.facePixelPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      expect({ ...p.outfitPlan.upper, pattern: saved.outfitPlan.upper.pattern }).toEqual(saved.outfitPlan.upper);
      const visiblePalette = (cloth ? pattern.blockColors! : []).map(hex => {
        const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let pixels = 0;
        for (const part of parts) {
          const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
            const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
            const at = result.atlas.rgba[oi + 3] === 255 ? oi : bi;
            if (rgb.every((c, ch) => result.atlas.rgba[at + ch] === c)) pixels++;
          }
        }
        expect(pixels, `${name}:${hex}`).toBeGreaterThan(0); return { color: hex, pixels };
      });
      const encoded = await encodePng(result.atlas); expect((await decodePng(encoded)).rgba).toEqual(result.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(result.atlas)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      rows.push({ name, rgbaSha256: sha(result.atlas.rgba), changedPixels, unrelatedPixels: 0,
        alphaUnchanged: true, craftPass: true, atlasPass: true, visiblePalette,
        frontHairCells: result.diagnostic.looseHair.points.filter(c => c.face === "front").length });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_same_run_pattern_transfer_not_live",
      sourceRoot: root, sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), runId: e.runId,
      actualPngExactBaseline: true, providerCalls: 0, earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST",
      observedClothing: t.primary.observed.clothing, beforePattern: saved.outfitPlan.upper.pattern,
      afterPattern: pattern, cuffColorExcludedFromBlockPalette: true, missingPromptsReconstructed: false,
      frozenAnalysisAndOtherPlanFieldsUnchanged: true, freshLiveDeliveryVerified: false, rows,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("D014_BLOCK_PALETTE_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
