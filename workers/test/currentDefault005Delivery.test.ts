import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("verifies -005 delivery and isolates the newly observed crossed-stripe loss offline", async () => {
  const guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const bytes = readFileSync(`${liveRoot}/summary.json`);
    const summary = JSON.parse(bytes.toString("utf8"));
    const checkpoints = readdirSync(liveRoot).filter(name => /summary\.json\.checkpoint-\d+\.json$/.test(name)).sort();
    for (const name of checkpoints) {
      const row = JSON.parse(readFileSync(`${liveRoot}/${name}`, "utf8"));
      expect(sha(JSON.stringify(row.snapshot))).toBe(row.snapshotSha256);
    }
    expect(JSON.parse(readFileSync(`${liveRoot}/${checkpoints.at(-1)}`, "utf8")).snapshot).toEqual(summary);
    const live = summary.currentDefaultE2E, result = live.result;
    expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
      cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(live).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 200, accounting: "known", diskRecovery: true });
    expect(result.bindingAttempts.map((a: {stage: string}) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary", "faceGeometry"]);
    expect(result.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true });
    expect(result.diagnostics.primaryDiagnostic.providerAttempts.find((p: {outcome: string}) => p.outcome === "failed"))
      .toMatchObject({ providerStatus: "FAILED_PRECONDITION", fallbackEligible: true });
    const actual = await decodePng(readFileSync(`${liveRoot}/skin.png`));
    expect(sha(readFileSync(`${liveRoot}/skin.png`))).toBe(live.png.sha256);
    expect(validateFinalAtlas(actual).ok).toBe(true);
    const saved = result.diagnostics.normalizedPrimary;
    // Missing rich context is synthetic; exact-atlas equality is independently
    // checked below before claiming the stored plan replay matches the live PNG.
    const analysis = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
      outfitPrompt: saved.observed.clothing, faceIdentityGeometry: result.diagnostics.geometry.acceptedGeometry });
    const style = buildFaceStyle(analysis, result.features);
    expect(style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    const beforePlan = result.analysis.skinPlan;
    expect(beforePlan.hairPlan.surfaceOnly).toBe(true);
    expect(beforePlan.headIdentityPlan.ownership.execution).toBe("resolved");
    expect(beforePlan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    expect(beforePlan.outfitPlan.upper).toMatchObject({ baseColor: "#273954", collarColor: "#273954", neckline: { innerVisible: false }, pattern: { kind: "vertical_stripe", color: "#eeeae1" } });
    const before = buildProceduralFallbackAtlas(result.features, style, beforePlan)!;
    expect(before).not.toBeNull();
    const exactReplay = sha(before.rgba) === sha(actual.rgba);
    const afterPlan = structuredClone(beforePlan);
    afterPlan.outfitPlan.upper.pattern = buildOutfitPlan(analysis).upper.pattern;
    expect(afterPlan.outfitPlan.upper.pattern).toMatchObject({ kind: "checker_block", construction: "crossed_bands", color: "#c5aa82" });
    const after = buildProceduralFallbackAtlas(result.features, style, afterPlan)!;
    expect(after).not.toBeNull();
    const craft = validateAtlasCraft(after, style, undefined, undefined, afterPlan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const allowed = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm].flatMap(p => [...Object.values(p.base), ...Object.values(p.overlay)]);
    const changed = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
      const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
      expect(allowed.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      expect(before.rgba[p * 4 + 3]).toBe(after.rgba[p * 4 + 3]);
    }
    const chinOnly = buildProceduralFallbackAtlas(result.features, { ...style, goateeHasMustache: false }, beforePlan)!;
    expect(chinOnly).not.toBeNull();
    const mustacheCells = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== chinOnly.rgba[p * 4 + c])) mustacheCells.push({ x: p % 64, y: Math.floor(p / 64) });
    const actualMustacheMatches = mustacheCells.map(({ x, y }) => {
      const i = (y * 64 + x) * 4;
      return { x, y, equalsEnabledReplay: [0, 1, 2, 3].every(c => actual.rgba[i + c] === before.rgba[i + c]),
        differsFromChinOnly: [0, 1, 2].some(c => actual.rgba[i + c] !== chinOnly.rgba[i + c]) };
    });
    const actualTop = CLASSIC_LAYOUT.head.overlay.top;
    let actualOuterTopPixels = 0;
    for (let y = 0; y < actualTop.h; y++) for (let x = 0; x < actualTop.w; x++)
      if (actual.rgba[((actualTop.y + y) * 64 + actualTop.x + x) * 4 + 3]) actualOuterTopPixels++;
    const replayMismatch = { head: 0, other: 0 };
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) replayMismatch[p < 1024 ? "head" : "other"]++;
    const root = mkdtempSync("evaluation-artifacts/current-default-005-delivery-20260926-");
    for (const [name, atlas] of [["actual-live", actual], ["stored-plan-replay", before], ["pattern-fixed-offline", after]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) {
        writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
        if (view.name === "front") writeFileSync(`${root}/${name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
      }
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ mode: "offline_followthrough_of_consumed_005_live", additionalProviderCalls: 0,
      checkpointsVerified: checkpoints.length, actualPngSha256: live.png.sha256, exactReplay, replayMismatch, mustacheCells, actualMustacheMatches, actualOuterTopPixels,
      hairSurfaceOnly: true, outerHairGroupCount: 0, changed, craft, finalAtlas: validateFinalAtlas(after),
      beforePattern: beforePlan.outfitPlan.upper.pattern, afterPattern: afterPlan.outfitPlan.upper.pattern,
      caution: "Fresh provider wording differs from -004; between-run pixel differences are not isolated code effects. New pattern correction is offline only.",
    }, null, 2), { flag: "wx" });
    console.info(`DELIVERY_ROOT ${root} exactReplay=${exactReplay} changed=${changed.length} mustache=${mustacheCells.length}`);
    expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(bytes);
    expect(guard).not.toHaveBeenCalled();
  } finally { guard.mockRestore(); }
});
