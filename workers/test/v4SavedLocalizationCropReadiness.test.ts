import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { validatePortraitRegion, type PortraitRegion } from "../src/analysis";
import { planAdaptiveHeadCrop, type AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { createIdentityCrops } from "../src/generate";
import { decodeImage } from "../src/png";
import { captureValidatedLocalizationEvidence, type ValidatedLocalizationEvidence } from "./audit/validatedLocalizationEvidence";
import { readLatestAuditCheckpoint, type CheckpointRecord } from "./primaryAuditRunnerSupport";

const LIVE = path.resolve("evaluation-artifacts/v4-validated-localization-persistence-live-20260925-001");
const OUTPUT = path.resolve("evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001");
const DERIVATIVE = path.resolve("evaluation-artifacts/face-geometry-openness-anchor-input-parity-audit-20260925-001/wavy/analysis-derivative.jpg");
const ORIGINAL = path.resolve("evaluation-artifacts/generalization-20260905/sources/19908659.jpg");
const DERIVATIVE_SHA = "39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d";
const ORIGINAL_SHA = "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702";
const RUN_OFFLINE_AUDIT = process.env.RUN_V4_SAVED_LOCALIZATION_CROP_READINESS
  === "approved-offline-crop-readiness-20260925-001";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const writeJson = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(OUTPUT, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const contains = (outer: PortraitRegion["headBox"], inner: PortraitRegion["faceBox"]) =>
  outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;

it.skipIf(!RUN_OFFLINE_AUDIT)("checks saved V4 crop inputs and creates only a context-invariant face crop offline", async () => {
  expect(fs.existsSync(OUTPUT)).toBe(false);
  const latest = await readLatestAuditCheckpoint(path.join(LIVE, "summary.json"));
  expect(latest).toMatchObject({ sequence: 33, event: "finalCheckpoint" });
  const final = latest!.snapshot as { primary: { ok: boolean }; validatedLocalizationEvidence: ValidatedLocalizationEvidence };
  const evidence = final.validatedLocalizationEvidence;
  const records = fs.readdirSync(LIVE).filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(LIVE, name), "utf8")) as CheckpointRecord);
  const observed = records.find(record => record.event === "validatedLocalizationObserved:wavy-open-blazer");
  expect(observed?.sequence).toBe(21);
  expect(observed?.snapshotSha256).toBe(sha(JSON.stringify(observed?.snapshot)));
  expect((observed?.snapshot as { validatedLocalizationEvidence: unknown }).validatedLocalizationEvidence).toEqual(evidence);
  expect(evidence.caseId).toBe("wavy-open-blazer");
  expect(evidence.runId).toMatch(/^[0-9a-f]{32}$/);
  expect(evidence.sourceSha256).toBe(ORIGINAL_SHA);
  expect(evidence.derivativeSha256).toBe(DERIVATIVE_SHA);
  expect(evidence.inputDimensions).toEqual({ width: 597, height: 896 });
  expect(evidence.portraitImageIndex).toBe(0);
  expect(evidence.expectedContractVersion).toBe(PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION);
  expect(evidence.provider).toBe("workers_ai");
  expect(evidence.model).toBe("@cf/google/gemma-4-26b-a4b-it");
  expect(evidence.promptSha256).toBe("fbd169cc36a61662cc6a3c3a3300893b32cff44db6f49874c1844824d7b9d99a");
  expect(evidence.schemaJsonSha256).toBe("b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3");
  expect(evidence.hashDomains).toEqual({ prompt: "final_prompt_utf8_sha256", schema: "json_stringify_provider_schema_sha256" });
  expect(evidence.contractValidation).toEqual({ providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true });
  expect(evidence.localizationTrace).toMatchObject({ traceVersion: 2, carrier: "structured_region", status: "VALID" });
  expect(evidence.provenanceComplete).toBe(true);
  const validated = validatePortraitRegion(evidence.region);
  expect(validated.ok).toBe(true);
  if (!validated.ok) return;
  const recaptured = captureValidatedLocalizationEvidence({ primaryOk: final.primary.ok,
    expectedContractVersion: evidence.expectedContractVersion, contractValidation: evidence.contractValidation,
    protectedLocalization: { portraitImageIndex: evidence.portraitImageIndex, region: evidence.region },
    localizationTrace: evidence.localizationTrace, imageCount: 1,
    runId: evidence.runId, caseId: evidence.caseId, sourceSha256: evidence.sourceSha256,
    derivativeSha256: evidence.derivativeSha256, inputDimensions: evidence.inputDimensions,
    provider: evidence.provider, model: evidence.model, promptSha256: evidence.promptSha256,
    schemaJsonSha256: evidence.schemaJsonSha256 });
  expect(recaptured).toEqual({ status: "captured", evidence });

  const original = fs.readFileSync(ORIGINAL);
  expect(original.byteLength).toBe(70_987);
  expect(sha(original)).toBe(ORIGINAL_SHA);
  const derivative = fs.readFileSync(DERIVATIVE);
  expect(derivative.byteLength).toBe(45_769);
  expect(sha(derivative)).toBe(DERIVATIVE_SHA);
  const decoded = await decodeImage(derivative);
  expect({ width: decoded.width, height: decoded.height, rgbaSha256: sha(decoded.rgba) })
    .toEqual({ width: 597, height: 896,
      rgbaSha256: "5cf244ae8b25648cc1c1be49a0a5f183ff3d8c950d1b74003a7d1b81619c6bab" });
  const imageDataUrl = "data:image/jpeg;base64," + derivative.toString("base64");
  expect(imageDataUrl.length).toBe(61_051);
  expect(JSON.stringify(latest!.snapshot)).not.toContain('"identityCropContext"');
  expect(JSON.stringify(latest!.snapshot)).not.toContain('"relevantRenderHints"');

  // Exhaust every current enum value for each production crop-context field.
  // This is a dependency proof, not a fabricated provider observation.
  const volumes = ["flat", "normal", "full"] as const;
  const textures = ["straight", "wavy", "curly", "coily"] as const;
  const lengths = ["cropped", "ear", "jaw", "shoulder", "chest", "waist", "hip"] as const;
  const asymmetries = ["none", "left", "right"] as const;
  const coverings = [false, true] as const;
  const face = evidence.region.faceBox;
  const w = face.right - face.left;
  const h = face.bottom - face.top;
  const expandedFace = { left: face.left - w * 0.2, top: face.top - h * 0.22,
    right: face.right + w * 0.2, bottom: face.bottom + h * 0.2 };
  const expandedWidthPixels = (expandedFace.right - expandedFace.left) * decoded.width;
  const minimumLateralWidthPixels = (evidence.region.headBox.bottom - evidence.region.headBox.top) * decoded.height * 0.65;
  let contextsChecked = 0;
  let faceInsideEveryHeadCrop = true;
  for (const hairVolume of volumes) for (const hairTexture of textures) for (const overallHairLength of lengths) {
    for (const sideHairAsymmetry of asymmetries) for (const headCovering of coverings) {
      const context: AdaptiveHeadCropContext = { hairVolume, hairTexture, overallHairLength, sideHairAsymmetry, headCovering };
      const plan = planAdaptiveHeadCrop({ width: decoded.width, height: decoded.height }, validated.region, context);
      contextsChecked++;
      faceInsideEveryHeadCrop &&= contains(plan.cropBox, expandedFace);
    }
  }
  expect(contextsChecked).toBe(504);
  expect(faceInsideEveryHeadCrop).toBe(true);
  expect(expandedWidthPixels).toBeGreaterThanOrEqual(minimumLateralWidthPixels);

  // Context is absent from the same-run checkpoint. Its full vocabulary is
  // proven not to affect this face crop, while the head crop can differ.
  const crops = await createIdentityCrops(imageDataUrl, validated.region, {});
  expect(crops?.diagnostics.cropMode).toBe("subject_aware");
  expect(crops?.diagnostics.faceCropLateralGuard.applied).toBe(false);
  expect(crops?.diagnostics.fallbackReason).toBeNull();
  const repeated = await createIdentityCrops(imageDataUrl, validated.region, {});
  expect(repeated?.faceDataUrl).toBe(crops?.faceDataUrl);
  const extreme = await createIdentityCrops(imageDataUrl, validated.region, {
    hairVolume: "full", hairTexture: "coily", overallHairLength: "hip", sideHairAsymmetry: "left", headCovering: true,
  });
  expect(extreme?.faceDataUrl).toBe(crops?.faceDataUrl);
  if (!crops) return;
  const encoded = Buffer.from(crops.faceDataUrl.slice(crops.faceDataUrl.indexOf(",") + 1), "base64");
  const faceDecoded = await decodeImage(encoded);
  const finalBox = crops.diagnostics.finalFaceBox!;
  const rawPixelBounds = { x: Math.round(finalBox.left * decoded.width), y: Math.round(finalBox.top * decoded.height),
    width: Math.round((finalBox.right - finalBox.left) * decoded.width),
    height: Math.round((finalBox.bottom - finalBox.top) * decoded.height) };
  fs.mkdirSync(OUTPUT, { recursive: false });
  writeJson("saved-evidence-verification.json", { evidenceSequence: observed!.sequence,
    evidenceSnapshotSha256: observed!.snapshotSha256, finalSequence: latest!.sequence,
    finalSnapshotSha256: latest!.snapshotSha256, evidenceEqual: true,
    region: evidence.region, portraitImageIndex: evidence.portraitImageIndex,
    runId: evidence.runId, caseId: evidence.caseId, derivativeSha256: evidence.derivativeSha256,
    expectedContractVersion: evidence.expectedContractVersion, provider: evidence.provider, model: evidence.model,
    promptSha256: evidence.promptSha256, schemaJsonSha256: evidence.schemaJsonSha256,
    hashDomains: evidence.hashDomains, contractValidation: evidence.contractValidation,
    localizationTrace: evidence.localizationTrace, provenanceComplete: evidence.provenanceComplete,
    validatePortraitRegion: true });
  writeJson("input-completeness.json", { sourceBytes: original.byteLength, sourceSha256: sha(original),
    derivativeBytes: derivative.byteLength, derivativeSha256: sha(derivative),
    derivativeDecodedRgbaSha256: sha(decoded.rgba), derivativeDimensions: { width: decoded.width, height: decoded.height },
    dataUrlChars: imageDataUrl.length, sameInputAsEvidence: true,
    contextStored: false, contextValuesFabricated: false, contextCombinationsChecked: contextsChecked,
    expandedFaceInsideEveryAdaptiveHeadCrop: faceInsideEveryHeadCrop, expandedWidthPixels, minimumLateralWidthPixels,
    lateralGuardAlwaysNoOp: true, cropInputComplete: true, exactFullHeadCropContextComplete: false });
  writeJson("crop-result.json", { newlyGeneratedOffline: true, cropMode: crops.diagnostics.cropMode,
    fallbackReason: crops.diagnostics.fallbackReason, sourceSha256: DERIVATIVE_SHA,
    sourceDimensions: crops.diagnostics.sourceDimensions,
    evidenceCheckpoint: { sequence: observed!.sequence, snapshotSha256: observed!.snapshotSha256 },
    contractVersion: evidence.expectedContractVersion, faceCropLateralGuard: crops.diagnostics.faceCropLateralGuard,
    finalFaceBox: finalBox, rawPixelBounds, outputDimensions: { width: faceDecoded.width, height: faceDecoded.height },
    mime: crops.faceDataUrl.slice(5, crops.faceDataUrl.indexOf(";")), encodedBytes: encoded.byteLength,
    encodedSha256: sha(encoded), decodedRgbaSha256: sha(faceDecoded.rgba),
    resized: rawPixelBounds.width !== faceDecoded.width || rawPixelBounds.height !== faceDecoded.height,
    deterministicReplaySameEncodedBytes: repeated?.faceDataUrl === crops.faceDataUrl,
    extremeContextSameFaceBytes: extreme?.faceDataUrl === crops.faceDataUrl,
    headCropNotClaimedEquivalent: true,
    policyIdentity: { generateSourceSha256: sha(fs.readFileSync("src/generate.ts")),
      adaptiveHeadCropSourceSha256: sha(fs.readFileSync("src/adaptiveHeadCrop.ts")),
      decoderSourceSha256: sha(fs.readFileSync("src/png.ts")),
      maximumEdge: 512, lateralGuardHeadHeightRatio: 0.65, encoding: "PNG",
      resizeSampling: "existing nearest-source-pixel selection" } });
  fs.writeFileSync(path.join(OUTPUT, "face-crop.png"), encoded, { flag: "wx" });
});
