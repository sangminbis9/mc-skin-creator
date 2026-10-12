import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng } from "../src/png";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";

it("checks retained eight-cue face trace and actual beard/mustache pixels without another live request", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const s = JSON.parse(bytes.toString()).currentDefaultE2E, r = s.result;
    const primary = r.diagnostics.normalizedPrimary, plan = r.analysis.skinPlan;
    const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-020-qualified-hair-before-20260928-XOfeL5/baseline.json", "utf8"));
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(baseline.summarySha256).toBe(sha(bytes)); expect(baseline.pngSha256).toBe(sha(png));
    const actual = await decodePng(png);
    expect(buildProceduralFallbackAtlas(r.features, baseline.style, plan)!.rgba).toEqual(actual.rgba);
    const cues = primary.faceMeasurementEvidence.cues;
    expect(Object.keys(cues)).toHaveLength(8);
    for (const [key, cue] of Object.entries(cues)) {
      expect(plan.facePixelPlan.layout.measurementTrace[key]).toMatchObject({
        ...(cue as { value: string; confidence: number; provenance: string }), selected: "categorical_grammar",
      });
    }
    expect(plan.facePixelPlan.layout).toMatchObject({ eyeSpacingTopology: "medium", eyeFootprintTopology: "medium",
      eyeOpenness: "readable", eyeTopology: "readable_iris", browDistanceTopology: "normal", browSlopeTopology: "straight",
      mouthWidth: 3, mouthOpening: "closed", mouthExpressionTopology: "neutral" });
    expect(Object.values(plan.facePixelPlan.layout.geometryUsage).every(v => v === false)).toBe(true);
    expect(primary.sourceSelection.portraitRegion).toBeNull(); expect(r.diagnostics.geometry).toBeNull();
    expect(r.diagnostics.localization.status).toBe("MISSING");
    expect(baseline.style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    const noMustache = buildProceduralFallbackAtlas(r.features, { ...baseline.style, goateeHasMustache: false }, plan)!;
    const noBeard = buildProceduralFallbackAtlas(r.features, { ...baseline.style, facialHair: "none", goateeHasMustache: false }, plan)!;
    const changed = (rgba: Uint8Array) => {
      const cells: { x: number; y: number }[] = [];
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => rgba[p * 4 + c] !== actual.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        // Removing all beard also changes existing cheek/jaw/overlay shading;
        // it is not a two-cell paint ablation. All effects must stay on the head.
        expect(y).toBeLessThan(16);
        cells.push({ x, y });
      }
      return cells;
    };
    const mustacheCells = changed(noMustache.rgba), beardCells = changed(noBeard.rgba);
    const chinOnly = facialHairBaseFootprint({ facialHair: "goatee", goateeHasMustache: false });
    const directMustache = facialHairBaseFootprint(baseline.style)
      .filter(p => !chinOnly.some(c => c.x === p.x && c.y === p.y)).map(p => ({ x: p.x + 8, y: p.y + 8 }));
    const irisCells = plan.facePixelPlan.pixels.filter((p: { role: string }) => p.role === "iris")
      .map((p: { x: number; y: number }) => ({ x: p.x + 8, y: p.y + 8 }));
    // skinPack.localContrast samples cardinal neighbours, including authored
    // facial hair. Record its iris color adaptation separately from beard paint.
    for (const cell of directMustache) expect(mustacheCells).toContainEqual(cell);
    for (const cell of mustacheCells) expect([...directMustache, ...irisCells]).toContainEqual(cell);
    expect(mustacheCells.length).toBeGreaterThan(0); expect(beardCells.length).toBeGreaterThan(mustacheCells.length);
    for (const cell of plan.facePixelPlan.pixels.filter((p: { role: string }) => ["sclera", "brow"].includes(p.role))) {
      expect(beardCells.some(c => c.x === cell.x + 8 && c.y === cell.y + 8)).toBe(false);
    }
    expect(primary.observed.clothing).toContain("checkered pattern");
    expect(plan.outfitPlan.upper.pattern.kind).toBe("checker_block");
    const out = mkdtempSync("evaluation-artifacts/current-020-remaining-face-boundary-20260928-");
    writeFileSync(`${out}/results.json`, JSON.stringify({ mode: "offline_actual_pixel_ablation", providerCalls: 0,
      summarySha256: sha(bytes), pngSha256: sha(png), retainedMeasurementCues: 8, cueTraceLoss: 0,
      exactLiveReplay: true, directMustache, mustacheCells, beardCells, otherAtlasRegionsChanged: 0,
      irisContrastAffected: mustacheCells.filter(c => irisCells.some((i: { x: number; y: number }) => i.x === c.x && i.y === c.y)),
      remaining: { localization: "MISSING", geometryUsed: false,
        pattern: "Provider accepted checkered squares; source has finer multicolor stripes. No downstream topology loss established.",
        freshLiveVerification: "Tan and qualified visible-scalp hair corrections postdate -020. New approval required." },
      conclusion: "No additional evidence-backed facial cue loss reproduced. Do not fabricate geometry, alter source labels, or reopen aperture experiments." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info(`REMAINING_FACE_BOUNDARY ${out}`);
  } finally { network.mockRestore(); }
});
