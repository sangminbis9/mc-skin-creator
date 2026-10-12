// Read-only verification of an actual in-memory preprocessing review.
// This test never launches a browser, remote runner or provider.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";

const root = "evaluation-artifacts/real-app-analysis-input-fidelity-offline-20261007-Vx0rgR";
const evidence = JSON.parse(readFileSync(`${root}/verification.json`, "utf8"));
const review = JSON.parse(readFileSync(`${root}/manual-review.json`, "utf8"));
const bytes = readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json");
const saved = JSON.parse(bytes.toString()).currentDefaultE2E;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

describe("actual production analysis input fidelity (offline)", () => {
  let network: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
  afterAll(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

  it("pins source, actual run and byte/decoded identities for both production derivatives", () => {
    expect(hash(bytes)).toBe(evidence.sourceSummarySha256);
    expect(evidence.runId).toBe(saved.runId);
    expect(evidence.originalSha256).toBe(saved.preprocessing.source.sha256);
    expect(evidence.originalBytes).toBe(saved.preprocessing.source.bytes);
    expect(evidence.originalRgbaSha256).toBe(saved.preprocessing.source.decodedRgbaSha256);
    expect(evidence.analysis).toEqual(saved.preprocessing.analysis);
    expect(evidence.generation).toEqual(saved.preprocessing.generation);
    expect(evidence.exactAnalysisIdentity).toBe(true);
    expect(evidence.exactGenerationIdentity).toBe(true);
    expect(hash(readFileSync("../src/lib/imageQuality.ts"))).toBe(evidence.preprocessingSourceSha256);
  });

  it("links manual input review to the real primary miss without rewriting provider evidence", () => {
    expect(review.provenance).toBe("manual_review_of_exact_analysis_jpeg_in_memory");
    expect(review.analysisSha256).toBe(evidence.analysis.sha256);
    expect(review.analysisRgbaSha256).toBe(evidence.analysis.rgbaSha256);
    expect(review.runId).toBe(evidence.runId);
    expect(review.reviewedCues).toMatchObject({ hairPart: "center", fringeOpening: "center",
      coherentRootDirectionSplitVisible: true, largeCentralForeheadOpeningVisible: true });
    expect(review.inputVisibleHairCuesLostByPreprocessing).toBe(false);
    const primary = saved.result.propagationTrace.primary.renderHints;
    expect(review.actualPrimaryHairPart).toBe(primary.hairPart);
    expect(review.actualPrimaryFringeOpening).toBe(primary.fringeOpening);
    expect(primary.hairPart).toBe("none"); expect(primary.fringeOpening).toBe("none");
    expect(review.earliestEstablishedHairLoss).toBe("PRIMARY_MISSED");
    expect(review.reasonForProviderMisobservation).toBe("unobserved");
  });

  it("retains only safe metadata and confirms terminal local review without a provider call", () => {
    expect(evidence.providerCalls).toBe(0); expect(evidence.remoteStartup).toBe(0);
    expect(evidence.externalPageRequests).toBe(0); expect(evidence.blockedPageRequestCount).toBe(0);
    expect(evidence.productionChanges).toBe(0);
    expect(evidence.rawImagesPersisted).toBe(false); expect(evidence.rawBase64Persisted).toBe(false);
    expect(review.privateInputFilesSaved).toBe(0); expect(review.localReviewProcessExitCode).toBe(0);
    expect(review.browserCloseAwaited).toBe(true); expect(review.localPreviewOneShotConsumed).toBe(true);
    expect(review.localPreviewBufferReferenceReleased).toBe(true);
    expect(readdirSync(root).every(file => /\.(json|md)$/.test(file))).toBe(true);
    expect(JSON.stringify([evidence, review])).not.toMatch(/data:image|Bearer\s|AIza|cfut_/);
    expect(hash(readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json"))).toBe(hash(bytes));
  });
});
