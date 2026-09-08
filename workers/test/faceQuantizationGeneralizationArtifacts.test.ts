/** Opt-in, offline before/after replay for the frozen 12-person face suite. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import {
  buildFaceStyle,
  buildProceduralFallbackAtlas,
  fallbackFeaturesToHex,
  normalizeAnalysisForRendering,
  refineFeatureColorsFromAnalysis,
} from "../src/generate";
import {
  findFacePlanCollisions,
  measureFaceIdentityAxisSignatures,
  measureFaceIdentityRetention,
  measureFacePlanPixelDifference,
} from "../src/faceIdentityFidelity";
import { measureFacialFeatureReadability } from "../src/facialFeatureReadability";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFacePixelPlanVariants, type FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import {
  renderFacePixelDifference,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { analysisFromAnnotation, crop, type AnnotatedCase } from "./generalizationSupport";

const RUN = process.env.RUN_FACE_QUANTIZATION_GENERALIZATION === "1";
const PHASE = process.env.FACE_QUANTIZATION_PHASE;
const GENERALIZATION_ROOT = resolve("evaluation-artifacts/generalization-20260905");
const OUTPUT_ROOT = resolve("evaluation-artifacts/face-quantization-generalization-20260907");

type KnownCue = "unknown" | "compact" | "medium" | "wide" | "narrow" | "normal" | "open" |
  "straight" | "arched" | "soft" | "strong" | "thin" | "full" | "closed" | "smile" | "neutral";

interface SourceVisibleCueAudit {
  eyeSpacing: KnownCue;
  eyeFootprint: KnownCue;
  eyeOpenness: KnownCue;
  eyeAsymmetry: KnownCue;
  browStrength: KnownCue;
  browEyeDistance: KnownCue;
  browSlope: KnownCue;
  mouthWidth: KnownCue;
  mouthOpenness: KnownCue;
  mouthTopology: KnownCue;
  mouthVerticalPlacement: KnownCue;
  mouthFullness: KnownCue;
  glassesRelationship: string;
  limitations: string[];
}

/**
 * Coarse observations made from the frozen source crops. These are evaluation
 * labels only: they never enter production quantization and contain no invented
 * continuous coordinates. Perspective/occlusion-limited fields stay unknown.
 */
const MANUAL_SOURCE_AUDIT: Record<string, SourceVisibleCueAudit> = {
  "buzz-striped": {
    eyeSpacing: "medium", eyeFootprint: "medium", eyeOpenness: "normal", eyeAsymmetry: "unknown",
    browStrength: "strong", browEyeDistance: "normal", browSlope: "soft",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "smile", mouthVerticalPlacement: "unknown", mouthFullness: "full",
    glassesRelationship: "none", limitations: ["three-quarter pose makes asymmetry and vertical placement unsuitable for exact scoring"],
  },
  "bun-check": {
    eyeSpacing: "unknown", eyeFootprint: "compact", eyeOpenness: "narrow", eyeAsymmetry: "unknown",
    browStrength: "unknown", browEyeDistance: "unknown", browSlope: "unknown",
    mouthWidth: "compact", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "unknown", mouthFullness: "thin",
    glassesRelationship: "none", limitations: ["downcast gaze and fringe obscure eye spacing and brows"],
  },
  "warm-white-tee": {
    eyeSpacing: "unknown", eyeFootprint: "compact", eyeOpenness: "narrow", eyeAsymmetry: "unknown",
    browStrength: "strong", browEyeDistance: "normal", browSlope: "straight",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "unknown", mouthFullness: "medium",
    glassesRelationship: "none", limitations: ["profile-biased pose makes spacing and asymmetry unsuitable for exact scoring"],
  },
  "full-body-layered": {
    eyeSpacing: "unknown", eyeFootprint: "unknown", eyeOpenness: "unknown", eyeAsymmetry: "unknown",
    browStrength: "unknown", browEyeDistance: "unknown", browSlope: "unknown",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "normal", mouthFullness: "full",
    glassesRelationship: "dark sunglasses occlude both eyes and most brow evidence", limitations: ["eyes and brows are not quantization-scoreable behind sunglasses"],
  },
  "wavy-open-blazer": {
    eyeSpacing: "medium", eyeFootprint: "medium", eyeOpenness: "normal", eyeAsymmetry: "unknown",
    browStrength: "strong", browEyeDistance: "normal", browSlope: "arched",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "normal", mouthFullness: "full",
    glassesRelationship: "none", limitations: [],
  },
  "striped-open-shirt": {
    eyeSpacing: "medium", eyeFootprint: "compact", eyeOpenness: "narrow", eyeAsymmetry: "unknown",
    browStrength: "medium", browEyeDistance: "normal", browSlope: "straight",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "normal", mouthFullness: "full",
    glassesRelationship: "none", limitations: ["slight turn makes left/right asymmetry unsuitable for identity scoring"],
  },
  "sleeveless-bag-skirt": {
    eyeSpacing: "medium", eyeFootprint: "medium", eyeOpenness: "normal", eyeAsymmetry: "unknown",
    browStrength: "strong", browEyeDistance: "normal", browSlope: "arched",
    mouthWidth: "medium", mouthOpenness: "closed", mouthTopology: "neutral", mouthVerticalPlacement: "normal", mouthFullness: "thin",
    glassesRelationship: "none", limitations: ["low camera angle makes exact vertical coordinates unsuitable"],
  },
};

interface Replay {
  source: RawImage;
  sourceFace: RawImage;
  analysis: ReturnType<typeof analysisFromAnnotation>;
  plan: SkinPlan;
  atlas: RawImage;
  evidenceTier: "A" | "B" | "C" | "D";
  sourceAudit?: SourceVisibleCueAudit;
}

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function loadSource(c: AnnotatedCase): Promise<RawImage> {
  const path = c.existing
    ? resolve(`evaluation-artifacts/facial-feature-renderer-20260904/${c.id}/01-source.png`)
    : join(GENERALIZATION_ROOT, `sources/${c.photoId}.jpg`);
  const bytes = new Uint8Array(await readFile(path));
  if (c.existing) return decodePng(bytes);
  const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
  return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}

async function buildReplay(c: AnnotatedCase): Promise<Replay> {
  const source = await loadSource(c);
  const analysis = analysisFromAnnotation(c);
  if (c.existing) {
    const stored = JSON.parse(await readFile(resolve(`evaluation-artifacts/head-structure-iteration-final/${c.id}/metrics.json`), "utf8")) as { sourceGeometryAfter: unknown };
    const geometry = parseIdentityGeometry(stored.sourceGeometryAfter);
    if (!geometry) throw new Error(`${c.id}: invalid stored geometry`);
    analysis.identityGeometry = geometry;
  }
  const normalized = normalizeAnalysisForRendering(structuredClone(analysis));
  const features = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  const style = buildFaceStyle(normalized, features);
  const plan = buildSkinPlan(normalized);
  const atlas = buildProceduralFallbackAtlas(features, style, plan);
  if (!atlas) throw new Error(`${c.id}: production atlas rejected`);
  return {
    source,
    sourceFace: crop(source, c.headBox),
    analysis,
    plan,
    atlas,
    evidenceTier: c.existing ? "A" : MANUAL_SOURCE_AUDIT[c.id] ? "C" : "D",
    sourceAudit: MANUAL_SOURCE_AUDIT[c.id],
  };
}

function distinctAxes(first: SourceVisibleCueAudit | undefined, second: SourceVisibleCueAudit | undefined): string[] {
  if (!first || !second) return [];
  const axes: Array<keyof Omit<SourceVisibleCueAudit, "limitations" | "glassesRelationship">> = [
    "eyeSpacing", "eyeFootprint", "eyeOpenness", "eyeAsymmetry",
    "browStrength", "browEyeDistance", "browSlope",
    "mouthWidth", "mouthOpenness", "mouthTopology", "mouthVerticalPlacement", "mouthFullness",
  ];
  return axes.filter((axis) => first[axis] !== "unknown" && second[axis] !== "unknown" && first[axis] !== second[axis]);
}

function collisionPairs(replays: Map<string, Replay>): Array<{ pair: [string, string]; distinctAxes: string[] }> {
  const samples = [...replays].map(([id, replay]) => ({ id, plan: replay.plan.facePixelPlan }));
  return findFacePlanCollisions(samples).flatMap((collision) => {
    const pairs: Array<{ pair: [string, string]; distinctAxes: string[] }> = [];
    for (let left = 0; left < collision.ids.length; left++) for (let right = left + 1; right < collision.ids.length; right++) {
      const first = replays.get(collision.ids[left])!;
      const second = replays.get(collision.ids[right])!;
      pairs.push({ pair: [collision.ids[left], collision.ids[right]], distinctAxes: distinctAxes(first.sourceAudit, second.sourceAudit) });
    }
    return pairs;
  });
}

function featureCategory(plan: FacePixelPlan, atlasX: number, atlasY: number): "eyes" | "brows" | "mouth" | undefined {
  const face = CLASSIC_LAYOUT.head.base.front;
  const x = atlasX - face.x;
  const y = atlasY - face.y;
  const pixel = plan.pixels.find((candidate) => candidate.x === x && candidate.y === y);
  if (!pixel) return undefined;
  if (pixel.role === "brow") return "brows";
  if (pixel.cluster === "left_eye" || pixel.cluster === "right_eye") return "eyes";
  if (pixel.cluster === "mouth") return "mouth";
  return undefined;
}

function atlasDifference(before: RawImage, after: RawImage, beforePlan: FacePixelPlan, afterPlan: FacePixelPlan) {
  const headCells = new Set<string>();
  for (const layer of ["base", "overlay"] as const) for (const rect of Object.values(CLASSIC_LAYOUT.head[layer])) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) headCells.add(`${x},${y}`);
  }
  const counts = { changed: 0, eyes: 0, brows: 0, mouth: 0, otherHead: 0, body: 0 };
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const offset = (y * before.width + x) * 4;
    if (![0, 1, 2, 3].some((channel) => before.rgba[offset + channel] !== after.rgba[offset + channel])) continue;
    counts.changed++;
    const category = featureCategory(afterPlan, x, y) ?? featureCategory(beforePlan, x, y);
    if (category) counts[category]++;
    else if (headCells.has(`${x},${y}`)) counts.otherHead++;
    else counts.body++;
  }
  return counts;
}

async function writePng(path: string, image: RawImage): Promise<void> {
  await writeFile(path, await encodePng(image));
}

describe.skipIf(!RUN)("frozen 12-person face quantization generalization", () => {
  it("freezes and compares source-supported plan collisions without any API call", async () => {
    expect(["before", "after"]).toContain(PHASE);
    const cases = JSON.parse(await readFile(join(GENERALIZATION_ROOT, "annotations.json"), "utf8")) as AnnotatedCase[];
    const manualIds = cases.filter((c) => !c.existing).map((c) => c.id).sort();
    expect(Object.keys(MANUAL_SOURCE_AUDIT).sort()).toEqual(manualIds);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network forbidden in offline face replay"); });
    try {
      const replayEntries = await Promise.all(cases.map(async (c) => [c.id, await buildReplay(c)] as const));
      const replays = new Map(replayEntries);
      const collisions = collisionPairs(replays);
      const sourceDistinct = collisions.filter((pair) => pair.distinctAxes.length > 0);
      const summaries = Object.fromEntries([...replays].map(([id, replay]) => {
        const facePlan = replay.plan.facePixelPlan;
        const exactRetention = replay.evidenceTier === "A" ? measureFaceIdentityRetention(replay.analysis, facePlan) : null;
        const quantizedToRendered = measureFaceIdentityRetention(replay.analysis, facePlan).stageRetention.quantizedToRendered;
        const readability = measureFacialFeatureReadability(replay.atlas, facePlan);
        return [id, {
          productionAccepted: true,
          evidenceTier: replay.evidenceTier,
          sourceAudit: replay.sourceAudit ?? null,
          analysisHash: hash(JSON.stringify(replay.analysis)),
          signature: measureFaceIdentityAxisSignatures(facePlan),
          layout: facePlan.layout,
          salience: facePlan.salience,
          exactRetention,
          quantizedToRendered,
          planToAtlasRetention: readability.protectedPixelRetention,
          candidateCount: buildFacePixelPlanVariants(replay.analysis, 99).length,
          atlasHash: hash(replay.atlas.rgba),
        }];
      }));
      const snapshot = {
        phase: PHASE,
        apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 },
        coverage: Object.fromEntries([...replays].map(([id, replay]) => [id, replay.evidenceTier])),
        collisions,
        sourceDistinctCollisionPairs: sourceDistinct,
        collisionDenominator: sourceDistinct.length,
        cases: summaries,
      };
      if (PHASE === "before") {
        const alreadyFrozen = await readFile(join(OUTPUT_ROOT, "before", "summary.json")).then(() => true, () => false);
        if (alreadyFrozen) throw new Error("face quantization baseline is already frozen");
        for (const [id, replay] of replays) {
          const directory = join(OUTPUT_ROOT, "before", id);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "face-plan.json"), JSON.stringify(replay.plan.facePixelPlan, null, 2));
          await writePng(join(directory, "atlas.png"), replay.atlas);
        }
        await mkdir(join(OUTPUT_ROOT, "before"), { recursive: true });
        await writeFile(join(OUTPUT_ROOT, "before", "summary.json"), JSON.stringify(snapshot, null, 2), { flag: "wx" });
      } else {
        const before = JSON.parse(await readFile(join(OUTPUT_ROOT, "before", "summary.json"), "utf8")) as typeof snapshot;
        const baselinePairs = before.sourceDistinctCollisionPairs;
        const currentSignatures = new Map([...replays].map(([id, replay]) => [id, measureFaceIdentityAxisSignatures(replay.plan.facePixelPlan).full]));
        const remaining = baselinePairs.filter(({ pair }) => currentSignatures.get(pair[0]) === currentSignatures.get(pair[1]));
        const pixelDiff: Record<string, unknown> = {};
        for (const [id, replay] of replays) {
          expect(summaries[id].analysisHash, `${id}: source analysis changed`).toBe(before.cases[id].analysisHash);
          const baselineDirectory = join(OUTPUT_ROOT, "before", id);
          const beforePlan = JSON.parse(await readFile(join(baselineDirectory, "face-plan.json"), "utf8")) as FacePixelPlan;
          const beforeAtlas = await decodePng(new Uint8Array(await readFile(join(baselineDirectory, "atlas.png"))));
          const planChanged = measureFaceIdentityAxisSignatures(beforePlan).full !== measureFaceIdentityAxisSignatures(replay.plan.facePixelPlan).full;
          const diff = atlasDifference(beforeAtlas, replay.atlas, beforePlan, replay.plan.facePixelPlan);
          pixelDiff[id] = { planChanged, ...measureFacePlanPixelDifference(beforePlan, replay.plan.facePixelPlan), atlas: diff };
          expect(diff.body, `${id}: body pixels changed`).toBe(0);
          expect(diff.otherHead, `${id}: unrelated head/hair/accessory pixels changed`).toBe(0);
          if (!planChanged) {
            expect(diff.changed, `${id}: atlas changed without a face-plan change`).toBe(0);
            continue;
          }
          const beforeViews = renderSkinViews(beforeAtlas);
          const afterViews = renderSkinViews(replay.atlas);
          const head = (views: ReturnType<typeof renderSkinViews>, name: "front" | "front_left_three_quarter" | "front_right_three_quarter") =>
            extractRenderedHeadView(views.find((view) => view.name === name)!);
          await writeIdentityEvaluationArtifacts(join(OUTPUT_ROOT, "changed-cases"), id, {
            sourceFace: replay.sourceFace,
            facePixelPlan: replay.plan.facePixelPlan,
            oldFacePixelPlan: beforePlan,
            facePixelDiff: renderFacePixelDifference(beforePlan, replay.plan.facePixelPlan),
            beforeHeadFront: head(beforeViews, "front"),
            beforeHeadFrontLeft: head(beforeViews, "front_left_three_quarter"),
            beforeHeadFrontRight: head(beforeViews, "front_right_three_quarter"),
            finalHeadFront: head(afterViews, "front"),
            finalHeadFrontLeft: head(afterViews, "front_left_three_quarter"),
            finalHeadFrontRight: head(afterViews, "front_right_three_quarter"),
            finalHeadLeft: head(afterViews, "front_left_three_quarter"),
            finalHeadRight: head(afterViews, "front_right_three_quarter"),
            finalSkin: replay.atlas,
            critique: { status: "not_run", reason: "offline deterministic quantization replay" },
            metrics: { before: before.cases[id], after: summaries[id], pixelDiff: pixelDiff[id] },
          });
        }
        const after = {
          ...snapshot,
          baselineSourceDistinctCollisionPairs: baselinePairs,
          remainingSourceDistinctCollisionPairs: remaining,
          sourceDistinctCollisionBefore: baselinePairs.length,
          sourceDistinctCollisionAfter: remaining.length,
          collisionDenominator: baselinePairs.length,
          pixelDiff,
        };
        await mkdir(join(OUTPUT_ROOT, "after"), { recursive: true });
        await writeFile(join(OUTPUT_ROOT, "after", "summary.json"), JSON.stringify(after, null, 2));
        expect(remaining.length).toBeLessThanOrEqual(baselinePairs.length);
      }
      expect([...replays.values()].filter((replay) => replay.evidenceTier === "A").every((replay) =>
        measureFaceIdentityRetention(replay.analysis, replay.plan.facePixelPlan).stageRetention.quantizedToRendered === 1,
      )).toBe(true);
      expect([...replays.values()].filter((replay) => replay.plan.facePixelPlan.glassesPlan.topology === "none").every((replay) =>
        measureFacialFeatureReadability(replay.atlas, replay.plan.facePixelPlan).protectedPixelRetention === 1,
      )).toBe(true);
      expect([...replays.values()].every((replay) => buildFacePixelPlanVariants(replay.analysis, 99).length <= 3)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120000);
});
