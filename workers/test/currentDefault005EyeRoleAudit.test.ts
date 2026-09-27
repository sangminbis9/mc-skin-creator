import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng } from "../src/png";
import { buildFacialContrastPlan, type FacialRgb } from "../src/facialContrast";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { FacePixelPlan } from "../src/identityPlans";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const luminance = (rgb: number[]) => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
const rgb = (hex: string): FacialRgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as FacialRgb;

it("audits the actual -005 sclera role without changing geometry or production palettes", async () => {
  const guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005";
    const savedBytes = readFileSync(`${liveRoot}/summary.json`);
    const run = JSON.parse(savedBytes.toString()).currentDefaultE2E;
    const result = run.result;
    const plan = result.analysis.skinPlan.facePixelPlan as FacePixelPlan;
    const actualBytes = readFileSync(`${liveRoot}/skin.png`);
    expect(sha(actualBytes)).toBe(run.png.sha256);
    const actual = await decodePng(actualBytes);
    // Synthetic omitted rich context is used only to reproduce palette inputs.
    // Actual atlas colors below remain the authoritative live observations.
    const saved = result.diagnostics.normalizedPrimary;
    const analysis = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
      outfitPrompt: saved.observed.clothing, faceIdentityGeometry: result.diagnostics.geometry.acceptedGeometry });
    const style = buildFaceStyle(analysis, result.features);
    const skin = rgb(result.features.skinTone), hair = rgb(result.features.hairColor);
    const contrast = buildFacialContrastPlan(skin, hair, {
      eyeColor: rgb(style.eyeColor!), lipColor: style.lipColor ?? "natural",
      irisLightness: style.irisLightness ?? "medium", contrastBoost: style.faceContrastBoost === true,
    }, plan.salience);
    const candidate = { ...actual, rgba: new Uint8Array(actual.rgba) };
    const face = CLASSIC_LAYOUT.head.base.front, overlay = CLASSIC_LAYOUT.head.overlay.front;
    const observations = [];
    const eyePixels = plan.pixels.filter(p => p.role === "sclera" || p.role === "iris");
    for (const pixel of eyePixels) {
      const at = ((face.y + pixel.y) * 64 + face.x + pixel.x) * 4;
      const rgba = Array.from(actual.rgba.slice(at, at + 4));
      const overlayAlpha = actual.rgba[((overlay.y + pixel.y) * 64 + overlay.x + pixel.x) * 4 + 3];
      const observation = { ...pixel, rgba, luminance: luminance(rgba), overlayAlpha,
        equalsEyeMid: rgba.slice(0, 3).every((v, i) => v === contrast.eyeMid[i]) };
      observations.push(observation);
      if (pixel.role === "sclera") {
        // Existing no-contrast-plan sclera palette, diagnostic substitution only.
        const alternative = skin.map((v, i) => Math.round(v * .28 + [236, 232, 218][i] * .72));
        candidate.rgba.set([...alternative, 255], at);
      }
    }
    expect(observations.some(p => p.role === "sclera")).toBe(true);
    for (const p of observations.filter(p => p.role === "sclera")) {
      expect(p.equalsEyeMid).toBe(true);
      expect(p.overlayAlpha).toBe(0);
      expect(p.luminance).toBeLessThan(luminance(skin));
    }
    const changed = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== candidate.rgba[p * 4 + c])) {
      const x = p % 64, y = Math.floor(p / 64);
      expect(plan.pixels.some(cell => cell.role === "sclera" && cell.x + face.x === x && cell.y + face.y === y)).toBe(true);
      changed.push({ x, y });
    }
    expect(validateFinalAtlas(candidate).ok).toBe(true);
    const root = mkdtempSync("evaluation-artifacts/current-default-005-eye-role-audit-20260926-");
    for (const [name, atlas] of [["actual-live", actual], ["sclera-palette-counterfactual", candidate]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(view => view.name === "front")!;
      writeFileSync(`${root}/${name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, productionChange: false,
      actualPngHash: sha(actualBytes), observations, contrast, skinLuminance: luminance(skin), changed,
      layoutAndRolesUnchanged: true, alphaUnchanged: true,
      limitation: "Counterfactual uses existing fallback sclera palette, not a validated new production palette. Geometry/localization accuracy is not established.",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${liveRoot}/summary.json`)).toEqual(savedBytes);
    expect(readFileSync(`${liveRoot}/skin.png`)).toEqual(actualBytes);
    expect(guard).not.toHaveBeenCalled();
    console.info(`EYE_ROLE_AUDIT_ROOT ${root} ${JSON.stringify(observations)}`);
  } finally { guard.mockRestore(); }
});

it("bounds the palette-only counterfactual across twelve frozen fixtures without activating it", async () => {
  const guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const fixtures: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
    const root = mkdtempSync("evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-");
    const cases = [];
    for (const fixture of fixtures) {
      const { analysis: input } = strictBoundaryAnalysisFromAnnotation(fixture);
      if (fixture.existing) input.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const analysis = normalizeAnalysisForRendering(input), plan = buildSkinPlan(analysis);
      const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, features);
      const stageEyes: Record<string, unknown> = {};
      const before = buildProceduralFallbackAtlas(features, style, plan, (stage, atlas) => {
        const face = CLASSIC_LAYOUT.head.base.front;
        stageEyes[stage] = plan.facePixelPlan.pixels.filter(p => p.role === "iris" || p.role === "sclera").map(p => ({
          ...p, neighborhood: [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => {
            const x = p.x + dx, y = p.y + dy;
            const at = ((face.y + y) * 64 + face.x + x) * 4;
            return { x, y, rgba: Array.from(atlas.rgba.slice(at, at + 4)) };
          }),
        }));
      })!;
      expect(before).not.toBeNull();
      const after = { ...before, rgba: new Uint8Array(before.rgba) };
      const face = CLASSIC_LAYOUT.head.base.front;
      const skin = rgb(features.skinTone);
      const sclera = skin.map((v, i) => Math.round(v * .28 + [236, 232, 218][i] * .72));
      const cells = plan.facePixelPlan.pixels.filter(p => p.role === "sclera");
      for (const p of cells) after.rgba.set([...sclera, 255], ((face.y + p.y) * 64 + face.x + p.x) * 4);
      let changed = 0;
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) {
        changed++;
        expect(cells.some(c => c.x + face.x === p % 64 && c.y + face.y === Math.floor(p / 64))).toBe(true);
        expect(before.rgba[p * 4 + 3]).toBe(after.rgba[p * 4 + 3]);
      }
      const craftBefore = validateAtlasCraft(before, style, plan.facePixelPlan, plan.hairPlan, plan);
      const craftAfter = validateAtlasCraft(after, style, plan.facePixelPlan, plan.hairPlan, plan);
      // The historical 12/12 check omitted face/hair-plan arguments. Record the
      // stronger full-plan check separately; do not disguise a baseline failure
      // as a palette regression or weaken either validator.
      const historicalCraftBefore = validateAtlasCraft(before, style, undefined, undefined, plan);
      const historicalCraftAfter = validateAtlasCraft(after, style, undefined, undefined, plan);
      expect(historicalCraftBefore.ok, fixture.id).toBe(true);
      expect(validateFinalAtlas(after).ok, fixture.id).toBe(true);
      cases.push({ id: fixture.id, calibrated: !!fixture.existing, changed, scleraCells: cells.length,
        baselinePlan: plan, baselineFeatures: features, baselineStyle: style,
        beforeHash: sha(before.rgba), candidateHash: sha(after.rgba), craftBefore, craftAfter, historicalCraftBefore, historicalCraftAfter,
        ...(!craftBefore.ok ? { stageEyes, eyeLayout: plan.facePixelPlan.layout, facePixelInstructions: plan.facePixelPlan.pixels } : {}),
        leftScleraCells: cells.filter(p => p.cluster === "left_eye").length,
        rightScleraCells: cells.filter(p => p.cluster === "right_eye").length });
      for (const [name, atlas] of [["before", before], ["candidate", after]] as const) {
        writeFileSync(`${root}/${fixture.id}-${name}.png`, await encodePng(atlas), { flag: "wx" });
        const view = renderSkinViews(atlas).find(v => v.name === "front")!;
        writeFileSync(`${root}/${fixture.id}-${name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 128, 128)), { flag: "wx" });
      }
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, productionChange: false,
      mode: "palette_only_counterfactual_not_new_source_evidence_or_production_change", cases,
      caveat: "Craft acceptance measures atlas constraints, not improved likeness. No geometry or feature placement was corrected.",
    }, null, 2), { flag: "wx" });
    expect(guard).not.toHaveBeenCalled();
    console.info(`SCLERA_FROZEN_COUNTERFACTUAL_ROOT ${root}`);
  } finally { guard.mockRestore(); }
});
