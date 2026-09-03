import {
  classifyEvaluatorQuotaFailure,
  type EvaluatorQuotaFailure,
} from "../src/evaluatorQuota";

export type ObservationStatus = "not_observed" | "completed";
export type CalibrationAttemptOutcome = "success" | "quota_failed" | "failed";

export interface CalibrationAttemptHistoryEntry {
  requestedAt: string;
  completedAt?: string;
  outcome: CalibrationAttemptOutcome;
  requestedModel: string;
  effectiveModel?: string;
  failure?: EvaluatorQuotaFailure;
}

export interface ResumableCalibrationRequest {
  id: string;
  status: "pending" | "success" | "failed" | "quota_failed";
  attempts: number;
  requestedAt?: string;
  completedAt?: string;
  detail?: string;
  observationStatus?: ObservationStatus;
  attemptHistory?: CalibrationAttemptHistoryEntry[];
  executionPriority?: number;
  requestedModel?: string;
  effectiveModel?: string;
  promptHash?: string;
  candidateSha256?: Record<string, string>;
  requestImageSha256?: string[];
}

export interface CalibrationEvidence {
  health: "unknown" | "healthy" | "degraded";
  evidenceTier: 0 | 1 | 2 | 3 | 4;
  completedObservations: number;
}

const TIER_ONE = [
  "01-glasses-absolute-A",
  "03-glasses-absolute-C",
  "04-glasses-absolute-D",
] as const;
const TIER_TWO = [
  ...TIER_ONE,
  "05-glasses-pairwise-A-C",
  "07-glasses-pairwise-A-D",
] as const;
const TIER_THREE = [
  ...TIER_TWO,
  "09-short-absolute-A",
  "11-short-absolute-C",
  "12-short-absolute-D",
] as const;
const FULL_CALIBRATION = [
  "01-glasses-absolute-A",
  "02-glasses-absolute-B",
  "03-glasses-absolute-C",
  "04-glasses-absolute-D",
  "05-glasses-pairwise-A-C",
  "06-glasses-pairwise-C-A",
  "07-glasses-pairwise-A-D",
  "08-glasses-pairwise-D-A",
  "09-short-absolute-A",
  "10-short-absolute-B",
  "11-short-absolute-C",
  "12-short-absolute-D",
  "13-short-pairwise-A-C",
  "14-short-pairwise-A-D",
] as const;

export function migrateCalibrationRequest<T extends ResumableCalibrationRequest>(
  request: T,
  pinnedModel: string,
): T & Required<Pick<ResumableCalibrationRequest, "observationStatus" | "attemptHistory" | "requestedModel">> {
  const migrated = { ...request } as T & Required<Pick<ResumableCalibrationRequest, "observationStatus" | "attemptHistory" | "requestedModel">>;
  migrated.requestedModel ||= pinnedModel;
  if (!migrated.attemptHistory) {
    migrated.attemptHistory = [];
    if (request.attempts > 0 || request.status !== "pending") {
      const outcome: CalibrationAttemptOutcome = request.status === "success"
        ? "success"
        : request.status === "quota_failed"
          ? "quota_failed"
          : "failed";
      const failure = outcome === "quota_failed"
        ? classifyEvaluatorQuotaFailure(request.detail || "quota failure") ?? undefined
        : undefined;
      migrated.attemptHistory.push({
        requestedAt: request.requestedAt || request.completedAt || "timestamp-not-recorded",
        ...(request.completedAt ? { completedAt: request.completedAt } : {}),
        outcome,
        requestedModel: pinnedModel,
        ...(failure?.model ? { effectiveModel: failure.model } : {}),
        ...(failure ? { failure } : {}),
      });
    }
  }
  migrated.attemptHistory = migrated.attemptHistory.map((attempt) => {
    if (attempt.outcome !== "quota_failed" || !attempt.failure?.sanitizedMessage) {
      return attempt;
    }
    const refreshed = classifyEvaluatorQuotaFailure(
      new Error(attempt.failure.sanitizedMessage),
    );
    if (!refreshed) return attempt;
    return {
      ...attempt,
      failure: {
        ...refreshed,
        ...attempt.failure,
        category: refreshed.category,
        retryable: refreshed.retryable,
      },
    };
  });
  migrated.attempts = migrated.attemptHistory.length;
  migrated.observationStatus = migrated.attemptHistory.some(
    (attempt) => attempt.outcome === "success" &&
      attempt.requestedModel === pinnedModel &&
      attempt.effectiveModel === pinnedModel,
  ) ? "completed" : "not_observed";
  return migrated;
}

export function isResumeEligible(
  request: ResumableCalibrationRequest,
  allowQuotaBlocked: boolean,
): boolean {
  if (request.observationStatus === "completed") return false;
  const history = request.attemptHistory || [];
  if (history.length === 0) return true;
  const last = history.at(-1);
  return Boolean(
    allowQuotaBlocked &&
    last?.outcome === "quota_failed" &&
    last.failure?.retryable,
  );
}

export function selectCalibrationBatch<T extends ResumableCalibrationRequest>(
  requests: T[],
  requestBudget: number,
  allowQuotaBlocked: boolean,
): T[] {
  if (!Number.isInteger(requestBudget) || requestBudget < 0) {
    throw new Error("MAX_LIVE_CALIBRATION_REQUESTS must be a non-negative integer");
  }
  const selected = requests
    .filter((request) => isResumeEligible(request, allowQuotaBlocked))
    .sort((first, second) =>
      (first.executionPriority ?? Number.MAX_SAFE_INTEGER) -
        (second.executionPriority ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, requestBudget);
  if (new Set(selected.map((request) => request.id)).size !== selected.length) {
    throw new Error("Duplicate observation selected for one calibration batch");
  }
  return selected;
}

export function calibrationEvidenceTier(completedRequestIds: Iterable<string>): 0 | 1 | 2 | 3 | 4 {
  const completed = new Set(completedRequestIds);
  if (FULL_CALIBRATION.every((id) => completed.has(id))) return 4;
  if (TIER_THREE.every((id) => completed.has(id))) return 3;
  if (TIER_TWO.every((id) => completed.has(id))) return 2;
  if (TIER_ONE.every((id) => completed.has(id))) return 1;
  return 0;
}

export function evaluatorEvidence(
  requests: ResumableCalibrationRequest[],
  assessedHealth?: "healthy" | "degraded",
): CalibrationEvidence {
  const completed = requests.filter((request) => request.observationStatus === "completed");
  const evidenceTier = calibrationEvidenceTier(completed.map((request) => request.id));
  return {
    health: evidenceTier === 0 ? "unknown" : assessedHealth ?? "unknown",
    evidenceTier,
    completedObservations: completed.length,
  };
}

export function modelObservationIsPinned(
  attempt: CalibrationAttemptHistoryEntry,
  pinnedModel: string,
): boolean {
  return attempt.outcome === "success" &&
    attempt.requestedModel === pinnedModel &&
    attempt.effectiveModel === pinnedModel;
}

export function immutableRequestMatches(
  current: ResumableCalibrationRequest,
  frozen: ResumableCalibrationRequest,
): boolean {
  return current.promptHash === frozen.promptHash &&
    current.requestedModel === frozen.requestedModel &&
    JSON.stringify(current.candidateSha256) === JSON.stringify(frozen.candidateSha256) &&
    JSON.stringify(current.requestImageSha256) === JSON.stringify(frozen.requestImageSha256);
}
