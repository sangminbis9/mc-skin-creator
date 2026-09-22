import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { FACE_IDENTITY_GEOMETRY_PROMPT } from "../src/faceIdentityGeometry";
import { createIdentityCrops } from "../src/generate";
import { base64ToBytes, bytesToBase64, decodeImage, decodePng, encodePng, type RawImage } from "../src/png";

const BUILD = process.env.BUILD_FACE_GEOMETRY_EYE_ROOT_CAUSE_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-eye-measurement-root-cause-20260922-001");
const LIVE_ROOT = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001");
const FROZEN_ROOT = path.resolve("evaluation-artifacts/generalization-20260905");
const SENTINEL_ROOT = path.resolve("evaluation-artifacts/face-only-geometry-20260914");
const SENTINEL_FACE = path.resolve("evaluation-artifacts/face-quantization-generalization-20260907/changed-cases/wavy-open-blazer/01-source-face.png");
const hash = (value: string | Uint8Array | Buffer) => createHash("sha256").update(value).digest("hex");
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

type Box = { left: number; top: number; right: number; bottom: number };
type Geometry = {
  face: { envelopeLeft: number; envelopeRight: number; foreheadY: number; chinY: number };
  eyes: { leftCenterX: number; leftCenterY: number; leftWidth: number; rightCenterX: number; rightCenterY: number; rightWidth: number; openness: number };
  nose: { centerX: number };
  mouth: { centerX: number };
  directLowerFaceContour: Record<"cheek" | "jaw" | "chin", { left: number | null; right: number | null; y: number | null; evidence: string; confidence: number }>;
  confidence: { eyes: number };
};
type LiveCase = {
  caseId: "warm-white-tee" | "striped-open-shirt";
  sourceSha256: string;
  sourceBytes: number;
  storedPortraitRegion: { subjectBox: Box; headBox: Box; faceBox: Box; confidence: number };
  cropContext: Record<string, unknown>;
  crop: Record<string, unknown> & { sourceDimensions: { width: number; height: number }; faceCropDimensions: { width: number; height: number }; finalFaceBox: Box };
  faceCropSha256: string;
  geometry: Geometry;
};
type LiveSummary = { head: string; branch: string; geometryResults: LiveCase[] };

const photoId = { "warm-white-tee": 26954028, "striped-open-shirt": 2881786 } as const;
const manualHead = {
  "warm-white-tee": { left: 0.32, top: 0.02, right: 0.79, bottom: 0.37 },
  "striped-open-shirt": { left: 0.46, top: 0.24, right: 0.71, bottom: 0.48 },
  "wavy-open-blazer": { left: 0.19, top: 0.18, right: 0.73, bottom: 0.65 },
} as const;

function pixelBounds(box: Box, image: RawImage) {
  const x = Math.max(0, Math.floor(box.left * image.width));
  const y = Math.max(0, Math.floor(box.top * image.height));
  const right = Math.min(image.width, Math.ceil(box.right * image.width));
  const bottom = Math.min(image.height, Math.ceil(box.bottom * image.height));
  return { x, y, width: right - x, height: bottom - y, right, bottom };
}

function boundsFromDiagnosticBox(box: Box, image: RawImage) {
  const x = Math.round(box.left * image.width);
  const y = Math.round(box.top * image.height);
  const right = Math.round(box.right * image.width);
  const bottom = Math.round(box.bottom * image.height);
  return { x, y, width: right - x, height: bottom - y, right, bottom };
}

function crop(image: RawImage, box: Box): RawImage {
  const bounds = pixelBounds(box, image);
  const rgba = new Uint8Array(bounds.width * bounds.height * 4);
  for (let row = 0; row < bounds.height; row++) {
    const start = ((bounds.y + row) * image.width + bounds.x) * 4;
    rgba.set(image.rgba.subarray(start, start + bounds.width * 4), row * bounds.width * 4);
  }
  return { width: bounds.width, height: bounds.height, rgba };
}

function fill(image: RawImage, color: [number, number, number, number]) {
  for (let offset = 0; offset < image.rgba.length; offset += 4) image.rgba.set(color, offset);
}

function putFitted(target: RawImage, source: RawImage, column: number, row: number, cell: number) {
  const scale = Math.min((cell - 8) / source.width, (cell - 8) / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const originX = column * cell + Math.floor((cell - width) / 2);
  const originY = row * cell + Math.floor((cell - height) / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
    const sourceY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    const from = (sourceY * source.width + sourceX) * 4;
    const to = ((originY + y) * target.width + originX + x) * 4;
    target.rgba.set(source.rgba.subarray(from, from + 4), to);
  }
}

function overlayBox(source: RawImage, box: Box, color: [number, number, number, number], thickness = 5): RawImage {
  const output = { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) };
  const b = pixelBounds(box, source);
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= output.width || y >= output.height) return;
    output.rgba.set(color, (y * output.width + x) * 4);
  };
  for (let offset = 0; offset < thickness; offset++) {
    for (let x = b.x; x < b.right; x++) { paint(x, b.y + offset); paint(x, b.bottom - 1 - offset); }
    for (let y = b.y; y < b.bottom; y++) { paint(b.x + offset, y); paint(b.right - 1 - offset, y); }
  }
  return output;
}

function boxMetrics(face: Box, head: Box, source: { width: number; height: number }) {
  const faceWidth = (face.right - face.left) * source.width;
  const faceHeight = (face.bottom - face.top) * source.height;
  const headWidth = (head.right - head.left) * source.width;
  const headHeight = (head.bottom - head.top) * source.height;
  return {
    facePixels: { width: faceWidth, height: faceHeight, aspect: faceWidth / faceHeight },
    headPixels: { width: headWidth, height: headHeight, aspect: headWidth / headHeight },
    faceToHead: { width: faceWidth / headWidth, height: faceHeight / headHeight },
    centerOffsetPixels: {
      x: (((face.left + face.right) - (head.left + head.right)) / 2) * source.width,
      y: (((face.top + face.bottom) - (head.top + head.bottom)) / 2) * source.height,
    },
  };
}

function quantize(geometry: Geometry) {
  const faceWidth = geometry.face.envelopeRight - geometry.face.envelopeLeft;
  const spacing = ((geometry.eyes.rightCenterX - geometry.eyes.leftCenterX) / faceWidth) * 7;
  const footprint = (((geometry.eyes.leftWidth + geometry.eyes.rightWidth) / 2) / faceWidth) * 8;
  return {
    faceWidth,
    spacingCells: spacing,
    spacingBin: spacing <= 2.8 ? "narrow" : spacing >= 3.4 ? "wide" : "medium",
    footprintCells: footprint,
    footprintBin: footprint <= 1.4 ? "compact" : footprint >= 1.9 ? "wide" : "medium",
    opennessScore: geometry.eyes.openness,
    opennessBin: geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable",
  };
}

function boundarySignals(geometry: Geometry) {
  const near = (value: number | null, edge: 0 | 1) => value !== null && Math.abs(value - edge) <= 0.02;
  return {
    envelopeLeftBoundary: near(geometry.face.envelopeLeft, 0),
    envelopeRightBoundary: near(geometry.face.envelopeRight, 1),
    leftEyeCenterBoundary: geometry.eyes.leftCenterX <= 0.08,
    rightEyeCenterBoundary: geometry.eyes.rightCenterX >= 0.92,
    noseExtremeBias: geometry.nose.centerX <= 0.25 || geometry.nose.centerX >= 0.75,
    mouthExtremeBias: geometry.mouth.centerX <= 0.25 || geometry.mouth.centerX >= 0.75,
    contourBoundaryTouches: Object.fromEntries(Object.entries(geometry.directLowerFaceContour).map(([name, contour]) => [name, {
      left: near(contour.left, 0), right: near(contour.right, 1), evidence: contour.evidence,
    }])),
  };
}

async function buildAudit() {
  const live = read<LiveSummary>(path.join(LIVE_ROOT, "summary.json"));
  expect(live.branch).toBe("main");
  expect(live.head).toBe("0b9d6dec4346076736ad21d92b4125481808efc1");
  expect(live.geometryResults.map(item => item.caseId)).toEqual(["warm-white-tee", "striped-open-shirt"]);

  const sheet: RawImage = { width: 4 * 260, height: 3 * 260, rgba: new Uint8Array(4 * 260 * 3 * 260 * 4) };
  fill(sheet, [238, 240, 244, 255]);
  const cropCases = [];
  for (let row = 0; row < live.geometryResults.length; row++) {
    const item = live.geometryResults[row];
    const bytes = fs.readFileSync(path.join(FROZEN_ROOT, "sources", `${photoId[item.caseId]}.jpg`));
    expect(hash(bytes)).toBe(item.sourceSha256);
    expect(bytes.length).toBe(item.sourceBytes);
    const source = await decodeImage(bytes);
    const crops = await createIdentityCrops(`data:image/jpeg;base64,${bytesToBase64(bytes)}`, item.storedPortraitRegion, item.cropContext);
    expect(crops, `${item.caseId}: crop`).toBeTruthy();
    if (!crops) throw new Error(`${item.caseId}: crop unavailable`);
    const faceBytes = base64ToBytes(crops.faceDataUrl.slice(crops.faceDataUrl.indexOf(",") + 1));
    if (crops.diagnostics.faceCropLateralGuard.applied) {
      expect(hash(faceBytes)).not.toBe(item.faceCropSha256);
      expect(crops.diagnostics.faceCropDimensions.width).toBeGreaterThan(item.crop.faceCropDimensions.width);
      expect(crops.diagnostics.faceCropDimensions.height).toBe(item.crop.faceCropDimensions.height);
      expect(crops.diagnostics.finalFaceBox?.top).toBe(item.crop.finalFaceBox.top);
      expect(crops.diagnostics.finalFaceBox?.bottom).toBe(item.crop.finalFaceBox.bottom);
    } else {
      expect(hash(faceBytes)).toBe(item.faceCropSha256);
      expect(crops.diagnostics.faceCropDimensions).toEqual(item.crop.faceCropDimensions);
      expect(crops.diagnostics.finalFaceBox).toEqual(item.crop.finalFaceBox);
    }
    const actual = await decodePng(faceBytes);
    const storedBounds = pixelBounds(item.storedPortraitRegion.faceBox, source);
    // finalFaceBox is emitted from already-integer crop bounds. Recover those
    // integers with round; floor/ceil would introduce a floating-point pixel.
    const finalBounds = boundsFromDiagnosticBox(crops.diagnostics.finalFaceBox, source);
    const margins = {
      left: storedBounds.x - finalBounds.x,
      top: storedBounds.y - finalBounds.y,
      right: finalBounds.right - storedBounds.right,
      bottom: finalBounds.bottom - storedBounds.bottom,
    };
    const manual = manualHead[item.caseId];
    cropCases.push({
      caseId: item.caseId,
      source: { sha256: hash(bytes), bytes: bytes.length, width: source.width, height: source.height },
      storedPortraitRegion: item.storedPortraitRegion,
      frozenManualHeadBox: manual,
      localizationComparison: {
        storedFaceVsStoredHead: boxMetrics(item.storedPortraitRegion.faceBox, item.storedPortraitRegion.headBox, source),
        storedFaceVsFrozenManualHead: boxMetrics(item.storedPortraitRegion.faceBox, manual, source),
      },
      crop: {
        inputFaceBox: item.storedPortraitRegion.faceBox,
        expandedFaceRule: { horizontalEachSide: 0.2, top: 0.22, bottom: 0.2 },
        clampLimit: "adaptive head crop",
        finalNormalizedBox: crops.diagnostics.finalFaceBox,
        preResize: { width: finalBounds.width, height: finalBounds.height, aspect: finalBounds.width / finalBounds.height },
        postResize: { ...crops.diagnostics.faceCropDimensions, aspect: actual.width / actual.height },
        resizeApplied: finalBounds.width !== actual.width || finalBounds.height !== actual.height,
        interpolation: "nearest-neighbor center sample; not exercised because crop is below 512 px",
        padding: false,
        marginsAroundStoredFacePixels: margins,
        encodedMime: "image/png",
        encodedSha256: hash(faceBytes),
        lateralGuard: crops.diagnostics.faceCropLateralGuard,
      },
      visualContract: item.caseId === "warm-white-tee" ? {
        classification: "RIGHT_CLIPPED",
        foreheadMargin: "visible",
        leftFaceMargin: "visible",
        rightFaceMargin: "insufficient; visible facial boundary reaches crop edge",
        chinMargin: "visible but lateral jaw continues beyond right edge",
        bothEyes: "visible",
        bothTemples: "no; viewer-right/image-right temple is not retained",
        nose: "visible",
        mouth: "visible",
      } : {
        classification: "MULTI_EDGE_CLIPPED",
        foreheadMargin: "visible",
        leftFaceMargin: "edge-tight",
        rightFaceMargin: "insufficient; right cheek/temple is outside the crop",
        chinMargin: "vertical margin exists, but lateral chin contour is clipped",
        bothEyes: "visible but the image-right eye is edge-tight",
        bothTemples: "no",
        nose: "visible and near image-right crop side",
        mouth: "edge-tight on image-right",
      },
      geometryBoundarySignals: boundarySignals(item.geometry),
      geometry: item.geometry,
      quantized: quantize(item.geometry),
    });
    putFitted(sheet, source, 0, row, 260);
    putFitted(sheet, overlayBox(source, item.storedPortraitRegion.faceBox, [255, 205, 0, 255]), 1, row, 260);
    putFitted(sheet, overlayBox(source, crops.diagnostics.finalFaceBox, [255, 45, 45, 255]), 2, row, 260);
    putFitted(sheet, actual, 3, row, 260);
  }

  const sentinelData = read<{
    selected: Array<{ id: string; sourceHash: string; cropBox: number[]; faceHash: string; dimensions: { width: number; height: number }; pose: string }>;
    results: Array<{ id: string; measurements: { eyes: { leftCenterX: number; rightCenterX: number; leftWidth: number; rightWidth: number; openness: number; confidence: number }; nose: { x: number }; mouth: { x: number } }; topology: { geometryUsage: { eyes: boolean } } }>;
  }>(path.join(SENTINEL_ROOT, "live-001", "measurements.json"));
  const selected = sentinelData.selected.find(item => item.id === "wavy-open-blazer");
  const sentinel = sentinelData.results.find(item => item.id === "wavy-open-blazer");
  expect(selected).toBeTruthy();
  expect(sentinel).toBeTruthy();
  if (!selected || !sentinel) throw new Error("wavy sentinel missing");
  const sentinelSourceBytes = fs.readFileSync(SENTINEL_FACE);
  expect(hash(sentinelSourceBytes)).toBe(selected.sourceHash);
  const sentinelSource = await decodePng(sentinelSourceBytes);
  const [left, top, right, bottom] = selected.cropBox;
  const sentinelBox = { left, top, right, bottom };
  const sentinelCrop = crop(sentinelSource, sentinelBox);
  const sentinelCropBytes = await encodePng(sentinelCrop);
  expect(hash(sentinelCropBytes)).toBe(selected.faceHash);
  expect({ width: sentinelCrop.width, height: sentinelCrop.height }).toEqual(selected.dimensions);
  const wavyJpegBytes = fs.readFileSync(path.join(FROZEN_ROOT, "sources", "19908659.jpg"));
  const wavyJpeg = await decodeImage(wavyJpegBytes);
  putFitted(sheet, wavyJpeg, 0, 2, 260);
  putFitted(sheet, sentinelSource, 1, 2, 260);
  putFitted(sheet, overlayBox(sentinelSource, sentinelBox, [255, 45, 45, 255]), 2, 2, 260);
  putFitted(sheet, sentinelCrop, 3, 2, 260);

  const wavy = {
    caseId: "wavy-open-blazer",
    provenance: "historical controlled sentinel using a frozen reviewed face-image crop; it is not a current production sourceSelection crop",
    fullSource: { sha256: hash(wavyJpegBytes), bytes: wavyJpegBytes.length, width: wavyJpeg.width, height: wavyJpeg.height },
    retainedSourceFace: { path: path.relative(path.resolve("."), SENTINEL_FACE), sha256: selected.sourceHash, width: sentinelSource.width, height: sentinelSource.height },
    frozenReviewedCropBox: sentinelBox,
    exactInputCrop: { sha256: selected.faceHash, ...selected.dimensions, aspect: selected.dimensions.width / selected.dimensions.height },
    productionLocalizationAvailable: false,
    cropValidity: "FULL_FACE_MARGIN_OK in the historical controlled input; no claim about current production localization",
    measurements: sentinel.measurements,
    geometryUsageEyes: sentinel.topology.geometryUsage.eyes,
    exactFaceEnvelopeRetained: false,
    reproducibleQuantization: {
      openness: { raw: sentinel.measurements.eyes.openness, bin: sentinel.measurements.eyes.openness >= 0.68 ? "open" : sentinel.measurements.eyes.openness <= 0.34 ? "compact" : "readable" },
      spacing: "not reproducible: retained sentinel summary omitted face envelope",
      footprint: "not reproducible: retained sentinel summary omitted face envelope",
    },
  };

  const quantizer = {
    coordinateBasis: "Gemma eye centers and widths are crop-normalized; face envelope is in the same crop coordinate system",
    spacing: { formula: "((rightCenterX-leftCenterX)/(envelopeRight-envelopeLeft))*7", bins: { narrowMax: 2.8, wideMin: 3.4 } },
    footprint: { formula: "(((leftWidth+rightWidth)/2)/(envelopeRight-envelopeLeft))*8", bins: { compactMax: 1.4, wideMin: 1.9 }, explanation: "values above 1 are Minecraft face-grid cell spans, not normalized proportions" },
    openness: { formula: "raw openness score", bins: { compactMax: 0.34, openMin: 0.68 } },
    warm: quantize(live.geometryResults[0].geometry),
    striped: quantize(live.geometryResults[1].geometry),
    wavy: wavy.reproducibleQuantization,
  };
  expect(quantizer.warm).toMatchObject({ spacingBin: "wide", footprintBin: "medium", opennessBin: "open" });
  expect(quantizer.striped).toMatchObject({ spacingBin: "narrow", footprintBin: "wide", opennessBin: "open" });
  expect(quantizer.warm.footprintCells).toBeCloseTo(1.81818181818, 9);
  expect(quantizer.striped.footprintCells).toBeCloseTo(2.10947368421, 9);
  expect(wavy.reproducibleQuantization.openness).toEqual({ raw: 0.85, bin: "open" });

  const geometryContract = {
    promptHash: hash(FACE_IDENTITY_GEOMETRY_PROMPT),
    exactPromptStatements: {
      coordinateSpace: "All coordinates use this crop: left=0, right=1, top=0, bottom=1.",
      eyeWidth: "measure viewer-left/right centers and each visible eye width",
      openness: "openness 0=narrow/closed to 1=fully open",
      faceEnvelope: "maximum visible facial skin envelope over the whole face ... horizontal scale reference",
      interEyeDistance: "derived in code as rightCenterX-leftCenterX; it is not a provider response-schema field",
    },
    interpretation: {
      openness: "perceptual 0..1 score; no eye-height/eye-width or face-relative denominator is specified",
      widths: "crop-coordinate normalized widths by the global coordinate-space instruction; the prompt does not restate the denominator on the width field",
      faceEnvelope: "crop-coordinate horizontal facial scale used by the quantizer",
      denominatorConsistency: "consistent coordinate basis: crop-normalized eye width divided by crop-normalized face-envelope width; multiplication by 8 maps to the 8-cell face grid",
      semanticRisk: "openness is operationally underspecified, making calibration/model adherence a secondary risk even though the earliest target failures are crop localization",
    },
  };

  const cases = {
    "warm-white-tee": {
      crop: cropCases[0],
      sourceRubric: { eyeOpenness: "narrow", eyeFootprint: "compact" },
      relativeEvidence: {
        openness: "0.70 < wavy 0.85: direction/rank supports narrower-than-wavy, but threshold maps both to open",
        footprint: "mean width 0.20 > wavy 0.1475: opposite the target compact-vs-normal visual ordering",
      },
      taxonomy: "MIXED",
      primaryCause: "CROP_LOCALIZATION_INVALID (image-right face boundary excluded before Gemma)",
      secondaryCause: "MEASUREMENT_RANK_CORRECT_BIN_WRONG for openness; MEASUREMENT_VALUE_WRONG for footprint",
    },
    "striped-open-shirt": {
      crop: cropCases[1],
      sourceRubric: { eyeOpenness: "narrow", eyeFootprint: "compact" },
      relativeEvidence: {
        openness: "0.70 < wavy 0.85: direction/rank supports narrower-than-wavy, but threshold maps both to open",
        footprint: "mean width 0.2505 > wavy 0.1475: opposite the target compact-vs-normal visual ordering",
      },
      taxonomy: "CROP_LOCALIZATION_INVALID",
      primaryCause: "stored primary faceBox is a central-face strip; the expanded crop remains horizontally clipped",
      secondaryCause: "openness calibration remains a candidate only after localization is corrected",
    },
  };

  return {
    live,
    cropCases,
    wavy,
    quantizer,
    geometryContract,
    cases,
    contactSheet: sheet,
    causeRanking: [
      { rank: 1, cause: "sourceSelection faceBox/localization under-coverage", evidence: "both exact crops omit at least one lateral facial boundary; striped is a 72x203 px central strip before expansion and remains 102 px wide" },
      { rank: 2, cause: "openness score/bin calibration", evidence: "targets 0.70 rank below wavy 0.85 but all exceed openMin=0.68" },
      { rank: 3, cause: "Gemma eye-width measurement value", evidence: "target mean widths 0.20/0.2505 exceed wavy 0.1475, opposite compact target ordering; crop defects confound attribution" },
      { rank: 4, cause: "numeric denominator mismatch", evidence: "not supported: widths and envelope share crop coordinates; division produces face-relative grid-cell span as designed" },
      { rank: 5, cause: "crop expansion/resize implementation", evidence: "not supported: exact hashes reproduce, 20/22/20 percent expansion is applied, no resize or padding occurs" },
    ],
  };
}

it("reproduces exact target and sentinel crops and the continuous-eye quantizer offline", async () => {
  const audit = await buildAudit();
  expect(audit.cropCases.every(item => item.crop.lateralGuard.applied)).toBe(true);
  expect(audit.cropCases.map(item => item.crop.encodedSha256)).not.toEqual([
    "4902d5b8c8cee49c8e9140c2397b31ee5aa7f7a775d5cd18bf596b8b87e70148",
    "4fd01fc62a538c53eb6876b493c6c8386042656a5d39db0a14790e8da3506d30",
  ]);
  expect(audit.wavy.exactInputCrop.sha256).toBe("fd5b83e6dc82952939db8b9045d39fe590f22fe345a5b6791fcb714b37c57f58");
  expect(audit.geometryContract.interpretation.denominatorConsistency).toContain("consistent coordinate basis");
});

it.skipIf(!BUILD)("writes the offline root-cause artifact set", async () => {
  const audit = await buildAudit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("crop-contract.json", {
    productionPath: ["stored portraitRegion.faceBox", "expand 20% horizontal / 22% top / 20% bottom", "clamp to adaptive head crop and source", "pixel floor(left/top), ceil(right/bottom)", "resize only above max edge 512", "nearest-neighbor center sampling", "PNG encoding"],
    cases: audit.cropCases,
    sentinel: audit.wavy,
    contactSheetLegend: { columns: ["SOURCE FULL", "stored faceBox/source-face", "expanded geometry box/reviewed sentinel box", "actual geometry input crop"], rows: ["warm-white-tee", "striped-open-shirt", "wavy-open-blazer historical sentinel"] },
  });
  write("geometry-contract.json", audit.geometryContract);
  write("quantizer-formulas.json", audit.quantizer);
  write("case-diagnosis.json", audit.cases);
  write("sentinel-comparison.json", {
    limitation: "The retained wavy sentinel is a historical controlled reviewed face crop, not current production sourceSelection localization; exact envelope values were not retained.",
    comparison: {
      warm: { crop: audit.cropCases[0].crop, eyes: audit.cropCases[0].geometry.eyes, face: audit.cropCases[0].geometry.face, quantized: audit.cropCases[0].quantized },
      striped: { crop: audit.cropCases[1].crop, eyes: audit.cropCases[1].geometry.eyes, face: audit.cropCases[1].geometry.face, quantized: audit.cropCases[1].quantized },
      wavy: audit.wavy,
    },
    ordering: {
      openness: "warm=striped=0.70 < wavy=0.85; raw rank is compatible with targets being narrower, but the current threshold maps all three to open",
      width: "wavy mean=0.1475 < warm mean=0.20 < striped mean=0.2505; this contradicts compact target vs normal sentinel ordering before binning",
      sourcePixelProxy: "not computed: no frozen/manual eye envelope coordinates exist; visual rubric is retained without fabricating anatomical landmarks",
    },
  });
  write("cause-ranking.json", {
    strongestRootCause: "sourceSelection faceBox/localization under-coverage",
    earliestBoundary: "stored primary portraitRegion.faceBox",
    ranking: audit.causeRanking,
    traceBacklog: "TRACE_PROVENANCE_INCONSISTENCY: layout.geometryUsage.eyes=true / face plan source=identity_geometry while resolveFaceMeasurements reports categorical_grammar",
    recommendedSingleNextBoundary: "face crop/localization robustness: require a full lateral face envelope before face-only geometry",
  });
  fs.writeFileSync(path.join(ROOT, "source-crop-contact-sheet.png"), await encodePng(audit.contactSheet), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face geometry eye-measurement root cause\n\n` +
    `- Scope: offline only; external calls 0; production source changes 0.\n` +
    `- Exact warm and striped production crops reproduced byte-for-byte from frozen JPEG + stored portraitRegion.\n` +
    `- Warm: 152x193, RIGHT_CLIPPED. The image-right facial boundary is excluded; Gemma envelopeRight=1 corroborates the crop-edge condition.\n` +
    `- Striped: 102x288, MULTI_EDGE_CLIPPED. The stored 72x203 faceBox is a central-face strip; 20% expansion does not recover both temples/lateral contours.\n` +
    `- Wavy: exact 265x296 historical controlled sentinel reproduced, but it used a frozen reviewed face-image crop and is not current production localization.\n` +
    `- Openness is a perceptual 0..1 score (closed/narrow to fully open), not a defined aperture ratio. Target 0.70 values rank below wavy 0.85 but all quantize open at >=0.68.\n` +
    `- Eye widths and face envelope share crop coordinates. Division by envelope width and multiplication by 8 intentionally yields Minecraft face-grid cell spans; no denominator mismatch was found.\n` +
    `- Target eye-width ordering is wrong before binning: wavy 0.1475 < warm 0.20 < striped 0.2505. Crop clipping is a confounder that must be removed first.\n` +
    `- Strongest earliest blocker: stored primary faceBox localization under-coverage. Crop expansion, resize, and encoding reproduce exactly and are not the first defect.\n` +
    `- Warm taxonomy: MIXED (localization first; openness rank/bin and width-value issues remain).\n` +
    `- Striped taxonomy: CROP_LOCALIZATION_INVALID.\n` +
    `- Backlog only: TRACE_PROVENANCE_INCONSISTENCY.\n\n` +
    `NEXT_QUALITY_TARGET: face crop/localization robustness—retain the full lateral face envelope before face-only geometry\n`, { flag: "wx" });
});
