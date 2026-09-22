import { expect, it } from "vitest";
import type { PortraitRegion } from "../src/analysis";
import { createIdentityCrops } from "../src/generate";
import { bytesToBase64, encodePng } from "../src/png";

async function solidSource(width = 640, height = 480) {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([174, 126, 99, 255], offset);
  const encoded = await encodePng({ width, height, rgba });
  return `data:image/png;base64,${bytesToBase64(encoded)}`;
}

const normalRegion: PortraitRegion = {
  subjectBox: { left: 0.2, top: 0.05, right: 0.8, bottom: 0.95 },
  headBox: { left: 0.36, top: 0.1, right: 0.64, bottom: 0.52 },
  faceBox: { left: 0.4, top: 0.19, right: 0.6, bottom: 0.46 },
  confidence: 0.95,
};

it("widens only a pathologically narrow localized face in source-pixel space", async () => {
  const source = await solidSource(900, 1349);
  const warm = await createIdentityCrops(source, {
    subjectBox: { left: 0.38, top: 0.06, right: 0.68, bottom: 0.31 },
    headBox: { left: 0.42, top: 0.06, right: 0.58, bottom: 0.31 },
    faceBox: { left: 0.43, top: 0.15, right: 0.55, bottom: 0.25 },
    confidence: 1,
  });
  const striped = await createIdentityCrops(source, {
    subjectBox: { left: 0.48, top: 0.25, right: 0.65, bottom: 0.85 },
    headBox: { left: 0.52, top: 0.28, right: 0.62, bottom: 0.45 },
    faceBox: { left: 0.52, top: 0.3, right: 0.6, bottom: 0.45 },
    confidence: 0.95,
  });
  expect(warm?.diagnostics.faceCropLateralGuard).toMatchObject({
    applied: true,
    reason: "expanded_face_below_head_height_floor",
  });
  expect(striped?.diagnostics.faceCropLateralGuard).toMatchObject({
    applied: true,
    reason: "expanded_face_below_head_height_floor",
  });
  expect(warm!.diagnostics.faceCropLateralGuard.originalExpandedWidthRatio).toBeLessThan(0.65);
  expect(warm!.diagnostics.faceCropLateralGuard.guardedWidthRatio).toBeCloseTo(0.65, 12);
  expect(striped!.diagnostics.faceCropLateralGuard.originalExpandedWidthRatio).toBeLessThan(0.65);
  expect(striped!.diagnostics.faceCropLateralGuard.guardedWidthRatio).toBeCloseTo(0.65, 12);
  expect(warm!.diagnostics.faceCropDimensions.height).toBe(193);
  expect(striped!.diagnostics.faceCropDimensions.height).toBe(288);
});

it.each([
  ["normal", {}, normalRegion],
  ["glasses contract", {}, { ...normalRegion, faceBox: { left: 0.39, top: 0.19, right: 0.61, bottom: 0.46 } }],
  ["headscarf contract", { headCovering: true }, { ...normalRegion, headBox: { left: 0.3, top: 0.06, right: 0.7, bottom: 0.54 } }],
  ["short hair contract", { hairVolume: "flat", overallHairLength: "cropped" }, normalRegion],
  ["long hair contract", { hairVolume: "full", overallHairLength: "chest" }, { ...normalRegion, headBox: { left: 0.3, top: 0.06, right: 0.7, bottom: 0.58 } }],
] as const)("leaves %s localization unchanged", async (_name, context, region) => {
  const result = await createIdentityCrops(await solidSource(), region, context);
  expect(result?.diagnostics.faceCropLateralGuard).toMatchObject({
    applied: false,
    reason: "expanded_face_meets_head_height_floor",
  });
});

it("clamps the lateral safety span to an edge-of-image adaptive head crop", async () => {
  const result = await createIdentityCrops(await solidSource(), {
    subjectBox: { left: 0, top: 0.02, right: 0.42, bottom: 0.96 },
    headBox: { left: 0.01, top: 0.08, right: 0.2, bottom: 0.5 },
    faceBox: { left: 0.02, top: 0.18, right: 0.11, bottom: 0.43 },
    confidence: 0.94,
  });
  expect(result?.diagnostics.faceCropLateralGuard.applied).toBe(true);
  expect(result!.diagnostics.finalFaceBox!.left).toBeGreaterThanOrEqual(0);
  expect(result!.diagnostics.finalFaceBox!.right).toBeLessThanOrEqual(result!.diagnostics.finalHeadBox!.right);
  expect(result!.diagnostics.finalFaceBox!.top).toBeGreaterThanOrEqual(result!.diagnostics.finalHeadBox!.top);
  expect(result!.diagnostics.finalFaceBox!.bottom).toBeLessThanOrEqual(result!.diagnostics.finalHeadBox!.bottom);
});

it("preserves existing fallback behavior when localization is malformed or absent", async () => {
  const source = await solidSource(640, 900);
  const malformed = await createIdentityCrops(source, {
    subjectBox: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.95 },
    headBox: { left: 0.2, top: 0.1, right: 0.7, bottom: 0.6 },
    faceBox: { left: 0.94, top: 0.2, right: 0.99, bottom: 0.5 },
    confidence: 0.9,
  });
  const absent = await createIdentityCrops(source, null);
  expect(malformed?.diagnostics.cropMode).toBe("center_fallback");
  expect(absent?.diagnostics.cropMode).toBe("center_fallback");
  expect(malformed?.diagnostics.faceCropLateralGuard).toEqual({
    applied: false,
    reason: "localized_head_unavailable",
    originalExpandedWidthRatio: null,
    guardedWidthRatio: null,
  });
  expect(absent?.diagnostics.faceCropLateralGuard).toEqual(malformed?.diagnostics.faceCropLateralGuard);
});
