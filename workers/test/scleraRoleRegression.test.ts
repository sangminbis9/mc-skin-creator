import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { makeAnalysis } from "./helpers";
import { historicalHairMaterialPlan } from "./historicalHairMaterial";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009";

it("bounds explicit sclera palette changes without altering plans, other roles, ownership or body", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const frozen: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
    const liveBytes = readFileSync(`${liveRoot}/summary.json`), pngBytes = readFileSync(`${liveRoot}/skin.png`);
    const live = JSON.parse(liveBytes.toString()).currentDefaultE2E;
    expect(hash(pngBytes)).toBe(live.png.sha256);
    const entries = frozen.map(fixture => {
      const { analysis: input } = strictBoundaryAnalysisFromAnnotation(fixture);
      if (fixture.existing) input.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const analysis = normalizeAnalysisForRendering(input);
      return { id: fixture.id, calibrated: !!fixture.existing, analysis,
        features: refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone)) };
    });
    // The saved primary is allowlisted, not the full provider response. Missing
    // fields are explicit helper context; the live full face plan is checked below.
    const primary = live.result.diagnostics.normalizedPrimary;
    entries.push({ id: "live-009-replay", calibrated: false, features: live.result.features,
      analysis: normalizeAnalysisForRendering(makeAnalysis({ ...primary,
        identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing, negativePrompt: "",
        faceIdentityGeometry: live.result.diagnostics.geometry.acceptedGeometry })) });
    const baselineRoot = process.env.SCLERA_ROLE_BASELINE_ROOT
      ?? "evaluation-artifacts/sclera-role-regression-20260927-aUHQfq";
    const baseline = baselineRoot ? JSON.parse(readFileSync(`${baselineRoot}/results.json`, "utf8")) : null;
    const root = mkdtempSync("evaluation-artifacts/sclera-role-regression-20260927-");
    const cases = [];
    for (const entry of entries) {
      // Isolate the older sclera comparison from the reviewed later foundation
      // material migration. Reverse only its exact roles, retaining old hashes.
      const plan = historicalHairMaterialPlan(buildSkinPlan(entry.analysis));
      // Keep this independent sclera comparison on its immutable outfit palette.
      // current009PatternPalette separately tests the later coordinated-list fix.
      if (entry.id === "live-009-replay") {
        // The later coordinated two-band representation did not exist in the
        // frozen sclera-only baseline. Assert that exact addition before undoing
        // it here; current plaid retention has its own non-projected regression.
        expect(plan.outfitPlan.upper.pattern.crossedBandColors).toEqual(["#c5aa82", "#d5af3f"]);
        delete plan.outfitPlan.upper.pattern.crossedBandColors;
        plan.outfitPlan.upper.pattern.color = live.result.analysis.skinPlan.outfitPlan.upper.pattern.color;
      }
      const style = buildFaceStyle(entry.analysis, entry.features, plan.hairPlan);
      const atlas = buildProceduralFallbackAtlas(entry.features, style, plan);
      expect(atlas, entry.id).not.toBeNull(); if (!atlas) throw new Error("atlas_rejected");
      const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
      expect(craft.ok, `${entry.id}: ${JSON.stringify(craft)}`).toBe(true);
      expect(validateFinalAtlas(atlas).ok, entry.id).toBe(true);
      const planHash = hash(JSON.stringify(plan)), sclera = plan.facePixelPlan.pixels.filter(p => p.role === "sclera");
      const face = CLASSIC_LAYOUT.head.base.front;
      const indices = new Set(sclera.map(p => (face.y + p.y) * 64 + face.x + p.x));
      const changed: { x: number; y: number; before: number[]; after: number[] }[] = [];
      if (baseline) {
        const prior = baseline.cases.find((c: { id: string }) => c.id === entry.id);
        expect(prior).toBeDefined(); expect(planHash, entry.id).toBe(prior.planHash);
        expect(hash(JSON.stringify(style))).toBe(prior.styleHash);
        expect(hash(JSON.stringify(entry.features))).toBe(prior.featuresHash);
        const before = await decodePng(readFileSync(`${baselineRoot}/${entry.id}.png`));
        expect(hash(before.rgba)).toBe(prior.rgbaHash);
        for (let p = 0; p < 4096; p++) {
          expect(atlas.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
          if ([0, 1, 2].some(c => before.rgba[p * 4 + c] !== atlas.rgba[p * 4 + c])) {
            expect(indices.has(p), `${entry.id}: non-sclera change at ${p % 64},${Math.floor(p / 64)}`).toBe(true);
            changed.push({ x: p % 64, y: Math.floor(p / 64), before: Array.from(before.rgba.slice(p * 4, p * 4 + 4)), after: Array.from(atlas.rgba.slice(p * 4, p * 4 + 4)) });
          }
        }
        expect(changed.length, entry.id).toBe(sclera.length);
      }
      if (entry.id === "live-009-replay") {
        expect(plan.facePixelPlan).toEqual(live.result.analysis.skinPlan.facePixelPlan);
        const actual = await decodePng(pngBytes);
        for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) {
          if (baseline && indices.has(y * 64 + x)) continue;
          const at = (y * 64 + x) * 4;
          expect(Array.from(atlas.rgba.slice(at, at + 4))).toEqual(Array.from(actual.rgba.slice(at, at + 4)));
        }
      }
      writeFileSync(`${root}/${entry.id}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${root}/${entry.id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
      cases.push({ id: entry.id, calibrated: entry.calibrated, planHash, styleHash: hash(JSON.stringify(style)),
        featuresHash: hash(JSON.stringify(entry.features)), rgbaHash: hash(atlas.rgba), scleraCells: sclera.length, changed, craft });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, baselineRoot: baselineRoot ?? null,
      liveSummaryHash: hash(liveBytes), livePngHash: hash(pngBytes), cases,
      limitation: "Offline palette replay; not fresh provider evidence, pose correction or source likeness score." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(liveBytes);
    expect(readFileSync(`${liveRoot}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`SCLERA_REGRESSION_ROOT ${root}`);
  } finally { network.mockRestore(); }
}, 60_000);
