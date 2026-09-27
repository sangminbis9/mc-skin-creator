import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import * as quantization from "../src/identityQuantization";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";

const baselineRoot = "evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-uXgimv";
const baselineBytes = readFileSync(`${baselineRoot}/results.json`);
const baseline: Array<{ id: string; baselinePlan: SkinPlan }> = JSON.parse(baselineBytes.toString()).cases;
const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const rows: unknown[] = [];
let root: string;
let guard: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  root = mkdtempSync("evaluation-artifacts/face-mouth-collision-20260926-");
  guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
});
afterEach(() => vi.mocked(quantization.buildQuantizedLayoutVariants).mockRestore?.());
afterAll(() => {
  expect(guard).not.toHaveBeenCalled(); guard.mockRestore();
  expect(hash(readFileSync(`${baselineRoot}/results.json`))).toBe(hash(baselineBytes));
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, baselineRoot, rows }, null, 2), { flag: "wx" });
  console.info(`FACE_MOUTH_COLLISION_ROOT ${root}`);
});

it.each((["closed", "teeth", "open"] as const).flatMap(opening => (["left", "right", "both"] as const).map(side => ({ opening, side }))))("retains both eyes and the complete $opening mouth for a $side corner collision", ({ opening, side }) => {
  const base = makeAnalysis();
  const analysis = makeAnalysis({ ...base, fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    observed: { ...base.observed, accessories: "none" }, negativePrompt: "no glasses" });
  const original = quantization.buildQuantizedLayoutVariants(analysis, 1)[0].layout;
  const layout = { ...original, leftEyeXs: [2], rightEyeXs: [5], leftEyeWidth: 1 as const, rightEyeWidth: 1 as const,
    leftEyeRow: 3 as const, rightEyeRow: 3 as const, eyeTiltOffset: 1 as const,
    eyeTopology: "compact_dark" as const, mouthRow: 5 as const, mouthWidth: side === "both" ? 4 as const : 3 as const, mouthCenterX: side === "left" ? 3 : side === "right" ? 4 : 3.5,
    mouthCornerOffsets: [-1, -1] as [number, number], mouthOpening: opening,
    mouthTopology: opening === "closed" ? "closed_wide" as const : opening === "teeth" ? "teeth_smile" as const : "open_wide" as const,
    renderContract: { mouth: { protected: false, opening, minimumPerceptualWidth: 3 as const,
      teethReadable: opening === "teeth", cornerDirection: "upward_or_level" as const, preserveAsymmetry: false,
      preferredTopology: opening === "closed" ? "closed_wide" as const : opening === "teeth" ? "teeth_smile" as const : "open_wide" as const },
      eyes: { protected: false, minimumInterEyeGap: 1, openness: "compact" as const, preserveAsymmetry: false } } };
  const frozen = structuredClone(layout);
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([{ id: "primary", layout }]);
  const plan = buildFacePixelPlanVariants(analysis, 1)[0];
  expect(plan).toBeDefined();
  expect(plan.pixels).toContainEqual({ x: 2, y: 4, role: "iris", cluster: "left_eye" });
  expect(plan.pixels).toContainEqual({ x: 5, y: 4, role: "iris", cluster: "right_eye" });
  expect(plan.layout.mouthRow).toBe(6);
  expect(plan.layout.mouthCornerOffsets).toEqual([-1, -1]);
  expect(plan.layout.mouthTopology).toBe(layout.mouthTopology);
  expect(plan.layout.geometryTarget).toEqual(layout.geometryTarget);
  expect(plan.mouthCollisionResolution).toEqual({ fromRow: 5, toRow: 6, reason: "eye_pixel_collision" });
  expect(plan.pixels.filter(p => p.cluster === "mouth").map(p => p.y)).toContain(5);
  expect(plan.pixels.filter(p => p.cluster === "mouth").every(p => p.y <= 7)).toBe(true);
  expect(layout).toEqual(frozen);
});

it("leaves a raised mouth unchanged when the tilted eye does not occupy its corner", () => {
  const base = makeAnalysis();
  const analysis = makeAnalysis({ ...base, fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    observed: { ...base.observed, accessories: "none" }, negativePrompt: "no glasses" });
  const layout = quantization.buildQuantizedLayoutVariants(analysis, 1)[0].layout;
  const safe = { ...layout, leftEyeXs: [1], rightEyeXs: [6], leftEyeWidth: 1 as const, rightEyeWidth: 1 as const,
    eyeTopology: "compact_dark" as const, mouthRow: 5 as const, mouthWidth: 3 as const, mouthCenterX: 3,
    mouthCornerOffsets: [-1, -1] as [number, number], renderContract: {} };
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([{ id: "primary", layout: safe }]);
  const plan = buildFacePixelPlanVariants(analysis, 1)[0];
  expect(plan.layout).toEqual(safe);
  expect(plan.mouthCollisionResolution).toBeUndefined();
});

it.each((["closed", "teeth", "open"] as const).flatMap(opening => ([5, 6] as const).flatMap(row => [false, true].map(mirror => ({ opening, row, mirror })))))("preserves open irises when a $opening smile at row $row cannot translate intact (mirror=$mirror)", async ({ opening, row, mirror }) => {
  const base = makeAnalysis();
  const analysis = makeAnalysis({ ...base, fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    observed: { ...base.observed, accessories: "none" }, negativePrompt: "no glasses" });
  const original = quantization.buildQuantizedLayoutVariants(analysis, 1)[0].layout;
  const layout = { ...original, leftEyeXs: [3], rightEyeXs: [6], leftEyeWidth: 1 as const, rightEyeWidth: 1 as const,
    leftEyeRow: mirror ? 3 as const : 4 as const, rightEyeRow: mirror ? 4 as const : 3 as const, eyeTiltOffset: 0 as const,
    eyeTopology: "asymmetric" as const, eyeOpenness: "open" as const,
    mouthRow: row, mouthWidth: 4 as const, mouthCenterX: 4.5,
    mouthCornerOffsets: [-1, -1] as [number, number], mouthOpening: opening,
    mouthTopology: opening === "closed" ? "closed_wide" as const : opening === "teeth" ? "wide_teeth_smile" as const : "open_wide" as const,
    noseStrength: 0,
    renderContract: { mouth: { protected: true, opening, minimumPerceptualWidth: 4 as const,
      teethReadable: opening === "teeth", cornerDirection: "upward_or_level" as const, preserveAsymmetry: false,
      preferredTopology: opening === "closed" ? "closed_wide" as const : opening === "teeth" ? "wide_teeth_smile" as const : "open_wide" as const },
      eyes: { protected: true, minimumInterEyeGap: 1, openness: "open" as const, preserveAsymmetry: true } } };
  const frozen = structuredClone(layout);
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([{ id: "primary", layout }]);
  const plan = buildFacePixelPlanVariants(analysis, 1)[0];
  expect(plan).toBeDefined();
  for (const [x, ys, cluster] of [[3, mirror ? [3, 4] : [4, 5], "left_eye"], [6, mirror ? [4, 5] : [3, 4], "right_eye"]] as const) {
    for (const y of ys) expect(plan.pixels).toContainEqual({ x, y, role: "iris", cluster });
  }
  expect(plan.layout.mouthRow).toBe(6);
  expect(plan.layout.mouthCornerOffsets).toEqual([0, 0]);
  expect(plan.layout.geometryTarget).toEqual(layout.geometryTarget);
  expect(plan.layout.mouthTopology).toBe(layout.mouthTopology);
  expect(plan.layout.mouthWidth).toBe(4);
  expect(plan.layout.leftEyeRow).toBe(layout.leftEyeRow);
  expect(plan.layout.rightEyeRow).toBe(layout.rightEyeRow);
  const mouth = plan.pixels.filter(p => p.cluster === "mouth");
  expect(mouth.filter(p => p.y === 6)).toHaveLength(4);
  expect(mouth.every(p => p.y === 6 || p.y === 7)).toBe(true);
  expect(plan.candidateCost.violations).toEqual([]);
  expect(layout).toEqual(frozen);
  expect(plan.mouthCollisionResolution).toEqual({ fromRow: row, toRow: 6,
    reason: "eye_pixel_collision_level_corners", fromCorners: [-1, -1] });
  // Role-map artifact, not a source photo or a fresh production generation.
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) rgba.set([210, 174, 130, 255], i * 4);
  for (const p of plan.pixels) {
    const color = p.role === "iris" ? [30, 30, 30] : p.role === "sclera" || p.role === "teeth"
      ? [245, 245, 245] : p.cluster === "mouth" ? [125, 55, 55] : [100, 90, 70];
    rgba.set([...color, 255], (p.y * 8 + p.x) * 4);
  }
  writeFileSync(`${root}/synthetic-${opening}-${row}-${mirror ? "right" : "left"}-roles.png`,
    await encodePng(scaleNearestNeighbor({ width: 8, height: 8, rgba }, 256, 256)), { flag: "wx" });
  rows.push({ synthetic: true, opening, mirror, originalMouthRow: row,
    resolution: plan.mouthCollisionResolution, eyes: plan.pixels.filter(p => p.role === "iris"), mouth });
});

it.each([false, true])("retains the measured open-eye axes through the real quantizer and raised-smile grammar (mirror=%s)", mirror => {
  const base = makeAnalysis(), geometry = makeIdentityGeometry();
  const leftY = mirror ? 0.36 : 0.53, rightY = mirror ? 0.53 : 0.36;
  const analysis = makeAnalysis({ observed: { ...base.observed, accessories: "no glasses" }, negativePrompt: "no glasses",
    fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    identityGeometry: makeIdentityGeometry({ glasses: null,
      eyes: { ...geometry.eyes, openness: 0.8, leftWidth: 0.15, rightWidth: 0.15,
        leftCenterY: leftY, rightCenterY: rightY, verticalAsymmetry: rightY - leftY },
      confidence: { ...geometry.confidence, eyes: 0.95 } }) });
  const before = structuredClone(analysis);
  const variants = buildFacePixelPlanVariants(analysis, 3);
  expect(variants.length).toBeGreaterThan(0); expect(variants.length).toBeLessThanOrEqual(3);
  for (const plan of variants) {
    expect(plan.layout.eyeOpenness).toBe("open");
    expect(plan.layout.leftEyeRow).not.toBe(plan.layout.rightEyeRow);
    for (const cluster of ["left_eye", "right_eye"]) expect(plan.pixels.filter(p => p.cluster === cluster && p.role === "iris")).toHaveLength(2);
    expect(plan.pixels.filter(p => p.cluster === "mouth" && p.role === "teeth").length).toBeGreaterThan(0);
    expect(plan.candidateCost.violations).toEqual([]);
  }
  expect(analysis).toEqual(before);
});

function asymmetricCollisionFixture(mirror = false) {
  const base = makeAnalysis();
  const analysis = makeAnalysis({ ...base, observed: { ...base.observed, accessories: "none" }, negativePrompt: "no glasses",
    fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" } });
  const original = quantization.buildQuantizedLayoutVariants(analysis, 1)[0].layout;
  const layout = { ...original, leftEyeXs: [3], rightEyeXs: [6], leftEyeWidth: 1 as const, rightEyeWidth: 1 as const,
    leftEyeRow: mirror ? 3 as const : 4 as const, rightEyeRow: mirror ? 4 as const : 3 as const,
    eyeTiltOffset: 0 as const, eyeTopology: "asymmetric" as const, eyeOpenness: "open" as const,
    noseStrength: 0, mouthRow: 6 as const, mouthWidth: 4 as const, mouthCenterX: 4.5,
    mouthCornerOffsets: (mirror ? [0, -1] : [-1, 0]) as [number, number], mouthOpening: "teeth" as const,
    mouthTopology: "asymmetric_smile" as const,
    renderContract: { ...original.renderContract, mouth: { protected: true, opening: "teeth" as const,
      minimumPerceptualWidth: 4 as const, teethReadable: true, cornerDirection: "preserve_asymmetry" as const,
      preserveAsymmetry: true, preferredTopology: "asymmetric_smile" as const } } };
  return { analysis, layout };
}

it.each([false, true])("does not accept an unresolved asymmetric mouth over an open iris (mirror=%s)", mirror => {
  const { analysis, layout } = asymmetricCollisionFixture(mirror), frozen = structuredClone(layout);
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([{ id: "primary", layout }]);
  expect(buildFacePixelPlanVariants(analysis, 3)).toEqual([]);
  expect(layout).toEqual(frozen);
  rows.push({ synthetic: true, asymmetricCollision: true, mirror, admissibleCandidates: 0,
    sourceCornerOffsets: layout.mouthCornerOffsets, sourceLayoutUnchanged: true });
});

it("uses an existing admissible quantized alternative without flattening the asymmetric mouth", () => {
  const { analysis, layout } = asymmetricCollisionFixture();
  const alternative = { ...layout, leftEyeXs: [2] };
  const frozen = structuredClone([layout, alternative]);
  const quantizer = vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockImplementation((_analysis, maximum) =>
    [{ id: "primary" as const, layout }, { id: "geometry_alt_1" as const, layout: alternative }].slice(0, maximum));
  const plan = buildSkinPlan(analysis).facePixelPlan;
  expect(plan.variantId).toBe("geometry_alt_1");
  expect(quantizer).toHaveBeenCalledWith(analysis, 3);
  expect(plan.layout).toEqual(alternative);
  expect(plan.mouthCollisionResolution).toBeUndefined();
  for (const cluster of ["left_eye", "right_eye"]) expect(plan.pixels.filter(p => p.cluster === cluster && p.role === "iris")).toHaveLength(2);
  expect(plan.pixels).toContainEqual({ x: 3, y: 5, role: "lip", cluster: "mouth" });
  expect(plan.pixels).toContainEqual({ x: 6, y: 6, role: "lip", cluster: "mouth" });
  expect(plan.candidateCost.violations).toEqual([]);
  expect([layout, alternative]).toEqual(frozen);
  rows.push({ synthetic: true, asymmetricAlternative: true, selectedVariant: plan.variantId,
    sourceCornerOffsets: layout.mouthCornerOffsets, selectedCornerOffsets: plan.layout.mouthCornerOffsets,
    eyes: plan.pixels.filter(p => p.role === "iris"), mouth: plan.pixels.filter(p => p.cluster === "mouth") });
});

it("keeps the admissible primary stable when considering existing alternatives", () => {
  const { analysis, layout } = asymmetricCollisionFixture();
  const primary = { ...layout, leftEyeXs: [2] }, alternative = { ...layout, leftEyeXs: [1] };
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([
    { id: "primary", layout: primary }, { id: "geometry_alt_1", layout: alternative },
  ]);
  const plan = buildSkinPlan(analysis).facePixelPlan;
  expect(plan.variantId).toBe("primary");
  expect(plan.layout).toEqual(primary);
  expect(plan.mouthCollisionResolution).toBeUndefined();
});

it("reports no admissible plan explicitly when existing variants cannot preserve eye and mouth ownership", () => {
  const { analysis, layout } = asymmetricCollisionFixture();
  vi.spyOn(quantization, "buildQuantizedLayoutVariants").mockReturnValue([{ id: "primary", layout }]);
  expect(() => buildSkinPlan(analysis)).toThrow("No admissible face pixel plan");
});

it.each(annotations)("preserves non-collision output and validates full face/hair contracts for $id", async fixture => {
  const { analysis: input } = strictBoundaryAnalysisFromAnnotation(fixture);
  if (fixture.existing) input.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
  const analysis = normalizeAnalysisForRendering(input), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features), atlas = buildProceduralFallbackAtlas(features, style, plan)!;
  expect(atlas).not.toBeNull();
  const previous = baseline.find(row => row.id === fixture.id)!.baselinePlan;
  const historical = await decodePng(readFileSync(`${baselineRoot}/${fixture.id}-before.png`));
  // Isolate the mouth-plan repair under one renderer. The independently tested
  // brow-ownership repair intentionally differs from the historical painter.
  const missingEye = ["left_eye", "right_eye"].some(cluster => !previous.facePixelPlan.pixels.some(p => p.cluster === cluster && (p.role === "iris" || p.role === "sclera")));
  let capturedControl: RawImage | undefined;
  const acceptedControl = buildProceduralFallbackAtlas(features, style, previous, (stage, raw) => {
    if (stage === "final_head") capturedControl = { ...raw, rgba: new Uint8Array(raw.rgba) };
  });
  expect(capturedControl).toBeDefined();
  // A deliberately obsolete plan can now fail craft. Inspect its local
  // pre-validation pixels as a rejected control, never as an accepted output.
  if (!acceptedControl) {
    expect(missingEye).toBe(true);
    expect(validateAtlasCraft(capturedControl!, style, undefined, undefined, previous).ok).toBe(false);
  }
  const before = acceptedControl ?? capturedControl!;
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== atlas.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  if (!missingEye) {
    expect(plan).toEqual(previous);
    expect(atlas.rgba).toEqual(before.rgba);
  } else {
    expect(plan.facePixelPlan.layout.mouthRow).toBe(previous.facePixelPlan.layout.mouthRow + 1);
    expect(plan.facePixelPlan.layout.geometryTarget).toEqual(previous.facePixelPlan.layout.geometryTarget);
    expect(plan.hairPlan).toEqual(previous.hairPlan);
    expect(plan.outfitPlan).toEqual(previous.outfitPlan);
    expect(changed.length).toBeGreaterThan(0);
    const fronts = [CLASSIC_LAYOUT.head.base.front, CLASSIC_LAYOUT.head.overlay.front];
    const seam = getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal.find(s => s.primary.every(p => p.y === fronts[0].y + 7))!;
    for (const p of changed.filter(p => !fronts.some(r => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h))) {
      const seamIndex = seam.adjacent.findIndex(cell => cell.x === p.x && cell.y === p.y);
      expect(seamIndex).toBeGreaterThanOrEqual(0);
      const source = seam.primary[seamIndex];
      const localX = source.x - fronts[0].x;
      expect(plan.facePixelPlan.pixels.some(cell => cell.cluster === "mouth" && cell.x === localX && cell.y === 7)).toBe(true);
      const frontAt = (source.y * 64 + source.x) * 4;
      const bottomAt = (p.y * 64 + p.x) * 4;
      expect(atlas.rgba.slice(bottomAt, bottomAt + 4)).toEqual(atlas.rgba.slice(frontAt, frontAt + 4));
    }
  }
  const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
  expect(craft.ok, `${fixture.id}: ${craft.problems.join("; ")}`).toBe(true);
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  rows.push({ id: fixture.id, calibrated: !!fixture.existing, missingEyeBefore: missingEye, changed,
    historicalHash: hash(historical.rgba), controlAccepted: acceptedControl !== null,
    beforeHash: hash(before.rgba), afterHash: hash(atlas.rgba), craft,
    beforeMouth: previous.facePixelPlan.pixels.filter(p => p.cluster === "mouth"),
    afterMouth: plan.facePixelPlan.pixels.filter(p => p.cluster === "mouth"),
    afterEyes: plan.facePixelPlan.pixels.filter(p => p.role === "iris" || p.role === "sclera") });
  if (missingEye) for (const [name, image] of [["before", before], ["after", atlas]] as const) {
    writeFileSync(`${root}/${fixture.id}-${name}.png`, await encodePng(image), { flag: "wx" });
    const view = renderSkinViews(image).find(v => v.name === "front")!;
    writeFileSync(`${root}/${fixture.id}-${name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
  }
});
