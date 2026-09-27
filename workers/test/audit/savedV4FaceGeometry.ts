import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { validatePortraitRegion } from "../../src/analysis";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../../src/compactPhotoAnalysisV4";
import { parseFaceIdentityGeometry, type FaceIdentityGeometryAnalysis } from "../../src/faceIdentityGeometry";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA,
  FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS } from "../../src/faceIdentityGeometry";
import { decodeImage } from "../../src/png";
import { readLatestAuditCheckpoint, type CheckpointRecord } from "../primaryAuditRunnerSupport";
import type { ValidatedLocalizationEvidence } from "./validatedLocalizationEvidence";

export const SAVED_V4_LIVE = path.resolve("evaluation-artifacts/v4-validated-localization-persistence-live-20260925-001");
export const SAVED_V4_CROP = path.resolve("evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001");
export const SAVED_V4_CROP_SHA = "26be2fb184d5497fa19ec5be826df248c53807db399408f5fa559f836adffab1";
export const SAVED_V4_CROP_RGBA_SHA = "da4991b97e39074dabf8b923c9ea6f3cf5e7984f35cba663b9d463e2b48fa0d0";
const DERIVATIVE_SHA = "39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(SAVED_V4_CROP, name), "utf8")) as Record<string, unknown>;
const assert = (ok: unknown, reason: string): asserts ok => { if (!ok) throw new Error(reason); };

/** Metadata-only preflight: never reads an image before protected health. */
export async function verifySavedV4FaceCropMetadata() {
  const geometryContract = JSON.parse(fs.readFileSync(path.resolve(
    "evaluation-artifacts/face-geometry-open-anchor-direct-input-eligibility-20260922-001/geometry-input-contract.json"),
  "utf8")) as { promptSha256?: string; schemaSha256?: string; imageCount?: number;
    requiresPhotoAnalysis?: boolean; requiresPortraitRegion?: boolean };
  assert(geometryContract.promptSha256 === sha(FACE_IDENTITY_GEOMETRY_PROMPT)
    && geometryContract.schemaSha256 === sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))
    && geometryContract.imageCount === 1 && geometryContract.requiresPhotoAnalysis === false
    && geometryContract.requiresPortraitRegion === false && FACE_GEOMETRY_MODEL === "@cf/google/gemma-4-26b-a4b-it"
    && FACE_GEOMETRY_TIMEOUT_MS === 25_000, "geometry_contract_drift");
  const final = await readLatestAuditCheckpoint(path.join(SAVED_V4_LIVE, "summary.json"));
  assert(final?.sequence === 33 && final.event === "finalCheckpoint", "saved_v4_final_checkpoint_invalid");
  const finalSnapshot = final.snapshot as { primary?: { ok?: boolean }; validatedLocalizationEvidence?: ValidatedLocalizationEvidence };
  const evidence = finalSnapshot.validatedLocalizationEvidence;
  assert(finalSnapshot.primary?.ok === true && evidence?.provenanceComplete === true, "saved_v4_evidence_unaccepted");
  const names = fs.readdirSync(SAVED_V4_LIVE).filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name));
  const first = names.map(name => JSON.parse(fs.readFileSync(path.join(SAVED_V4_LIVE, name), "utf8")) as CheckpointRecord)
    .find(record => record.sequence === 21 && record.event === "validatedLocalizationObserved:wavy-open-blazer");
  assert(first?.snapshotSha256 === sha(JSON.stringify(first.snapshot)), "saved_v4_first_checkpoint_invalid");
  assert(JSON.stringify((first.snapshot as { validatedLocalizationEvidence?: unknown }).validatedLocalizationEvidence)
    === JSON.stringify(evidence), "saved_v4_evidence_changed");
  assert(evidence.caseId === "wavy-open-blazer" && evidence.derivativeSha256 === DERIVATIVE_SHA
    && evidence.portraitImageIndex === 0 && evidence.inputDimensions?.width === 597
    && evidence.inputDimensions.height === 896
    && evidence.expectedContractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
    && evidence.provider === "workers_ai" && evidence.model === "@cf/google/gemma-4-26b-a4b-it"
    && evidence.contractValidation.providerWireSchemaValid === true
    && evidence.contractValidation.primaryCoreValid === true
    && evidence.contractValidation.localizationValid === true
    && evidence.localizationTrace?.status === "VALID"
    && evidence.hashDomains.prompt === "final_prompt_utf8_sha256"
    && evidence.hashDomains.schema === "json_stringify_provider_schema_sha256"
    && validatePortraitRegion(evidence.region).ok, "saved_v4_localization_invalid");
  const saved = readJson("saved-evidence-verification.json");
  const crop = readJson("crop-result.json");
  const input = readJson("input-completeness.json");
  const review = readJson("crop-visual-review.json");
  assert(saved.evidenceSequence === 21 && saved.evidenceSnapshotSha256 === first.snapshotSha256
    && saved.finalSequence === 33 && saved.finalSnapshotSha256 === final.snapshotSha256
    && saved.evidenceEqual === true && JSON.stringify(saved.region) === JSON.stringify(evidence.region)
    && saved.runId === evidence.runId, "saved_v4_crop_lineage_invalid");
  assert(crop.encodedSha256 === SAVED_V4_CROP_SHA && crop.decodedRgbaSha256 === SAVED_V4_CROP_RGBA_SHA
    && crop.encodedBytes === 92_486 && crop.mime === "image/png"
    && (crop.outputDimensions as { width?: number; height?: number })?.width === 185
    && (crop.outputDimensions as { width?: number; height?: number })?.height === 192
    && crop.newlyGeneratedOffline === true && crop.cropMode === "subject_aware"
    && crop.fallbackReason === null && crop.resized === false
    && (crop.faceCropLateralGuard as { applied?: boolean })?.applied === false
    && crop.deterministicReplaySameEncodedBytes === true
    && crop.extremeContextSameFaceBytes === true, "saved_v4_crop_metadata_invalid");
  assert(input.derivativeSha256 === DERIVATIVE_SHA && input.derivativeBytes === 45_769
    && input.derivativeDecodedRgbaSha256 === "5cf244ae8b25648cc1c1be49a0a5f183ff3d8c950d1b74003a7d1b81619c6bab"
    && input.contextCombinationsChecked === 504 && input.expandedFaceInsideEveryAdaptiveHeadCrop === true
    && input.lateralGuardAlwaysNoOp === true && review.vocabulary === "FULL_FACE_MARGIN_OK"
    && review.bothEyesVisible === true && review.upperAndLowerEyelidBoundariesVisible === true
    && review.bothBrowsVisible === true && review.outerEyeCornersAndFacialMarginsVisible === true
    && review.glasses === false && review.eyeOcclusion === false && review.criticalFaceClipping === false,
  "saved_v4_crop_eligibility_invalid");
  return { evidence, first: { sequence: first.sequence, snapshotSha256: first.snapshotSha256 },
    final: { sequence: final.sequence, snapshotSha256: final.snapshotSha256 }, crop };
}

/** Health-gated image read; no transformation, recrop or re-encoding. */
export async function verifySavedV4FaceCropBytes() {
  const bytes = fs.readFileSync(path.join(SAVED_V4_CROP, "face-crop.png"));
  assert(bytes.byteLength === 92_486 && sha(bytes) === SAVED_V4_CROP_SHA
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "saved_v4_crop_bytes_invalid");
  const decoded = await decodeImage(bytes);
  assert(decoded.width === 185 && decoded.height === 192 && sha(decoded.rgba) === SAVED_V4_CROP_RGBA_SHA,
    "saved_v4_crop_pixels_invalid");
  return bytes;
}

/** Copy only approved numeric/canonical-enum fields, then revalidate on disk. */
export function acceptedFaceGeometry(value: FaceIdentityGeometryAnalysis): FaceIdentityGeometryAnalysis {
  const contour = (name: "cheek" | "jaw" | "chin") => ({
    left: value.directLowerFaceContour[name].left, right: value.directLowerFaceContour[name].right,
    y: value.directLowerFaceContour[name].y, evidence: value.directLowerFaceContour[name].evidence,
    confidence: value.directLowerFaceContour[name].confidence,
  });
  const wire = {
    face: { envelopeLeft: value.face.envelopeLeft, envelopeRight: value.face.envelopeRight,
      foreheadY: value.face.foreheadY, chinY: value.face.chinY },
    eyes: { leftCenterX: value.eyes.leftCenterX, leftCenterY: value.eyes.leftCenterY,
      rightCenterX: value.eyes.rightCenterX, rightCenterY: value.eyes.rightCenterY,
      leftWidth: value.eyes.leftWidth, rightWidth: value.eyes.rightWidth, openness: value.eyes.openness },
    brows: { leftY: value.brows.leftY, rightY: value.brows.rightY,
      thickness: value.brows.thickness, tilt: value.brows.tilt },
    nose: { centerX: value.nose.centerX, contrastY: value.nose.contrastY,
      visibleStrength: value.nose.visibleStrength },
    mouth: { centerX: value.mouth.centerX, centerY: value.mouth.centerY, width: value.mouth.width,
      leftCornerY: value.mouth.leftCornerY, rightCornerY: value.mouth.rightCornerY,
      opening: value.mouth.opening },
    confidence: { faceBounds: value.confidence.faceBounds, eyes: value.confidence.eyes,
      brows: value.confidence.brows, nose: value.confidence.nose, mouth: value.confidence.mouth },
    directLowerFaceContour: { cheek: contour("cheek"), jaw: contour("jaw"), chin: contour("chin") },
  };
  const errors: string[] = [];
  const restored = parseFaceIdentityGeometry(wire, errors);
  assert(restored && errors.length === 0, "accepted_face_geometry_revalidation_failed");
  return restored;
}
