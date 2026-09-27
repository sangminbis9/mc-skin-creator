import { validatePortraitRegion } from "../../src/analysis";
import {
  PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
  type PrimaryContractVersion,
} from "../../src/compactPhotoAnalysisV4";
import type { ProtectedAuditLocalizationTrace } from "../primaryFaceMeasurementAuditWorker";

/** Calibration-only gate. Production generation deliberately does not call this. */
export function calibrationLocalizationGate(input: {
  primaryPassed: boolean;
  quality: unknown;
  faceVisible: unknown;
  portraitImageIndex: unknown;
  imageCount?: number;
  sourceVerified?: boolean;
  expectedContractVersion?: PrimaryContractVersion;
  trace: ProtectedAuditLocalizationTrace | null | undefined;
  portraitRegion: unknown;
}) {
  const normalizedRegion = validatePortraitRegion(input.portraitRegion);
  const structured = input.expectedContractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION;
  const carrierMatches = structured
    ? input.trace?.traceVersion === 2
      && input.trace.contractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
      && input.trace.carrier === "structured_region" && input.sourceVerified === true
    : input.trace?.traceVersion === 1;
  const imageCount = input.imageCount ?? 1;
  const eligible = input.primaryPassed
    && input.quality === "pass"
    && input.faceVisible === true
    && Number.isInteger(imageCount) && imageCount >= 1 && imageCount <= 5
    && Number.isInteger(input.portraitImageIndex)
    && typeof input.portraitImageIndex === "number"
    && input.portraitImageIndex >= 0 && input.portraitImageIndex < imageCount
    && carrierMatches
    && input.trace?.status === "VALID"
    && normalizedRegion.ok;
  return {
    providerLocalizationStatus: input.trace?.status ?? null,
    calibrationLocalizationEligible: eligible,
    normalizedRegion,
  };
}

/** Historical-only interpretation: absence of a sidecar is never an observed provider token. */
export function historicalLocalizationInterpretation(normalizedRegion: unknown) {
  return {
    preNormalizationTraceObserved: false as const,
    classification: validatePortraitRegion(normalizedRegion).ok
      ? "INFERRED_VALID_FROM_NORMALIZED_REGION" as const
      : "UNKNOWN_NULL_COLLAPSED" as const,
  };
}
