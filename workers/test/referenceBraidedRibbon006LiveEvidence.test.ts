// Read-only verification of consumed H-006. Never imports a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildReferencePairedHair, buildReferencePairedDrapePlan } from "../src/referencePairedHair";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { measureReferenceAccessoryRetention } from "../src/referenceOutfitRetention";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-006";
const bytes = readFileSync(`${root}/summary.json`);
const summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers the consumed checkpoint chain and bounded eligible provider sequence", () => {
  expect(sha(bytes)).toBe("cf7b7f8b05a26ce3d9b3ee82bb265bc811427e7105b2045141b39b819d3cde6f");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "5a61e13a6ebb4985c76aa6faa5cc4d05", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 17570, diskRecovery: true });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 1028 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 13048 }),
  ]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    providerStatus: "FAILED_PRECONDITION", fallbackEligible: true, fallbackReason: "provider_failed_precondition",
  }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(run.result.diagnostics.geometry).toBeNull();
});

it("links valid final PNG, delivered hair palette and neck bow to the same run", async () => {
  const png = readFileSync(`${root}/skin.png`), image = await decodePng(png);
  expect(sha(png)).toBe("9c784c6b851e69a4c499e77757f5c93284810c8377a8cd33551aa0a33b873f5f");
  expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([image.width, image.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(trace.referenceStyle).toMatchObject({ status: "reference_style_accepted", craftValidation: "pass" });
  expect(trace.primary.observed.hair).toContain("light-brown hair");
  expect(trace.injectedParameters.features.hairColor).toBe("#96725d");
  expect(trace.primary.observed.clothing).toContain("pink bow at the center of the neckline");
  expect(saved.outfitPlan.accessories).toContainEqual(expect.objectContaining({ kind: "bow", color: "#c8798c" }));
  const colors = (part: "head" | "body", layer: "base" | "overlay") => {
    const r = CLASSIC_LAYOUT[part][layer].front;
    return Array.from({ length: r.w * r.h }, (_, i) => {
      const p = ((r.y + Math.floor(i / r.w)) * 64 + r.x + i % r.w) * 4;
      return [...image.rgba.slice(p, p + 3)].map(v => v.toString(16).padStart(2, "0")).join("");
    });
  };
  expect(colors("head", "base")).toContain("96725d");
  // Source bow uses light/shadow ramp cells, not necessarily its exact base hex.
  const retention = measureReferenceAccessoryRetention(image, saved.outfitPlan, trace.injectedParameters.features.skinTone);
  expect(retention.valid).toBe(true);
});

it("does not claim unobserved wrist delivery or quiet-mouth eligibility for full rose lips", () => {
  expect(trace.primary.observed.accessories).not.toMatch(/wrist/i);
  expect(saved.outfitPlan.accessories.some(a => a.kind === "wrist_cuff")).toBe(false);
  expect(trace.injectedParameters.faceStyle).toMatchObject({ lipFullness: "full", lipColor: "rose" });
  expect(trace.injectedParameters.familyDesign.face.mouthCells).toBe(0);
});

it("repairs only the evidenced paired junction and drape in an offline H-006 counterfactual", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const original = JSON.stringify(saved);
    const analysis = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const style = trace.injectedParameters.faceStyle, design = trace.referenceStyle.design;
    const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, saved)!;
    const replay = renderReferencePrimaryAtlas(baseline, saved, analysis, style);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.reason);
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    const paired = buildReferencePairedHair(saved, design);
    const drapePlan = buildReferencePairedDrapePlan(saved, design, style), drape = drapePlan.points;
    const composition = composeReferenceStyleAtlas(baseline, saved, design, style);
    expect(design.hair.family).toBe("twin_braids");
    expect(design.drape.eligible).toBe(true);
    expect(paired.status).toBe("authored");
    expect(trace.primary.observed.hair).toContain("two small braids on either side of the face that drape over the chest");
    expect(saved.hairPlan.headMask.semanticSilhouette).toMatchObject({ endpointCue: "chest", sideEndpointCue: "jaw" });
    expect(drape).toHaveLength(22);
    expect(drapePlan.junctions).toEqual([{ face: "front", x: 0, y: 7, drapeGroup: "left_lock" },
      { face: "front", x: 7, y: 7, drapeGroup: "right_lock" }]);
    expect(composition.diagnostic.drapeCells).toBe(22);
    const allowed = new Set([...drape.map(p => ({ ...p, part: "body" as const })),
      ...drapePlan.junctions.map(p => ({ ...p, part: "head" as const }))].map(p => {
      const r = CLASSIC_LAYOUT[p.part].base.front;
      return (r.y + p.y) * 64 + r.x + p.x;
    }));
    const changed: number[] = [];
    for (let p = 0; p < 4096; p++) {
      expect(replay.atlas.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if (replay.atlas.rgba.slice(p * 4, p * 4 + 4).some((v, i) => v !== before.rgba[p * 4 + i])) changed.push(p);
    }
    expect(new Set(changed)).toEqual(allowed);
    expect(changed).toHaveLength(24);
    expect(validateFinalAtlas(replay.atlas)).toEqual({ ok: true, problems: [] });
    const missingFrontRoots = [0, 7].filter(x => !saved.headIdentityPlan.ownership!.cells.some(c =>
      c.face === "front" && c.layer === "base" && c.owner === "hair_base" && c.x === x && c.y === 7));
    expect(missingFrontRoots).toEqual([0, 7]);
    expect(JSON.stringify(saved)).toBe(original);
    expect(network).not.toHaveBeenCalled();
    const out = freshAuditOutput("evaluation-artifacts/reference-paired-junction-006-counterfactual-20261010-");
    writeFileSync(`${out}/before-live.png`, readFileSync(`${root}/skin.png`), { flag: "wx" });
    writeFileSync(`${out}/after-offline.png`, await encodePng(replay.atlas), { flag: "wx" });
    for (const view of renderSkinViews(before))
      writeFileSync(`${out}/before-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    for (const view of renderSkinViews(replay.atlas))
      writeFileSync(`${out}/${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRun: run.runId, sourceSummarySha256: sha(bytes),
      livePngSha256: run.png.sha256, evidenceKind: "offline_counterfactual_not_live", exactReplay: false,
      changedPixels: changed.length, outsideAuthorizedDrapeDelta: 0, selectedFamily: design.hair.family, paired,
      drapeCells: drape.length, junctions: drapePlan.junctions, missingFrontRoots, endpoint: saved.hairPlan.headMask.semanticSilhouette,
      primaryPairedChestEvidence: true, sourcePlanUnchanged: true, externalCalls: 0,
      earliestBoundary: "PAIRED_DRAPE_SUPPRESSED_BY_FACE_FRAMING_FOUNDATION",
      note: "Source-supported long paired locks receive two inner junctions independently of the unchanged jaw-length face-framing cue; all other pixels remain identical to consumed live H-006." }, null, 2));
    console.log("H006_REVIEW", out);
  } finally { network.mockRestore(); }
});

it("observes complete graceful teardown without claiming independent remote deletion", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
