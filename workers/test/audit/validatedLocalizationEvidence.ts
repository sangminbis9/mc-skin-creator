import { validatePortraitRegion, type PortraitRegion } from "../../src/analysis";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../../src/compactPhotoAnalysisV4";
import type { ProtectedAuditLocalizationTrace } from "../primaryFaceMeasurementAuditWorker";

type ContractValidation = {
  providerWireSchemaValid: boolean | null;
  primaryCoreValid: boolean | null;
  localizationValid: boolean | null;
};

export type ProtectedValidatedLocalization = { portraitImageIndex: number; region: PortraitRegion };

const copyRegion = (region: PortraitRegion): PortraitRegion => ({
  subjectBox: { left: region.subjectBox.left, top: region.subjectBox.top,
    right: region.subjectBox.right, bottom: region.subjectBox.bottom },
  headBox: { left: region.headBox.left, top: region.headBox.top,
    right: region.headBox.right, bottom: region.headBox.bottom },
  faceBox: { left: region.faceBox.left, top: region.faceBox.top,
    right: region.faceBox.right, bottom: region.faceBox.bottom },
  confidence: region.confidence,
});

/** Protected Worker projection: only an already-normalized, revalidated region crosses the boundary. */
export function projectProtectedValidatedLocalization(input: {
  primaryOk: boolean;
  primaryCoreValid: unknown;
  localizationValid: unknown;
  portraitImageIndex: unknown;
  portraitRegion: unknown;
  imageCount: number;
}): ProtectedValidatedLocalization | null {
  if (!input.primaryOk || input.primaryCoreValid !== true || input.localizationValid !== true
    || !Number.isInteger(input.portraitImageIndex) || typeof input.portraitImageIndex !== "number"
    || input.portraitImageIndex < 0 || input.portraitImageIndex >= input.imageCount
    || !record(input.portraitRegion)) return null;
  const validated = validatePortraitRegion(input.portraitRegion);
  return validated.ok ? { portraitImageIndex: input.portraitImageIndex, region: copyRegion(validated.region) } : null;
}

type EvidenceInput = {
  primaryOk: boolean;
  expectedContractVersion: unknown;
  contractValidation: ContractValidation | null | undefined;
  protectedLocalization: unknown;
  localizationTrace: unknown;
  imageCount: number;
  runId: unknown;
  caseId: unknown;
  sourceSha256: unknown;
  derivativeSha256: unknown;
  inputDimensions: { width: unknown; height: unknown } | null;
  provider: unknown;
  model: unknown;
  promptSha256: unknown;
  schemaJsonSha256: unknown;
};

export type ValidatedLocalizationEvidence = {
  evidenceSchemaVersion: 1;
  runId: string | null;
  caseId: string | null;
  sourceSha256: string | null;
  derivativeSha256: string | null;
  inputDimensions: { width: number; height: number } | null;
  portraitImageIndex: number;
  expectedContractVersion: typeof PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION;
  provider: "gemini" | "workers_ai" | null;
  model: string | null;
  promptSha256: string | null;
  schemaJsonSha256: string | null;
  hashDomains: { prompt: "final_prompt_utf8_sha256"; schema: "json_stringify_provider_schema_sha256" };
  contractValidation: ContractValidation;
  localizationTrace: ProtectedAuditLocalizationTrace | null;
  region: PortraitRegion;
  provenanceComplete: boolean;
  missingProvenance: string[];
};

export type ValidatedLocalizationCapture =
  | { status: "captured"; evidence: ValidatedLocalizationEvidence }
  | { status: "not_captured"; reason: "primary_failed" | "wrong_contract" | "core_invalid"
    | "localization_invalid" | "region_missing_or_invalid" };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;

function protectedTrace(value: unknown): ProtectedAuditLocalizationTrace | null {
  if (!record(value) || value.traceVersion !== 2
    || value.contractVersion !== PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
    || value.carrier !== "structured_region"
    || !["VALID", "EXPLICIT_NULL", "MISSING", "MALFORMED", "INVALID_REGION"].includes(String(value.status))
    || typeof value.fieldPresent !== "boolean"
    || !["passed", "failed", "not_applicable"].includes(String(value.shapeValidation))
    || !["passed", "failed", "not_applicable"].includes(String(value.regionValidation))) return null;
  const validationReason = value.validationReason;
  if (validationReason !== null && !["portrait_region_missing", "malformed_normalized_bounds",
    "invalid_localization_confidence", "face_bounds_too_small", "face_head_relationship_invalid",
    "face_outside_head", "head_outside_subject"].includes(String(validationReason))) return null;
  return {
    traceVersion: 2, contractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
    carrier: "structured_region",
    status: value.status as Extract<ProtectedAuditLocalizationTrace, { traceVersion: 2 }>["status"],
    fieldPresent: value.fieldPresent,
    shapeValidation: value.shapeValidation as Extract<ProtectedAuditLocalizationTrace, { traceVersion: 2 }>["shapeValidation"],
    regionValidation: value.regionValidation as Extract<ProtectedAuditLocalizationTrace, { traceVersion: 2 }>["regionValidation"],
    validationReason: validationReason as Extract<ProtectedAuditLocalizationTrace, { traceVersion: 2 }>["validationReason"],
  };
}

/** Runner boundary: revalidate the protected DTO and copy evidence before any calibration gate. */
export function captureValidatedLocalizationEvidence(input: EvidenceInput): ValidatedLocalizationCapture {
  if (!input.primaryOk) return { status: "not_captured", reason: "primary_failed" };
  if (input.expectedContractVersion !== PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION) {
    return { status: "not_captured", reason: "wrong_contract" };
  }
  if (input.contractValidation?.primaryCoreValid !== true) {
    return { status: "not_captured", reason: "core_invalid" };
  }
  if (input.contractValidation.localizationValid !== true) {
    return { status: "not_captured", reason: "localization_invalid" };
  }
  if (!record(input.protectedLocalization)) {
    return { status: "not_captured", reason: "region_missing_or_invalid" };
  }
  const projected = projectProtectedValidatedLocalization({
    primaryOk: true, primaryCoreValid: true, localizationValid: true,
    portraitImageIndex: input.protectedLocalization.portraitImageIndex,
    portraitRegion: input.protectedLocalization.region,
    imageCount: input.imageCount,
  });
  if (!projected) return { status: "not_captured", reason: "region_missing_or_invalid" };

  const runId = typeof input.runId === "string" && /^[0-9a-f]{32}$/.test(input.runId) ? input.runId : null;
  const caseId = typeof input.caseId === "string" && /^[a-z0-9-]{1,64}$/.test(input.caseId) ? input.caseId : null;
  const sourceSha256 = sha(input.sourceSha256);
  const derivativeSha256 = sha(input.derivativeSha256);
  const inputDimensions = input.inputDimensions && Number.isInteger(input.inputDimensions.width)
    && Number.isInteger(input.inputDimensions.height)
    && typeof input.inputDimensions.width === "number" && typeof input.inputDimensions.height === "number"
    && input.inputDimensions.width > 0 && input.inputDimensions.height > 0
    ? { width: input.inputDimensions.width, height: input.inputDimensions.height } : null;
  const provider = input.provider === "gemini" || input.provider === "workers_ai" ? input.provider : null;
  const model = provider && typeof input.model === "string" && /^[a-zA-Z0-9@/_\-.]{1,100}$/.test(input.model)
    ? input.model : null;
  const promptSha256 = sha(input.promptSha256);
  const schemaJsonSha256 = sha(input.schemaJsonSha256);
  const localizationTrace = protectedTrace(input.localizationTrace);
  const missingProvenance = Object.entries({ runId, caseId, sourceSha256, derivativeSha256,
    inputDimensions, provider, model, promptSha256, schemaJsonSha256, localizationTrace })
    .filter(([, value]) => value === null).map(([name]) => name);
  return { status: "captured", evidence: {
    evidenceSchemaVersion: 1, runId, caseId, sourceSha256, derivativeSha256, inputDimensions,
    portraitImageIndex: projected.portraitImageIndex,
    expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
    provider, model, promptSha256, schemaJsonSha256,
    hashDomains: { prompt: "final_prompt_utf8_sha256", schema: "json_stringify_provider_schema_sha256" },
    contractValidation: { providerWireSchemaValid: typeof input.contractValidation.providerWireSchemaValid === "boolean"
      ? input.contractValidation.providerWireSchemaValid : null,
      primaryCoreValid: input.contractValidation.primaryCoreValid,
      localizationValid: input.contractValidation.localizationValid },
    localizationTrace,
    region: copyRegion(projected.region),
    provenanceComplete: missingProvenance.length === 0, missingProvenance,
  } };
}

/** The caller must await its existing authoritative checkpoint before running the calibration gate. */
export async function checkpointValidatedLocalizationCapture(
  input: EvidenceInput,
  persist: (capture: ValidatedLocalizationCapture) => Promise<void>,
): Promise<ValidatedLocalizationCapture> {
  const capture = captureValidatedLocalizationEvidence(input);
  await persist(capture);
  return capture;
}
