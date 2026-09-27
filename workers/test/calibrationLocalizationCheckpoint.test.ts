import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { classifyPortraitLocalization } from "../src/analysis";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";

describe("versioned calibration localization checkpoint", () => {
  it("persists and recovers trace v1 without changing the checkpoint envelope", async () => {
    const root = resolve("evaluation-artifacts/portrait-region-face-head-relationship-audit-20260925-001");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "checkpoint-test-"));
    const destination = join(directory, "summary.json");
    const trace = auditLocalizationTrace(classifyPortraitLocalization("Portrait visible | REGION:null"));
    const first = await atomicCheckpoint(destination, { stage: "primary_completed", localizationTrace: trace,
      providerLocalizationStatus: "EXPLICIT_NULL", calibrationLocalizationEligible: false }, "primary_completed");
    const recovered = await readLatestAuditCheckpoint(destination);
    expect(first.sequence).toBe(1);
    expect(recovered).toMatchObject({ schemaVersion: 1, sequence: 1,
      snapshot: { localizationTrace: { traceVersion: 1, status: "EXPLICIT_NULL" },
        calibrationLocalizationEligible: false } });
  });

  it("reads optional relationship metadata without changing old checkpoint compatibility", async () => {
    const root = resolve("evaluation-artifacts/portrait-region-face-head-relationship-audit-20260925-001");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "relationship-checkpoint-test-"));
    const destination = join(directory, "summary.json");
    const rejected = "Synthetic contract portrait | REGION:[0,0,1,1,0,0,0.2549,0.3,0,0,0.25,0.2,0.9]";
    const trace = auditLocalizationTrace(classifyPortraitLocalization(rejected));
    expect(trace?.relationshipFailure).toBe("head_width_ratio");
    await atomicCheckpoint(destination, { localizationTrace: trace, calibrationLocalizationEligible: false }, "primary_completed");
    const recovered = await readLatestAuditCheckpoint(destination);
    expect(recovered?.snapshot).toMatchObject({ localizationTrace: {
      validationReason: "face_head_relationship_invalid", relationshipFailure: "head_width_ratio",
    }, calibrationLocalizationEligible: false });
  });
});
