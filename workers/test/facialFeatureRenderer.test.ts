import { describe, expect, it } from "vitest";
import { buildFacialContrastPlan, facialColorDistance, type FacialRgb } from "../src/facialContrast";
import { measureFaceFeatureSignature, measureFaceFeatureSignatureSeparability, measureFacialFeatureReadability, measurePreviewFeatureReadability } from "../src/facialFeatureReadability";
import { buildIdentityPixelPlans, type FacePixelPlan } from "../src/identityPlans";
import { createFacePlanAtlasCandidate, DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const SKINS = [
  { name: "light", rgb: [238, 194, 164] as FacialRgb, hex: "#eec2a4" },
  { name: "medium", rgb: [181, 126, 91] as FacialRgb, hex: "#b57e5b" },
  { name: "dark", rgb: [87, 57, 43] as FacialRgb, hex: "#57392b" },
];

function analysisWithGeometry(overrides: Parameters<typeof makeIdentityGeometry>[0] = {}) {
  const base = makeAnalysis();
  return makeAnalysis({
    identityGeometry: makeIdentityGeometry({ ...overrides, glasses: overrides.glasses ?? null }),
    fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    observed: { ...base.observed, accessories: "none" },
    negativePrompt: "no glasses",
  });
}

function solidAtlas(color: FacialRgb): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([...color, 255], offset);
  for (const rect of Object.values(CLASSIC_LAYOUT.head.overlay)) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      rgba.fill(0, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
    }
  }
  return { width: 64, height: 64, rgba };
}

function style(skin: string, overrides: Partial<FaceStyle> = {}): FaceStyle {
  return { ...DEFAULT_FACE_STYLE, skinTone: skin, hairColor: "#392b25", eyeColor: "#4f4032", lipColor: "natural", glasses: "none", ...overrides };
}

function rgbAtPlan(atlas: ReturnType<typeof solidAtlas>, pixel: FacePixelPlan["pixels"][number]): FacialRgb {
  const face = CLASSIC_LAYOUT.head.base.front;
  const offset = ((face.y + pixel.y) * atlas.width + face.x + pixel.x) * 4;
  return [atlas.rgba[offset], atlas.rgba[offset + 1], atlas.rgba[offset + 2]];
}

describe("facial feature renderer readability", () => {
  it.each(SKINS)("keeps eyes, brows and mouth readable on $name skin", ({ rgb, hex }) => {
    const plan = buildIdentityPixelPlans(analysisWithGeometry()).facePixelPlan;
    const rendered = createFacePlanAtlasCandidate(solidAtlas(rgb), plan, style(hex));
    const reading = measureFacialFeatureReadability(rendered, plan);
    expect(reading.eyes.readable).toBe(true);
    expect(reading.eyes.pairSeparated).toBe(true);
    expect(reading.brows.readable).toBe(true);
    expect(reading.brows.separatedFromEyes).toBe(true);
    expect(reading.mouth.readable).toBe(true);
    expect(reading.protectedPixelRetention).toBe(1);
  });

  it("uses one clear dark mark for one-cell eyes without adding geometry", () => {
    const source = makeIdentityGeometry();
    const plan = buildIdentityPixelPlans(analysisWithGeometry({
      eyes: { ...source.eyes, leftWidth: 0.06, rightWidth: 0.06, openness: 0.42 },
    })).facePixelPlan;
    const eyePixels = plan.pixels.filter((pixel) => pixel.role === "iris" || pixel.role === "sclera");
    expect(plan.layout.leftEyeWidth).toBe(1);
    expect(plan.layout.rightEyeWidth).toBe(1);
    const rendered = createFacePlanAtlasCandidate(solidAtlas([181, 126, 91]), plan, style("#b57e5b"));
    for (const pixel of eyePixels) expect(facialColorDistance(rgbAtPlan(rendered, pixel), [181, 126, 91])).toBeGreaterThanOrEqual(90);
    expect(eyePixels.filter((pixel) => pixel.cluster === "left_eye")).toHaveLength(1);
    expect(eyePixels.filter((pixel) => pixel.cluster === "right_eye")).toHaveLength(1);
  });

  it("uses a mirrored dark/mid grammar for multi-cell eyes", () => {
    const source = makeIdentityGeometry();
    const quantized = buildIdentityPixelPlans(analysisWithGeometry({
      eyes: { ...source.eyes, leftWidth: 0.2, rightWidth: 0.2, openness: 0.48 },
    })).facePixelPlan;
    // Exercise the renderer with a valid two-cell-per-eye wire plan. The
    // quantizer itself is frozen in this iteration and may choose one visible
    // iris cell even when its continuous layout span is two cells wide.
    const plan: FacePixelPlan = {
      ...quantized,
      pixels: [
        ...quantized.pixels,
        { x: quantized.layout.leftEyeXs.at(-1)!, y: quantized.layout.leftEyeRow, role: "iris", cluster: "left_eye" },
        { x: quantized.layout.rightEyeXs.at(-1)!, y: quantized.layout.rightEyeRow, role: "iris", cluster: "right_eye" },
      ],
    };
    const rendered = createFacePlanAtlasCandidate(solidAtlas([181, 126, 91]), plan, style("#b57e5b"));
    const colors = (cluster: "left_eye" | "right_eye") => new Set(plan.pixels
      .filter((pixel) => pixel.cluster === cluster && (pixel.role === "iris" || pixel.role === "sclera"))
      .map((pixel) => rgbAtPlan(rendered, pixel).join(",")));
    expect(colors("left_eye").size).toBeGreaterThanOrEqual(2);
    expect(colors("right_eye").size).toBeGreaterThanOrEqual(2);
    expect(measureFacialFeatureReadability(rendered, plan).eyes.darkMidGrammar).toBe(true);
  });

  it("keeps brow hue source-linked while strength changes contrast, not coordinates", () => {
    const source = makeIdentityGeometry();
    const subtle = buildIdentityPixelPlans(analysisWithGeometry({ brows: { ...source.brows, thickness: 0.3 } })).facePixelPlan;
    const strong = buildIdentityPixelPlans(analysisWithGeometry({ brows: { ...source.brows, thickness: 0.82 } })).facePixelPlan;
    const subtleAtlas = createFacePlanAtlasCandidate(solidAtlas([181, 126, 91]), subtle, style("#b57e5b"));
    const strongAtlas = createFacePlanAtlasCandidate(solidAtlas([181, 126, 91]), strong, style("#b57e5b"));
    const subtleColor = rgbAtPlan(subtleAtlas, subtle.pixels.find((pixel) => pixel.role === "brow")!);
    const strongColor = rgbAtPlan(strongAtlas, strong.pixels.find((pixel) => pixel.role === "brow")!);
    expect(strong.pixels.filter((pixel) => pixel.role === "brow").length).toBeGreaterThan(subtle.pixels.filter((pixel) => pixel.role === "brow").length);
    expect(facialColorDistance(strongColor, [181, 126, 91])).toBeGreaterThan(facialColorDistance(subtleColor, [181, 126, 91]));
  });

  it("renders teeth as complexion-linked off-white and retains mouth topology", () => {
    const source = makeIdentityGeometry();
    const plan = buildIdentityPixelPlans(analysisWithGeometry({ mouth: { ...source.mouth, opening: "teeth", width: 0.42 } })).facePixelPlan;
    const light = createFacePlanAtlasCandidate(solidAtlas(SKINS[0].rgb), plan, style(SKINS[0].hex, { mouthOpening: "teeth_visible" }));
    const dark = createFacePlanAtlasCandidate(solidAtlas(SKINS[2].rgb), plan, style(SKINS[2].hex, { mouthOpening: "teeth_visible" }));
    const tooth = plan.pixels.find((pixel) => pixel.role === "teeth")!;
    expect(rgbAtPlan(light, tooth)).not.toEqual(rgbAtPlan(dark, tooth));
    const reading = measureFacialFeatureReadability(dark, plan);
    expect(reading.mouth.topologyReadable).toBe(true);
    expect(reading.mouth.widthReadable).toBe(true);
  });

  it("keeps the nose optional and does not invent a shading cell", () => {
    const source = makeIdentityGeometry();
    const plan = buildIdentityPixelPlans(analysisWithGeometry({
      nose: { ...source.nose, visibleStrength: 0.1 },
      confidence: { ...source.confidence, nose: 0.4 },
    })).facePixelPlan;
    expect(plan.salience.pixelBudget.nose).toBe(0);
    expect(plan.pixels.some((pixel) => pixel.cluster === "nose")).toBe(false);
    expect(measureFacialFeatureReadability(createFacePlanAtlasCandidate(solidAtlas(SKINS[1].rgb), plan, style(SKINS[1].hex)), plan).nose.optional).toBe(true);
  });

  it("builds deterministic role-relative contrast instead of a global threshold", () => {
    const plan = buildIdentityPixelPlans(analysisWithGeometry()).facePixelPlan;
    const first = buildFacialContrastPlan(SKINS[1].rgb, [57, 43, 37], {
      eyeColor: [79, 64, 50], lipColor: "natural", irisLightness: "medium", contrastBoost: false,
    }, plan.salience);
    const second = buildFacialContrastPlan(SKINS[1].rgb, [57, 43, 37], {
      eyeColor: [79, 64, 50], lipColor: "natural", irisLightness: "medium", contrastBoost: false,
    }, plan.salience);
    expect(first).toEqual(second);
    expect(first.targets.eye).toBeGreaterThan(first.targets.brow);
    expect(first.targets.brow).toBeGreaterThan(first.targets.nose);
  });

  it("retains feature colours in the actual 32px front-view raster", () => {
    const plan = buildIdentityPixelPlans(analysisWithGeometry()).facePixelPlan;
    const atlas = createFacePlanAtlasCandidate(solidAtlas(SKINS[1].rgb), plan, style(SKINS[1].hex));
    const preview = extractRenderedHeadView(renderSkinViews(atlas).find((view) => view.name === "front")!, 32);
    const reading = measurePreviewFeatureReadability(preview, atlas, plan);
    expect(reading.size).toBe("32x32");
    expect(reading.eyesRetained).toBe(1);
    expect(reading.browsRetained).toBe(1);
    expect(reading.mouthRetained).toBe(1);
  });

  it("reasserts protected landmarks after outer-layer work while preserving glasses ownership", () => {
    const analysis = makeAnalysis({ identityGeometry: makeIdentityGeometry() });
    const plan = buildIdentityPixelPlans(analysis).facePixelPlan;
    const atlas = solidAtlas(SKINS[1].rgb);
    const overlay = CLASSIC_LAYOUT.head.overlay.front;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) atlas.rgba.set([18, 28, 38, 255], ((overlay.y + y) * 64 + overlay.x + x) * 4);
    const rendered = createFacePlanAtlasCandidate(atlas, plan, style(SKINS[1].hex, { glasses: "round" }));
    const frames = new Set(plan.glassesPlan.framePixels.filter((point) => point.face === "front").map((point) => `${point.x},${point.y}`));
    for (const pixel of plan.pixels.filter((item) => item.cluster !== "complexion" && item.cluster !== "fringe")) {
      const alpha = rendered.rgba[((overlay.y + pixel.y) * 64 + overlay.x + pixel.x) * 4 + 3];
      expect(alpha).toBe(frames.has(`${pixel.x},${pixel.y}`) ? 255 : 0);
    }
    for (const frame of plan.glassesPlan.framePixels.filter((point) => point.face === "front")) {
      expect(rendered.rgba[((overlay.y + frame.y) * 64 + overlay.x + frame.x) * 4 + 3]).toBe(255);
    }
  });

  it("includes morphology and contrast bands in deterministic feature signatures", () => {
    const compact = buildIdentityPixelPlans(analysisWithGeometry()).facePixelPlan;
    const source = makeIdentityGeometry();
    const wide = buildIdentityPixelPlans(analysisWithGeometry({ mouth: { ...source.mouth, width: 0.46 } })).facePixelPlan;
    const compactAtlas = createFacePlanAtlasCandidate(solidAtlas(SKINS[1].rgb), compact, style(SKINS[1].hex));
    const wideAtlas = createFacePlanAtlasCandidate(solidAtlas(SKINS[1].rgb), wide, style(SKINS[1].hex));
    const compactSignature = measureFaceFeatureSignature(compactAtlas, compact);
    expect(measureFaceFeatureSignature(compactAtlas, compact)).toEqual(compactSignature);
    const separability = measureFaceFeatureSignatureSeparability([compactSignature, measureFaceFeatureSignature(wideAtlas, wide)]);
    expect(separability).toEqual({ pairCount: 1, identicalPairs: 0, collisionRate: 0 });
  });
});
