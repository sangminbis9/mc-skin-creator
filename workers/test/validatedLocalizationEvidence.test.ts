import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePortraitRegion } from "../src/analysis";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
  validateStructuredLocalization } from "../src/compactPhotoAnalysisV4";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { captureValidatedLocalizationEvidence, checkpointValidatedLocalizationCapture,
  projectProtectedValidatedLocalization } from "./audit/validatedLocalizationEvidence";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";

const region = {
  subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
  headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
  faceBox: { left: 0.21, top: 0.17, right: 0.47, bottom: 0.44 },
  confidence: 0.91,
};
const protectedTrace = auditLocalizationTrace(validateStructuredLocalization(true, region).trace);
const base = () => ({
  primaryOk: true,
  expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
  contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true },
  protectedLocalization: projectProtectedValidatedLocalization({ primaryOk: true, primaryCoreValid: true,
    localizationValid: true, portraitImageIndex: 0, portraitRegion: region, imageCount: 1 }),
  localizationTrace: protectedTrace,
  imageCount: 1,
  runId: randomBytes(16).toString("hex"), caseId: "wavy-open-blazer",
  sourceSha256: "a".repeat(64), derivativeSha256: "b".repeat(64),
  inputDimensions: { width: 597, height: 896 },
  provider: "workers_ai", model: "@cf/google/gemma-4-26b-a4b-it",
  promptSha256: "c".repeat(64), schemaJsonSha256: "d".repeat(64),
});
const checkpoint = async () => join(await mkdtemp(join(tmpdir(), "validated-localization-")), "summary.json");

describe("validated localization evidence is independent of calibration eligibility", () => {
  it("persists copied region before a strict gate rejection, without crop or geometry", async () => {
    const input = base();
    const wrongTrace = { ...protectedTrace, traceVersion: 1 };
    const path = await checkpoint();
    const captured = await checkpointValidatedLocalizationCapture({ ...input, localizationTrace: wrongTrace },
      async observed => {
        await atomicCheckpoint(path, { validatedLocalizationEvidence: observed.status === "captured"
          ? observed.evidence : null }, "validated_localization_observed");
      });
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") return;
    expect(captured.evidence.provenanceComplete).toBe(false);
    expect(captured.evidence.missingProvenance).toContain("localizationTrace");
    const recovered = await readLatestAuditCheckpoint(path);
    expect(recovered?.event).toBe("validated_localization_observed");
    expect((recovered?.snapshot as { validatedLocalizationEvidence: typeof captured.evidence })
      .validatedLocalizationEvidence.region).toEqual(region);
    const gate = calibrationLocalizationGate({ primaryPassed: true, quality: "pass", faceVisible: true,
      portraitImageIndex: 0, imageCount: 1, sourceVerified: true,
      expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      trace: wrongTrace as typeof protectedTrace, portraitRegion: region });
    expect(gate.calibrationLocalizationEligible).toBe(false);
  });

  it("recovers the authoritative evidence after a later local gate exception", async () => {
    const path = await checkpoint();
    const captured = await checkpointValidatedLocalizationCapture(base(), async observed => {
      await atomicCheckpoint(path, { validatedLocalizationEvidence: observed.status === "captured"
        ? observed.evidence : null }, "validated_localization_observed");
    });
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") return;
    const failingGate = () => { throw new Error("local_gate_failure"); };
    expect(failingGate).toThrow("local_gate_failure");
    const recovered = await readLatestAuditCheckpoint(path);
    expect((recovered?.snapshot as { validatedLocalizationEvidence: typeof captured.evidence })
      .validatedLocalizationEvidence.region).toEqual(region);
  });

  it("does not return a capture or reach the gate when authoritative persistence fails", async () => {
    let gateCalls = 0;
    await expect(checkpointValidatedLocalizationCapture(base(), async () => {
      throw new Error("authoritative_checkpoint_failed");
    }).then(() => { gateCalls++; })).rejects.toThrow("authoritative_checkpoint_failed");
    expect(gateCalls).toBe(0);
  });

  it("does not promote flags without a region, rejected localization, or an invalid index", () => {
    for (const value of [null, undefined, "malformed", { ...region, faceBox: {
      left: 0.7, top: 0.17, right: 0.9, bottom: 0.44,
    } }]) {
      expect(projectProtectedValidatedLocalization({ primaryOk: true, primaryCoreValid: true,
        localizationValid: true, portraitImageIndex: 0, portraitRegion: value, imageCount: 1 })).toBeNull();
    }
    const input = base();
    for (const candidate of [
      { ...input, primaryOk: false },
      { ...input, expectedContractVersion: "primary_compact_v3_legacy_suffix" },
      { ...input, contractValidation: { ...input.contractValidation, primaryCoreValid: false } },
      { ...input, contractValidation: { ...input.contractValidation, localizationValid: false } },
      { ...input, protectedLocalization: null },
      { ...input, protectedLocalization: { ...input.protectedLocalization, portraitImageIndex: 1 } },
    ]) {
      expect(captureValidatedLocalizationEvidence(candidate).status).toBe("not_captured");
    }
  });

  it("copies only validated numeric boxes and preserves wire=false and missing provenance", () => {
    const original = { ...region, rejectedCoordinates: "raw-model-payload",
      headBox: { ...region.headBox, rawProse: "do-not-persist" } };
    const projection = projectProtectedValidatedLocalization({ primaryOk: true, primaryCoreValid: true,
      localizationValid: true, portraitImageIndex: 0, portraitRegion: original, imageCount: 1 });
    expect(projection?.region).toEqual(region);
    const input = base();
    const captured = captureValidatedLocalizationEvidence({ ...input,
      contractValidation: { ...input.contractValidation, providerWireSchemaValid: false },
      protectedLocalization: projection, promptSha256: undefined });
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") return;
    expect(captured.evidence.contractValidation.providerWireSchemaValid).toBe(false);
    expect(captured.evidence.promptSha256).toBeNull();
    expect(captured.evidence.missingProvenance).toContain("promptSha256");
    expect(JSON.stringify(captured)).not.toMatch(/raw-model-payload|do-not-persist|rejectedCoordinates|rawProse/);
  });

  it("does not mutate persisted coordinates through a shared memory reference", async () => {
    const input = base();
    const captured = captureValidatedLocalizationEvidence(input);
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") return;
    const path = await checkpoint();
    await atomicCheckpoint(path, { validatedLocalizationEvidence: captured.evidence }, "validated_localization_observed");
    region.faceBox.left = 0.22;
    try {
      expect(captured.evidence.region.faceBox.left).toBe(0.21);
      const recovered = await readLatestAuditCheckpoint(path);
      expect((recovered?.snapshot as { validatedLocalizationEvidence: typeof captured.evidence })
        .validatedLocalizationEvidence.region.faceBox.left).toBe(0.21);
    } finally { region.faceBox.left = 0.21; }
  });

  it("recovers evidence when the summary projection fails and skips a corrupt newest version", async () => {
    const captured = captureValidatedLocalizationEvidence(base());
    expect(captured.status).toBe("captured");
    if (captured.status !== "captured") return;
    const path = await checkpoint();
    const written = await atomicCheckpoint(path, { validatedLocalizationEvidence: captured.evidence },
      "validated_localization_observed", {
        writeVersion: async (destination, text) => writeFile(destination, text, { flag: "wx" }),
        replaceSummary: async () => { throw new Error("summary_projection_failed"); },
      });
    expect(written.summaryProjectionFailed).toBe(true);
    expect((await readLatestAuditCheckpoint(path))?.event).toBe("validated_localization_observed");
    await writeFile(`${path}.checkpoint-000002.json`, "{");
    const recovered = await readLatestAuditCheckpoint(path);
    expect(recovered?.sequence).toBe(1);
    const evidence = (recovered?.snapshot as { validatedLocalizationEvidence: typeof captured.evidence })
      .validatedLocalizationEvidence;
    expect(validatePortraitRegion(evidence.region).ok).toBe(true);
  });
});
