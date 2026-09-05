/** Opt-in offline facial-feature renderer replay. No model or evaluator calls. */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import { measureFaceIdentitySignature, measureGenericFaceConvergence } from "../src/faceIdentityFidelity";
import { measureFaceFeatureSeparability, measureFaceFeatureSignature, measureFaceFeatureSignatureSeparability, measureFacialFeatureReadability, measurePreviewFeatureReadability, type FaceFeatureSignature } from "../src/facialFeatureReadability";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { createFacePlanAtlasCandidate, DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { buildBeforeAfterHeadMontage } from "./evaluationArtifacts";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_FACIAL_FEATURE_ARTIFACTS === "1";
const GEOMETRY_ROOT = resolve("evaluation-artifacts/head-structure-iteration-final");
const BEFORE_ROOT = resolve("evaluation-artifacts/face-identity-quantization-20260904");
const OUTPUT_ROOT = resolve(process.env.FACIAL_FEATURE_ARTIFACT_DIR ?? "evaluation-artifacts/facial-feature-renderer-20260904");
const CASES = ["short-hair-red-shirt", "glasses-monochrome", "curly-hair", "headscarf-color-blocks", "long-straight-hair"] as const;

interface StoredP5Check { feature: string; targetRegions: string[] }

function featureCategory(feature: string, regions: string[]): IdentityFeatureCategory {
  const text = `${feature} ${regions.join(" ")}`.toLowerCase();
  if (/glass|frame|spectacle|scarf|accessor/.test(text)) return "accessory";
  if (/hair|fringe|bang|curl|silhouette/.test(text)) return "hair";
  if (/shirt|torso|outfit|collar|sweater/.test(text)) return "outfit";
  return "face";
}

function replayAnalysis(geometry: IdentityGeometryAnalysis, checks: StoredP5Check[]): PhotoAnalysis {
  const base = makeAnalysis();
  const features = checks.map((check) => ({
    feature: check.feature,
    category: featureCategory(check.feature, check.targetRegions),
    priority: 5 as const,
    confidence: "high" as const,
    evidence: "Stored source-analysis cue",
    targetRegions: check.targetRegions,
  }));
  const cueText = features.map((feature) => feature.feature).join(", ");
  return makeAnalysis({
    identityGeometry: geometry,
    canonicalIdentity: { overallImpression: cueText, mustPreserve: features.map((feature) => feature.feature), features },
    observed: { ...base.observed, accessories: geometry.glasses ? "measured glasses" : "no glasses" },
    fallbackFeatures: { ...base.fallbackFeatures, glasses: geometry.glasses ? "round" : "none" },
    renderHints: {
      ...base.renderHints,
      eyeShape: geometry.eyes.openness >= 0.68 ? "round" : geometry.eyes.openness <= 0.34 ? "narrow" : "almond",
      eyeSize: Math.max(geometry.eyes.leftWidth, geometry.eyes.rightWidth) >= 0.16 ? "large" : "average",
      mouthShape: geometry.mouth.width / Math.max(0.08, geometry.face.visibleRight - geometry.face.visibleLeft) >= 0.45 ? "wide" : "average",
      mouthOpening: geometry.mouth.opening === "teeth" ? "teeth_visible" : geometry.mouth.opening === "open" ? "slightly_open" : "closed",
    },
    identityPrompt: cueText,
    negativePrompt: geometry.glasses ? base.negativePrompt : "no glasses",
  });
}

function rgbAt(atlas: RawImage, x: number, y: number): [number, number, number] {
  const offset = (y * atlas.width + x) * 4;
  return [atlas.rgba[offset], atlas.rgba[offset + 1], atlas.rgba[offset + 2]];
}

function mostCommonColor(atlas: RawImage, points: Array<{ x: number; y: number }>): [number, number, number] {
  const counts = new Map<string, { color: [number, number, number]; count: number }>();
  for (const point of points) {
    const color = rgbAt(atlas, point.x, point.y);
    const key = color.join(",");
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { color, count: 1 });
  }
  return [...counts.values()].sort((first, second) => second.count - first.count)[0]?.color ?? [180, 135, 110];
}

function atlasColors(atlas: RawImage, plan: FacePixelPlan) {
  const face = CLASSIC_LAYOUT.head.base.front;
  const occupied = new Set(plan.pixels.filter((pixel) => pixel.cluster !== "complexion").map((pixel) => `${pixel.x},${pixel.y}`));
  const skinPoints: Array<{ x: number; y: number }> = [];
  for (let y = 2; y < 8; y++) for (let x = 0; x < 8; x++) if (!occupied.has(`${x},${y}`)) skinPoints.push({ x: face.x + x, y: face.y + y });
  const hairPoint = plan.pixels.find((pixel) => pixel.cluster === "fringe") ?? plan.pixels.find((pixel) => pixel.role === "brow");
  return {
    skin: mostCommonColor(atlas, skinPoints),
    hair: hairPoint ? rgbAt(atlas, face.x + hairPoint.x, face.y + hairPoint.y) : [52, 42, 36] as [number, number, number],
  };
}

function styleFor(geometry: IdentityGeometryAnalysis, plan: FacePixelPlan, skin: [number, number, number], hair: [number, number, number]): FaceStyle {
  const hex = (color: [number, number, number]) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return {
    ...DEFAULT_FACE_STYLE,
    eyeColor: hex(hair), hairColor: hex(hair), skinTone: hex(skin),
    glasses: geometry.glasses ? "round" : "none",
    eyebrowThickness: plan.layout.browThickness === "strong" ? "thick" : "normal",
    expression: geometry.mouth.opening === "closed" ? "neutral" : "smile",
    mouthOpening: geometry.mouth.opening === "teeth" ? "teeth_visible" : geometry.mouth.opening === "open" ? "slightly_open" : "closed",
  };
}

function compositeFace(atlas: RawImage, scale = 24): RawImage {
  const base = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const rgba = new Uint8Array(8 * scale * 8 * scale * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const baseAt = ((base.y + y) * atlas.width + base.x + x) * 4;
    const overlayAt = ((overlay.y + y) * atlas.width + overlay.x + x) * 4;
    const sourceAt = atlas.rgba[overlayAt + 3] > 0 ? overlayAt : baseAt;
    for (let py = y * scale; py < (y + 1) * scale; py++) for (let px = x * scale; px < (x + 1) * scale; px++) {
      rgba.set(atlas.rgba.subarray(sourceAt, sourceAt + 4), (py * 8 * scale + px) * 4);
    }
  }
  return { width: 8 * scale, height: 8 * scale, rgba };
}

function renderedPixelDiff(before: RawImage, after: RawImage, plan: FacePixelPlan, scale = 24): { image: RawImage; changed: number; byFeature: Record<string, number> } {
  const face = CLASSIC_LAYOUT.head.base.front;
  const rgba = new Uint8Array(8 * scale * 8 * scale * 4);
  const byFeature: Record<string, number> = { eyes: 0, brows: 0, mouth: 0, nose: 0, other: 0 };
  let changed = 0;
  for (let cell = 0; cell < 64; cell++) {
    const x = cell % 8;
    const y = Math.floor(cell / 8);
    const beforeColor = rgbAt(before, face.x + x, face.y + y);
    const afterColor = rgbAt(after, face.x + x, face.y + y);
    const difference = beforeColor.reduce((sum, channel, index) => sum + Math.abs(channel - afterColor[index]), 0);
    const instruction = plan.pixels.find((pixel) => pixel.x === x && pixel.y === y);
    const feature = instruction?.role === "brow" ? "brows" : instruction?.cluster === "left_eye" || instruction?.cluster === "right_eye" ? "eyes" : instruction?.cluster === "mouth" ? "mouth" : instruction?.cluster === "nose" ? "nose" : "other";
    if (difference > 0) { changed++; byFeature[feature]++; }
    const color: [number, number, number, number] = difference === 0 ? [24, 27, 32, 255] : [Math.min(255, 80 + difference), 72, 128, 255];
    for (let py = y * scale; py < (y + 1) * scale; py++) for (let px = x * scale; px < (x + 1) * scale; px++) rgba.set(color, (py * 8 * scale + px) * 4);
  }
  return { image: { width: 8 * scale, height: 8 * scale, rgba }, changed, byFeature };
}

function contrastOverlay(atlas: RawImage, plan: FacePixelPlan, scale = 24): RawImage {
  const output = compositeFace(atlas, scale);
  const colors: Record<string, [number, number, number, number]> = {
    eyes: [58, 210, 255, 255], brows: [255, 196, 48, 255], mouth: [255, 82, 139, 255], nose: [184, 136, 255, 255],
  };
  for (const pixel of plan.pixels.filter((item) => !["complexion", "fringe"].includes(item.cluster))) {
    const feature = pixel.role === "brow" ? "brows" : pixel.cluster === "left_eye" || pixel.cluster === "right_eye" ? "eyes" : pixel.cluster;
    const color = colors[feature] ?? [126, 235, 112, 255];
    for (let offset = 0; offset < scale; offset++) for (const [px, py] of [[pixel.x * scale + offset, pixel.y * scale], [pixel.x * scale + offset, (pixel.y + 1) * scale - 1], [pixel.x * scale, pixel.y * scale + offset], [(pixel.x + 1) * scale - 1, pixel.y * scale + offset]]) {
      output.rgba.set(color, (py * output.width + px) * 4);
    }
  }
  return output;
}

async function saveImages(directory: string, images: Array<[string, RawImage]>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(images.map(async ([name, image]) => writeFile(resolve(directory, name), await encodePng(image))));
}

describe.skipIf(!RUN)("offline facial feature renderer artifacts", () => {
  it("repaints the same stored plans and measures five real-photo sentinels", async () => {
    const readings = [];
    const beforeSignatures: FaceFeatureSignature[] = [];
    const afterSignatures: FaceFeatureSignature[] = [];
    const plans: FacePixelPlan[] = [];
    const cases: Record<string, unknown> = {};
    for (const id of CASES) {
      const geometryDirectory = resolve(GEOMETRY_ROOT, id);
      const priorDirectory = resolve(BEFORE_ROOT, id);
      const [geometryBytes, critiqueBytes, sourceBytes, beforeBytes, priorMetricsBytes] = await Promise.all([
        readFile(resolve(geometryDirectory, "metrics.json")), readFile(resolve(geometryDirectory, "critique.json")),
        readFile(resolve(priorDirectory, "01-source-face.png")), readFile(resolve(priorDirectory, "10-final-skin.png")),
        readFile(resolve(priorDirectory, "metrics.json")),
      ]);
      const geometryJson = JSON.parse(geometryBytes.toString("utf8")) as { sourceGeometryAfter: Record<string, unknown> };
      const critique = JSON.parse(critiqueBytes.toString("utf8")) as { after?: { critique?: { p5IdentityChecks?: StoredP5Check[] } } };
      const geometry = parseIdentityGeometry(geometryJson.sourceGeometryAfter);
      if (!geometry) throw new Error(`${id}: invalid stored geometry`);
      const analysis = replayAnalysis(geometry, critique.after?.critique?.p5IdentityChecks ?? []);
      const plan = buildIdentityPixelPlans(analysis).facePixelPlan;
      const beforeAtlas = await decodePng(new Uint8Array(beforeBytes));
      const source = await decodePng(new Uint8Array(sourceBytes));
      const colors = atlasColors(beforeAtlas, plan);
      const facialOnlyPlan: FacePixelPlan = {
        ...plan,
        pixels: plan.pixels.filter((pixel) => pixel.cluster !== "fringe" && pixel.cluster !== "complexion"),
      };
      const afterAtlas = createFacePlanAtlasCandidate(beforeAtlas, facialOnlyPlan, styleFor(geometry, plan, colors.skin, colors.hair));
      const priorMetrics = JSON.parse(priorMetricsBytes.toString("utf8")) as { after: unknown; genericConvergence: { after: { convergence: number } } };
      expect(measureFaceIdentitySignature(plan)).toEqual(priorMetrics.after);
      expect(priorMetrics.genericConvergence.after.convergence).toBeLessThanOrEqual(0.05);
      const beforeReading = measureFacialFeatureReadability(beforeAtlas, plan);
      const afterReading = measureFacialFeatureReadability(afterAtlas, plan);
      const beforeFeatureSignature = measureFaceFeatureSignature(beforeAtlas, plan);
      const afterFeatureSignature = measureFaceFeatureSignature(afterAtlas, plan);
      beforeSignatures.push(beforeFeatureSignature);
      afterSignatures.push(afterFeatureSignature);
      readings.push(afterReading);
      plans.push(plan);
      const beforeViews = renderSkinViews(beforeAtlas);
      const afterViews = renderSkinViews(afterAtlas);
      const head = (views: ReturnType<typeof renderSkinViews>, name: Parameters<typeof extractRenderedHeadView>[0]["name"], size = 96) => extractRenderedHeadView(views.find((view) => view.name === name)!, size);
      const beforePreview = head(beforeViews, "front", 32);
      const afterPreview = head(afterViews, "front", 32);
      const beforePreviewReading = measurePreviewFeatureReadability(beforePreview, beforeAtlas, plan);
      const afterPreviewReading = measurePreviewFeatureReadability(afterPreview, afterAtlas, plan);
      const diff = renderedPixelDiff(beforeAtlas, afterAtlas, plan);
      expect(diff.byFeature.other).toBe(0);
      expect(afterReading.protectedPixelRetention).toBe(1);
      expect(afterPreviewReading.retainedFeatureColorRate).toBeGreaterThanOrEqual(beforePreviewReading.retainedFeatureColorRate);
      expect(afterPreviewReading.mouthRetained).toBe(1);
      if (geometry.glasses) expect(afterPreviewReading.eyesRetained).toBeGreaterThan(0);
      else expect(afterPreviewReading.retainedFeatureColorRate).toBe(1);
      const directory = resolve(OUTPUT_ROOT, id);
      await saveImages(directory, [
        ["01-source.png", source], ["02-before-flat.png", compositeFace(beforeAtlas)], ["03-after-flat.png", compositeFace(afterAtlas)],
        ["04-before-after-flat.png", buildBeforeAfterHeadMontage(compositeFace(beforeAtlas), compositeFace(afterAtlas))],
        ["05-preview-front.png", buildBeforeAfterHeadMontage(scaleNearestNeighbor(beforePreview, 96, 96), scaleNearestNeighbor(afterPreview, 96, 96))],
        ["06-after-front.png", head(afterViews, "front")],
        ["07-before-front-left.png", head(beforeViews, "front_left_three_quarter")], ["08-after-front-left.png", head(afterViews, "front_left_three_quarter")],
        ["09-before-front-right.png", head(beforeViews, "front_right_three_quarter")], ["10-after-front-right.png", head(afterViews, "front_right_three_quarter")],
        ["11-feature-contrast-overlay.png", contrastOverlay(afterAtlas, plan)], ["12-rendered-pixel-diff.png", diff.image], ["13-final-skin.png", afterAtlas],
      ]);
      const metrics = { id, apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 }, planSignature: measureFaceIdentitySignature(plan), featureSignature: { before: beforeFeatureSignature, after: afterFeatureSignature }, before: beforeReading, after: afterReading, previewBefore: beforePreviewReading, previewAfter: afterPreviewReading, renderedPixelDifference: { changed: diff.changed, byFeature: diff.byFeature } };
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
      cases[id] = metrics;
    }
    const convergence = measureGenericFaceConvergence(plans);
    const separability = measureFaceFeatureSeparability(readings);
    const featureSignatureSeparability = { before: measureFaceFeatureSignatureSeparability(beforeSignatures), after: measureFaceFeatureSignatureSeparability(afterSignatures) };
    expect(convergence.convergence).toBeLessThanOrEqual(0.05);
    expect(separability.collisionRate).toBe(0);
    expect(separability.readableRate).toBe(1);
    expect(featureSignatureSeparability.after.collisionRate).toBeLessThanOrEqual(featureSignatureSeparability.before.collisionRate);
    await mkdir(OUTPUT_ROOT, { recursive: true });
    await writeFile(resolve(OUTPUT_ROOT, "summary.json"), JSON.stringify({ apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 }, genericConvergence: convergence, separability, featureSignatureSeparability, cases }, null, 2), "utf8");
  });
});
