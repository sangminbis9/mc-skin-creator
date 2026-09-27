import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePortraitRegion } from "../src/analysis";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { readLatestAuditCheckpoint, type CheckpointRecord } from "./primaryAuditRunnerSupport";
import type { ValidatedLocalizationEvidence } from "./audit/validatedLocalizationEvidence";

const ROOT = path.resolve("evaluation-artifacts/v4-validated-localization-persistence-live-20260925-001");
const VERIFY = process.env.VERIFY_V4_VALIDATED_LOCALIZATION_LIVE === "approved-offline-recovery-20260925-001";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

it.skipIf(!VERIFY)("recovers the live V4 evidence from authoritative versions without a remote selector", async () => {
  const summaryPath = path.join(ROOT, "summary.json");
  expect(existsSync(ROOT)).toBe(true);
  const latest = await readLatestAuditCheckpoint(summaryPath);
  expect(latest).not.toBeNull();
  const snapshot = latest!.snapshot as { validatedLocalizationCapture?: { status?: string };
    validatedLocalizationEvidence?: ValidatedLocalizationEvidence | null;
    calls?: { faceCropPreparations?: number; geometryPosts?: number };
    primaryContract?: Record<string, string> };
  expect(snapshot.calls?.faceCropPreparations).toBe(0);
  expect(snapshot.calls?.geometryPosts).toBe(0);

  const versions = readdirSync(ROOT).filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name));
  const evidenceRecords = versions.map(name => JSON.parse(readFileSync(path.join(ROOT, name), "utf8")) as CheckpointRecord)
    .filter(record => record.event === "validatedLocalizationObserved:wavy-open-blazer");
  if (snapshot.validatedLocalizationCapture?.status !== "captured") {
    expect(snapshot.validatedLocalizationEvidence).toBeNull();
    expect(evidenceRecords).toHaveLength(0);
    return;
  }

  expect(evidenceRecords).toHaveLength(1);
  const record = evidenceRecords[0];
  expect(record.schemaVersion).toBe(1);
  expect(record.sequence).toBeLessThan(latest!.sequence);
  expect(record.snapshotSha256).toBe(sha256(JSON.stringify(record.snapshot)));
  const observed = (record.snapshot as { validatedLocalizationEvidence: ValidatedLocalizationEvidence })
    .validatedLocalizationEvidence;
  const recovered = snapshot.validatedLocalizationEvidence;
  expect(recovered).toEqual(observed);
  expect(recovered?.evidenceSchemaVersion).toBe(1);
  expect(recovered?.caseId).toBe("wavy-open-blazer");
  expect(recovered?.runId).toMatch(/^[0-9a-f]{32}$/);
  expect(recovered?.sourceSha256).toBe("fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702");
  expect(recovered?.derivativeSha256).toBe("39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d");
  expect(recovered?.inputDimensions).toEqual({ width: 597, height: 896 });
  expect(recovered?.portraitImageIndex).toBe(0);
  expect(recovered?.expectedContractVersion).toBe(PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION);
  expect(recovered?.provider).toMatch(/^(gemini|workers_ai)$/);
  expect(recovered?.model).toBeTruthy();
  expect(recovered?.promptSha256).toBe(snapshot.primaryContract?.[recovered?.provider === "gemini"
    ? "promptFinalSha256" : "gemmaPromptFinalSha256"]);
  expect(recovered?.schemaJsonSha256).toBe(snapshot.primaryContract?.[recovered?.provider === "gemini"
    ? "schemaJsonSha256" : "gemmaSchemaJsonSha256"]);
  expect(recovered?.hashDomains).toEqual({ prompt: "final_prompt_utf8_sha256",
    schema: "json_stringify_provider_schema_sha256" });
  expect(recovered?.contractValidation.primaryCoreValid).toBe(true);
  expect(recovered?.contractValidation.localizationValid).toBe(true);
  expect(recovered?.region).toBeDefined();
  const validated = validatePortraitRegion(recovered?.region);
  expect(validated.ok).toBe(true);
  if (validated.ok) expect(validated.region).toEqual(recovered?.region);
});
