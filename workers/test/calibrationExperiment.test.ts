import { describe, expect, it } from "vitest";
import {
  calibrationEvidenceTier,
  evaluatorEvidence,
  immutableRequestMatches,
  isResumeEligible,
  migrateCalibrationRequest,
  modelObservationIsPinned,
  selectCalibrationBatch,
  type ResumableCalibrationRequest,
} from "./calibrationExperiment";

const MODEL = "gemini-3.6-flash";

function request(
  id: string,
  overrides: Partial<ResumableCalibrationRequest> = {},
): ResumableCalibrationRequest {
  return {
    id,
    status: "pending",
    attempts: 0,
    observationStatus: "not_observed",
    attemptHistory: [],
    executionPriority: Number(id.slice(0, 2)),
    requestedModel: MODEL,
    promptHash: "prompt-v1",
    candidateSha256: { A: "atlas-a" },
    requestImageSha256: ["render-a"],
    ...overrides,
  };
}

describe("controlled calibration resume semantics", () => {
  it("migrates historical quota failure without deleting it or completing an observation", () => {
    const migrated = migrateCalibrationRequest(request("01-glasses-absolute-A", {
      status: "quota_failed",
      attempts: 1,
      requestedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:01.000Z",
      detail: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash. retry in 20s",
      attemptHistory: undefined,
      observationStatus: undefined,
    }), MODEL);
    expect(migrated.observationStatus).toBe("not_observed");
    expect(migrated.attemptHistory).toHaveLength(1);
    expect(migrated.attemptHistory[0]).toMatchObject({
      outcome: "quota_failed",
      failure: { category: "rate_limit", retryable: true },
    });
    expect(isResumeEligible(migrated, true)).toBe(true);
    expect(isResumeEligible(migrated, false)).toBe(false);
  });

  it("reclassifies a persisted billing-guidance false positive from rate-limit evidence", () => {
    const migrated = migrateCalibrationRequest(request("01-glasses-absolute-A", {
      status: "quota_failed",
      attempts: 1,
      attemptHistory: [{
        requestedAt: "2026-08-30T00:00:00.000Z",
        outcome: "quota_failed",
        requestedModel: MODEL,
        failure: {
          category: "billing",
          retryable: false,
          quotaIds: [],
          quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
          quotaLimit: 20,
          model: MODEL,
          modelSpecific: true,
          projectSpecific: "unknown",
          sanitizedMessage: "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash. Please retry in 20s.",
        },
      }],
    }), MODEL);

    expect(migrated.attemptHistory[0]?.failure).toMatchObject({
      category: "rate_limit",
      retryable: true,
      quotaLimit: 20,
      model: MODEL,
    });
    expect(isResumeEligible(migrated, true)).toBe(true);
  });

  it("skips completed observations and rejects fallback-contaminated success", () => {
    const completed = request("01-glasses-absolute-A", {
      status: "success",
      observationStatus: "completed",
      attemptHistory: [{
        requestedAt: "now",
        outcome: "success",
        requestedModel: MODEL,
        effectiveModel: MODEL,
      }],
    });
    expect(isResumeEligible(completed, true)).toBe(false);
    expect(modelObservationIsPinned(completed.attemptHistory![0], MODEL)).toBe(true);
    expect(modelObservationIsPinned({
      ...completed.attemptHistory![0],
      effectiveModel: "gemini-fallback",
    }, MODEL)).toBe(false);
  });

  it("enforces small request budgets, priority, and duplicate prevention", () => {
    const requests = [
      request("03-glasses-absolute-C", { executionPriority: 2 }),
      request("01-glasses-absolute-A", { executionPriority: 1 }),
      request("04-glasses-absolute-D", { executionPriority: 3 }),
    ];
    expect(selectCalibrationBatch(requests, 2, true).map((item) => item.id)).toEqual([
      "01-glasses-absolute-A",
      "03-glasses-absolute-C",
    ]);
    expect(selectCalibrationBatch(requests, 0, true)).toEqual([]);
    expect(() => selectCalibrationBatch([requests[0], requests[0]], 2, true)).toThrow(
      "Duplicate observation",
    );
    expect(() => selectCalibrationBatch(requests, -1, true)).toThrow(
      "non-negative integer",
    );
  });

  it("preserves candidate/render hashes, prompt hash, and requested model", () => {
    const frozen = request("01-glasses-absolute-A");
    expect(immutableRequestMatches({ ...frozen }, frozen)).toBe(true);
    expect(immutableRequestMatches({ ...frozen, promptHash: "changed" }, frozen)).toBe(false);
    expect(immutableRequestMatches({ ...frozen, candidateSha256: { A: "changed" } }, frozen)).toBe(false);
    expect(immutableRequestMatches({ ...frozen, requestedModel: "fallback" }, frozen)).toBe(false);
  });

  it("defines minimum calibration evidence tiers 0 through 4", () => {
    expect(calibrationEvidenceTier([])).toBe(0);
    const tierOne = ["01-glasses-absolute-A", "03-glasses-absolute-C", "04-glasses-absolute-D"];
    expect(calibrationEvidenceTier(tierOne)).toBe(1);
    const tierTwo = [...tierOne, "05-glasses-pairwise-A-C", "07-glasses-pairwise-A-D"];
    expect(calibrationEvidenceTier(tierTwo)).toBe(2);
    const tierThree = [...tierTwo, "09-short-absolute-A", "11-short-absolute-C", "12-short-absolute-D"];
    expect(calibrationEvidenceTier(tierThree)).toBe(3);
    expect(calibrationEvidenceTier(Array.from({ length: 14 }, (_, index) => String(index)))).toBe(0);
    expect(calibrationEvidenceTier([
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
    ])).toBe(4);
  });

  it("keeps evaluator health separate from evidence completeness", () => {
    const requests = [request("01-glasses-absolute-A")];
    expect(evaluatorEvidence(requests, "healthy")).toEqual({
      health: "unknown",
      evidenceTier: 0,
      completedObservations: 0,
    });
    const completed = [
      "01-glasses-absolute-A",
      "03-glasses-absolute-C",
      "04-glasses-absolute-D",
    ].map((id) => request(id, { observationStatus: "completed" }));
    expect(evaluatorEvidence(completed, "degraded")).toEqual({
      health: "degraded",
      evidenceTier: 1,
      completedObservations: 3,
    });
  });
});
