// Immutable same-run evidence. Offline only, no provider/source-image access.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-013";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());

it("recovers D013 success, validation and graceful cleanup independently of the runner exit", () => {
  expect(sha(bytes)).toBe("f6b5f27266e8bebb9ed0b05552838d23054db779af0289106f7274ed68869a61");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(files).toHaveLength(57);
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
  expect(e).toMatchObject({ runId: "8af98f3bfaad70166e6677e03bc797e7", generationPosts: 1,
    providerRetry: 0, httpStatus: 200, elapsedMs: 52715, accounting: "known", diskRecovery: true });
  expect(r.bindingAttempts).toHaveLength(2);
  expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 });
  expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 48118, deadlineMs: 60000 });
  const attempts = r.diagnostics.primaryDiagnostic.providerAttempts;
  expect(attempts).toContainEqual(expect.objectContaining({ provider: "gemini", providerStatus: "FAILED_PRECONDITION", fallbackEligible: true }));
  expect(attempts).toContainEqual(expect.objectContaining({ provider: "workers_ai", outcome: "completed", deadlineTimerFired: false,
    configuredDeadlineMs: 60000, providerSchemaValidation: "passed", strictValidation: "passed" }));
  expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
    strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
  expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "malformed_normalized_bounds" });
  expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
  const old = JSON.parse(readFileSync(root.replace(/013$/, "012") + "/summary.json", "utf8")).currentDefaultE2E;
  expect(e.preprocessing).toEqual(old.preprocessing);
  expect(Object.keys(e.fixedHashes).filter(f => e.fixedHashes[f] !== old.fixedHashes[f]).map(f => f.replaceAll("\\", "/")))
    .toEqual(["src/gemini.ts"]);
});

it("replays the actual D013 PNG and separates preserved materials from the remaining front-lock loss", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const e = s.currentDefaultE2E, t = e.result.propagationTrace, p = t.skinPlan.skinPlan;
    const f = t.injectedParameters.features, style = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(f, style, p)!;
    const local = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
    const png = readFileSync(`${root}/skin.png`), actual = await decodePng(png);
    expect(sha(png)).toBe("d419d8221d727af1a008cc89861336101f87d173b4956610c1a5a4cafe810f76");
    expect([actual.width, actual.height]).toEqual([64, 64]); expect(local.atlas.rgba).toEqual(actual.rgba);
    expect(sha(actual.rgba)).toBe(t.finalPng.rgbaSha256); expect(validateFinalAtlas(actual).ok).toBe(true);
    expect(validateReferenceAtlasCraft(actual, base, p, style, buildReferenceCraftPlan(p, t.referenceStyle.design, local)).ok).toBe(true);
    expect(f.hatColor).toBe("#2f7775");
    expect(p.outfitPlan.upper.pattern.blockColors).toEqual(["#d9a5af", "#a38cab", "#a9d5eb", "#e1c87d"]);
    expect(p.outfitPlan.upper.leftSleeve.length).toBe("long"); expect(p.outfitPlan.upper.rightSleeve.length).toBe("long");
    expect(t.primary.observed.hair).toContain("The hair frames the face and falls past the shoulders down to the chest/waist area.");
    expect(t.renderAnalysis.observed.hair).toBe(t.primary.observed.hair);
    expect(t.referenceStyle.design.drape.eligible).toBe(false);
    expect(local.diagnostic.looseHair.points.filter(c => c.face === "front")).toEqual([]);
    const out = freshAuditOutput("evaluation-artifacts/reference-teal-hat-013-offline-review-20261011-");
    for (const view of renderSkinViews(actual)) writeFileSync(`${out}/${view.name}.png`,
      await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, summarySha256: sha(bytes), runId: e.runId,
      checkpointCount: 57, checkpointIntegrity: true, exactAtlasReplay: true, craftPass: true, atlasPass: true,
      pngSha256: sha(png), rgbaSha256: sha(actual.rgba), selectedFamilies: t.selectedFamilies,
      observedHair: t.primary.observed.hair, headwearColor: f.hatColor, checkerPalette: p.outfitPlan.upper.pattern.blockColors,
      leftSleeve: p.outfitPlan.upper.leftSleeve.length, rightSleeve: p.outfitPlan.upper.rightSleeve.length,
      nextBoundary: "NORMALIZED_PRESERVED_SELECTION_LOST", frontHairPoints: 0,
      livePrimaryCalls: 2, liveGeometryCalls: 0, retry: 0, offlineProviderCalls: 0,
      elapsedMs: e.elapsedMs, gemmaMs: 48118, fixedDeadlineMs: 60000,
      extendedDeadlineNeededThisRun: false, referenceRendererCompleted: true,
      productionSucceeded: true, gracefulCleanup: true,
      remoteDeletionIndependentlyConfirmed: s.serverSidePreviewDeletionIndependentlyConfirmed,
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("D013_EXACT_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
