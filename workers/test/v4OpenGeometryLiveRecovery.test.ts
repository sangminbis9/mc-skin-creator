import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validatePortraitRegion } from "../src/analysis";
import type { FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { verifyV4NormalReference } from "./audit/v4OpenGeometryAudit";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

it("recovers the accepted -002 V4 OPEN localization and geometry without another provider call", async () => {
  const root = path.resolve("evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002");
  const final = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(final?.snapshotSha256).toBe(sha(JSON.stringify(final?.snapshot)));
  const saved = final?.snapshot as {
    classification: string;
    calls: { primaryPosts: number; geometryPosts: number };
    validatedLocalizationEvidence: { caseId: string; runId: string; derivativeSha256: string;
      provenanceComplete: boolean; region: unknown };
    validLocalization: { runId: string; region: unknown };
    v4Open: { primaryRunId: string; cropSha256: string; geometryImageSha256: string;
      acceptedGeometry: unknown; openOpenness: number; eyesConfidence: number;
      diskRecovery: boolean; acceptedGeometryRevalidated: boolean };
  };
  expect(saved.classification).toBe("V4_OPEN_GEOMETRY_OBSERVED_WITH_LIMITATIONS");
  expect(saved.calls).toMatchObject({ primaryPosts: 1, geometryPosts: 1 });
  expect(saved.validatedLocalizationEvidence).toMatchObject({ caseId: "open-eye-calibration-001",
    derivativeSha256: "9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b",
    provenanceComplete: true });
  expect(saved.validatedLocalizationEvidence.runId).toBe(saved.v4Open.primaryRunId);
  const region = validatePortraitRegion(saved.validatedLocalizationEvidence.region);
  expect(region.ok).toBe(true);
  expect(saved.validLocalization.region).toEqual(region.ok ? region.region : null);
  expect(saved.v4Open.geometryImageSha256).toBe(saved.v4Open.cropSha256);
  expect(saved.v4Open).toMatchObject({ diskRecovery: true, acceptedGeometryRevalidated: true,
    openOpenness: 0.5, eyesConfidence: 0.95 });
  const accepted = acceptedFaceGeometry(saved.v4Open.acceptedGeometry as FaceIdentityGeometryAnalysis);
  expect(accepted.eyes.openness).toBe(saved.v4Open.openOpenness);
  expect(accepted.confidence.eyes).toBe(saved.v4Open.eyesConfidence);
  expect((await verifyV4NormalReference()).normalOpenness).toBe(saved.v4Open.openOpenness);
});
