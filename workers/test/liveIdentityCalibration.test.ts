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
  assessPairwiseDecision,
  assessPairwiseOrderBias,
  runHeadPairwiseComparison,
  type HeadPairwiseReview,
  type HeadPairwiseResult,
  type PairwiseActionableVerdict,
  type PairwiseDecision,
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
import {
  evaluatorEvidence,
  immutableRequestMatches,
  migrateCalibrationRequest,
  selectCalibrationBatch,
  type CalibrationAttemptHistoryEntry,
  type ObservationStatus,
  type ResumableCalibrationRequest,
} from "./calibrationExperiment";
import { makeAnalysis } from "./helpers";

const LIVE = process.env.RUN_LIVE_IDENTITY_CALIBRATION === "1";
const REPAIR_LIVE = process.env.RUN_LIVE_PAIRWISE_REPAIR_VALIDATION === "1";
const PREFLIGHT = process.env.RUN_IDENTITY_CALIBRATION_PREFLIGHT === "1";
const MODEL = process.env.LIVE_GEMINI_VISION_MODEL?.trim() || "gemini-3.6-flash";
const MAX_LIVE_REQUESTS = Number(process.env.MAX_LIVE_CALIBRATION_REQUESTS || "0");
const ALLOW_QUOTA_BLOCKED_RESUME =
  process.env.ALLOW_QUOTA_BLOCKED_CALIBRATION_RESUME === "1";
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

export const PAIRWISE_REPAIR_VALIDATION_SPECS = [
  { id: "repair-01-forward-A-C", direction: "forward", candidates: ["A", "C"] as const },
  { id: "repair-02-reverse-C-A", direction: "reverse", candidates: ["C", "A"] as const },
] as const;

const EXECUTION_PRIORITY: Record<string, number> = {
  "01-glasses-absolute-A": 1,
  "03-glasses-absolute-C": 2,
  "04-glasses-absolute-D": 3,
  "05-glasses-pairwise-A-C": 4,
  "07-glasses-pairwise-A-D": 5,
  "09-short-absolute-A": 6,
  "11-short-absolute-C": 7,
  "12-short-absolute-D": 8,
  "13-short-pairwise-A-C": 9,
  "14-short-pairwise-A-D": 10,
  "02-glasses-absolute-B": 11,
  "10-short-absolute-B": 12,
  "06-glasses-pairwise-C-A": 13,
  "08-glasses-pairwise-D-A": 14,
};

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

function normalizedActionableVerdict(
  verdict: PairwiseActionableVerdict,
  labels: readonly [CandidateLabel, CandidateLabel],
): CandidateLabel | PairwiseActionableVerdict {
  return verdict === "A" ? labels[0] : verdict === "B" ? labels[1] : verdict;
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

interface ManifestRequest extends ResumableCalibrationRequest {
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
  observationStatus: ObservationStatus;
  attemptHistory: CalibrationAttemptHistoryEntry[];
  executionPriority: number;
  requestedModel: string;
  effectiveModel?: string;
  promptHash: string;
  inFlightAttempt?: { requestedAt: string; requestedModel: string };
}

interface CalibrationManifest {
  experiment: "identity-calibration-live";
  createdAt: string;
  head: string;
  model: string;
  evaluatorVersion?: string;
  promptHashAlgorithm?: "sha256-template-source";
  promptHashBackfilledAt?: string;
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
  decision?: PairwiseDecision;
  normalizedActionableVerdict?: CandidateLabel | PairwiseActionableVerdict;
}

interface PairwiseRepairValidationRequest {
  id: string;
  direction: "forward" | "reverse";
  candidates: [CandidateLabel, CandidateLabel];
  candidateSha256: [string, string];
  requestImageSha256: [string, string];
  promptHash: string;
  requestedModel: string;
  effectiveModel?: string;
  status: RequestStatus;
  requestedAt?: string;
  completedAt?: string;
  inFlight?: boolean;
  result?: HeadPairwiseResult;
  rawWinner?: HeadPairwiseReview["winner"];
  normalizedWinner?: CandidateLabel | "tie";
  decision?: PairwiseDecision;
  normalizedActionableVerdict?: CandidateLabel | PairwiseActionableVerdict;
}

interface PairwiseRepairValidationManifest {
  experiment: "controlled-20260830-01";
  validation: "source-fidelity-pairwise-repair";
  baseHead: string;
  model: string;
  promptHash: string;
  priorPairwisePromptHash: string;
  sourceFaceSha256: string;
  sourceHeadSha256: string;
  authorizedRequests: 2;
  requests: PairwiseRepairValidationRequest[];
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

async function evaluatorPromptHashes(): Promise<{
  absolute: string;
  pairwise: string;
  version: string;
}> {
  const [absoluteSource, pairwiseSource] = await Promise.all([
    readFile(resolve("src/skinCritique.ts"), "utf8"),
    readFile(resolve("src/headIdentity.ts"), "utf8"),
  ]);
  const template = (source: string, label: string): string => {
    const match = /const prompt = `([\s\S]*?)`;\r?\n\s*const models/.exec(source);
    if (!match) throw new Error(`Unable to fingerprint ${label} evaluator prompt`);
    return sha256(Buffer.from(match[1], "utf8"));
  };
  const absolute = template(absoluteSource, "absolute");
  const pairwiseBlock = /export function buildHeadPairwisePrompt\([\s\S]*?\r?\n}\r?\n\r?\nexport async function runHeadPairwiseComparison/.exec(pairwiseSource)?.[0];
  if (!pairwiseBlock) throw new Error("Unable to fingerprint pairwise evaluator prompt builder");
  const pairwise = sha256(Buffer.from(pairwiseBlock, "utf8"));
  return {
    absolute,
    pairwise,
    version: `absolute:${absolute};pairwise:${pairwise}`,
  };
}

function buildManifest(
  cases: Map<CaseId, PreparedCase>,
  head: string,
  promptHashes: Awaited<ReturnType<typeof evaluatorPromptHashes>>,
): CalibrationManifest {
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
      observationStatus: "not_observed",
      attemptHistory: [],
      executionPriority: EXECUTION_PRIORITY[spec.id],
      requestedModel: MODEL,
      promptHash: spec.type === "absolute" ? promptHashes.absolute : promptHashes.pairwise,
    };
  });
  return {
    experiment: "identity-calibration-live",
    createdAt: new Date().toISOString(),
    head,
    model: MODEL,
    evaluatorVersion: promptHashes.version,
    promptHashAlgorithm: "sha256-template-source",
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
    manifest.requests.length !== planned.requests.length ||
    manifest.requests.some((request, index) =>
      request.id !== planned.requests[index].id ||
      JSON.stringify(request.candidateSha256) !== JSON.stringify(planned.requests[index].candidateSha256) ||
      JSON.stringify(request.requestImageSha256) !== JSON.stringify(planned.requests[index].requestImageSha256)
    )
  ) {
    throw new Error("Existing manifest does not match the frozen calibration plan");
  }
  const backfilledPromptHash = manifest.requests.some((request) => !request.promptHash);
  manifest.requests = manifest.requests.map((request, index) => {
    const frozen = planned.requests[index];
    const migrated = migrateCalibrationRequest({
      ...request,
      executionPriority: frozen.executionPriority,
      requestedModel: frozen.requestedModel,
      promptHash: request.promptHash || frozen.promptHash,
    }, MODEL) as ManifestRequest;
    if (migrated.inFlightAttempt) {
      migrated.attemptHistory.push({
        requestedAt: migrated.inFlightAttempt.requestedAt,
        completedAt: new Date().toISOString(),
        outcome: "failed",
        requestedModel: migrated.inFlightAttempt.requestedModel,
      });
      migrated.attempts = migrated.attemptHistory.length;
      migrated.status = "failed";
      migrated.observationStatus = "not_observed";
      migrated.detail = "Process ended after dispatch; historical attempt preserved without automatic retry";
      delete migrated.inFlightAttempt;
    }
    if (!immutableRequestMatches(migrated, frozen)) {
      throw new Error(`Frozen candidate, render, prompt, or model changed for ${request.id}`);
    }
    return migrated;
  });
  manifest.evaluatorVersion ||= planned.evaluatorVersion;
  manifest.promptHashAlgorithm ||= "sha256-template-source";
  if (backfilledPromptHash) manifest.promptHashBackfilledAt = new Date().toISOString();
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
  const duplicateCompletedObservations = manifest.requests
    .filter((request) => request.attemptHistory.filter((attempt) =>
      attempt.outcome === "success" &&
      attempt.requestedModel === MODEL &&
      attempt.effectiveModel === MODEL,
    ).length > 1)
    .map((request) => request.id);
  return {
    plannedRequests: manifest.requests.length,
    absoluteRequests: manifest.requests.filter((request) => request.type === "absolute").length,
    pairwiseRequests: manifest.requests.filter((request) => request.type === "pairwise").length,
    attempted: manifest.requests.reduce((sum, request) => sum + request.attemptHistory.length, 0),
    completedObservations: manifest.requests.filter((request) => request.observationStatus === "completed").length,
    duplicateIds,
    duplicateCompletedObservations,
    hashMismatches,
    valid:
      manifest.requests.length === 14 &&
      duplicateIds.length === 0 &&
      hashMismatches.length === 0 &&
      duplicateCompletedObservations.length === 0 &&
      manifest.requests.every((request) => Boolean(request.promptHash && request.requestedModel)),
  };
}

function findPairwise(
  entries: PairwiseArtifact[],
  first: CandidateLabel,
  second: CandidateLabel,
): PairwiseArtifact | undefined {
  return entries.find((entry) => entry.candidates[0] === first && entry.candidates[1] === second);
}

async function prepareExperiment(): Promise<{
  preparedList: PreparedCase[];
  cases: Map<CaseId, PreparedCase>;
  manifest: CalibrationManifest;
  plannedManifest: CalibrationManifest;
  fresh: boolean;
  integrity: Record<string, unknown>;
}> {
  const preparedList = await Promise.all(CASE_IDS.map((id) => prepareCase(id)));
  const cases = new Map(preparedList.map((prepared) => [prepared.replay.id, prepared]));
  const promptHashes = await evaluatorPromptHashes();
  const plannedManifest = buildManifest(
    cases,
    process.env.IDENTITY_CALIBRATION_HEAD || "37914d7",
    promptHashes,
  );
  const { manifest, fresh } = await loadOrCreateManifest(plannedManifest);
  for (const prepared of preparedList) {
    if (fresh) {
      await writeCaseImages(
        prepared.replay,
        new Map([...prepared.montages].map(([label, image]) => [label, image.image])),
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
  return {
    preparedList,
    cases,
    manifest,
    plannedManifest,
    fresh,
    integrity: manifestIntegrity(manifest, cases),
  };
}

describe("live calibration request manifest", () => {
  it("predefines exactly eight absolute and six unique pairwise request slots", () => {
    expect(LIVE_CALIBRATION_REQUEST_SPECS).toHaveLength(14);
    expect(LIVE_CALIBRATION_REQUEST_SPECS.filter((request) => request.type === "absolute")).toHaveLength(8);
    expect(LIVE_CALIBRATION_REQUEST_SPECS.filter((request) => request.type === "pairwise")).toHaveLength(6);
    expect(new Set(LIVE_CALIBRATION_REQUEST_SPECS.map((request) => request.id)).size).toBe(14);
  });

  it("pins the repair validation to A/C forward then reverse only", () => {
    expect(PAIRWISE_REPAIR_VALIDATION_SPECS).toEqual([
      { id: "repair-01-forward-A-C", direction: "forward", candidates: ["A", "C"] },
      { id: "repair-02-reverse-C-A", direction: "reverse", candidates: ["C", "A"] },
    ]);
  });
});

describe.skipIf(!PREFLIGHT)("API-free calibration preflight", () => {
  it("migrates and audits the existing controlled experiment without a provider call", async () => {
    const { manifest, plannedManifest, integrity } = await prepareExperiment();
    const quotaBlocked = manifest.requests.filter((request) =>
      request.observationStatus === "not_observed" &&
      request.attemptHistory.at(-1)?.outcome === "quota_failed",
    );
    const neverAttempted = manifest.requests.filter((request) => request.attemptHistory.length === 0);
    const completed = manifest.requests.filter((request) => request.observationStatus === "completed");
    const selectable = selectCalibrationBatch(manifest.requests, 14, true);
    const promptUnchanged = manifest.requests.every((request, index) =>
      immutableRequestMatches(request, plannedManifest.requests[index]),
    );
    const fallbackContamination = manifest.requests.some((request) =>
      request.attemptHistory.some((attempt) =>
        attempt.outcome === "success" &&
        (attempt.requestedModel !== MODEL || attempt.effectiveModel !== MODEL),
      ),
    );
    const evidence = evaluatorEvidence(manifest.requests);
    const report = {
      experiment: "controlled-20260830-01",
      evaluatorModel: MODEL,
      absoluteEvaluatorModel: MODEL,
      pairwiseEvaluatorModel: MODEL,
      calibrationFallbackModel: MODEL,
      evaluatorVersion: manifest.evaluatorVersion,
      observations: {
        completed: completed.length,
        quotaBlocked: quotaBlocked.length,
        neverAttempted: neverAttempted.length,
        resumeEligible: selectable.length,
      },
      candidateIntegrity: {
        validRequests: integrity.valid ? 14 : 0,
        plannedRequests: 14,
        hashMismatches: integrity.hashMismatches,
      },
      prompt: {
        unchanged: promptUnchanged,
        algorithm: manifest.promptHashAlgorithm,
        backfilledAt: manifest.promptHashBackfilledAt,
      },
      modelPinning: {
        requestedModel: MODEL,
        fallbackDeDuplicatedToSameModel: true,
        workersAiBindingPresentInCalibrationEnv: false,
        fallbackContamination,
      },
      evidence,
      readyToResume: Boolean(integrity.valid && promptUnchanged && selectable.length > 0),
      blockingReason:
        "A new explicit live approval and positive MAX_LIVE_CALIBRATION_REQUESTS are required; quota availability remains unknown until the first real observation.",
      recommendedNextRequestBudget: 2,
      checkpointPath: join(OUTPUT_ROOT, "manifest.json"),
      historicalQuotaFailures: quotaBlocked.map((request) => ({
        requestId: request.id,
        failure: request.attemptHistory.at(-1)?.failure,
      })),
      liveApiCalls: 0,
    };
    await writeJson(join(OUTPUT_ROOT, "preflight.json"), report);
    console.log([
      "Experiment: controlled-20260830-01",
      `Evaluator model: ${MODEL}`,
      `Observations: completed ${completed.length}, quota-blocked ${quotaBlocked.length}, never-attempted ${neverAttempted.length}`,
      `Candidate integrity: ${integrity.valid ? "14/14 valid" : "invalid"}`,
      `Prompt: ${promptUnchanged ? "unchanged" : "changed"}`,
      `Evidence tier: ${evidence.evidenceTier}`,
      `Ready to resume: ${integrity.valid && promptUnchanged && selectable.length > 0 ? "yes" : "no"}`,
      `Blocking reason: ${report.blockingReason}`,
    ].join("\n"));
    expect(report).toMatchObject({
      candidateIntegrity: { validRequests: 14, plannedRequests: 14 },
      prompt: { unchanged: true },
      modelPinning: { fallbackContamination: false },
      readyToResume: true,
      liveApiCalls: 0,
    });
    expect(report.observations).toEqual({
      completed: completed.length,
      quotaBlocked: quotaBlocked.length,
      neverAttempted: neverAttempted.length,
      resumeEligible: selectable.length,
    });
    expect(report.evidence.completedObservations).toBe(completed.length);
    expect(report.evidence.evidenceTier).toBeGreaterThanOrEqual(0);
    expect(report.evidence.evidenceTier).toBeLessThanOrEqual(4);
  }, 120_000);
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

    if (!Number.isInteger(MAX_LIVE_REQUESTS) || MAX_LIVE_REQUESTS <= 0) {
      throw new Error("A positive MAX_LIVE_CALIBRATION_REQUESTS is required for an explicitly authorized live batch");
    }
    // Freeze both cases and every A/B/C/D atlas before the first live request.
    const { preparedList, cases, manifest, integrity: preflight } = await prepareExperiment();
    await writeJson(join(OUTPUT_ROOT, "manifest-integrity-preflight.json"), preflight);
    expect(preflight).toMatchObject({
      plannedRequests: 14,
      absoluteRequests: 8,
      pairwiseRequests: 6,
      duplicateIds: [],
      duplicateCompletedObservations: [],
      hashMismatches: [],
      valid: true,
    });

    const selectedRequests = selectCalibrationBatch(
      manifest.requests,
      MAX_LIVE_REQUESTS,
      ALLOW_QUOTA_BLOCKED_RESUME,
    );
    let attempted = 0;
    let stoppedAfterFailure = false;
    for (const request of selectedRequests) {
      await paceLiveCalls(attempted);
      const prepared = cases.get(request.case)!;
      request.requestedAt = new Date().toISOString();
      request.inFlightAttempt = { requestedAt: request.requestedAt, requestedModel: MODEL };
      request.attempts = request.attemptHistory.length + 1;
      // Persist dispatch before the request. A process restart turns this into
      // historical failure and never auto-retries it.
      await saveManifest(manifest);
      attempted++;
      let effectiveModel: string | undefined;
      let attemptFailure: CalibrationAttemptHistoryEntry["failure"];

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
        if (result.ok) effectiveModel = MODEL;
        else {
          request.detail = result.detail;
          attemptFailure = result.quotaFailure;
          effectiveModel = result.quotaFailure?.model;
        }
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
        const decision = result.ok ? assessPairwiseDecision(result.review) : undefined;
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
          ...(decision
            ? {
                decision,
                normalizedActionableVerdict: normalizedActionableVerdict(
                  decision.actionableVerdict,
                  candidates,
                ),
              }
            : {}),
        };
        prepared.pairwiseResults.push(artifact);
        await writeJson(join(prepared.directory, "pairwise-results.json"), prepared.pairwiseResults);
        request.status = status;
        request.completedAt = completedAt;
        if (result.ok) effectiveModel = MODEL;
        else {
          request.detail = result.detail;
          attemptFailure = result.quotaFailure;
          effectiveModel = result.quotaFailure?.model;
        }
      }

      const outcome = request.status === "success"
        ? "success"
        : request.status === "quota_failed"
          ? "quota_failed"
          : "failed";
      request.attemptHistory.push({
        requestedAt: request.requestedAt,
        completedAt: request.completedAt,
        outcome,
        requestedModel: MODEL,
        ...(effectiveModel ? { effectiveModel } : {}),
        ...(attemptFailure ? { failure: attemptFailure } : {}),
      });
      request.attempts = request.attemptHistory.length;
      request.effectiveModel = effectiveModel;
      request.observationStatus = outcome === "success" && effectiveModel === MODEL
        ? "completed"
        : "not_observed";
      if (outcome === "success" && effectiveModel !== MODEL) {
        request.status = "failed";
        request.detail = "Observation excluded because effective model did not match the pinned evaluator model";
      }
      delete request.inFlightAttempt;
      // Persist terminal status immediately. This batch never selects the
      // same observation twice; later quota resume requires new user approval.
      await saveManifest(manifest);
      // A live calibration batch is measurement-only. Any non-observation
      // ends the authorized batch without retrying or advancing to another slot.
      if (outcome !== "success") {
        stoppedAfterFailure = true;
        break;
      }
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
        return {
          level,
          absolute: entry.result.critique,
          ...(forward
            ? {
                pairwise: {
                  ...forward,
                  actionableVerdict: assessPairwiseDecision(forward).actionableVerdict,
                },
              }
            : {}),
        };
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
          attempted: caseRequests.reduce((sum, request) => sum + request.attemptHistory.length, 0),
          success: caseRequests.filter((request) => request.observationStatus === "completed").length,
          quotaFailed: caseRequests.reduce(
            (sum, request) => sum + request.attemptHistory.filter((attempt) => attempt.outcome === "quota_failed").length,
            0,
          ),
          failed: caseRequests.reduce(
            (sum, request) => sum + request.attemptHistory.filter((attempt) => attempt.outcome === "failed").length,
            0,
          ),
          completedObservations: caseRequests.filter((request) => request.observationStatus === "completed").length,
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
      attempted: manifest.requests.reduce((sum, request) => sum + request.attemptHistory.length, 0),
      success: manifest.requests.filter((request) => request.observationStatus === "completed").length,
      quotaFailed: manifest.requests.reduce(
        (sum, request) => sum + request.attemptHistory.filter((attempt) => attempt.outcome === "quota_failed").length,
        0,
      ),
      otherFailed: manifest.requests.reduce(
        (sum, request) => sum + request.attemptHistory.filter((attempt) => attempt.outcome === "failed").length,
        0,
      ),
      stoppedAfterFailure,
      cases: aggregate,
    });
    expect(integrity).toMatchObject({
      duplicateIds: [],
      duplicateCompletedObservations: [],
      hashMismatches: [],
      valid: true,
    });
    expect(attempted).toBeLessThanOrEqual(MAX_LIVE_REQUESTS);
  }, 1_500_000);
});

describe.skipIf(!REPAIR_LIVE)("live source-fidelity pairwise repair validation", () => {
  it("runs A/C forward then reverse exactly once with durable checkpoints", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    if (!Number.isInteger(MAX_LIVE_REQUESTS) || MAX_LIVE_REQUESTS <= 0 || MAX_LIVE_REQUESTS > 2) {
      throw new Error("Pairwise repair validation requires a positive request budget no greater than 2");
    }
    if (!OUTPUT_ROOT.endsWith("controlled-20260830-01")) {
      throw new Error("Pairwise repair validation must run inside controlled-20260830-01");
    }

    const prepared = await prepareCase("glasses-monochrome");
    const baseManifest = JSON.parse(
      await readFile(join(OUTPUT_ROOT, "manifest.json"), "utf8"),
    ) as CalibrationManifest;
    const promptHash = (await evaluatorPromptHashes()).pairwise;
    const originalForward = baseManifest.requests.find((request) => request.id === "05-glasses-pairwise-A-C");
    const originalReverse = baseManifest.requests.find((request) => request.id === "06-glasses-pairwise-C-A");
    if (!originalForward || !originalReverse) throw new Error("Frozen A/C pairwise requests are missing");
    if (promptHash === originalForward.promptHash) {
      throw new Error("Repair validation requires a new source-fidelity evaluator prompt hash");
    }

    const requests = PAIRWISE_REPAIR_VALIDATION_SPECS.map((spec): PairwiseRepairValidationRequest => {
      const candidates = [...spec.candidates] as [CandidateLabel, CandidateLabel];
      const frozen = spec.direction === "forward" ? originalForward : originalReverse;
      const candidateSha256 = candidates.map((candidate) => prepared.atlasSha256.get(candidate)!) as [string, string];
      const requestImageSha256 = candidates.map((candidate) => prepared.headPanels.get(candidate)!.sha256) as [string, string];
      if (
        JSON.stringify(candidateSha256) !== JSON.stringify(candidates.map((candidate) => frozen.candidateSha256[candidate])) ||
        JSON.stringify(requestImageSha256) !== JSON.stringify(frozen.requestImageSha256)
      ) {
        throw new Error(`Frozen candidate or evidence hash changed for ${spec.id}`);
      }
      return {
        id: spec.id,
        direction: spec.direction,
        candidates,
        candidateSha256,
        requestImageSha256,
        promptHash,
        requestedModel: MODEL,
        status: "pending",
      };
    });
    const manifest: PairwiseRepairValidationManifest = {
      experiment: "controlled-20260830-01",
      validation: "source-fidelity-pairwise-repair",
      baseHead: baseManifest.head,
      model: MODEL,
      promptHash,
      priorPairwisePromptHash: originalForward.promptHash,
      sourceFaceSha256: sha256(prepared.replay.sourceFaceBytes),
      sourceHeadSha256: sha256(prepared.replay.sourceHeadBytes),
      authorizedRequests: 2,
      requests,
    };
    const validationPath = join(OUTPUT_ROOT, "pairwise-repair-validation.json");
    await writeFile(validationPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });

    const env = {
      GEMINI_API_KEY: key,
      VISION_MODEL: MODEL,
      VISION_FALLBACK_MODEL: MODEL,
      GEMINI_STRUCTURED_TIMEOUT_MS:
        process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS || "90000",
    } as Env;
    let attempted = 0;
    for (const request of manifest.requests.slice(0, MAX_LIVE_REQUESTS)) {
      await paceLiveCalls(attempted);
      request.requestedAt = new Date().toISOString();
      request.inFlight = true;
      await writeJson(validationPath, manifest);
      attempted++;
      const result = await runHeadPairwiseComparison(
        env,
        prepared.replay.analysis,
        prepared.replay.sourceFaceDataUrl,
        prepared.headPanels.get(request.candidates[0])!.dataUrl,
        prepared.headPanels.get(request.candidates[1])!.dataUrl,
        "candidate_selection",
        prepared.replay.sourceHeadDataUrl,
      );
      request.completedAt = new Date().toISOString();
      request.status = statusFor(result);
      request.result = result;
      delete request.inFlight;
      if (result.ok) {
        const decision = assessPairwiseDecision(result.review);
        request.effectiveModel = MODEL;
        request.rawWinner = result.review.winner;
        request.normalizedWinner = candidateWinner(result.review, request.candidates);
        request.decision = decision;
        request.normalizedActionableVerdict = normalizedActionableVerdict(
          decision.actionableVerdict,
          request.candidates,
        );
      } else {
        request.effectiveModel = result.quotaFailure?.model;
      }
      await writeJson(validationPath, manifest);
      if (request.status !== "success") break;
    }

    const completed = manifest.requests.filter((request) => request.status === "success");
    await writeJson(join(OUTPUT_ROOT, "pairwise-repair-summary.json"), {
      experiment: manifest.experiment,
      validation: manifest.validation,
      authorized: 2,
      attempted,
      success: completed.length,
      quotaFailed: manifest.requests.filter((request) => request.status === "quota_failed").length,
      otherFailed: manifest.requests.filter((request) => request.status === "failed").length,
      results: completed.map((request) => ({
        id: request.id,
        direction: request.direction,
        candidates: request.candidates,
        rawWinner: request.rawWinner,
        normalizedWinner: request.normalizedWinner,
        confidence: request.decision?.confidence,
        actionableVerdict: request.decision?.actionableVerdict,
        normalizedActionableVerdict: request.normalizedActionableVerdict,
        replacementSafe: request.decision?.replacementSafe,
      })),
    });
    expect(attempted).toBeLessThanOrEqual(2);
    expect(new Set(manifest.requests.map((request) => request.id)).size).toBe(2);
    expect(manifest.requests.every((request) =>
      request.status !== "success" ||
      (request.requestedModel === MODEL && request.effectiveModel === MODEL)
    )).toBe(true);
  }, 600_000);
});
