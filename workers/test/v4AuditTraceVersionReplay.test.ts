import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import type { ProtectedAuditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";

const historicalCheckpoint = resolve("evaluation-artifacts/structured-localization-v4-wavy-primary-live-20260925-001/summary.json");

describe("immutable V4 live checkpoint: offline evidence availability", () => {
  it("reads the authoritative versioned snapshot without inventing a missing region", async () => {
    const record = await readLatestAuditCheckpoint(historicalCheckpoint);
    expect(record).toMatchObject({ schemaVersion: 1, sequence: 32, event: "finalCheckpoint",
      snapshotSha256: "fb8cb0037ebfad4f9b8632c3623be4c05d3e0bf3d370ebbe18d571edabf4dc59" });
    const snapshot = record!.snapshot as {
      classification: string;
      validLocalization: unknown;
      primary: {
        runId: string; derivativeSha256: string; expectedContractVersion: string;
        contractValidation: { providerWireSchemaValid: boolean; primaryCoreValid: boolean; localizationValid: boolean };
        quality: string; faceVisible: boolean; portraitImageIndex: number;
        localizationTrace: ProtectedAuditLocalizationTrace;
        normalizedPortraitRegionPresent: boolean;
        portraitRegion?: unknown;
      };
    };
    expect(snapshot.classification).toBe("V4_LOCALIZATION_CONTRACT_FAILURE");
    expect(snapshot.primary).toMatchObject({
      runId: "ceaf92f9d12b30ef336b3553c7563eaa",
      derivativeSha256: "39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d",
      expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true },
      quality: "pass", faceVisible: true, portraitImageIndex: 0,
      localizationTrace: { traceVersion: 2, carrier: "structured_region", status: "VALID" },
      normalizedPortraitRegionPresent: true,
    });
    expect(snapshot.primary).not.toHaveProperty("portraitRegion");
    expect(snapshot.validLocalization).toBeNull();
    const storedInputOnly = calibrationLocalizationGate({
      primaryPassed: snapshot.primary.contractValidation.primaryCoreValid,
      quality: snapshot.primary.quality, faceVisible: snapshot.primary.faceVisible,
      portraitImageIndex: snapshot.primary.portraitImageIndex,
      expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      sourceVerified: true, imageCount: 1,
      trace: snapshot.primary.localizationTrace,
      portraitRegion: snapshot.primary.portraitRegion,
    });
    expect(storedInputOnly.providerLocalizationStatus).toBe("VALID");
    expect(storedInputOnly.calibrationLocalizationEligible).toBe(false);
    expect(storedInputOnly.normalizedRegion.ok).toBe(false);
  });
});
