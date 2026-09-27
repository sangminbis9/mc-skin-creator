import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseFaceIdentityGeometry, validateFaceGeometryProviderShape } from "../src/faceIdentityGeometry";
import { COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA } from "../src/compactPhotoAnalysisV4";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("pins the -005 missing-localization boundary without inventing a replacement region or measurement", () => {
  const path = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json";
  const bytes = readFileSync(path);
  const run = JSON.parse(bytes.toString()).currentDefaultE2E;
  const diagnostics = run.result.diagnostics;
  const replay = run.cropReplay;
  const crop = replay.diagnostics;
  const geometry = diagnostics.geometry.acceptedGeometry;
  const layout = run.result.analysis.skinPlan.facePixelPlan.layout;

  expect(diagnostics.localization).toMatchObject({ status: "MISSING", markerPresent: false });
  expect(diagnostics.normalizedPrimary.sourceSelection.portraitRegion).toBeNull();
  expect(replay.matchesActualWire).toBe(true);
  expect(replay.replaySha256).toBe(replay.actualWireCropSha256);
  expect(replay.actualWireCropSha256).toBe("0e2a052bc14ca48ed48c57ef646c7c1cc5c995cc497161bbd6ba273a292f6167");
  expect(crop.cropMode).toBe("center_fallback");
  expect(crop.faceCropDimensions).toEqual({ width: 343, height: 382 });
  expect(crop.faceCropLateralGuard.reason).toBe("localized_head_unavailable");
  expect(crop.quality.sourceClippingKnown).toBe(false);
  expect(crop.quality.warnings).toContain("portrait_region_unavailable");
  expect(crop.quality.usableForFaceGeometry).toBe(true);

  // Revalidate the persisted allowlist only. Passing schema/semantics does not
  // certify that this unlocalized crop contains the whole source face.
  const wire = structuredClone(geometry);
  delete wire.source;
  delete wire.eyes.interEyeDistance;
  delete wire.eyes.verticalAsymmetry;
  delete wire.nose.leftRightBias;
  expect(validateFaceGeometryProviderShape(wire)).toEqual([]);
  const errors: string[] = [];
  expect(parseFaceIdentityGeometry(wire, errors)).toEqual(geometry);
  expect(errors).toEqual([]);
  expect(geometry.face.envelopeRight).toBe(1);
  expect(geometry.directLowerFaceContour.chin.evidence).toBe("unknown");
  expect(layout.geometryUsage.eyes).toBe(true);
  expect(layout.geometryUsage.mouth).toBe(true);
  expect(layout.eyeTopology).toBe("asymmetric");
  expect(layout.mouthOpening).toBe("open");

  // A carrier string and a required nullable region are distinct contracts.
  // This test does not activate V4 or assert that V4 will return a valid region.
  for (const schema of [COMPACT_PHOTO_ANALYSIS_V3_SCHEMA, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA]) {
    expect(schema.properties!.sourceSelection.properties!.portraitEvidence).toEqual({ type: "string" });
    expect(schema.properties!.sourceSelection.properties).not.toHaveProperty("portraitRegion");
  }
  expect(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA.properties!.sourceSelection.required).toContain("portraitRegion");

  const root = mkdtempSync("evaluation-artifacts/current-default-005-localization-boundary-20260926-");
  writeFileSync(`${root}/results.json`, JSON.stringify({
    mode: "offline_persisted_evidence_no_image_or_provider_access",
    sourceSummarySha256: sha(bytes), providerCalls: 0,
    productionChange: false, defaultContractChanged: false,
    localization: diagnostics.localization,
    normalizedRegionAvailable: false,
    historicalCropSha256: replay.actualWireCropSha256,
    crop: { mode: crop.cropMode, dimensions: crop.faceCropDimensions,
      guardReason: crop.faceCropLateralGuard.reason,
      sourceClippingKnown: crop.quality.sourceClippingKnown,
      usableForFaceGeometry: crop.quality.usableForFaceGeometry },
    savedGeometryShapeValid: true, savedGeometrySemanticValid: true,
    sourceMeasurementAccuracyEstablished: false,
    geometryConsumed: { eyes: layout.geometryUsage.eyes, mouth: layout.geometryUsage.mouth },
    currentGrammar: { eyeTopology: layout.eyeTopology, mouthOpening: layout.mouthOpening },
    earliestUnresolvedBoundary: "provider_localization_missing_before_center_fallback_crop",
    limitations: ["crop boundary contact is not alone proof of clipping",
      "no source label, replacement region, or corrected geometry inferred",
      "V4 is internal opt-in only; source-specific V4 success is unobserved"],
  }, null, 2), { flag: "wx" });
  expect(sha(readFileSync(path))).toBe(sha(bytes));
});
