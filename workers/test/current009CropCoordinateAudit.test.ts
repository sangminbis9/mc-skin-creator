import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import type { FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";

type Box = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");

// Offline coordinate change only. This never creates or alters a measurement.
function sourceFrame(g: FaceIdentityGeometryAnalysis, box: Box, image: Size, crop: Size) {
  const x = (v: number) => (box.left + v * (box.right - box.left)) * image.width;
  const y = (v: number) => (box.top + v * (box.bottom - box.top)) * image.height;
  const width = (v: number) => v * (box.right - box.left) * image.width;
  const eyeAngle = Math.atan2((g.eyes.rightCenterY - g.eyes.leftCenterY) * crop.height,
    (g.eyes.rightCenterX - g.eyes.leftCenterX) * crop.width) * 180 / Math.PI;
  return { leftEye: { x: x(g.eyes.leftCenterX), y: y(g.eyes.leftCenterY), width: width(g.eyes.leftWidth) },
    rightEye: { x: x(g.eyes.rightCenterX), y: y(g.eyes.rightCenterY), width: width(g.eyes.rightWidth) },
    face: { left: x(g.face.envelopeLeft), right: x(g.face.envelopeRight), top: y(g.face.foreheadY), bottom: y(g.face.chinY) },
    nose: { x: x(g.nose.centerX), y: y(g.nose.contrastY) },
    mouth: { x: x(g.mouth.centerX), y: y(g.mouth.centerY), width: width(g.mouth.width) },
    imageSpaceEyeLineAngleDegrees: eyeAngle };
}

it("compares accepted observations in their common source frame without assuming a missing localization", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const currentPath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009/summary.json";
    const localizedPath = "evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-002/summary.json";
    const currentBytes = readFileSync(currentPath), localizedBytes = readFileSync(localizedPath);
    const current = JSON.parse(currentBytes.toString()).currentDefaultE2E;
    const localized = JSON.parse(localizedBytes.toString()).currentSourceV4;
    const image: Size = current.result.inputs.analysis;
    expect(image).toMatchObject({ width: 597, height: 896 });
    expect(localized.crop.sourceDerivativeSha256).toBe(current.result.inputs.analysis.sha256);
    expect(localized.localization.evidence.derivativeSha256).toBe(current.result.inputs.analysis.sha256);
    expect(current.cropReplay.matchesActualWire).toBe(true);
    expect(current.cropReplay.replaySha256).toBe(current.cropReplay.actualWireCropSha256);
    const currentCrop = current.cropReplay.diagnostics;
    expect(currentCrop.cropMode).toBe("center_fallback");
    expect(currentCrop.quality.sourceClippingKnown).toBe(false);
    expect(currentCrop.quality.usableForFaceGeometry).toBe(true);
    expect(localized.geometry).toMatchObject({ providerShapeValid: true, semanticValid: true });
    const a = acceptedFaceGeometry(current.result.diagnostics.geometry.acceptedGeometry);
    const b = acceptedFaceGeometry(localized.acceptedGeometry);
    const currentBox: Box = currentCrop.finalFaceBox, localizedBox: Box = localized.crop.diagnostics.finalFaceBox;
    const currentMapped = sourceFrame(a, currentBox, image, currentCrop.faceCropDimensions);
    const localizedMapped = sourceFrame(b, localizedBox, image, localized.crop);
    const cropRight = currentBox.right * image.width;
    // These are cross-observation facts, not a manually annotated true eye box.
    expect(localizedMapped.leftEye.x).toBeLessThan(cropRight);
    expect(localizedMapped.rightEye.x).toBeGreaterThan(cropRight);
    expect(localizedMapped.face.right).toBeGreaterThan(cropRight);
    expect(currentMapped.face.right).toBeCloseTo(cropRight, 10);
    expect(currentMapped.rightEye.width).toBeLessThan(localizedMapped.rightEye.width);
    const root = mkdtempSync("evaluation-artifacts/current-009-common-source-crop-audit-20260927-");
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, sourceImageReads: 0, productionChange: false,
      currentSummaryHash: sha(currentBytes), localizedSummaryHash: sha(localizedBytes),
      sourceDerivativeSha256: current.result.inputs.analysis.sha256, image,
      currentCrop: { box: currentBox, dimensions: currentCrop.faceCropDimensions,
        hash: current.cropReplay.actualWireCropSha256, clippingKnown: false, usableForFaceGeometry: true },
      localizedCrop: { box: localizedBox, dimensions: { width: localized.crop.width, height: localized.crop.height }, hash: localized.crop.sha256 },
      currentMapped, localizedMapped, currentCropRightInSourcePixels: cropRight,
      localizedRightCenterBeyondCurrentCropPixels: localizedMapped.rightEye.x - cropRight,
      localizedFaceEdgeBeyondCurrentCropPixels: localizedMapped.face.right - cropRight,
      leftEyeCenterDisagreementPixels: Math.hypot(currentMapped.leftEye.x - localizedMapped.leftEye.x, currentMapped.leftEye.y - localizedMapped.leftEye.y),
      rightEyeCenterDisagreementPixels: Math.hypot(currentMapped.rightEye.x - localizedMapped.rightEye.x, currentMapped.rightEye.y - localizedMapped.rightEye.y),
      rightEyeWidthRatioCurrentToLocalized: currentMapped.rightEye.width / localizedMapped.rightEye.width,
      conclusion: "Source-linked accepted localization evidence is inconsistent with complete right-eye/face coverage by the center fallback crop. Shape/semantic acceptance did not resolve coverage uncertainty.",
      limits: ["Accepted historical coordinates are not ground truth", "Subpixel center crossing alone is not proof of clipping", "No actual frontal identity or head pose angle inferred from eye-line angle", "No accepted/rejected geometry replaced or relabeled", "No runtime gate or confidence changed"] }, null, 2), { flag: "wx" });
    expect(readFileSync(currentPath)).toEqual(currentBytes); expect(readFileSync(localizedPath)).toEqual(localizedBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`COMMON_SOURCE_CROP_AUDIT ${root}`);
  } finally { network.mockRestore(); }
});
