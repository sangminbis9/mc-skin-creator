import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { decode as decodeJpeg } from "jpeg-js";
import { decodeImage } from "../../src/png";
import type { AdaptiveHeadCropContext } from "../../src/adaptiveHeadCrop";
import type { FaceIdentityGeometryAnalysis } from "../../src/faceIdentityGeometry";
import { FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS,
  FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA } from "../../src/faceIdentityGeometry";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../../src/compactPhotoAnalysisV4";
import { readLatestAuditCheckpoint } from "../primaryAuditRunnerSupport";
import { acceptedFaceGeometry, SAVED_V4_CROP_SHA } from "./savedV4FaceGeometry";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const NORMAL_ROOT = path.resolve("evaluation-artifacts/v4-wavy-saved-face-crop-geometry-live-20260925-001");
const NORMAL_CROP_ROOT = path.resolve("evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001");
const OPEN_FREEZE = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/frozen-open-label.json");
const OPEN_ORIGINAL = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const OPEN_DERIVATIVE_ROOT = path.resolve("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001");
const ORIGINAL_SHA = "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac";
const ORIGINAL_RGBA_SHA = "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89";
const DERIVATIVE_SHA = "9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b";
const DERIVATIVE_RGBA_SHA = "7f97174def06d69b590bd5d8466f398e0ef6a26fa54b7ffba3af969520605a68";
const LABEL_SHA = "b1c7a8fb3bb8275e5d656420e4bbc418992815c1aefb402896875dc441bc10ed";
const assert = (value: unknown, reason: string): asserts value => { if (!value) throw new Error(reason); };

/** Complete local-only input preflight. Never returns the canonical original bytes. */
export async function verifyFrozenV4OpenInputs(readBytes: (file: string) => Buffer = fs.readFileSync) {
  const frozen = JSON.parse(readBytes(OPEN_FREEZE).toString("utf8")) as {
    payload: { caseId: string; sourceSha256: string; decodedRgbaSha256: string; bytes: number;
      dimensions: { width: number; height: number }; label: { eyeOpenness: string };
      labelFrozenBeforeProvider: boolean; sourceReview: { lateralFaceMargins: string;
        stableAperture: string; glasses: string; occlusion: string } }; payloadSha256: string };
  assert(sha(JSON.stringify(frozen.payload)) === LABEL_SHA && frozen.payloadSha256 === LABEL_SHA
    && frozen.payload.caseId === "open-eye-calibration-001"
    && frozen.payload.sourceSha256 === ORIGINAL_SHA && frozen.payload.decodedRgbaSha256 === ORIGINAL_RGBA_SHA
    && frozen.payload.bytes === 3_497_355 && frozen.payload.dimensions.width === 2002
    && frozen.payload.dimensions.height === 3000 && frozen.payload.label.eyeOpenness === "open"
    && frozen.payload.labelFrozenBeforeProvider === true
    && frozen.payload.sourceReview.lateralFaceMargins === "FULL_FACE_MARGIN_OK"
    && frozen.payload.sourceReview.stableAperture === "stable_large"
    && frozen.payload.sourceReview.glasses === "none" && frozen.payload.sourceReview.occlusion === "none",
  "v4_open_frozen_source_label_mismatch");

  const original = readBytes(OPEN_ORIGINAL);
  assert(original.length === 3_497_355 && sha(original) === ORIGINAL_SHA
    && original[0] === 0xff && original[1] === 0xd8 && original[2] === 0xff,
  "v4_open_original_file_mismatch");
  // Canonical original is local provenance only. The production 64 MiB decoder
  // is deliberately not used or modified for this 2002×3000 source.
  const originalDecoded = decodeJpeg(original, { useTArray: true, maxMemoryUsageInMB: 127 });
  assert(originalDecoded.width === 2002 && originalDecoded.height === 3000
    && sha(originalDecoded.data) === ORIGINAL_RGBA_SHA, "v4_open_original_rgba_mismatch");

  const manifest = JSON.parse(readBytes(path.join(OPEN_DERIVATIVE_ROOT, "analysis-derivative.json")).toString("utf8")) as {
    productionInputDerivative: { role: string; sourceSha256: string; width: number; height: number;
      bytes: number; dataUrlChars: number; sha256: string; decodedRgbaSha256: string; mime: string } };
  assert(manifest.productionInputDerivative.role === "analysis"
    && manifest.productionInputDerivative.sourceSha256 === ORIGINAL_SHA
    && manifest.productionInputDerivative.width === 598 && manifest.productionInputDerivative.height === 896
    && manifest.productionInputDerivative.bytes === 96_780
    && manifest.productionInputDerivative.dataUrlChars === 129_063
    && manifest.productionInputDerivative.sha256 === DERIVATIVE_SHA
    && manifest.productionInputDerivative.decodedRgbaSha256 === DERIVATIVE_RGBA_SHA
    && manifest.productionInputDerivative.mime === "image/jpeg", "v4_open_derivative_manifest_mismatch");
  const derivative = readBytes(path.join(OPEN_DERIVATIVE_ROOT, "analysis-derivative.jpg"));
  assert(derivative.length === 96_780 && sha(derivative) === DERIVATIVE_SHA
    && derivative[0] === 0xff && derivative[1] === 0xd8 && derivative[2] === 0xff,
  "v4_open_derivative_file_mismatch");
  // This is the current production image decoder, including its 64 MiB JPEG limit.
  const derivativeDecoded = await decodeImage(derivative);
  assert(derivativeDecoded.width === 598 && derivativeDecoded.height === 896
    && sha(derivativeDecoded.rgba) === DERIVATIVE_RGBA_SHA, "v4_open_derivative_rgba_mismatch");
  return { derivative, sourceSha256: ORIGINAL_SHA, sourceBytes: original.length,
    sourceDecodedRgbaSha256: ORIGINAL_RGBA_SHA, frozenLabelPayloadSha256: LABEL_SHA,
    derivativeSha256: DERIVATIVE_SHA, derivativeBytes: derivative.length,
    derivativeDecodedRgbaSha256: DERIVATIVE_RGBA_SHA,
    derivativeDimensions: { width: 598, height: 896 }, dataUrlChars: 129_063,
    originalDecoder: "audit_only_jpeg_js_127_MiB", derivativeDecoder: "production_decodeImage_64_MiB" };
}

/** The actual remote starter is supplied by the runner and is never invoked on failed input preflight. */
export async function launchAfterV4OpenPreflight<T>(preflight: () => Promise<unknown>, launch: () => T): Promise<T> {
  await preflight();
  return launch();
}

/** No image access; verifies the accepted NORMAL observation and policy identity before remote startup. */
export async function verifyV4NormalReference() {
  const final = await readLatestAuditCheckpoint(path.join(NORMAL_ROOT, "summary.json"));
  if (!final || final.sequence !== 31 || final.event !== "savedV4GeometryDiskRecoveryChecked"
    || final.snapshotSha256 !== sha(JSON.stringify(final.snapshot))) throw new Error("v4_normal_checkpoint_invalid");
  const snapshot = final.snapshot as { classification?: string; savedV4FaceGeometry?: {
    acceptedGeometry?: FaceIdentityGeometryAnalysis; normalOpenness?: number; eyesConfidence?: number;
    cropSha256?: string; cropDimensions?: { width: number; height: number };
    primaryContractVersion?: string; primaryProvider?: string; primaryModel?: string;
    primaryPromptSha256?: string; primarySchemaJsonSha256?: string;
    primaryHashDomains?: { prompt?: string; schema?: string };
    geometryModel?: string; geometryTimeoutMs?: number;
    geometryPromptSha256?: string; geometrySchemaJsonSha256?: string;
    diskRecovery?: boolean; acceptedGeometryRevalidated?: boolean;
  } };
  const saved = snapshot.savedV4FaceGeometry;
  if (snapshot.classification !== "V4_NORMAL_GEOMETRY_OBSERVED_WITH_LIMITATIONS"
    || saved?.diskRecovery !== true || saved.acceptedGeometryRevalidated !== true
    || saved.cropSha256 !== SAVED_V4_CROP_SHA
    || saved.cropDimensions?.width !== 185 || saved.cropDimensions.height !== 192
    || saved.primaryContractVersion !== PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
    || saved.primaryProvider !== "workers_ai" || saved.primaryModel !== "@cf/google/gemma-4-26b-a4b-it"
    || saved.primaryPromptSha256 !== "fbd169cc36a61662cc6a3c3a3300893b32cff44db6f49874c1844824d7b9d99a"
    || saved.primarySchemaJsonSha256 !== "b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3"
    || saved.primaryHashDomains?.prompt !== "final_prompt_utf8_sha256"
    || saved.primaryHashDomains.schema !== "json_stringify_provider_schema_sha256"
    || saved.geometryModel !== FACE_GEOMETRY_MODEL || saved.geometryTimeoutMs !== FACE_GEOMETRY_TIMEOUT_MS
    || saved.geometryPromptSha256 !== sha(FACE_IDENTITY_GEOMETRY_PROMPT)
    || saved.geometrySchemaJsonSha256 !== sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))
    || saved.normalOpenness !== 0.5 || saved.eyesConfidence !== 0.95
    || !saved.acceptedGeometry) throw new Error("v4_normal_contract_or_measurement_drift");
  const restored = acceptedFaceGeometry(saved.acceptedGeometry);
  if (JSON.stringify(restored) !== JSON.stringify(saved.acceptedGeometry)
    || restored.eyes.openness !== saved.normalOpenness
    || restored.confidence.eyes !== saved.eyesConfidence) throw new Error("v4_normal_geometry_invalid");
  const policy = JSON.parse(fs.readFileSync(path.join(NORMAL_CROP_ROOT, "crop-result.json"), "utf8")) as {
    policyIdentity?: { generateSourceSha256?: string; adaptiveHeadCropSourceSha256?: string;
      decoderSourceSha256?: string; lateralGuardHeadHeightRatio?: number } };
  if (policy.policyIdentity?.generateSourceSha256 !== sha(fs.readFileSync("src/generate.ts"))
    || policy.policyIdentity.adaptiveHeadCropSourceSha256 !== sha(fs.readFileSync("src/adaptiveHeadCrop.ts"))
    || policy.policyIdentity.decoderSourceSha256 !== sha(fs.readFileSync("src/png.ts"))
    || policy.policyIdentity.lateralGuardHeadHeightRatio !== 0.65) throw new Error("v4_crop_policy_drift");
  return { sequence: final.sequence, snapshotSha256: final.snapshotSha256,
    normalOpenness: restored.eyes.openness, eyesConfidence: restored.confidence.eyes,
    geometryPromptSha256: saved.geometryPromptSha256,
    geometrySchemaJsonSha256: saved.geometrySchemaJsonSha256,
    primaryContractVersion: saved.primaryContractVersion, policyIdentity: policy.policyIdentity };
}

/** A missing or malformed same-run context blocks crop construction; no defaults are substituted. */
export function validatedSameRunCropContext(input: unknown): AdaptiveHeadCropContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "hairTexture,hairVolume,headCovering,overallHairLength,sideHairAsymmetry"
    || !["straight", "wavy", "curly", "coily"].includes(String(value.hairTexture))
    || !["flat", "normal", "full"].includes(String(value.hairVolume))
    || !["cropped", "ear", "jaw", "shoulder", "chest", "waist", "hip"].includes(String(value.overallHairLength))
    || !["none", "left", "right"].includes(String(value.sideHairAsymmetry))
    || typeof value.headCovering !== "boolean") return null;
  return { hairTexture: value.hairTexture as AdaptiveHeadCropContext["hairTexture"],
    hairVolume: value.hairVolume as AdaptiveHeadCropContext["hairVolume"],
    overallHairLength: value.overallHairLength as AdaptiveHeadCropContext["overallHairLength"],
    sideHairAsymmetry: value.sideHairAsymmetry as AdaptiveHeadCropContext["sideHairAsymmetry"],
    headCovering: value.headCovering };
}

export type CropVisualReview = { runId: string; cropSha256: string; vocabulary: "FULL_FACE_MARGIN_OK";
  bothEyesVisible: true; upperAndLowerEyelidsVisible: true; bothBrowsVisible: true;
  outerEyeCornersAndFacialMarginsVisible: true; foreheadNoseMouthChinVisible: true;
  frozenOpenCueReadable: true; glasses: false; eyeOcclusion: false; criticalFaceClipping: false };

export function validatedCropVisualReview(input: unknown, runId: string, cropSha256: string): CropVisualReview | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== ["runId", "cropSha256", "vocabulary", "bothEyesVisible",
    "upperAndLowerEyelidsVisible", "bothBrowsVisible", "outerEyeCornersAndFacialMarginsVisible",
    "foreheadNoseMouthChinVisible", "frozenOpenCueReadable", "glasses", "eyeOcclusion", "criticalFaceClipping"].sort().join()
    || value.runId !== runId || value.cropSha256 !== cropSha256 || value.vocabulary !== "FULL_FACE_MARGIN_OK"
    || value.bothEyesVisible !== true || value.upperAndLowerEyelidsVisible !== true
    || value.bothBrowsVisible !== true || value.outerEyeCornersAndFacialMarginsVisible !== true
    || value.foreheadNoseMouthChinVisible !== true || value.frozenOpenCueReadable !== true
    || value.glasses !== false || value.eyeOcclusion !== false || value.criticalFaceClipping !== false) return null;
  return value as CropVisualReview;
}

/** Local human review is bounded; absence or rejection never silently passes the geometry gate. */
export async function awaitCropVisualReview(directory: string, runId: string, cropSha256: string, timeoutMs = 120_000) {
  const reviewPath = path.join(directory, "crop-visual-review.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const review = validatedCropVisualReview(JSON.parse(fs.readFileSync(reviewPath, "utf8")), runId, cropSha256);
      if (review) return review;
      return null;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return null;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}
