import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { decodeImage, encodePng, type RawImage } from "../src/png";
import { MAX_IMAGE_CHARS } from "../src/generate";
import { scaleNearestNeighbor } from "../src/skinRender";

const ROOT = path.resolve("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001");
const FREEZE = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001");
const SOURCE = path.join(FREEZE, "source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const EXPECTED_SOURCE = "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac";
const EXPECTED_RGBA = "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89";
const EXPECTED_PAYLOAD = "b1c7a8fb3bb8275e5d656420e4bbc418992815c1aefb402896875dc441bc10ed";
const EXPECTED_PREPROCESSING_SOURCE = "dd6b7dde82b35cc0dd7947b16287c217a23b64d2ac58420015511bfdb352235d";
const BUILD = process.env.BUILD_OPEN_ANCHOR_PREPROCESSING_PARITY === "approved-offline";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const read = (name: string) => fs.readFileSync(path.join(ROOT, name));
const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

function reviewCrop(image: RawImage, x1: number, y1: number, x2: number, y2: number): RawImage {
  const left = Math.floor(image.width * x1);
  const top = Math.floor(image.height * y1);
  const right = Math.ceil(image.width * x2);
  const bottom = Math.ceil(image.height * y2);
  const width = right - left;
  const height = bottom - top;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((top + row) * image.width + left) * 4;
    rgba.set(image.rgba.subarray(offset, offset + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function pasteFitted(sheet: RawImage, image: RawImage, x: number, y: number, width: number, height: number): void {
  const scale = Math.min((width - 16) / image.width, (height - 16) / image.height);
  const fitted = scaleNearestNeighbor(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const left = x + Math.floor((width - fitted.width) / 2);
  const top = y + Math.floor((height - fitted.height) / 2);
  for (let row = 0; row < fitted.height; row++) {
    const from = row * fitted.width * 4;
    const to = ((top + row) * sheet.width + left) * 4;
    sheet.rgba.set(fitted.rgba.subarray(from, from + fitted.width * 4), to);
  }
}

it("verifies actual browser production derivatives against the Worker input and decoder contracts", async () => {
  expect(sha(fs.readFileSync(path.resolve("../src/lib/imageQuality.ts")))).toBe(EXPECTED_PREPROCESSING_SOURCE);
  const frozen = JSON.parse(fs.readFileSync(path.join(FREEZE, "frozen-open-label.json"), "utf8"));
  const source = fs.readFileSync(SOURCE);
  expect(source.length).toBe(3_497_355);
  expect(sha(source)).toBe(EXPECTED_SOURCE);
  expect(sha(JSON.stringify(frozen.payload))).toBe(EXPECTED_PAYLOAD);
  expect(frozen.payloadSha256).toBe(EXPECTED_PAYLOAD);
  expect(frozen.payload.label.eyeOpenness).toBe("open");
  const originalDecoded = decodeJpeg(source, { useTArray: true, maxMemoryUsageInMB: 127 });
  expect([originalDecoded.width, originalDecoded.height, sha(originalDecoded.data)]).toEqual([2002, 3000, EXPECTED_RGBA]);

  const browser = JSON.parse(read("browser-execution.json").toString("utf8"));
  expect(browser.execution).toBe("actual preparePhotoForUpload in browser");
  expect(browser.sourceSha256).toBe(EXPECTED_SOURCE);
  const outputs = [];
  for (const [role, dimensions] of [["analysis", [598, 896]], ["generation", [299, 448]]] as const) {
    const bytes = read(`${role}-derivative.jpg`);
    const metadata = browser.derivatives[role];
    const decoded = await decodeImage(bytes);
    expect(metadata.mime).toBe("image/jpeg");
    expect(metadata.bytes).toBe(bytes.length);
    expect(metadata.sha256).toBe(sha(bytes));
    expect(metadata.dataUrlChars).toBe(23 + 4 * Math.ceil(bytes.length / 3));
    expect([decoded.width, decoded.height]).toEqual(dimensions);
    expect(decoded.rgba.length).toBe(decoded.width * decoded.height * 4);
    expect(metadata.dataUrlChars).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
    outputs.push({ role, bytes: bytes.length, sha256: sha(bytes), decodedRgbaSha256: sha(decoded.rgba),
      width: decoded.width, height: decoded.height, dataUrlChars: metadata.dataUrlChars, decoded });
  }
  expect(outputs[0].dataUrlChars).toBeLessThan(MAX_IMAGE_CHARS);
  expect(23 + 4 * Math.ceil(source.length / 3)).toBeGreaterThan(MAX_IMAGE_CHARS);
});

it.skipIf(!BUILD)("writes secret-safe parity artifacts and a display-only contact sheet", async () => {
  const source = fs.readFileSync(SOURCE);
  const browser = JSON.parse(read("browser-execution.json").toString("utf8"));
  const originalDecoded = decodeJpeg(source, { useTArray: true, maxMemoryUsageInMB: 127 });
  const original: RawImage = { width: originalDecoded.width, height: originalDecoded.height, rgba: originalDecoded.data };
  const analysis = await decodeImage(read("analysis-derivative.jpg"));
  const generation = await decodeImage(read("generation-derivative.jpg"));
  const roleData = (role: "analysis" | "generation", decoded: RawImage, maxLongestEdge: number) => ({
    role, transform: "preparePhotoForUpload (Image/FileReader → canvas.drawImage → canvas.toDataURL)",
    sourceSha256: EXPECTED_SOURCE, mime: "image/jpeg", width: decoded.width, height: decoded.height,
    bytes: browser.derivatives[role].bytes, dataUrlChars: browser.derivatives[role].dataUrlChars,
    sha256: browser.derivatives[role].sha256, decodedRgbaSha256: sha(decoded.rgba),
    encoderExecution: "Codex in-app browser (Chromium canvas JPEG)", quality: 0.85, maxLongestEdge,
  });
  const analysisData = roleData("analysis", analysis, 896);
  const generationData = roleData("generation", generation, 448);
  writeJson("canonical-source.json", { caseId: "open-eye-calibration-001", sourceReviewBasis: "canonical_original",
    sourceSha256: EXPECTED_SOURCE, sourceDecodedRgbaSha256: EXPECTED_RGBA, sourceBytes: source.length,
    sourceDimensions: { width: 2002, height: 3000 }, frozenLabel: "open", frozenPayloadSha256: EXPECTED_PAYLOAD });
  writeJson("preprocessing-contract.json", { productionFunction: "src/lib/imageQuality.ts:preparePhotoForUpload",
    callSite: "src/pages/UploadPage.tsx:handlePhotos", inputType: "File", browserDecode: "new Image() from FileReader data URL",
    explicitExifOrientationHandling: false, browserImageOrientationBehavior: "browser-managed; not explicitly configured",
    canvas: "HTMLCanvasElement 2d drawImage full frame", crop: false, aspectRatioPreserved: true,
    explicitAlphaBackgroundHandling: false, jpegMime: "image/jpeg", attemptedQualities: [0.85, 0.75, 0.6],
    selectedQuality: 0.85, outputType: "two JPEG data URLs", failurePaths: ["FileReader error", "Image error", "2d context unavailable", "all JPEG data URLs above 1500000 characters"],
    parity: { semanticTransform: true, productionFunctionExecuted: true, byteIdentity: "frozen only for this browser execution/runtime" } });
  writeJson("analysis-derivative.json", { productionInputDerivative: analysisData, providerInputBasis: "production_analysis_derivative" });
  writeJson("generation-derivative.json", { generationDerivative: generationData, providerInput: false });
  writeJson("worker-input-preflight.json", { maxImageChars: MAX_IMAGE_CHARS, originalDataUrlChars: 23 + 4 * Math.ceil(source.length / 3),
    originalDirectInputValid: false, analysisDataUrlChars: analysisData.dataUrlChars,
    analysisPublicLengthPass: analysisData.dataUrlChars <= MAX_IMAGE_CHARS,
    currentDecodeImage64MiBPass: true, decodedDimensions: { width: analysis.width, height: analysis.height },
    decodedRgbaSha256: analysisData.decodedRgbaSha256, createIdentityCropsNotRun: true,
    portraitRegionFabricated: false });
  writeJson("calibration-runner-parity.json", { sourceReviewBasis: "canonical_original", providerInputBasis: "production_analysis_derivative",
    sourceSha256: EXPECTED_SOURCE, providerInputSha256: analysisData.sha256,
    providerInputPath: "analysis-derivative.jpg", generationDerivativeIsNotProviderInput: true,
    noProviderCallThisIteration: true, nextLiveInputFrozen: true });

  // Identical normalized view boxes are display-only and never used as portraitRegion or provider crops.
  const sheet: RawImage = { width: 1200, height: 640, rgba: new Uint8Array(1200 * 640 * 4) };
  for (let i = 0; i < sheet.rgba.length; i += 4) sheet.rgba.set([238, 240, 244, 255], i);
  for (const [index, image] of [original, analysis, generation].entries()) {
    pasteFitted(sheet, reviewCrop(image, 0.15, 0.20, 0.85, 0.72), index * 400, 0, 400, 400);
    pasteFitted(sheet, reviewCrop(image, 0.206, 0.33, 0.794, 0.53), index * 400, 400, 400, 240);
  }
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(sheet), { flag: "wx" });
  writeJson("contact-sheet-manifest.json", { columns: ["canonical original", "production analysis 896", "production generation 448"],
    rows: ["face review crop", "eye/brow enlargement"], localDiagnosticOnly: true, providerInput: false });
});
