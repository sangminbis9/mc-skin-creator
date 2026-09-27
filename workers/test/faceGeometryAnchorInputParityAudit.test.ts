import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { decode as decodeJpeg } from "jpeg-js";
import { createIdentityCrops } from "../src/generate";
import { decodeImage, encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";

const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-anchor-input-parity-audit-20260925-001");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const OPEN_DERIVATIVE = path.resolve("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001/analysis-derivative.jpg");
const OPEN_LIVE = path.resolve("evaluation-artifacts/face-geometry-openness-production-derivative-open-anchor-live-20260924-002/summary.json.checkpoint-000037.json");
const WAVE_LIVE = path.resolve("evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001/summary.json");
const BUILD = process.env.BUILD_ANCHOR_INPUT_PARITY_AUDIT === "approved-offline";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const writeBytes = (name: string, value: Uint8Array | string) => {
  const target = path.join(ROOT, name);
  if (fs.existsSync(target)) expect(sha(fs.readFileSync(target))).toBe(sha(value));
  else fs.writeFileSync(target, value, { flag: "wx" });
};
const writeJson = (name: string, value: unknown) => writeBytes(name, `${JSON.stringify(value, null, 2)}\n`);
const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;

function crop(image: RawImage, x1: number, y1: number, x2: number, y2: number): RawImage {
  const left = Math.floor(image.width * x1);
  const top = Math.floor(image.height * y1);
  const right = Math.ceil(image.width * x2);
  const bottom = Math.ceil(image.height * y2);
  const width = right - left;
  const height = bottom - top;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    rgba.set(image.rgba.subarray(((top + row) * image.width + left) * 4, ((top + row) * image.width + right) * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function paste(sheet: RawImage, image: RawImage, col: number, row: number): void {
  const cellWidth = 360;
  const cellHeight = 310;
  const scale = Math.min((cellWidth - 16) / image.width, (cellHeight - 16) / image.height);
  const fitted = scaleNearestNeighbor(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const x = col * cellWidth + Math.floor((cellWidth - fitted.width) / 2);
  const y = row * cellHeight + Math.floor((cellHeight - fitted.height) / 2);
  for (let r = 0; r < fitted.height; r++) {
    sheet.rgba.set(fitted.rgba.subarray(r * fitted.width * 4, (r + 1) * fitted.width * 4), ((y + r) * sheet.width + x) * 4);
  }
}

it("verifies browser derivatives and exact OPEN production crop without external calls", async () => {
  const cases = [
    ["striped", "2881786.jpg", "7d5b593c474be26cf5df09fbe034993d7ce02bf8d561e300ee4a9216692d6573", "216b25495536295ea2fba8d65f929d06e0c8e3071d3bb77846f7d80e0a680f98"],
    ["wavy", "19908659.jpg", "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702", "39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d"],
  ] as const;
  const derivativeMetrics = [];
  for (const [name, filename, sourceSha, derivativeSha] of cases) {
    const source = fs.readFileSync(path.join(GENERALIZATION, filename));
    const derivative = fs.readFileSync(path.join(ROOT, name, "analysis-derivative.jpg"));
    const browser = JSON.parse(fs.readFileSync(path.join(ROOT, name, "browser-execution.json"), "utf8"));
    expect(sha(source)).toBe(sourceSha);
    expect(sha(derivative)).toBe(derivativeSha);
    expect(browser.sourceSha256).toBe(sourceSha);
    expect(browser.analysis.sha256).toBe(derivativeSha);
    const decoded = await decodeImage(derivative);
    expect(Math.max(decoded.width, decoded.height)).toBe(896);
    derivativeMetrics.push({ caseId: name, sourceSha256: sourceSha, derivativeSha256: derivativeSha,
      derivativeBytes: derivative.length, derivativeDimensions: [decoded.width, decoded.height],
      derivativeDecodedRgbaSha256: sha(decoded.rgba), dataUrlChars: browser.analysis.dataUrlChars,
      selectedQuality: 0.85, newDerivativeRawOpenness: "unknown" });
  }

  const openLive = JSON.parse(fs.readFileSync(OPEN_LIVE, "utf8")).snapshot;
  const openResult = openLive.geometryResults[0];
  const openBytes = fs.readFileSync(OPEN_DERIVATIVE);
  expect(sha(openBytes)).toBe("9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b");
  const openCrops = await createIdentityCrops(dataUrl(openBytes), openResult.freshPortraitRegion, openResult.cropContext);
  expect(openCrops).not.toBeNull();
  const openCropBytes = Buffer.from(openCrops!.faceDataUrl.split(",", 2)[1], "base64");
  expect(sha(openCropBytes)).toBe("22a7bd7e01295f9902e3de40088db35bacb298e3e6c08a1479c59c4c3b1caefa");
  const openFace = await decodeImage(openCropBytes);
  expect([openFace.width, openFace.height]).toEqual([350, 510]);

  const wavyLive = JSON.parse(fs.readFileSync(WAVE_LIVE, "utf8"));
  const wavyBytes = fs.readFileSync(path.join(ROOT, "wavy/analysis-derivative.jpg"));
  const wavyCrops = await createIdentityCrops(dataUrl(wavyBytes), wavyLive.geometryResults[0].freshPortraitRegion, wavyLive.geometryResults[0].cropContext);
  expect(wavyCrops).not.toBeNull();
  const wavyFace = await decodeImage(Buffer.from(wavyCrops!.faceDataUrl.split(",", 2)[1], "base64"));

  if (BUILD) {
    writeJson("production-derivatives.json", derivativeMetrics);
    writeJson("open-crop-regeneration.json", { imageInputSha256: sha(openBytes), portraitRegionSource: OPEN_LIVE,
      exactCropSha256: sha(openCropBytes), dimensions: [openFace.width, openFace.height],
      faceCropLateralGuard: openResult.crop.faceCropLateralGuard, finalFaceBox: openResult.crop.finalFaceBox });
    writeJson("wavy-diagnostic-crop.json", { imageInputSha256: sha(wavyBytes),
      portraitRegionSource: WAVE_LIVE, dimensions: [wavyFace.width, wavyFace.height],
      status: "offline diagnostic crop using stored normalized portraitRegion; not fresh provider localization or measurement" });
    writeBytes("open-final-face-crop.png", await encodePng(openFace));
    writeBytes("wavy-diagnostic-face-crop.png", await encodePng(wavyFace));
    const openSourceJpeg = decodeJpeg(fs.readFileSync(path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg")), { useTArray: true, maxMemoryUsageInMB: 127 });
    const sourceOpen: RawImage = { width: openSourceJpeg.width, height: openSourceJpeg.height, rgba: openSourceJpeg.data };
    const sourceWavy = await decodeImage(fs.readFileSync(path.join(GENERALIZATION, "19908659.jpg")));
    const derivativeOpen = await decodeImage(openBytes);
    const derivativeWavy = await decodeImage(wavyBytes);
    const sheet: RawImage = { width: 1440, height: 620, rgba: new Uint8Array(1440 * 620 * 4) };
    for (let i = 0; i < sheet.rgba.length; i += 4) sheet.rgba.set([238, 240, 244, 255], i);
    const rows = [
      [crop(sourceOpen, 0.2, 0.2, 0.8, 0.8), crop(derivativeOpen, 0.2, 0.2, 0.8, 0.8), openFace, crop(openFace, 0.26, 0.37, 0.84, 0.57)],
      [crop(sourceWavy, 0.26, 0.2, 0.74, 0.6), crop(derivativeWavy, 0.26, 0.2, 0.74, 0.6), wavyFace, crop(wavyFace, 0.17, 0.28, 0.77, 0.47)],
    ];
    for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) paste(sheet, rows[row][col], col, row);
    writeBytes("contact-sheet.png", await encodePng(sheet));
    writeJson("contact-sheet-manifest.json", { columns: ["source face view", "actual production analysis derivative face view", "production/equivalent diagnostic crop", "eye and brow patch"],
      rows: ["OPEN open-eye-calibration-001", "NORMAL wavy-open-blazer"],
      wavyCropStatus: "diagnostic using stored normalized portraitRegion, not fresh production localization", localOnly: true, providerMeasurement: false });
  }
});
