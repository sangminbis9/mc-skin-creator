import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { resolveFaceMeasurements, type FaceMeasurementEvidence } from "../src/faceMeasurementEvidence";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

const SUMMARY = path.resolve("evaluation-artifacts/bound-profile-cli-primary-canary-live-20260921-001/summary.json");
const OUTPUT = path.resolve("evaluation-artifacts/primary-eye-consumer-path-review-20260921-001");
const BUILD = process.env.BUILD_PRIMARY_EYE_CONSUMER_REVIEW === "approved-offline";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eyeCues = ["eyeSpacing", "eyeOpenness", "eyeFootprint"] as const;
const otherCues = ["browEyeDistance", "browSlope", "mouthWidth", "mouthOpenness", "expression"] as const;

type Summary = {
  selectedCanary: { id: string; expectedSha256: string; expectedBytes: number };
  primary: {
    visibleRegions: PhotoAnalysis["visibleRegions"];
    sourceSelection: Pick<PhotoAnalysis["sourceSelection"], "portraitImageIndex" | "outfitImageIndex" | "generationImageIndex">;
    faceMeasurementEvidence: FaceMeasurementEvidence;
    relevantRenderHints: Partial<PhotoAnalysis["renderHints"]>;
    measurementTraceSelected: Record<string, string>;
    categoricalOnlyFaceLayoutPlan: Record<string, unknown>;
  };
};

function readSummary(): Summary {
  return JSON.parse(fs.readFileSync(SUMMARY, "utf8")) as Summary;
}

function analysisFor(summary: Summary, glasses: "none" | "regular" | "round" | "sunglasses",
  evidence = summary.primary.faceMeasurementEvidence): PhotoAnalysis {
  const seed = makeAnalysis();
  return makeAnalysis({
    visibleRegions: { ...seed.visibleRegions, ...summary.primary.visibleRegions },
    sourceSelection: { ...seed.sourceSelection, ...summary.primary.sourceSelection },
    renderHints: { ...seed.renderHints, ...summary.primary.relevantRenderHints },
    fallbackFeatures: { ...seed.fallbackFeatures, glasses, expression: "neutral" },
    faceMeasurementEvidence: structuredClone(evidence),
    identityGeometry: undefined,
  });
}

function withEyeCues(evidence: FaceMeasurementEvidence,
  values: Partial<FaceMeasurementEvidence["cues"]>): FaceMeasurementEvidence {
  const next = structuredClone(evidence);
  for (const cue of eyeCues) next.cues[cue] = { value: "unknown", provenance: "unknown", confidence: 0 };
  Object.assign(next.cues, values);
  return next;
}

function snapshot(analysis: PhotoAnalysis) {
  const facePlan = buildFacePixelPlanVariants(analysis, 1)[0];
  const trace = resolveFaceMeasurements(analysis);
  const layout = facePlan.layout;
  const eyePixels = facePlan.pixels.filter(pixel => pixel.cluster === "left_eye" || pixel.cluster === "right_eye");
  return {
    trace: Object.fromEntries(Object.entries(trace).map(([cue, decision]) => [cue, {
      value: decision.value, provenance: decision.provenance, confidence: decision.confidence,
      selected: decision.selected, reason: decision.reason,
    }])),
    layout: {
      eyeSpacing: layout.eyeSpacingTopology,
      eyeFootprint: layout.eyeFootprintTopology,
      eyeOpenness: layout.eyeOpenness,
      browEyeDistance: layout.browDistanceTopology,
      browSlope: layout.browSlopeTopology,
      mouthWidth: layout.mouthWidth,
      mouthOpenness: layout.mouthOpening,
      expression: layout.mouthExpressionTopology,
      leftEyeXs: layout.leftEyeXs,
      rightEyeXs: layout.rightEyeXs,
      leftEyeRow: layout.leftEyeRow,
      rightEyeRow: layout.rightEyeRow,
      eyeTopology: layout.eyeTopology,
    },
    facePixelHash: hash(facePlan.pixels),
    eyePixelHash: hash(eyePixels),
  };
}

function replay() {
  const summary = readSummary();
  const evidence = summary.primary.faceMeasurementEvidence;
  const removed = withEyeCues(evidence, {});
  const mixed = withEyeCues(evidence, {
    eyeSpacing: evidence.cues.eyeSpacing,
    eyeOpenness: evidence.cues.eyeOpenness,
  });
  const invalidConfidence = withEyeCues(evidence, {
    eyeSpacing: { ...evidence.cues.eyeSpacing, confidence: 0.74 },
  });
  const glassesPolicy = Object.fromEntries((["regular", "round", "sunglasses"] as const).map(glasses => [
    glasses,
    snapshot(analysisFor(summary, glasses)),
  ]));
  const noGlassesEvidence = snapshot(analysisFor(summary, "none"));
  const noGlassesRemoved = snapshot(analysisFor(summary, "none", removed));
  const mixedEvidence = snapshot(analysisFor(summary, "none", mixed));
  const lowConfidence = snapshot(analysisFor(summary, "none", invalidConfidence));
  const geometryAnalysis = analysisFor(summary, "regular");
  geometryAnalysis.identityGeometry = makeIdentityGeometry({ glasses: null });
  const geometry = snapshot(geometryAnalysis);
  return { summary, evidence, removed, glassesPolicy, noGlassesEvidence, noGlassesRemoved, mixedEvidence, lowConfidence, geometry };
}

it.skipIf(!fs.existsSync(SUMMARY))("isolates the verified canary eye consumer boundary without provider calls", () => {
  const value = replay();
  for (const cue of eyeCues) {
    expect(value.evidence.cues[cue].provenance).toBe("observed_categorical");
    expect(value.evidence.cues[cue].confidence).toBeGreaterThanOrEqual(0.75);
    expect(value.noGlassesEvidence.trace[cue].selected).toBe("categorical_grammar");
    expect(value.noGlassesRemoved.trace[cue].selected).toBe("legacy_fallback");
    expect(value.geometry.trace[cue].selected).toBe("continuous_geometry");
    for (const replayed of Object.values(value.glassesPolicy)) {
      expect(replayed.trace[cue]).toMatchObject({ selected: "legacy_fallback", reason: "existing glasses openings constrain eye placement" });
    }
  }
  expect(value.mixedEvidence.trace.eyeSpacing.selected).toBe("categorical_grammar");
  expect(value.mixedEvidence.trace.eyeFootprint.selected).toBe("legacy_fallback");
  expect(value.mixedEvidence.trace.eyeOpenness.selected).toBe("categorical_grammar");
  expect(value.lowConfidence.trace.eyeSpacing.selected).toBe("legacy_fallback");
  for (const cue of otherCues) expect(value.glassesPolicy.regular.trace[cue].selected).toBe("categorical_grammar");
  expect(value.glassesPolicy.regular.layout).toMatchObject(value.summary.primary.categoricalOnlyFaceLayoutPlan);
  // The provider categories agree with the neutral legacy hints, so removing
  // evidence in a no-glasses control changes attribution but not rendered pixels.
  expect(value.noGlassesEvidence.facePixelHash).toBe(value.noGlassesRemoved.facePixelHash);
  expect(value.noGlassesEvidence.eyePixelHash).toBe(value.noGlassesRemoved.eyePixelHash);
});

it.skipIf(!BUILD || !fs.existsSync(SUMMARY))("writes the secret-safe offline consumer review", () => {
  const value = replay();
  fs.mkdirSync(OUTPUT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(OUTPUT, name),
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("canary-input-summary.json", {
    caseId: value.summary.selectedCanary.id,
    sourceSha256: value.summary.selectedCanary.expectedSha256,
    sourceBytes: value.summary.selectedCanary.expectedBytes,
    faceMeasurementEvidence: value.evidence,
    relevantRenderHints: value.summary.primary.relevantRenderHints,
    storedFallbackFeaturesGlassesToken: "not_stored",
    provenConsumerPolicyClass: "non_none_glasses",
    proof: "all eye cues are valid while all three selected legacy_fallback; the only eye-only veto after geometry is glassesConstrained",
  });
  write("before-trace.json", {
    storedLiveTrace: value.summary.primary.measurementTraceSelected,
    storedLivePlan: value.summary.primary.categoricalOnlyFaceLayoutPlan,
    classification: "intentional_non_none_glasses_policy",
  });
  write("after-trace.json", {
    productionChangeApplied: false,
    traceUnchanged: value.summary.primary.measurementTraceSelected,
    reason: "existing policy and regression explicitly protect glasses openings; exact provider glasses token was not stored, so changing policy would exceed evidence",
  });
  write("counterfactual-replay.json", {
    confidenceThreshold: 0.75,
    glassesPolicy: Object.fromEntries(Object.entries(value.glassesPolicy).map(([glasses, result]) => [glasses, result.trace])),
    noGlassesEvidence: value.noGlassesEvidence,
    noGlassesEyeEvidence: value.noGlassesRemoved,
    mixedEvidence: value.mixedEvidence,
    lowConfidence: value.lowConfidence,
    continuousGeometry: value.geometry,
    independentEyeAxes: { spacing: "categorical_grammar", footprint: "legacy_fallback", openness: "categorical_grammar" },
  });
  write("plan-diff.json", {
    exactLiveFacePixelPlanAvailable: false,
    reason: "the approved live artifact intentionally retained only sanitized trace and layout axes, not the full PhotoAnalysis or FacePixelPlan",
    storedLiveLayout: value.summary.primary.categoricalOnlyFaceLayoutPlan,
    syntheticPolicyReplay: {
      noGlassesEvidenceVsRemovedFacePixelDiff: value.noGlassesEvidence.facePixelHash === value.noGlassesRemoved.facePixelHash ? 0 : "nonzero",
      noGlassesEvidenceVsRemovedEyePixelDiff: value.noGlassesEvidence.eyePixelHash === value.noGlassesRemoved.eyePixelHash ? 0 : "nonzero",
      interpretation: "provider categories and legacy hints map to the same topology; the live plan match is coincidental fallback agreement, not evidence consumption",
    },
  });
  write("REPORT.md", `# Primary eye consumer path review\n\n` +
    `- External calls: 0\n- Production changes: 0\n- Root cause: intentional non-none-glasses protection policy in resolveFaceMeasurements.\n` +
    `- Rejected causes: field wiring, enum normalization, confidence, provenance, legacy-before-categorical precedence, and trace-label error.\n` +
    `- Continuous geometry remains first priority. Missing/unknown/low-confidence evidence remains legacy fallback.\n` +
    `- All three eye axes select categorical grammar independently when the glasses guard is absent.\n` +
    `- The live plan matched the source because medium/normal/medium evidence and average/almond legacy hints quantize identically.\n` +
    `- No consumer policy change was made because the exact live glasses token was intentionally not stored and existing regression requires glasses protection.\n`);
});
