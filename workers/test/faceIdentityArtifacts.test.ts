/** Opt-in offline replay for the five stored real-photo face sentinels. */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import { measureFaceIdentityRetention, measureFaceIdentitySignature, measureFacePlanPixelDifference, measureGenericFaceConvergence } from "../src/faceIdentityFidelity";
import { parseIdentityGeometry, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, type RawImage } from "../src/png";
import { applyHeadIdentityPlan, DEFAULT_FACE_STYLE, type FaceStyle } from "../src/skinPack";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import {
  buildBeforeAfterHeadMontage,
  buildFaceGeometryOverlay,
  buildSourceToFaceGridOverlay,
  renderFacePixelDifference,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_FACE_IDENTITY_ARTIFACTS === "1";
const INPUT_ROOT = resolve("evaluation-artifacts/head-structure-iteration-final");
const OUTPUT_ROOT = resolve(process.env.FACE_IDENTITY_ARTIFACT_DIR ?? "evaluation-artifacts/face-identity-quantization-20260904");
const CASES = ["short-hair-red-shirt", "glasses-monochrome", "curly-hair", "headscarf-color-blocks", "long-straight-hair"] as const;

interface StoredP5Check {
  feature: string;
  targetRegions: string[];
}

interface Replay {
  id: (typeof CASES)[number];
  sourceFace: RawImage;
  beforeAtlas: RawImage;
  geometry: IdentityGeometryAnalysis;
  analysis: PhotoAnalysis;
  beforePlan: FacePixelPlan;
  afterPlan: FacePixelPlan;
}

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
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.color ?? [180, 135, 110];
}

function atlasColors(atlas: RawImage, oldPlan: FacePixelPlan): { skin: [number, number, number]; hair: [number, number, number] } {
  const face = CLASSIC_LAYOUT.head.base.front;
  const occupied = new Set(oldPlan.pixels.filter((pixel) => pixel.cluster !== "complexion").map((pixel) => `${pixel.x},${pixel.y}`));
  const skinPoints: Array<{ x: number; y: number }> = [];
  for (let y = 2; y < 8; y++) for (let x = 0; x < 8; x++) if (!occupied.has(`${x},${y}`)) skinPoints.push({ x: face.x + x, y: face.y + y });
  const brow = oldPlan.pixels.find((pixel) => pixel.role === "brow");
  const hairPoint = oldPlan.pixels.find((pixel) => pixel.cluster === "fringe") ?? brow;
  return {
    skin: mostCommonColor(atlas, skinPoints),
    hair: hairPoint ? rgbAt(atlas, face.x + hairPoint.x, face.y + hairPoint.y) : [52, 42, 36],
  };
}

function erasePriorFace(atlas: RawImage, oldPlan: FacePixelPlan, skin: [number, number, number]): void {
  const face = CLASSIC_LAYOUT.head.base.front;
  for (const pixel of oldPlan.pixels.filter((item) => !["fringe", "complexion"].includes(item.cluster))) {
    const offset = ((face.y + pixel.y) * atlas.width + face.x + pixel.x) * 4;
    atlas.rgba.set([...skin, 255], offset);
  }
  for (const point of [...oldPlan.glassesPlan.framePixels, ...oldPlan.glassesPlan.sideArms]) {
    const rect = point.face === "front" ? CLASSIC_LAYOUT.head.overlay.front : CLASSIC_LAYOUT.head.overlay[point.face];
    const offset = ((rect.y + point.y) * atlas.width + rect.x + point.x) * 4;
    atlas.rgba.fill(0, offset, offset + 4);
  }
}

function styleFor(replay: Replay, colors: { skin: [number, number, number]; hair: [number, number, number] }): FaceStyle {
  const hex = (color: [number, number, number]) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return {
    ...DEFAULT_FACE_STYLE,
    eyeColor: hex(colors.hair),
    hairColor: hex(colors.hair),
    skinTone: hex(colors.skin),
    glasses: replay.geometry.glasses ? "round" : "none",
    eyebrowThickness: replay.afterPlan.layout.browThickness === "strong" ? "thick" : "normal",
    expression: replay.geometry.mouth.opening === "closed" ? "neutral" : "smile",
  };
}

async function loadReplay(id: Replay["id"]): Promise<Replay> {
  const directory = resolve(INPUT_ROOT, id);
  const [metricsBytes, critiqueBytes, sourceFaceBytes, atlasBytes] = await Promise.all([
    readFile(resolve(directory, "metrics.json")),
    readFile(resolve(directory, "critique.json")),
    readFile(resolve(directory, "01-source-face.png")),
    readFile(resolve(directory, "10-final-skin.png")),
  ]);
  const metrics = JSON.parse(metricsBytes.toString("utf8")) as { sourceGeometryAfter: Record<string, unknown>; newFacePixelPlan: FacePixelPlan };
  const critique = JSON.parse(critiqueBytes.toString("utf8")) as { after?: { critique?: { p5IdentityChecks?: StoredP5Check[] } } };
  const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter);
  if (!geometry) throw new Error(`${id}: invalid stored geometry`);
  const analysis = replayAnalysis(geometry, critique.after?.critique?.p5IdentityChecks ?? []);
  return {
    id,
    sourceFace: await decodePng(new Uint8Array(sourceFaceBytes)),
    beforeAtlas: await decodePng(new Uint8Array(atlasBytes)),
    geometry,
    analysis,
    beforePlan: metrics.newFacePixelPlan,
    afterPlan: buildIdentityPixelPlans(analysis).facePixelPlan,
  };
}

describe.skipIf(!RUN)("offline face identity artifacts", () => {
  it("replays five real-photo cases without any model or evaluator call", async () => {
    const replays = await Promise.all(CASES.map(loadReplay));
    const beforeConvergence = measureGenericFaceConvergence(replays.map((replay) => replay.beforePlan));
    const afterConvergence = measureGenericFaceConvergence(replays.map((replay) => replay.afterPlan));
    const summaryCases: Record<string, unknown> = {};
    for (const replay of replays) {
      const colors = atlasColors(replay.beforeAtlas, replay.beforePlan);
      const afterAtlas = { ...replay.beforeAtlas, rgba: replay.beforeAtlas.rgba.slice() };
      erasePriorFace(afterAtlas, replay.beforePlan, colors.skin);
      const headIdentityPlan = buildIdentityPixelPlans(replay.analysis).headIdentityPlan;
      // This iteration is face-only: keep the stored hair/fringe atlas bytes
      // frozen while applying the new facial landmarks and glasses contract.
      applyHeadIdentityPlan(afterAtlas, {
        ...headIdentityPlan,
        baseFace: {
          ...headIdentityPlan.baseFace,
          pixels: headIdentityPlan.baseFace.pixels.filter((pixel) => pixel.cluster !== "fringe"),
        },
      }, undefined, colors.hair, colors.skin, styleFor(replay, colors), true);
      const priorFringe = replay.beforePlan.pixels.filter((pixel) => pixel.cluster === "fringe");
      const afterLandmarks = new Set(replay.afterPlan.pixels
        .filter((pixel) => !["fringe", "complexion"].includes(pixel.cluster))
        .map((pixel) => `${pixel.x},${pixel.y}`));
      expect(priorFringe.filter((pixel) => afterLandmarks.has(`${pixel.x},${pixel.y}`))).toEqual([]);
      const faceRect = CLASSIC_LAYOUT.head.base.front;
      for (const pixel of priorFringe) {
        const offset = ((faceRect.y + pixel.y) * replay.beforeAtlas.width + faceRect.x + pixel.x) * 4;
        expect([...afterAtlas.rgba.slice(offset, offset + 4)]).toEqual([...replay.beforeAtlas.rgba.slice(offset, offset + 4)]);
      }
      const beforeViews = renderSkinViews(replay.beforeAtlas);
      const afterViews = renderSkinViews(afterAtlas);
      const head = (views: ReturnType<typeof renderSkinViews>, name: Parameters<typeof extractRenderedHeadView>[0]["name"]) => extractRenderedHeadView(views.find((view) => view.name === name)!);
      const beforeFront = head(beforeViews, "front");
      const afterFront = head(afterViews, "front");
      const pixelDifference = measureFacePlanPixelDifference(replay.beforePlan, replay.afterPlan);
      const retention = measureFaceIdentityRetention(replay.analysis, replay.afterPlan);
      const metrics = {
        case: replay.id,
        apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactionsCanary: 0 },
        sourceGeometry: replay.geometry,
        before: measureFaceIdentitySignature(replay.beforePlan),
        after: measureFaceIdentitySignature(replay.afterPlan),
        salience: replay.afterPlan.salience,
        retention,
        pixelDifference,
        genericConvergence: { before: beforeConvergence, after: afterConvergence },
      };
      summaryCases[replay.id] = metrics;
      await writeIdentityEvaluationArtifacts(OUTPUT_ROOT, replay.id, {
        sourceFace: replay.sourceFace,
        sourceFaceGeometryOverlay: buildFaceGeometryOverlay(replay.sourceFace, replay.geometry),
        sourceToGridOverlay: buildSourceToFaceGridOverlay(replay.sourceFace, replay.geometry, replay.afterPlan),
        facePixelPlan: replay.afterPlan,
        oldFacePixelPlan: replay.beforePlan,
        facePixelDiff: renderFacePixelDifference(replay.beforePlan, replay.afterPlan),
        beforeHeadFront: beforeFront,
        beforeHeadFrontLeft: head(beforeViews, "front_left_three_quarter"),
        beforeHeadFrontRight: head(beforeViews, "front_right_three_quarter"),
        finalHeadFront: afterFront,
        finalHeadFrontLeft: head(afterViews, "front_left_three_quarter"),
        finalHeadFrontRight: head(afterViews, "front_right_three_quarter"),
        finalHeadLeft: head(afterViews, "left"),
        finalHeadRight: head(afterViews, "right"),
        beforeAfterHeadMontage: buildBeforeAfterHeadMontage(beforeFront, afterFront),
        finalSkin: afterAtlas,
        critique: { status: "not_run", reason: "offline deterministic face quantization iteration" },
        metrics,
      });
    }
    await mkdir(OUTPUT_ROOT, { recursive: true });
    await writeFile(resolve(OUTPUT_ROOT, "summary.json"), JSON.stringify({
      apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactionsCanary: 0 },
      beforeConvergence,
      afterConvergence,
      cases: summaryCases,
    }, null, 2), "utf8");
    expect(afterConvergence.convergence).toBeLessThanOrEqual(beforeConvergence.convergence);
  });
});
