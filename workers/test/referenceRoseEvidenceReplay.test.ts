// Offline saved-plan counterfactual; never reconstruct missing primary fields.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { resolveObservedFloralPattern } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { freshAuditOutput } from "./freshAuditOutput";
import * as layeredCrown from "../src/referenceLayeredCrown";

const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-floral-20261008-004";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("reproduces the actual 004 PNG then restores only its observed rose-pattern plans", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const summaryBytes = readFileSync(`${sourceRoot}/summary.json`);
    const run = JSON.parse(summaryBytes.toString()).currentDefaultE2E;
    const trace = run.result.propagationTrace;
    const saved: SkinPlan = trace.skinPlan.skinPlan;
    const style: FaceStyle = trace.injectedParameters.faceStyle;
    const design: ReferenceStylePlan = trace.referenceStyle.design;
    const original = JSON.stringify(trace);
    const actual = await decodePng(readFileSync(`${sourceRoot}/skin.png`));
    expect(sha(actual.rgba)).toBe(run.png.decodedRgbaSha256);
    const beforeSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, saved)!;
    const before = composeReferenceStyleAtlas(beforeSource, saved, design, style);
    const historical = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
    try { expect(composeReferenceStyleAtlas(beforeSource, saved, design, style).atlas.rgba).toEqual(actual.rgba); }
    finally { historical.mockRestore(); }
    // The later layered-crown relief removes only two front silhouette cells
    // and their top seam partners. Isolate that migration from rose delivery.
    const crownBoundary = new Set<number>();
    const front = CLASSIC_LAYOUT.head.overlay.front, top = CLASSIC_LAYOUT.head.overlay.top;
    for (let x = 0; x < front.w; x++) if (!layeredCrown.retainLayeredCrownAccent("front", x, 0, saved, design, style)) {
      crownBoundary.add(front.y * 64 + front.x + x);
      crownBoundary.add((top.y + top.h - 1) * 64 + top.x + x);
    }
    let crownMigrationPixels = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
      expect(crownBoundary.has(i), `unrelated crown migration:${i}`).toBe(true);
      expect(actual.rgba[i * 4 + 3]).toBe(255);
      expect([...before.atlas.rgba.slice(i * 4, i * 4 + 4)]).toEqual([0, 0, 0, 0]);
      crownMigrationPixels++;
    }
    expect(crownMigrationPixels).toBe(crownBoundary.size);
    expect(crownMigrationPixels).toBe(4);

    expect(trace.renderAnalysis.visibleRegions).toMatchObject({ upperBody: true, lowerBody: true });
    const fixed = structuredClone(saved), clothing = trace.renderAnalysis.observed.clothing;
    fixed.outfitPlan.upper.pattern = resolveObservedFloralPattern(saved.outfitPlan.upper.pattern, clothing, true);
    fixed.outfitPlan.lower.pattern = resolveObservedFloralPattern(saved.outfitPlan.lower.pattern, clothing, false);
    expect(fixed.outfitPlan.upper.pattern).toMatchObject({ motif: "floral", surfaceParts: ["rightArm"], color: "#b53a35" });
    expect(fixed.outfitPlan.lower.pattern).toMatchObject({ motif: "floral", surfaceParts: ["rightLeg"], color: "#b53a35" });
    // No invented sleeve length, new geometry, hidden prompt or changed family.
    expect(fixed.outfitPlan.upper.rightSleeve).toEqual(saved.outfitPlan.upper.rightSleeve);
    const afterSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, fixed)!;
    const after = composeReferenceStyleAtlas(afterSource, fixed, design, style);
    expect(after.diagnostic.constraints.ok).toBe(true);
    const craft = validateReferenceAtlasCraft(after.atlas, afterSource, fixed, style,
      buildReferenceCraftPlan(fixed, design, after));
    expect(craft.ok, craft.problems.join(",")).toBe(true);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(composeReferenceStyleAtlas(afterSource, fixed, design, style).atlas.rgba).toEqual(after.atlas.rgba);
    const allowed = new Set<number>();
    for (const part of ["rightArm", "rightLeg"] as const) {
      const r = CLASSIC_LAYOUT[part].base.front;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) allowed.add((r.y + y) * 64 + r.x + x);
    }
    const changed: number[] = [];
    for (let p = 0; p < 64 * 64; p++) {
      if ([0, 1, 2, 3].some(ch => before.atlas.rgba[p * 4 + ch] !== after.atlas.rgba[p * 4 + ch])) {
        expect(allowed.has(p), `unexpected_pixel:${p}`).toBe(true);
        changed.push(p);
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    const counts: Record<string, number> = {};
    const redInkPixels: Record<string, number> = {};
    for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      const r = CLASSIC_LAYOUT[part].base.front;
      counts[part] = changed.filter(p => p % 64 >= r.x && p % 64 < r.x + r.w && Math.floor(p / 64) >= r.y && Math.floor(p / 64) < r.y + r.h).length;
      redInkPixels[part] = 0;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * 64 + r.x + x) * 4, rgba = after.atlas.rgba;
        if (rgba[i] > rgba[i + 1] * 1.7 && rgba[i] > rgba[i + 2] * 1.7) redInkPixels[part]++;
      }
    }
    expect(counts.rightArm).toBeGreaterThan(0); expect(counts.rightLeg).toBeGreaterThan(0);
    expect(counts.body + counts.leftArm + counts.leftLeg).toBe(0);
    expect(redInkPixels.rightArm).toBeGreaterThan(0);
    expect(redInkPixels.rightLeg).toBeGreaterThan(0);
    expect(redInkPixels.body + redInkPixels.leftArm + redInkPixels.leftLeg).toBe(0);
    expect(JSON.stringify(trace)).toBe(original);
    expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(summaryBytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/reference-rose-evidence-offline-20261008-");
    for (const [name, atlas] of [["before", before.atlas], ["after", after.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas)) writeFileSync(`${output}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ context: "saved_plan_fixed_family_counterfactual_not_new_live",
      sourceRun: run.runId, sourceSummarySha256: sha(summaryBytes), historicalPngExactReplay: true,
      beforeMatchesLivePng: false, crownMigrationPixels, unrelatedCrownMigrationPixels: 0,
      noFullAnalysisReconstruction: true, familyAndSleevesUnchanged: true,
      beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba),
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", changedPixels: changed.length, counts, redInkPixels,
      sleeveMotifVisible: redInkPixels.rightArm > 0, recordedSleeve: saved.outfitPlan.upper.rightSleeve,
      upperPattern: fixed.outfitPlan.upper.pattern, lowerPattern: fixed.outfitPlan.lower.pattern,
      craftPass: craft.ok, atlasPass: true, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_ROSE_EVIDENCE_REPLAY ${output}`);
  } finally { network.mockRestore(); }
}, 60000);
