// Consumed H-004 is immutable. These tests never import a remote runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { preserveObservedWristCuffs } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { measureReferenceAccessoryRetention } from "../src/referenceOutfitRetention";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { withHistoricalCalmMouth } from "./historicalHairMaterial";
import { assertHistoricalSingletonEyePresentation } from "./historicalSingletonEyePresentation";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-004";
const summaryBytes = readFileSync(`${root}/summary.json`);
const summary = JSON.parse(summaryBytes.toString());
const run = summary.currentDefaultE2E, trace = run.result.propagationTrace;
const saved: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers all checkpoints, one POST and the actual deadline-eligible fallback", () => {
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(32);
  for (const name of names) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "72e45f899fc926b7aceb06dce7ce361f", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 200, elapsedMs: 68069, diskRecovery: true });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "threw", httpStatus: null, elapsedMs: 45000 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 19460 }),
  ]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    origin: "LOCAL_DEADLINE", providerStatus: "DEADLINE_EXCEEDED", fallbackEligible: true,
  }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(run.result.diagnostics.localization.status).toBe("MISSING");
  expect(run.result.diagnostics.geometry).toBeNull();
});

it("verifies delivered sleeves and records the actual wrist-plan omission without claiming overall completion", async () => {
  const bytes = readFileSync(`${root}/skin.png`), image = await decodePng(bytes);
  expect(sha(bytes)).toBe("530eea9b626b4e5cf37b92c1bf6d9d3314e4483bcce06b3933bd68439771d04b");
  expect(sha(image.rgba)).toBe(run.png.decodedRgbaSha256);
  expect([image.width, image.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(image)).toEqual({ ok: true, problems: [] });
  expect(run.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true,
    generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  expect(trace.replay).toMatchObject({ renderAnalysisMatch: true, sourcePlanMatch: true,
    featuresMatch: true, selectedDesignMatch: true, finalAtlasMatch: true });
  expect(trace.primary.observed.accessories).toContain("pink fabric cuffs on both wrists");
  expect(trace.renderAnalysis.observed.accessories).toBe(trace.primary.observed.accessories);
  expect(saved.outfitPlan.accessories.some(a => a.kind === "wrist_cuff")).toBe(false);
  for (const side of ["leftSleeve", "rightSleeve"] as const)
    expect(saved.outfitPlan.upper[side]).toMatchObject({ length: "short", color: "#c8798c", source: "observed" });
  for (const side of ["leftArm", "rightArm"] as const) {
    const r = CLASSIC_LAYOUT[side].base.front;
    const colors = Array.from({ length: 4 }, (_, y) => Array.from({ length: r.w }, (_, x) => {
      const p = ((r.y + y) * 64 + r.x + x) * 4;
      return `#${[...image.rgba.slice(p, p + 3)].map(v => v.toString(16).padStart(2, "0")).join("")}`;
    })).flat();
    expect(colors).toContain("#c8798c");
  }
  // Separate known evidence boundary, not fixed as part of wrist localization.
  expect(trace.primary.observed.clothing).toContain("pink bow at the center of the neckline");
  expect(saved.outfitPlan.accessories.find(a => a.kind === "bow")?.color).toBe("#eeeae1");
  expect(trace.selectedFamilies.hair).toBe("long_straight_with_bangs");
});

it.each(["pink fabric cuffs on both wrists", "blue ruffled cuffs around the two wrists"])(
  "accepts explicit paired wrist localization: %s", text => {
    const a = makeAnalysis(); a.visibleRegions.upperBody = true; a.observed.clothing = "a white top"; a.observed.accessories = text;
    expect(preserveObservedWristCuffs(saved.outfitPlan, a).accessories.at(-1)).toMatchObject({
      kind: "wrist_cuff", color: text.startsWith("pink") ? "#c8798c" : "#416b9d", source: "observed", side: "center",
    });
  });

it.each(["pink cuffs on one wrist", "pink cuffs on wrists", "pink cuffs on the left wrist", "no pink cuffs on both wrists",
  "possibly pink cuffs on both wrists", "pink cuffs on both wrists are hidden", "pink and blue cuffs on both wrists",
  "pink bow and cuffs on both wrists", "pink cuffs on both wrists with white stripes",
  "pink cuffs on both wrists; blue wrist cuffs", "pink cuffs on both wrists; cuffs on wrists of unknown color"])(
  "does not infer pairing, palette or contradictory cuff evidence: %s", text => {
    const a = makeAnalysis(); a.visibleRegions.upperBody = true; a.observed.clothing = "a white top"; a.observed.accessories = text;
    expect(preserveObservedWristCuffs(saved.outfitPlan, a)).toBe(saved.outfitPlan);
  });

it("isolates the actual same-run cuff loss and changes only wrist cells in an offline counterfactual", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const render = (plan: SkinPlan) => {
      const baseline = buildProceduralSourceAtlas(features, style, plan)!;
      const r = withHistoricalCalmMouth(() => renderReferencePrimaryAtlas(baseline, plan, a, style));
      if (!r.ok) throw new Error(r.reason);
      expect(r.summary.craftValidation).toBe("pass");
      return r.atlas;
    };
    const before = render(saved);
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    const historicalEyeChanges = assertHistoricalSingletonEyePresentation(before, historical,
      buildProceduralSourceAtlas(features, style, saved)!, saved, style, trace.referenceStyle.design);
    const fixed = { ...saved, outfitPlan: preserveObservedWristCuffs(saved.outfitPlan, a) };
    expect(fixed.outfitPlan.upper).toEqual(saved.outfitPlan.upper);
    expect(fixed.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
    const after = render(fixed);
    expect(render(fixed).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    const retention = measureReferenceAccessoryRetention(after, fixed.outfitPlan, features.skinColor);
    expect(retention.valid).toBe(true);
    const allowed = new Set<number>();
    for (const part of ["leftArm", "rightArm"] as const) for (const layer of ["base", "overlay"] as const)
      for (const face of ["front", "back", "left", "right"] as const) {
        const r = CLASSIC_LAYOUT[part][layer][face];
        for (let x = 0; x < r.w; x++) allowed.add((r.y + r.h - 3) * 64 + r.x + x);
      }
    const changed = [...Array(4096).keys()].filter(p => [0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c]));
    expect(changed.length).toBe(32); expect(changed.every(p => allowed.has(p))).toBe(true);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(summaryBytes);
    const output = freshAuditOutput("evaluation-artifacts/observed-wrist-localization-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_plan_counterfactual_not_live", sourceRun: run.runId,
      sourceSummarySha256: sha(summaryBytes), beforeMatchesLive: false, providerCalls: 0,
      historicalEyeChanges, outsideHistoricalEyeChangesExact: true,
      historicalCalmMouthPreservedToIsolateWristChange: true,
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", cue: "pink fabric cuffs on both wrists",
      changedPixels: changed.length, outsideWristDiff: 0, beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba),
      accessoryRetention: retention, craftPass: true, atlasValid: true }, null, 2), { flag: "wx" });
    console.info(`WRIST_LOCALIZATION ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);

it("confirms graceful teardown, finalization and unchanged production config", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
  expect(summary.shutdownLatch.phase).toBe("finalized");
});
