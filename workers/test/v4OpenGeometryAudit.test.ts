import fs from "node:fs";
import { createHash } from "node:crypto";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it, vi } from "vitest";
import { decodeImage } from "../src/png";
import { launchAfterV4OpenPreflight, validatedCropVisualReview, validatedSameRunCropContext,
  verifyFrozenV4OpenInputs, verifyV4NormalReference } from "./audit/v4OpenGeometryAudit";

it("pins the accepted V4 NORMAL comparator without opening an image", async () => {
  const normal = await verifyV4NormalReference();
  expect(normal.normalOpenness).toBe(0.5);
  expect(normal.eyesConfidence).toBe(0.95);
  expect(normal.policyIdentity.lateralGuardHeadHeightRatio).toBe(0.65);
});

it("verifies the frozen OPEN original and the only allowed 598×896 derivative offline", async () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const source = fs.readFileSync("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
  expect([source.length, sha(source)]).toEqual([3_497_355,
    "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac"]);
  await expect(decodeImage(source)).rejects.toThrow();
  const original = decodeJpeg(source, { useTArray: true, maxMemoryUsageInMB: 127 });
  expect([original.width, original.height, sha(original.data)]).toEqual([2002, 3000,
    "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89"]);
  const derivative = fs.readFileSync("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001/analysis-derivative.jpg");
  expect([derivative.length, sha(derivative)]).toEqual([96_780,
    "9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b"]);
  const decoded = await decodeImage(derivative);
  expect([decoded.width, decoded.height, sha(decoded.rgba)]).toEqual([598, 896,
    "7f97174def06d69b590bd5d8466f398e0ef6a26fa54b7ffba3af969520605a68"]);
});

it("pins the actual OPEN selector input: audit-only original decode, production derivative decode, no original payload", async () => {
  const verified = await verifyFrozenV4OpenInputs();
  expect(verified).toMatchObject({ sourceBytes: 3_497_355, derivativeBytes: 96_780,
    derivativeSha256: "9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b",
    originalDecoder: "audit_only_jpeg_js_127_MiB", derivativeDecoder: "production_decodeImage_64_MiB" });
  expect(Object.keys(verified)).not.toContain("original");
  expect(verified.derivative.length).toBe(96_780);
  expect(verified.derivative.length).not.toBe(verified.sourceBytes);
});

it("never invokes the remote starter on OPEN source or derivative preflight failure", async () => {
  const startRemote = vi.fn(() => "started");
  const badOriginal = (file: string) => file.endsWith("200916_EPFL_Raffaella_Buonsanti_Portrait.jpg")
    ? Buffer.from([0xff, 0xd8, 0xff]) : fs.readFileSync(file);
  await expect(launchAfterV4OpenPreflight(() => verifyFrozenV4OpenInputs(badOriginal), startRemote))
    .rejects.toThrow("v4_open_original_file_mismatch");
  expect(startRemote).not.toHaveBeenCalled();
  const badDerivative = (file: string) => file.endsWith("analysis-derivative.jpg")
    ? Buffer.from([0xff, 0xd8, 0xff]) : fs.readFileSync(file);
  await expect(launchAfterV4OpenPreflight(() => verifyFrozenV4OpenInputs(badDerivative), startRemote))
    .rejects.toThrow("v4_open_derivative_file_mismatch");
  expect(startRemote).not.toHaveBeenCalled();
});

it("requires exact same-run crop context rather than filling missing hints", () => {
  const context = { hairTexture: "straight", hairVolume: "normal", overallHairLength: "ear",
    sideHairAsymmetry: "none", headCovering: false };
  expect(validatedSameRunCropContext(context)).toEqual(context);
  expect(validatedSameRunCropContext({ ...context, overallHairLength: undefined })).toBeNull();
  expect(validatedSameRunCropContext({ ...context, extra: "invented" })).toBeNull();
  expect(validatedSameRunCropContext(null)).toBeNull();
});

it("fails closed unless manual visual review names the exact run and crop hash", () => {
  const runId = "a".repeat(32);
  const cropSha256 = "b".repeat(64);
  const review = { runId, cropSha256, vocabulary: "FULL_FACE_MARGIN_OK",
    bothEyesVisible: true, upperAndLowerEyelidsVisible: true, bothBrowsVisible: true,
    outerEyeCornersAndFacialMarginsVisible: true, foreheadNoseMouthChinVisible: true,
    frozenOpenCueReadable: true, glasses: false, eyeOcclusion: false, criticalFaceClipping: false };
  expect(validatedCropVisualReview(review, runId, cropSha256)).toEqual(review);
  expect(validatedCropVisualReview({ ...review, bothBrowsVisible: false }, runId, cropSha256)).toBeNull();
  expect(validatedCropVisualReview({ ...review, glasses: true }, runId, cropSha256)).toBeNull();
  expect(validatedCropVisualReview({ ...review, extra: "x" }, runId, cropSha256)).toBeNull();
  expect(validatedCropVisualReview(review, "c".repeat(32), cropSha256)).toBeNull();
  expect(validatedCropVisualReview(review, runId, "d".repeat(64))).toBeNull();
});
