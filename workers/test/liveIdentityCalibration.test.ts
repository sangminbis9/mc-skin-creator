/**
 * Opt-in, single-sample blind calibration of the production identity evaluator.
 *
 * This is evaluation-only code. It replays stored public-photo crops, geometry,
 * face plans, and final atlases. It never invokes photo analysis or generation.
 * Run with RUN_LIVE_IDENTITY_CALIBRATION=1 and GEMINI_API_KEY set.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IdentityFeatureCategory, PhotoAnalysis } from "../src/analysis";
import type { IdentityGeometryAnalysis } from "../src/identityGeometry";
import {
  assessEvaluatorHealth,
  assessIdentitySensitivity,
  buildIdentityCalibrationAtlases,
  type CalibrationBenchmarkObservation,
  type IdentityCalibrationAtlas,
  validateCalibrationBenchmark,
} from "../src/identityCalibration";
import {
  assessPairwiseOrderBias,
  runHeadPairwiseComparison,
  type HeadPairwiseReview,
  type HeadPairwiseResult,
} from "../src/headIdentity";
import type { FacePixelPlan } from "../src/identityPlans";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import {
  buildPairwiseHeadEvidence,
  buildSkinViewMontage,
  renderSkinViews,
} from "../src/skinRender";
import {
  runSkinCritique,
  type SkinCritique,
  type SkinCritiqueResult,
} from "../src/skinCritique";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";

const LIVE = process.env.RUN_LIVE_IDENTITY_CALIBRATION === "1";
const MODEL = process.env.LIVE_GEMINI_VISION_MODEL?.trim() || "gemini-3.6-flash";
const INTER_CALL_DELAY_MS = Number(
  process.env.IDENTITY_CALIBRATION_INTER_CALL_DELAY_MS || "3500",
);
const REPLAY_ROOT = resolve(
  process.env.IDENTITY_CALIBRATION_REPLAY_ROOT ||
    "evaluation-artifacts/head-structure-iteration-final",
);
const OUTPUT_ROOT = resolve(
  process.env.IDENTITY_CALIBRATION_OUTPUT_ROOT ||
    "evaluation-artifacts/evaluator-calibration-live",
);
const CASE_IDS = ["glasses-monochrome", "short-hair-red-shirt"] as const;

type CaseId = (typeof CASE_IDS)[number];
type CandidateLabel = "A" | "B" | "C" | "D";
type RequestStatus = "pending" | "success" | "failed" | "quota_failed";

type RequestSpec =
  | { id: string; case: CaseId; type: "absolute"; candidate: CandidateLabel }
  | {
      id: string;
      case: CaseId;
      type: "pairwise";
      candidates: readonly [CandidateLabel, CandidateLabel];
    };

export const LIVE_CALIBRATION_REQUEST_SPECS: readonly RequestSpec[] = [
  { id: "01-glasses-absolute-A", case: "glasses-monochrome", type: "absolute", candidate: "A" },
  { id: "02-glasses-absolute-B", case: "glasses-monochrome", type: "absolute", candidate: "B" },
  { id: "03-glasses-absolute-C", case: "glasses-monochrome", type: "absolute", candidate: "C" },
  { id: "04-glasses-absolute-D", case: "glasses-monochrome", type: "absolute", candidate: "D" },
  { id: "05-glasses-pairwise-A-C", case: "glasses-monochrome", type: "pairwise", candidates: ["A", "C"] },
  { id: "06-glasses-pairwise-C-A", case: "glasses-monochrome", type: "pairwise", candidates: ["C", "A"] },
  { id: "07-glasses-pairwise-A-D", case: "glasses-monochrome", type: "pairwise", candidates: ["A", "D"] },
  { id: "08-glasses-pairwise-D-A", case: "glasses-monochrome", type: "pairwise", candidates: ["D", "A"] },
  { id: "09-short-absolute-A", case: "short-hair-red-shirt", type: "absolute", candidate: "A" },
  { id: "10-short-absolute-B", case: "short-hair-red-shirt", type: "absolute", candidate: "B" },
  { id: "11-short-absolute-C", case: "short-hair-red-shirt", type: "absolute", candidate: "C" },
  { id: "12-short-absolute-D", case: "short-hair-red-shirt", type: "absolute", candidate: "D" },
  { id: "13-short-pairwise-A-C", case: "short-hair-red-shirt", type: "pairwise", candidates: ["A", "C"] },
  { id: "14-short-pairwise-A-D", case: "short-hair-red-shirt", type: "pairwise", candidates: ["A", "D"] },
] as const;

interface SavedMetrics {
  sourceGeometryAfter: IdentityGeometryAnalysis;
  newFacePixelPlan: FacePixelPlan;
}

interface SavedP5Check {
  feature: string;
  status: "present" | "weak" | "missing" | "wrong";
  evidence: string;
  targetRegions: string[];
}

interface SavedCritique {
  after: {
    ok: boolean;
    critique?: { p5IdentityChecks?: SavedP5Check[] };
  };
}

interface ReplayCase {
  id: CaseId;
  analysis: PhotoAnalysis;
  skinPlan: SkinPlan;
  facePlan: FacePixelPlan;
  sourceFaceBytes: Uint8Array;
  sourceHeadBytes: Uint8Array;
  sourceFaceDataUrl: string;
  sourceHeadDataUrl: string;
  currentAtlas: RawImage;
  variants: IdentityCalibrationAtlas[];
}

function bytesToDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function imageToDataUrl(image: RawImage): Promise<string> {
  return bytesToDataUrl(await encodePng(image));
}

function featureCategory(feature: string, regions: string[]): IdentityFeatureCategory {
  const text = `${feature} ${regions.join(" ")}`.toLowerCase();
  if (/glass|frame|spectacle|earring|scarf|accessor/.test(text)) return "accessory";
  if (/hair|fringe|bang|dread|curl|silhouette/.test(text)) return "hair";
  if (/shirt|torso|jacket|sweater|outfit|collar/.test(text)) return "outfit";
  if (/tone|color|colour/.test(text)) return "color";
  return "face";
}

function buildReplayAnalysis(
  geometry: IdentityGeometryAnalysis,
  p5Checks: SavedP5Check[],
): PhotoAnalysis {
  const features = p5Checks.map((check) => ({
    feature: check.feature,
    category: featureCategory(check.feature, check.targetRegions),
    priority: 5 as const,
    confidence: "high" as const,
    // The saved critique is used only to recover canonical cue names and
    // regions. Candidate-specific prior critique wording is never replayed to
    // the blind evaluator.
    evidence: "Saved source-analysis cue; verify it directly against the source crops.",
    targetRegions: check.targetRegions,
  }));
  const cueText = features.map((feature) => feature.feature).join(", ");
  const base = makeAnalysis();
  return {
    ...base,
    observed: {
      ...base.observed,
      face: `Stored source evidence for: ${cueText}`,
      hair: `Stored source head evidence for: ${cueText}`,
      accessories: `Stored source accessory evidence for: ${cueText}`,
      clothing: `Stored source clothing evidence for: ${cueText}`,
    },
    canonicalIdentity: {
      overallImpression: cueText,
      mustPreserve: features.map((feature) => feature.feature),
      features,
    },
    identityPrompt: cueText,
    outfitPrompt: "Match only the clothing visibly supported by the source crop.",
    identityGeometry: geometry,
  };
}

async function readReplayCase(id: CaseId): Promise<ReplayCase> {
  const directory = join(REPLAY_ROOT, id);
  const [metricsBytes, critiqueBytes, sourceFaceBytes, sourceHeadBytes, atlasBytes] =
    await Promise.all([
      readFile(join(directory, "metrics.json")),
      readFile(join(directory, "critique.json")),
      readFile(join(directory, "01-source-face.png")),
      readFile(join(directory, "01b-source-head.png")),
      readFile(join(directory, "10-final-skin.png")),
    ]);
  const metrics = JSON.parse(metricsBytes.toString("utf8")) as SavedMetrics;
  const savedCritique = JSON.parse(critiqueBytes.toString("utf8")) as SavedCritique;
  const p5Checks = savedCritique.after.critique?.p5IdentityChecks;
  if (!metrics.sourceGeometryAfter || !metrics.newFacePixelPlan || !p5Checks?.length) {
    throw new Error(`${id}: stored replay evidence is incomplete`);
  }
  const analysis = buildReplayAnalysis(metrics.sourceGeometryAfter, p5Checks);
  const builtPlan = buildSkinPlan(analysis);
  const skinPlan = { ...builtPlan, facePixelPlan: metrics.newFacePixelPlan };
  const currentAtlas = await decodePng(atlasBytes);
  return {
    id,
    analysis,
    skinPlan,
    facePlan: metrics.newFacePixelPlan,
    sourceFaceBytes,
    sourceHeadBytes,
    sourceFaceDataUrl: bytesToDataUrl(sourceFaceBytes),
    sourceHeadDataUrl: bytesToDataUrl(sourceHeadBytes),
    currentAtlas,
    variants: buildIdentityCalibrationAtlases(
      currentAtlas,
      metrics.newFacePixelPlan,
      builtPlan.hairPlan,
    ),
  };
}

function candidateLabel(level: IdentityCalibrationAtlas["level"]): CandidateLabel {
  return level === "A_identical"
    ? "A"
    : level === "B_minor"
      ? "B"
      : level === "C_degraded"
        ? "C"
        : "D";
}

function candidateWinner(
  review: Pick<HeadPairwiseReview, "winner">,
  labels: readonly [CandidateLabel, CandidateLabel],
): CandidateLabel | "tie" {
  return review.winner === "A" ? labels[0] : review.winner === "B" ? labels[1] : "tie";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function paceLiveCalls(completedCalls: number): Promise<void> {
  if (completedCalls === 0 || !Number.isFinite(INTER_CALL_DELAY_MS) || INTER_CALL_DELAY_MS <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, INTER_CALL_DELAY_MS));
}

async function writeCaseImages(
  replay: ReplayCase,
  montages: Map<CandidateLabel, RawImage>,
): Promise<string> {
  const directory = join(OUTPUT_ROOT, replay.id);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "source-face.png"), replay.sourceFaceBytes),
    writeFile(join(directory, "source-head.png"), replay.sourceHeadBytes),
    ...(["A", "B", "C", "D"] as const).map(async (label) => {
      const names = {
        A: "A-current.png",
        B: "B-minor.png",
        C: "C-degraded.png",
        D: "D-generic.png",
      } as const;
      await writeFile(join(directory, names[label]), await encodePng(montages.get(label)!));
    }),
  ]);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface PreparedImage {
  image: RawImage;
  dataUrl: string;
  sha256: string;
}

interface PreparedCase {
  replay: ReplayCase;
  directory: string;
  variants: Map<CandidateLabel, IdentityCalibrationAtlas>;
  atlasSha256: Map<CandidateLabel, string>;
  montages: Map<CandidateLabel, PreparedImage>;
  headPanels: Map<CandidateLabel, PreparedImage>;
  absoluteResults: AbsoluteArtifact[];
  pairwiseResults: PairwiseArtifact[];
}

interface ManifestRequest {
  id: string;
  requestNumber: number;
  case: CaseId;
  type: "absolute" | "pairwise";
  candidates: CandidateLabel[];
  candidateSha256: Record<string, string>;
  requestImageSha256: string[];
  status: RequestStatus;
  attempts: number;
  requestedAt?: string;
  completedAt?: string;
  detail?: string;
}

interface CalibrationManifest {
  experiment: "identity-calibration-live";
  createdAt: string;
  head: string;
  model: string;
  plannedRequests: 14;
  priorPreCheckpointAttempts: {
    attempted: 2;
    retainedSamples: 0;
    note: string;
  };
  requests: ManifestRequest[];
}

interface AbsoluteArtifact {
  requestId: string;
  requestNumber: number;
  case: CaseId;
  candidate: CandidateLabel;
  candidateSha256: string;
  requestImageSha256: string;
  model: string;
  requestedAt: string;
  completedAt: string;
  status: RequestStatus;
  changedPixels: number;
  changedIdentityDimensions: string[];
  result: SkinCritiqueResult;
  identity?: number;
  faceHair?: number;
  outfit?: number;
  consistency?: number;
  layer?: number;
  samePersonReadability?: SkinCritique["identityDiagnosis"]["samePersonReadability"];
  genericization?: SkinCritique["identityDiagnosis"]["genericization"];
  strongestPreservedCues?: string[];
  strongestLostCues?: string[];
  p5Status?: SkinCritique["p5IdentityChecks"];
  criticalDefects?: SkinCritique["defects"];
}

interface PairwiseArtifact {
  requestId: string;
  requestNumber: number;
  case: CaseId;
  candidates: [CandidateLabel, CandidateLabel];
  candidateSha256: [string, string];
  requestImageSha256: [string, string];
  model: string;
  requestedAt: string;
  completedAt: string;
  status: RequestStatus;
  result: HeadPairwiseResult;
  normalizedWinner?: CandidateLabel | "tie";
}

async function prepareCase(id: CaseId): Promise<PreparedCase> {
  const replay = await readReplayCase(id);
  const variants = new Map<CandidateLabel, IdentityCalibrationAtlas>();
  const atlasSha256 = new Map<CandidateLabel, string>();
  const montages = new Map<CandidateLabel, PreparedImage>();
  const headPanels = new Map<CandidateLabel, PreparedImage>();
  for (const variant of replay.variants) {
    const label = candidateLabel(variant.level);
    const views = renderSkinViews(variant.atlas);
    const montage = buildSkinViewMontage(views);
    const panel = buildPairwiseHeadEvidence(views);
    const [atlasBytes, montageBytes, panelBytes] = await Promise.all([
      encodePng(variant.atlas),
      encodePng(montage),
      encodePng(panel),
    ]);
    variants.set(label, variant);
    atlasSha256.set(label, sha256(atlasBytes));
    montages.set(label, {
      image: montage,
      dataUrl: bytesToDataUrl(montageBytes),
      sha256: sha256(montageBytes),
    });
    headPanels.set(label, {
      image: panel,
      dataUrl: bytesToDataUrl(panelBytes),
      sha256: sha256(panelBytes),
    });
  }
  return {
    replay,
    directory: join(OUTPUT_ROOT, id),
    variants,
    atlasSha256,
    montages,
    headPanels,
    absoluteResults: [],
    pairwiseResults: [],
  };
}

function buildManifest(cases: Map<CaseId, PreparedCase>, head: string): CalibrationManifest {
  const requests = LIVE_CALIBRATION_REQUEST_SPECS.map((spec, index): ManifestRequest => {
    const prepared = cases.get(spec.case)!;
    const candidates = spec.type === "absolute" ? [spec.candidate] : [...spec.candidates];
    const images = spec.type === "absolute" ? prepared.montages : prepared.headPanels;
    return {
      id: spec.id,
      requestNumber: index + 1,
      case: spec.case,
      type: spec.type,
      candidates,
      candidateSha256: Object.fromEntries(
        candidates.map((candidate) => [candidate, prepared.atlasSha256.get(candidate)!]),
      ),
      requestImageSha256: candidates.map((candidate) => images.get(candidate)!.sha256),
      status: "pending",
      attempts: 0,
    };
  });
  return {
    experiment: "identity-calibration-live",
    createdAt: new Date().toISOString(),
    head,
    model: MODEL,
    plannedRequests: 14,
    priorPreCheckpointAttempts: {
      attempted: 2,
      retainedSamples: 0,
      note: "One glasses A response and one glasses B quota failure occurred before durable checkpointing; neither is reused.",
    },
    requests,
  };
}

function statusFor(result: SkinCritiqueResult | HeadPairwiseResult): RequestStatus {
  return result.ok ? "success" : result.quotaExceeded ? "quota_failed" : "failed";
}

async function saveManifest(manifest: CalibrationManifest): Promise<void> {
  await writeJson(join(OUTPUT_ROOT, "manifest.json"), manifest);
}

async function loadOrCreateManifest(
  planned: CalibrationManifest,
): Promise<{ manifest: CalibrationManifest; fresh: boolean }> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const existing = await readdir(OUTPUT_ROOT);
  if (existing.length === 0) {
    await writeFile(
      join(OUTPUT_ROOT, "manifest.json"),
      JSON.stringify(planned, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
    return { manifest: planned, fresh: true };
  }
  if (!existing.includes("manifest.json")) {
    throw new Error(`Existing calibration output has no resumable manifest: ${OUTPUT_ROOT}`);
  }
  const manifest = JSON.parse(
    await readFile(join(OUTPUT_ROOT, "manifest.json"), "utf8"),
  ) as CalibrationManifest;
  if (
    manifest.experiment !== planned.experiment ||
    manifest.model !== planned.model ||
    manifest.head !== planned.head ||
    manifest.requests.length !== planned.requests.length ||
    manifest.requests.some((request, index) =>
      request.id !== planned.requests[index].id ||
      JSON.stringify(request.candidateSha256) !== JSON.stringify(planned.requests[index].candidateSha256) ||
      JSON.stringify(request.requestImageSha256) !== JSON.stringify(planned.requests[index].requestImageSha256)
    )
  ) {
    throw new Error("Existing manifest does not match the frozen calibration plan");
  }
  for (const request of manifest.requests) {
    if (request.status === "pending" && request.attempts > 0) {
      request.status = "failed";
      request.completedAt = new Date().toISOString();
      request.detail = "Process ended after dispatch; slot sealed without retry";
    }
  }
  await saveManifest(manifest);
  return { manifest, fresh: false };
}

async function loadResultArray<T>(path: string): Promise<T[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error(`Expected an array in ${path}`);
    return value as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function manifestIntegrity(
  manifest: CalibrationManifest,
  cases: Map<CaseId, PreparedCase>,
): Record<string, unknown> {
  const ids = manifest.requests.map((request) => request.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const hashMismatches = manifest.requests.flatMap((request) => {
    const prepared = cases.get(request.case)!;
    const images = request.type === "absolute" ? prepared.montages : prepared.headPanels;
    return request.candidates.flatMap((candidate, index) => {
      const atlasMatches = request.candidateSha256[candidate] === prepared.atlasSha256.get(candidate);
      const imageMatches = request.requestImageSha256[index] === images.get(candidate)?.sha256;
      return atlasMatches && imageMatches ? [] : [`${request.id}:${candidate}`];
    });
  });
  return {
    plannedRequests: manifest.requests.length,
    absoluteRequests: manifest.requests.filter((request) => request.type === "absolute").length,
    pairwiseRequests: manifest.requests.filter((request) => request.type === "pairwise").length,
    attempted: manifest.requests.filter((request) => request.attempts === 1).length,
    duplicateIds,
    attemptsAboveOne: manifest.requests.filter((request) => request.attempts > 1).map((request) => request.id),
    hashMismatches,
    valid:
      manifest.requests.length === 14 &&
      duplicateIds.length === 0 &&
      hashMismatches.length === 0 &&
      manifest.requests.every((request) => request.attempts <= 1),
  };
}

function findPairwise(
  entries: PairwiseArtifact[],
  first: CandidateLabel,
  second: CandidateLabel,
): PairwiseArtifact | undefined {
  return entries.find((entry) => entry.candidates[0] === first && entry.candidates[1] === second);
}

describe("live calibration request manifest", () => {
  it("predefines exactly eight absolute and six unique pairwise request slots", () => {
    expect(LIVE_CALIBRATION_REQUEST_SPECS).toHaveLength(14);
    expect(LIVE_CALIBRATION_REQUEST_SPECS.filter((request) => request.type === "absolute")).toHaveLength(8);
    expect(LIVE_CALIBRATION_REQUEST_SPECS.filter((request) => request.type === "pairwise")).toHaveLength(6);
    expect(new Set(LIVE_CALIBRATION_REQUEST_SPECS.map((request) => request.id)).size).toBe(14);
  });
});

describe.skipIf(!LIVE)("live blind identity evaluator calibration", () => {
  it("runs each durable request slot at most once", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    const env = {
      GEMINI_API_KEY: key,
      VISION_MODEL: MODEL,
      // The same value is de-duplicated by production code, guaranteeing one
      // outbound model call per request slot and no fallback sample.
      VISION_FALLBACK_MODEL: MODEL,
      GEMINI_STRUCTURED_TIMEOUT_MS:
        process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS || "90000",
    } as Env;

    // Freeze both cases and every A/B/C/D atlas before the first live request.
    const preparedList = await Promise.all(CASE_IDS.map((id) => prepareCase(id)));
    const cases = new Map(preparedList.map((prepared) => [prepared.replay.id, prepared]));
    const plannedManifest = buildManifest(cases, process.env.IDENTITY_CALIBRATION_HEAD || "f7c9ec6");
    const { manifest, fresh } = await loadOrCreateManifest(plannedManifest);
    for (const prepared of preparedList) {
      if (fresh) {
        await writeCaseImages(
          prepared.replay,
          new Map(
            [...prepared.montages].map(([label, image]) => [label, image.image]),
          ),
        );
      } else {
        prepared.absoluteResults = await loadResultArray<AbsoluteArtifact>(
          join(prepared.directory, "absolute-results.json"),
        );
        prepared.pairwiseResults = await loadResultArray<PairwiseArtifact>(
          join(prepared.directory, "pairwise-results.json"),
        );
      }
    }
    const preflight = manifestIntegrity(manifest, cases);
    await writeJson(join(OUTPUT_ROOT, "manifest-integrity-preflight.json"), preflight);
    expect(preflight).toMatchObject({
      plannedRequests: 14,
      absoluteRequests: 8,
      pairwiseRequests: 6,
      duplicateIds: [],
      attemptsAboveOne: [],
      hashMismatches: [],
      valid: true,
    });

    let attempted = 0;
    let consecutiveQuotaFailures = 0;
    for (const request of manifest.requests) {
      if (consecutiveQuotaFailures >= 2) break;
      if (request.status !== "pending" || request.attempts !== 0) continue;
      await paceLiveCalls(attempted);
      const prepared = cases.get(request.case)!;
      request.attempts = 1;
      request.requestedAt = new Date().toISOString();
      // Persist dispatch before the request. A process restart sees attempts=1
      // and must never return this slot to pending for a second sample.
      await saveManifest(manifest);
      attempted++;

      if (request.type === "absolute") {
        const candidate = request.candidates[0];
        const variant = prepared.variants.get(candidate)!;
        const result = await runSkinCritique(
          env,
          prepared.replay.analysis,
          [prepared.replay.sourceHeadDataUrl],
          prepared.montages.get(candidate)!.dataUrl,
          prepared.replay.skinPlan,
          variant.atlas,
          prepared.replay.sourceFaceDataUrl,
        );
        const completedAt = new Date().toISOString();
        const status = statusFor(result);
        const artifact: AbsoluteArtifact = {
          requestId: request.id,
          requestNumber: request.requestNumber,
          case: request.case,
          candidate,
          candidateSha256: request.candidateSha256[candidate],
          requestImageSha256: request.requestImageSha256[0],
          model: MODEL,
          requestedAt: request.requestedAt,
          completedAt,
          status,
          changedPixels: variant.changedPixels,
          changedIdentityDimensions: variant.changedIdentityDimensions,
          result,
          ...(result.ok
            ? {
                identity: result.critique.identityScore,
                faceHair: result.critique.faceHairScore,
                outfit: result.critique.outfitScore,
                consistency: result.critique.consistencyScore,
                layer: result.critique.layerScore,
                samePersonReadability: result.critique.identityDiagnosis.samePersonReadability,
                genericization: result.critique.identityDiagnosis.genericization,
                strongestPreservedCues: result.critique.identityDiagnosis.strongestPreservedCues,
                strongestLostCues: result.critique.identityDiagnosis.strongestLostCues,
                p5Status: result.critique.p5IdentityChecks,
                criticalDefects: result.critique.defects.filter((defect) => defect.severity === "critical"),
              }
            : {}),
        };
        prepared.absoluteResults.push(artifact);
        await writeJson(join(prepared.directory, "absolute-results.json"), prepared.absoluteResults);
        request.status = status;
        request.completedAt = completedAt;
        if (!result.ok) request.detail = result.detail;
      } else {
        const candidates = request.candidates as [CandidateLabel, CandidateLabel];
        const result = await runHeadPairwiseComparison(
          env,
          prepared.replay.analysis,
          prepared.replay.sourceFaceDataUrl,
          prepared.headPanels.get(candidates[0])!.dataUrl,
          prepared.headPanels.get(candidates[1])!.dataUrl,
          "candidate_selection",
          prepared.replay.sourceHeadDataUrl,
        );
        const completedAt = new Date().toISOString();
        const status = statusFor(result);
        const artifact: PairwiseArtifact = {
          requestId: request.id,
          requestNumber: request.requestNumber,
          case: request.case,
          candidates,
          candidateSha256: [
            request.candidateSha256[candidates[0]],
            request.candidateSha256[candidates[1]],
          ],
          requestImageSha256: [request.requestImageSha256[0], request.requestImageSha256[1]],
          model: MODEL,
          requestedAt: request.requestedAt,
          completedAt,
          status,
          result,
          ...(result.ok ? { normalizedWinner: candidateWinner(result.review, candidates) } : {}),
        };
        prepared.pairwiseResults.push(artifact);
        await writeJson(join(prepared.directory, "pairwise-results.json"), prepared.pairwiseResults);
        request.status = status;
        request.completedAt = completedAt;
        if (!result.ok) request.detail = result.detail;
      }

      // Persist terminal status immediately. Failed/quota slots are never
      // returned to pending and therefore can never be retried by this run.
      await saveManifest(manifest);
      if (request.status === "quota_failed") consecutiveQuotaFailures++;
      else consecutiveQuotaFailures = 0;
    }

    const aggregate: Record<string, unknown>[] = [];
    for (const prepared of preparedList) {
      const successfulAbsolute = prepared.absoluteResults.filter(
        (entry): entry is AbsoluteArtifact & { result: Extract<SkinCritiqueResult, { ok: true }> } => entry.result.ok,
      );
      const successfulPairwise = prepared.pairwiseResults.filter(
        (entry): entry is PairwiseArtifact & { result: Extract<HeadPairwiseResult, { ok: true }> } => entry.result.ok,
      );
      const observations: CalibrationBenchmarkObservation[] = successfulAbsolute.map((entry) => {
        const level = prepared.variants.get(entry.candidate)!.level;
        const forward = entry.candidate === "C" || entry.candidate === "D"
          ? findPairwise(successfulPairwise, "A", entry.candidate)?.result.review
          : undefined;
        return { level, absolute: entry.result.critique, ...(forward ? { pairwise: forward } : {}) };
      });
      const orderAssessments = (["C", "D"] as const).flatMap((candidate) => {
        const forward = findPairwise(successfulPairwise, "A", candidate);
        const reversed = findPairwise(successfulPairwise, candidate, "A");
        return forward && reversed
          ? [{
              comparison: `A/${candidate}`,
              ...assessPairwiseOrderBias(forward.result.review, reversed.result.review),
            }]
          : [];
      });
      const caseRequests = manifest.requests.filter((request) => request.case === prepared.replay.id);
      const health = assessEvaluatorHealth({
        observations,
        diagnosisConflictCount: successfulAbsolute.reduce(
          (sum, entry) => sum + entry.result.calibrationConflicts.length,
          0,
        ),
        completedPairwiseComparisons: successfulPairwise.length,
        requiredPairwiseComparisons: prepared.replay.id === "glasses-monochrome" ? 4 : 2,
        liveCallFailures: caseRequests.filter(
          (request) => request.status === "failed" || request.status === "quota_failed",
        ).length,
        orderBiasDetected: orderAssessments.some((assessment) => !assessment.consistent),
      });
      const summary = {
        case: prepared.replay.id,
        evaluatorModel: MODEL,
        replay: {
          photoAnalysisCalls: 0,
          generationCalls: 0,
          sourceFaceSha256: sha256(prepared.replay.sourceFaceBytes),
          sourceHeadSha256: sha256(prepared.replay.sourceHeadBytes),
          baseAtlasSha256: prepared.atlasSha256.get("A"),
          fixedGeometrySource: "metrics.json#sourceGeometryAfter",
          fixedFacePlanSource: "metrics.json#newFacePixelPlan",
          fixedIdentityEvidenceSource:
            "feature names/regions only from critique.json#after.critique.p5IdentityChecks",
        },
        calls: {
          planned: caseRequests.length,
          attempted: caseRequests.filter((request) => request.attempts === 1).length,
          success: caseRequests.filter((request) => request.status === "success").length,
          quotaFailed: caseRequests.filter((request) => request.status === "quota_failed").length,
          failed: caseRequests.filter((request) => request.status === "failed").length,
          repeatsPerSlot: 0,
        },
        sensitivity: successfulAbsolute.length === 4
          ? assessIdentitySensitivity(
              (["A", "B", "C", "D"] as const).map((candidate, index) => ({
                id: candidate,
                retainedIdentity: [1, 0.99, 0.55, 0][index],
                critique: successfulAbsolute.find((entry) => entry.candidate === candidate)!.result.critique,
              })),
            )
          : null,
        benchmarkFailures: validateCalibrationBenchmark(observations),
        scoreDiagnosisConflicts: successfulAbsolute.flatMap((entry) =>
          entry.result.calibrationConflicts.map((conflict) => ({
            candidate: entry.candidate,
            conflict,
          })),
        ),
        orderAssessments,
        evaluatorHealth: health,
        strictGate: Object.fromEntries(
          successfulAbsolute.map((entry) => [entry.candidate, entry.result.approved]),
        ),
      };
      await writeJson(join(prepared.directory, "calibration-summary.json"), summary);
      aggregate.push(summary);
    }

    const integrity = manifestIntegrity(manifest, cases);
    await writeJson(join(OUTPUT_ROOT, "manifest-integrity.json"), integrity);
    await writeJson(join(OUTPUT_ROOT, "calibration-summary.json"), {
      planned: 14,
      attempted: manifest.requests.filter((request) => request.attempts === 1).length,
      success: manifest.requests.filter((request) => request.status === "success").length,
      quotaFailed: manifest.requests.filter((request) => request.status === "quota_failed").length,
      otherFailed: manifest.requests.filter((request) => request.status === "failed").length,
      stoppedAfterConsecutiveQuotaFailures: consecutiveQuotaFailures >= 2,
      cases: aggregate,
    });
    expect(integrity).toMatchObject({
      duplicateIds: [],
      attemptsAboveOne: [],
      hashMismatches: [],
      valid: true,
    });
    expect(attempted).toBeLessThanOrEqual(14);
  }, 1_500_000);
});
