import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import {
  assessCandidateAdmissibility,
  assessPairwiseDecision,
  runHeadPairwiseComparison,
  runHeadPairwiseIfAdmissible,
  type HeadCandidate,
} from "../src/headIdentity";
import type { IdentityGeometryAnalysis } from "../src/identityGeometry";
import { compareFacePlans, type FacePixelPlan } from "../src/identityPlans";
import { bytesToBase64, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import {
  assessMeaningfulImprovementSensitivity,
  assessPairwiseStability,
  type PairwiseStabilityDirectionInput,
} from "../src/identityCalibration";
import { makeAnalysis } from "./helpers";

const LIVE = process.env.RUN_LIVE_NEAR_PEER_VALIDATION === "1";
const MODEL = process.env.NEAR_PEER_VALIDATION_MODEL?.trim() || "gemini-3.6-flash";
const OUTPUT_ROOT = resolve(process.env.NEAR_PEER_VALIDATION_OUTPUT_ROOT || join(
  process.cwd(),
  "evaluation-artifacts",
  "evaluator-calibration-live",
  "controlled-20260830-01",
));

interface SavedP5Check {
  feature: string;
  status: "present" | "weak" | "missing" | "wrong";
  targetRegions: string[];
}

interface SavedCritiquePass {
  critique: {
    p5IdentityChecks: SavedP5Check[];
    defects: Array<{ severity: "minor" | "major" | "critical"; feature: string }>;
  };
}

interface SavedMetrics {
  sourceGeometryAfter: IdentityGeometryAnalysis;
  oldFacePixelPlan: FacePixelPlan;
  newFacePixelPlan: FacePixelPlan;
  planDifference: ReturnType<typeof compareFacePlans>;
  craftStatus: { before: "valid" | "rejected"; planned: "valid" | "rejected"; plannedProblems: string[] };
}

interface RealNearPeerSpec {
  id: "long-hair-face-geometry" | "headscarf-mouth-topology";
  labels: readonly ["X", "Y"] | readonly ["M", "N"];
  artifactDirectory: string;
  candidateEvidenceHashes: readonly [string, string];
  calibrationEvidence: {
    calibrationType: "ambiguous_near_peer" | "meaningful_improvement_near_peer";
    expectedMeaningfullyImprovedCandidateId: string | null;
    identityRelevantDifferences: ReadonlyArray<{
      dimension: "hairline" | "eyeLayout" | "mouthExpression" | "faceProportions";
      sourceEvidence: string;
      firstCandidateRepresentation: string;
      secondCandidateRepresentation: string;
    }>;
  };
}

export const REAL_NEAR_PEER_SPECS: readonly RealNearPeerSpec[] = [
  {
    id: "long-hair-face-geometry",
    labels: ["X", "Y"],
    artifactDirectory: "head-structure-iteration-final/long-straight-hair",
    candidateEvidenceHashes: [
      "b7b7ed0ac3fcc25eb664d03d1a62e3b639ebbe99233c7dd1f83eb93a9437a2c6",
      "5df36e70ed321dd1788a34278b49d1e81677492d6498a552b9bd65316c06c2c8",
    ],
    calibrationEvidence: {
      calibrationType: "ambiguous_near_peer",
      expectedMeaningfullyImprovedCandidateId: null,
      identityRelevantDifferences: [{
        dimension: "faceProportions",
        sourceEvidence: "The source exposes a high forehead and open eyes, but the frozen panels differ only subtly in their compact 8x8 encoding.",
        firstCandidateRepresentation: "X uses the earlier face geometry.",
        secondCandidateRepresentation: "Y slightly adjusts eye and face-window placement without a clearly material identity advantage.",
      }],
    },
  },
  {
    id: "headscarf-mouth-topology",
    labels: ["M", "N"],
    artifactDirectory: "head-structure-iteration-final/headscarf-color-blocks",
    candidateEvidenceHashes: [
      "92e9ab3aefb381122534b3ce71bf8a77d41707781f80a4ee1da930f8dd5400d5",
      "ea5f49d332f4f38a61bc8769ae0e80baeed5fd5a16b98ee5f8e3ff3ee148e698",
    ],
    calibrationEvidence: {
      calibrationType: "meaningful_improvement_near_peer",
      expectedMeaningfullyImprovedCandidateId: "N",
      identityRelevantDifferences: [
        {
          dimension: "mouthExpression",
          sourceEvidence: "The source has a closed, compact mouth; normalized geometry targets a 3.33-pixel width at row 5.",
          firstCandidateRepresentation: "M uses a four-pixel closed-wide mouth.",
          secondCandidateRepresentation: "N uses a three-pixel closed-compact mouth at the same row.",
        },
        {
          dimension: "eyeLayout",
          sourceEvidence: "The source has strong brows clearly above open eyes.",
          firstCandidateRepresentation: "M keeps subtle brows on the eye row.",
          secondCandidateRepresentation: "N places strong brows one row above the eyes.",
        },
      ],
    },
  },
] as const;

interface PreparedNearPeer {
  spec: RealNearPeerSpec;
  analysis: PhotoAnalysis;
  sourceFaceDataUrl: string;
  sourceHeadDataUrl: string;
  candidates: readonly [HeadCandidate, HeadCandidate];
  candidateEvidenceHashes: readonly [string, string];
  deterministicDifference: ReturnType<typeof compareFacePlans>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

function featureCategory(feature: string): "face" | "hair" | "accessory" | "outfit" | "color" {
  const normalized = feature.toLowerCase();
  if (/glass|frame|earring|scarf|accessor/.test(normalized)) return "accessory";
  if (/hair|fringe|bang|curl|silhouette/.test(normalized)) return "hair";
  if (/shirt|top|bottom|jacket|sweater|outfit|collar/.test(normalized)) return "outfit";
  if (/tone|color|colour/.test(normalized)) return "color";
  return "face";
}

function replayAnalysis(geometry: IdentityGeometryAnalysis, p5Checks: SavedP5Check[]): PhotoAnalysis {
  const base = makeAnalysis();
  const features = p5Checks.map((check) => ({
    feature: check.feature,
    category: featureCategory(check.feature),
    priority: 5 as const,
    confidence: "high" as const,
    evidence: "Frozen source cue; verify only against the supplied source pixels.",
    targetRegions: check.targetRegions,
  }));
  const cueText = features.map((feature) => feature.feature).join(", ");
  return {
    ...base,
    canonicalIdentity: {
      overallImpression: cueText,
      mustPreserve: features.map((feature) => feature.feature),
      features,
    },
    identityPrompt: cueText,
    identityGeometry: geometry,
  };
}

async function candidate(
  id: string,
  kind: HeadCandidate["kind"],
  atlasCarrierBytes: Uint8Array,
  evidencePanelBytes: Uint8Array,
  plan: FacePixelPlan,
  p5Checks: SavedP5Check[],
  craftValid: boolean,
  criticalDefects: string[],
): Promise<{ candidate: HeadCandidate; panelHash: string }> {
  const atlas = await decodePng(atlasCarrierBytes);
  const finalValidation = validateFinalAtlas(atlas);
  const p5Valid = p5Checks.length > 0 &&
    p5Checks.every((check) => check.status === "present") &&
    plan.candidateCost.p5ContractViolations === 0;
  return {
    candidate: {
      id,
      kind,
      atlas,
      headMontageDataUrl: dataUrl(evidencePanelBytes),
      structuralValidity: finalValidation.ok,
      facePlan: plan,
      structuralEvidence: {
        dimensions: {
          headSilhouette: "present",
          hairline: "present",
          eyeLayout: "present",
          mouthExpression: "present",
          distinctiveAccessories: "not_applicable",
          faceProportions: "present",
        },
        contractSatisfaction: {
          headSilhouette: "satisfied",
          hairline: "satisfied",
          eyeLayout: "satisfied",
          mouthExpression: "satisfied",
          distinctiveAccessories: "not_applicable",
          faceProportions: "satisfied",
        },
        contractViolations: [],
        expectedPixels: 1,
        presentPixels: 1,
      },
      admissibilityEvidence: {
        p5Valid,
        craftValid,
        renderContractValid: finalValidation.ok,
        criticalDefects,
        calibrationConflicts: [],
      },
    },
    panelHash: sha256(evidencePanelBytes),
  };
}

async function prepare(spec: RealNearPeerSpec): Promise<PreparedNearPeer> {
  const directory = join(process.cwd(), "evaluation-artifacts", ...spec.artifactDirectory.split("/"));
  const [metricsBytes, critiqueBytes, sourceFaceBytes, sourceHeadBytes, candidateABytes, candidateBBytes, finalAtlasBytes] = await Promise.all([
    readFile(join(directory, "metrics.json")),
    readFile(join(directory, "critique.json")),
    readFile(join(directory, "01-source-face.png")),
    readFile(join(directory, "01b-source-head.png")),
    readFile(join(directory, "05-candidate-a.png")),
    readFile(join(directory, "06-candidate-b.png")),
    readFile(join(directory, "10-final-skin.png")),
  ]);
  const metrics = JSON.parse(metricsBytes.toString("utf8")) as SavedMetrics;
  const critique = JSON.parse(critiqueBytes.toString("utf8")) as { before: SavedCritiquePass; after: SavedCritiquePass };
  const p5Checks = critique.before.critique.p5IdentityChecks;
  const [first, second] = await Promise.all([
    candidate(
      spec.labels[0],
      "generated",
      finalAtlasBytes,
      candidateABytes,
      metrics.oldFacePixelPlan,
      p5Checks,
      metrics.craftStatus.before === "valid",
      critique.before.critique.defects.filter((defect) => defect.severity === "critical").map((defect) => defect.feature),
    ),
    candidate(
      spec.labels[1],
      "deterministic",
      finalAtlasBytes,
      candidateBBytes,
      metrics.newFacePixelPlan,
      critique.after.critique.p5IdentityChecks,
      metrics.craftStatus.planned === "valid",
      critique.after.critique.defects.filter((defect) => defect.severity === "critical").map((defect) => defect.feature),
    ),
  ]);
  return {
    spec,
    analysis: replayAnalysis(metrics.sourceGeometryAfter, p5Checks),
    sourceFaceDataUrl: dataUrl(sourceFaceBytes),
    sourceHeadDataUrl: dataUrl(sourceHeadBytes),
    candidates: [first.candidate, second.candidate],
    candidateEvidenceHashes: [first.panelHash, second.panelHash],
    deterministicDifference: compareFacePlans(metrics.oldFacePixelPlan, metrics.newFacePixelPlan),
  };
}

function normalizedWinner(
  review: Pick<HeadPairwiseReview, "winner">,
  labels: readonly [string, string],
): string | "tie" {
  return review.winner === "A" ? labels[0] : review.winner === "B" ? labels[1] : "tie";
}

describe("real near-peer calibration domain", () => {
  it("pins two real, distinct, admissible candidate pairs and their hashes", async () => {
    for (const spec of REAL_NEAR_PEER_SPECS) {
      const prepared = await prepare(spec);
      expect(prepared.candidateEvidenceHashes).toEqual(spec.candidateEvidenceHashes);
      expect(prepared.candidateEvidenceHashes[0]).not.toBe(prepared.candidateEvidenceHashes[1]);
      expect(prepared.deterministicDifference.weightedSimilarity).toBeLessThan(1);
      expect(prepared.deterministicDifference.weightedSimilarity).toBeGreaterThan(0.8);
      expect(assessCandidateAdmissibility(prepared.candidates[0])).toMatchObject({ admissible: true, reasons: [] });
      expect(assessCandidateAdmissibility(prepared.candidates[1])).toMatchObject({ admissible: true, reasons: [] });
      expect(prepared.analysis.identityPrompt).not.toContain(
        spec.calibrationEvidence.expectedMeaningfullyImprovedCandidateId ?? "expected-candidate-not-defined",
      );
      for (const difference of spec.calibrationEvidence.identityRelevantDifferences) {
        expect(prepared.analysis.identityPrompt).not.toContain(difference.sourceEvidence);
      }
    }
    expect(REAL_NEAR_PEER_SPECS[1].calibrationEvidence).toMatchObject({
      calibrationType: "meaningful_improvement_near_peer",
      expectedMeaningfullyImprovedCandidateId: "N",
    });
  }, 30_000);

  it.skipIf(!LIVE)("measures decision stability on Pair 2 without retries or fallback", async () => {
    const maximum = Number(process.env.MAX_LIVE_NEAR_PEER_REQUESTS);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4) {
      throw new Error("MAX_LIVE_NEAR_PEER_REQUESTS must be an integer from 1 through 4");
    }
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for live near-peer validation");
    const controlledRoot = resolve(process.cwd(), "evaluation-artifacts", "evaluator-calibration-live", "controlled-20260830-01");
    if (OUTPUT_ROOT !== controlledRoot) throw new Error("near-peer output root must remain inside controlled-20260830-01");
    const env = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      VISION_MODEL: MODEL,
      VISION_FALLBACK_MODEL: MODEL,
    } as Env;
    const artifact: {
      validation: "pairwise-decision-stability";
      authorizedMaximum: number;
      model: string;
      attempted: number;
      success: number;
      quotaFailed: number;
      otherFailed: number;
      stoppedReason: string | null;
      pairs: Array<Record<string, unknown>>;
    } = {
      validation: "pairwise-decision-stability",
      authorizedMaximum: maximum,
      model: MODEL,
      attempted: 0,
      success: 0,
      quotaFailed: 0,
      otherFailed: 0,
      stoppedReason: null,
      pairs: [],
    };
    const checkpoint = async () => writeFile(
      join(OUTPUT_ROOT, "decision-stability-validation.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );

    const prepared = await prepare(REAL_NEAR_PEER_SPECS[1]);
    const pairArtifact: Record<string, unknown> = {
      pair: 2,
      id: prepared.spec.id,
      labels: prepared.spec.labels,
      candidateEvidenceHashes: prepared.candidateEvidenceHashes,
      admissibility: prepared.candidates.map(assessCandidateAdmissibility),
      deterministicDifference: prepared.deterministicDifference,
      calibrationEvidence: prepared.spec.calibrationEvidence,
      directions: [],
    };
    artifact.pairs.push(pairArtifact);
    await checkpoint();
    const directions = [
      { id: "forward", order: [0, 1] as const },
      { id: "reverse", order: [1, 0] as const },
    ];
    const successfulDirections: PairwiseStabilityDirectionInput[] = [];
    for (const direction of directions) {
      if (artifact.attempted >= maximum) break;
      const labels = [prepared.spec.labels[direction.order[0]], prepared.spec.labels[direction.order[1]]] as const;
      const first = prepared.candidates[direction.order[0]];
      const second = prepared.candidates[direction.order[1]];
      artifact.attempted++;
      await checkpoint();
      const startedAt = new Date().toISOString();
      const gated = await runHeadPairwiseIfAdmissible(first, second, () => runHeadPairwiseComparison(
        env,
        prepared.analysis,
        prepared.sourceFaceDataUrl,
        first.headMontageDataUrl,
        second.headMontageDataUrl,
        "candidate_selection",
        prepared.sourceHeadDataUrl,
        first.structuralEvidence,
        second.structuralEvidence,
      ));
      if (!gated.pairwiseExecuted) throw new Error(`${prepared.spec.id} became inadmissible before dispatch`);
      const completedAt = new Date().toISOString();
      if (gated.result.ok) {
        artifact.success++;
        const decision = assessPairwiseDecision(gated.result.review);
        successfulDirections.push({ candidateOrder: labels, decision });
        (pairArtifact.directions as Array<Record<string, unknown>>).push({
          direction: direction.id,
          labels,
          startedAt,
          completedAt,
          status: "success",
          rawWinner: gated.result.review.winner,
          normalizedWinner: normalizedWinner(gated.result.review, labels),
          confidence: gated.result.review.confidence,
          decision,
          review: gated.result.review,
        });
      } else {
        if (gated.result.quotaFailure) artifact.quotaFailed++;
        else artifact.otherFailed++;
        (pairArtifact.directions as Array<Record<string, unknown>>).push({
          direction: direction.id,
          labels,
          startedAt,
          completedAt,
          status: gated.result.quotaFailure ? "quota_failed" : "other_failed",
          detail: gated.result.detail.slice(0, 500),
        });
        artifact.stoppedReason = `${prepared.spec.id}:${direction.id}:live_failure`;
        await checkpoint();
        break;
      }
      await checkpoint();
    }
    if (!artifact.stoppedReason && successfulDirections.length !== 2) {
      artifact.stoppedReason = `${prepared.spec.id}:incomplete_order_pair`;
    }
    const stability = assessPairwiseStability({
      incumbentCandidateId: prepared.spec.labels[0],
      forward: successfulDirections[0],
      reverse: successfulDirections[1],
    });
    const meaningfulSensitivity = assessMeaningfulImprovementSensitivity(
      stability,
      prepared.spec.calibrationEvidence.expectedMeaningfullyImprovedCandidateId,
    );
    pairArtifact.stability = stability;
    pairArtifact.meaningfulImprovementSensitivity = meaningfulSensitivity;
    if (!artifact.stoppedReason) {
      if (stability.productionDecisionStable === false) {
        artifact.stoppedReason = `${prepared.spec.id}:decision_order_instability`;
      } else if (meaningfulSensitivity !== "supported") {
        artifact.stoppedReason = stability.safeAbstention
          ? `${prepared.spec.id}:meaningful_improvement_not_supported_safe_abstention`
          : `${prepared.spec.id}:meaningful_improvement_not_supported`;
      } else {
        artifact.stoppedReason = "phase2_not_attempted_no_independent_meaningful_pair";
      }
    }
    await checkpoint();
    await writeFile(
      join(OUTPUT_ROOT, "decision-stability-summary.json"),
      `${JSON.stringify({
        validation: artifact.validation,
        authorizedMaximum: artifact.authorizedMaximum,
        attempted: artifact.attempted,
        success: artifact.success,
        quotaFailed: artifact.quotaFailed,
        otherFailed: artifact.otherFailed,
        stoppedReason: artifact.stoppedReason,
        pairCount: artifact.pairs.length,
        phaseOnePairId: prepared.spec.id,
        phaseTwoAttempted: false,
      }, null, 2)}\n`,
      "utf8",
    );
    expect(artifact.attempted).toBeLessThanOrEqual(maximum);
  }, 300_000);
});
