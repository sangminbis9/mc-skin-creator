import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { verifyPreparedE2E } from "./currentDefaultE2ELive";
import { imageIdentity } from "./currentDefaultE2E";
import { accountingOf } from "../primaryAuditRunnerSupport";
import { createIdentityCrops } from "../../src/generate";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION, COMPACT_PHOTO_ANALYSIS_V4_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA } from "../../src/compactPhotoAnalysisV4";
import { GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA } from "../../src/gemmaPhotoAnalysis";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA,
  FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS, type FaceIdentityGeometryAnalysis } from "../../src/faceIdentityGeometry";
import { captureValidatedLocalizationEvidence, type ValidatedLocalizationCapture } from "./validatedLocalizationEvidence";
import { calibrationLocalizationGate } from "./calibrationLocalizationGate";
import { validatedSameRunCropContext } from "./v4OpenGeometryAudit";
import { acceptedFaceGeometry } from "./savedV4FaceGeometry";
import type { ProtectedAuditLocalizationTrace } from "../primaryFaceMeasurementAuditWorker";
import type { PortraitRegion } from "../../src/analysis";

export const CURRENT_SOURCE_V4_ROOT = path.resolve("evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-002");
export const CURRENT_SOURCE_V4_SELECTOR = "approved-29002888-v4-localization-20260926-002";
export const ANALYSIS_SHA = "a98165d2ed43a031cfbd182871417a3555f31474a630df6a6be34278b5e317f3";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
export function currentSourceV4Contract() {
  const contract = {
    version: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
    gemini: { model: "gemini-3.8-flash", promptSha256: sha(COMPACT_PHOTO_ANALYSIS_V4_PROMPT + suffix),
      schemaJsonSha256: sha(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA)) },
    gemma: { model: "@cf/google/gemma-4-26b-a4b-it", promptSha256: sha(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT + suffix),
      schemaJsonSha256: sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA)) },
    geometry: { model: FACE_GEOMETRY_MODEL, timeoutMs: FACE_GEOMETRY_TIMEOUT_MS,
      promptSha256: sha(FACE_IDENTITY_GEOMETRY_PROMPT), schemaJsonSha256: sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)) },
  };
  if (contract.gemini.promptSha256 !== "af8ed44ca8cfd3d571706be2a87206d186383c66c7f6c5b5e38b056014ff2c08"
    || contract.gemini.schemaJsonSha256 !== "5461f447d49f687b66c5cf03ee73b71c586f6e5349e8ca642f3ddac409e80b7d"
    || contract.gemma.promptSha256 !== "fbd169cc36a61662cc6a3c3a3300893b32cff44db6f49874c1844824d7b9d99a"
    || contract.gemma.schemaJsonSha256 !== "b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3"
    || contract.geometry.promptSha256 !== "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd"
    || contract.geometry.schemaJsonSha256 !== "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469"
    || contract.geometry.model !== contract.gemma.model || contract.geometry.timeoutMs !== 25000)
    throw new Error("current_source_v4_contract_drift");
  return contract;
}

export async function prepareCurrentSourceV4() {
  if (fs.existsSync(CURRENT_SOURCE_V4_ROOT)) throw new Error("current_source_v4_fresh_root_required");
  const contract = currentSourceV4Contract();
  const response = await fetch("http://127.0.0.1:59926/consume", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("production_preprocessing_not_ready");
  const prepared = await verifyPreparedE2E(await response.json() as Parameters<typeof verifyPreparedE2E>[0]);
  if (prepared.metadata.analysis.sha256 !== ANALYSIS_SHA || prepared.metadata.analysis.bytes !== 110605)
    throw new Error("approved_analysis_derivative_mismatch");
  const files = ["wrangler.jsonc", "../src/lib/imageQuality.ts",
    ...fs.readdirSync("src", { recursive: true }).map(String).map(file => path.join("src", file)).filter(file => fs.statSync(file).isFile())];
  // Generation bytes stay local and are not returned to this audit's dispatcher.
  return { imageDataUrl: prepared.payload.analysisImage, source: prepared.metadata.source,
    input: prepared.metadata.analysis, contract,
    fixedHashes: Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(file))])) };
}

export function createCurrentSourceV4State() {
  return { primaryRunId: randomBytes(16).toString("hex"), geometryRunId: randomBytes(16).toString("hex"),
    primaryPosts: 0, geometryPosts: 0, cropPreparations: 0, retry: 0,
    primaryHttp: null as number | null, geometryHttp: null as number | null,
    primaryElapsedMs: null as number | null, geometryElapsedMs: null as number | null,
    primaryAccounting: { dispatch: "unknown" } as ReturnType<typeof accountingOf>,
    geometryAccounting: null as ReturnType<typeof accountingOf> | null,
    primary: null as Record<string, unknown> | null,
    localization: null as ValidatedLocalizationCapture | null,
    crop: null as Record<string, unknown> | null,
    geometry: null as Record<string, unknown> | null,
    acceptedGeometry: null as FaceIdentityGeometryAnalysis | null,
    classification: "not_started", diskRecovery: false };
}
export type CurrentSourceV4State = ReturnType<typeof createCurrentSourceV4State>;
type Primary = {
  ok?: boolean; expectedContractVersion?: string; auditState?: unknown;
  contractValidation?: { providerWireSchemaValid: boolean; primaryCoreValid: boolean; localizationValid: boolean };
  validatedLocalization?: unknown; localizationTrace?: ProtectedAuditLocalizationTrace;
  providerSequence?: Array<{ provider?: string; model?: string; modelId?: string; outcome?: string;
    httpStatus?: number; providerStatus?: string; elapsedMs?: number }>;
  validation?: Record<string, string>;
  analysis?: { quality?: string; visibleRegions?: { face?: boolean }; identityCropContext?: unknown;
    sourceSelection?: { portraitImageIndex?: number; portraitRegion?: PortraitRegion | null } };
};
type Geometry = { ok?: boolean; auditState?: unknown; inputMode?: string; crop?: unknown;
  providerShapeValid?: boolean; errors?: string[]; geometry?: FaceIdentityGeometryAnalysis;
  httpStatus?: number | null; providerStatus?: string | null };
type Post = (route: "/primary-audit-v4-structured-localization" | "/face-geometry-direct-audit",
  image: string, runId: string) => Promise<{ status: number; body: unknown }>;

/** Injected transport is the existing protected Worker; never loops or retries. */
export async function runCurrentSourceV4(state: CurrentSourceV4State,
  input: { imageDataUrl: string; source: { sha256: string }; input: { sha256: string; width: number; height: number } },
  post: Post, persist: (event: string) => Promise<void>, cropper = createIdentityCrops) {
  if (state.primaryPosts) throw new Error("current_source_v4_already_consumed");
  const contract = currentSourceV4Contract();
  await persist("currentSourceV4PrimaryIntent");
  state.primaryPosts = 1;
  await persist("currentSourceV4PrimaryPostStarted");
  const start = Date.now();
  let primaryResponse: Awaited<ReturnType<Post>>;
  try { primaryResponse = await post("/primary-audit-v4-structured-localization", input.imageDataUrl, state.primaryRunId); }
  catch { state.primaryElapsedMs = Date.now() - start; state.classification = "V4_PRIMARY_RESPONSE_UNOBSERVED";
    await persist("currentSourceV4PrimaryUnobserved"); return; }
  state.primaryElapsedMs = Date.now() - start; state.primaryHttp = primaryResponse.status;
  const primary = primaryResponse.body as Primary;
  state.primaryAccounting = accountingOf(primary.auditState, state.primaryRunId);
  const sequence = primary.providerSequence ?? [];
  const completed = sequence.filter(p => p.outcome === "completed");
  const selected = completed.length === 1 ? completed[0] : null;
  const selectedContract = selected?.provider === "gemini" ? contract.gemini
    : selected?.provider === "workers_ai" ? contract.gemma : null;
  state.primary = { ok: primary.ok === true, expectedContractVersion: primary.expectedContractVersion ?? null,
    contractValidation: primary.contractValidation ?? null, validation: primary.validation ?? null,
    localizationTrace: primary.localizationTrace ?? null,
    providerSequence: sequence.map(p => ({ provider: p.provider, model: p.model ?? p.modelId,
      outcome: p.outcome, httpStatus: p.httpStatus, providerStatus: p.providerStatus, elapsedMs: p.elapsedMs })) };
  state.localization = captureValidatedLocalizationEvidence({ primaryOk: primary.ok === true,
    expectedContractVersion: primary.expectedContractVersion, contractValidation: primary.contractValidation,
    protectedLocalization: primary.validatedLocalization, localizationTrace: primary.localizationTrace,
    imageCount: 1, runId: state.primaryRunId, caseId: "pexels-29002888",
    sourceSha256: input.source.sha256, derivativeSha256: input.input.sha256,
    inputDimensions: input.input, provider: selected?.provider, model: selected?.model ?? selected?.modelId,
    promptSha256: selectedContract?.promptSha256, schemaJsonSha256: selectedContract?.schemaJsonSha256 });
  await persist("currentSourceV4PrimaryCaptured");
  const a = state.primaryAccounting;
  const passed = primaryResponse.status === 200 && primary.ok === true
    && primary.expectedContractVersion === contract.version && primary.validation?.richPhotoAnalysis === "passed"
    && primary.contractValidation?.providerWireSchemaValid === true && primary.contractValidation.primaryCoreValid === true
    && primary.contractValidation.localizationValid === true && a.dispatch === "known"
    && a.providerCalls.geminiStarted <= 1 && a.providerCalls.gemmaStarted <= 1 && a.providerCalls.retry === 0;
  const gate = calibrationLocalizationGate({ primaryPassed: passed, quality: primary.analysis?.quality,
    faceVisible: primary.analysis?.visibleRegions?.face, portraitImageIndex: primary.analysis?.sourceSelection?.portraitImageIndex,
    expectedContractVersion: contract.version, sourceVerified: true, imageCount: 1,
    trace: primary.localizationTrace, portraitRegion: primary.analysis?.sourceSelection?.portraitRegion });
  if (!gate.calibrationLocalizationEligible || !gate.normalizedRegion.ok
    || state.localization.status !== "captured" || !state.localization.evidence.provenanceComplete
    || state.localization.evidence.model !== selectedContract?.model
    || JSON.stringify(state.localization.evidence.region) !== JSON.stringify(gate.normalizedRegion.region)) {
    state.classification = "V4_LOCALIZATION_UNAVAILABLE"; await persist("currentSourceV4LocalizationBlocked"); return;
  }
  const context = validatedSameRunCropContext(primary.analysis?.identityCropContext);
  if (!context) { state.classification = "V4_CROP_CONTEXT_UNAVAILABLE"; await persist("currentSourceV4ContextBlocked"); return; }
  state.cropPreparations++;
  const crop = await cropper(input.imageDataUrl, gate.normalizedRegion.region, context);
  if (!crop || crop.diagnostics.cropMode !== "subject_aware" || !crop.diagnostics.quality.usableForFaceGeometry) {
    state.classification = "V4_PRODUCTION_CROP_UNUSABLE"; await persist("currentSourceV4CropBlocked"); return;
  }
  const cropIdentity = await imageIdentity(crop.faceDataUrl);
  state.crop = { ...cropIdentity, context, diagnostics: crop.diagnostics, sourceDerivativeSha256: input.input.sha256,
    primaryRunId: state.primaryRunId, geometryRunId: state.geometryRunId };
  await persist("currentSourceV4CropVerifiedGeometryIntent");
  state.geometryPosts = 1;
  await persist("currentSourceV4GeometryPostStarted");
  const geometryStart = Date.now();
  let geometryResponse: Awaited<ReturnType<Post>>;
  try { geometryResponse = await post("/face-geometry-direct-audit", crop.faceDataUrl, state.geometryRunId); }
  catch { state.geometryElapsedMs = Date.now() - geometryStart; state.classification = "V4_GEOMETRY_RESPONSE_UNOBSERVED";
    await persist("currentSourceV4GeometryUnobserved"); return; }
  state.geometryElapsedMs = Date.now() - geometryStart; state.geometryHttp = geometryResponse.status;
  const result = geometryResponse.body as Geometry;
  state.geometryAccounting = accountingOf(result.auditState, state.geometryRunId);
  const ga = state.geometryAccounting;
  const safeErrors = (result.errors ?? []).filter(e => /^(?:faceGeometry|geometry)(?:\.[A-Za-z0-9_.]+)?:[A-Za-z0-9_]+$/.test(e) && e.length <= 128).slice(0, 32);
  state.geometry = { providerShapeValid: result.providerShapeValid ?? null,
    semanticValid: result.ok === true && result.errors?.length === 0, errors: safeErrors,
    httpStatus: result.httpStatus ?? null, providerStatus: result.providerStatus ?? null };
  if (geometryResponse.status === 200 && result.ok === true && result.providerShapeValid === true
    && result.errors?.length === 0 && result.inputMode === "direct_frozen_face_crop" && result.crop === null
    && ga.dispatch === "known" && ga.providerCalls.geminiStarted === 0 && ga.providerCalls.gemmaStarted === 1
    && ga.providerCalls.retry === 0 && result.geometry) {
    state.acceptedGeometry = acceptedFaceGeometry(result.geometry);
  }
  state.classification = state.acceptedGeometry ? "V4_LOCALIZATION_AND_GEOMETRY_ACQUIRED" : "V4_GEOMETRY_NOT_ACCEPTED";
  await persist("currentSourceV4GeometryCaptured");
}
