import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";

const BUILD = process.env.BUILD_FACE_GEOMETRY_EXTERNAL_OPEN_SOURCE_FREEZE === "approved-offline";
const REFRESH_CONTACT = process.env.REFRESH_FACE_GEOMETRY_EXTERNAL_OPEN_SOURCE_CONTACT === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001");
const SOURCE = path.join(ROOT, "source", "200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const EXPECTED_SOURCE_SHA256 = "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac";
const CASE_ID = "open-eye-calibration-001";

type Review = {
  candidateId: string;
  sourceFileIdentifier: string;
  sourcePage: string;
  originalUrl: string;
  originalFilename: string;
  license: string;
  licenseUrl: string;
  authorOrUploader: string;
  dimensions: { width: number; height: number };
  bytes: number;
  bothEyesVisible: boolean;
  upperLowerEyelidsVisible: boolean;
  bothBrowsVisible: boolean;
  lateralFaceMargins: "full" | "edge_tight" | "clipped";
  aperture: "stable_large" | "ordinary" | "narrow" | "ambiguous";
  expression: "neutral" | "smile" | "surprised" | "other" | "ambiguous";
  brows: "ordinary" | "raised" | "ambiguous";
  blinkOrClosure: "none" | "possible" | "ambiguous";
  eyeContrast: "none" | "present_not_decisive" | "ambiguous";
  glasses: "none" | "clear" | "sunglasses";
  occlusion: "none" | "minor" | "material";
  pose: "frontal" | "mild_turn" | "other";
  sufficientFaceResolution: boolean;
  qualified: boolean;
  rejectionReasons: string[];
};

const reviews: Review[] = [
  {
    candidateId: "candidate-01",
    sourceFileIdentifier: "File:Girl close-up face portrait (49749906893).jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Girl_close-up_face_portrait_(49749906893).jpg",
    originalUrl: "https://upload.wikimedia.org/wikipedia/commons/1/12/Girl_close-up_face_portrait_%2849749906893%29.jpg",
    originalFilename: "Girl_close-up_face_portrait_(49749906893).jpg",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    authorOrUploader: "Pedro Ribeiro Simões",
    dimensions: { width: 3043, height: 2022 },
    bytes: 1_346_820,
    bothEyesVisible: true,
    upperLowerEyelidsVisible: true,
    bothBrowsVisible: true,
    lateralFaceMargins: "full",
    aperture: "ordinary",
    expression: "other",
    brows: "ordinary",
    blinkOrClosure: "none",
    eyeContrast: "present_not_decisive",
    glasses: "none",
    occlusion: "minor",
    pose: "mild_turn",
    sufficientFaceResolution: true,
    qualified: false,
    rejectionReasons: ["vertical eyelid aperture is ordinary rather than stable_large", "side gaze and partially open mouth reduce neutral calibration stability"],
  },
  {
    candidateId: "candidate-02",
    sourceFileIdentifier: "File:200916 EPFL Raffaella Buonsanti Portrait.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:200916_EPFL_Raffaella_Buonsanti_Portrait.jpg",
    originalUrl: "https://upload.wikimedia.org/wikipedia/commons/4/40/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg",
    originalFilename: "200916_EPFL_Raffaella_Buonsanti_Portrait.jpg",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0",
    authorOrUploader: "EPFL-MEDIACOM; attribution EPFL",
    dimensions: { width: 2002, height: 3000 },
    bytes: 3_497_355,
    bothEyesVisible: true,
    upperLowerEyelidsVisible: true,
    bothBrowsVisible: true,
    lateralFaceMargins: "full",
    aperture: "stable_large",
    expression: "neutral",
    brows: "ordinary",
    blinkOrClosure: "none",
    eyeContrast: "present_not_decisive",
    glasses: "none",
    occlusion: "none",
    pose: "frontal",
    sufficientFaceResolution: true,
    qualified: true,
    rejectionReasons: [],
  },
  {
    candidateId: "candidate-03",
    sourceFileIdentifier: "File:Alessia Mosca ritratto.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Alessia_Mosca_ritratto.jpg",
    originalUrl: "https://upload.wikimedia.org/wikipedia/commons/e/e9/Alessia_Mosca_ritratto.jpg",
    originalFilename: "Alessia_Mosca_ritratto.jpg",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    authorOrUploader: "Gabriel Zurlo Sconosciuto",
    dimensions: { width: 2348, height: 3262 },
    bytes: 3_491_985,
    bothEyesVisible: true,
    upperLowerEyelidsVisible: true,
    bothBrowsVisible: true,
    lateralFaceMargins: "full",
    aperture: "ordinary",
    expression: "neutral",
    brows: "ordinary",
    blinkOrClosure: "none",
    eyeContrast: "present_not_decisive",
    glasses: "clear",
    occlusion: "minor",
    pose: "frontal",
    sufficientFaceResolution: true,
    qualified: false,
    rejectionReasons: ["vertical eyelid aperture is ordinary rather than stable_large", "clear glasses add avoidable calibration refraction/frame context"],
  },
  {
    candidateId: "candidate-04",
    sourceFileIdentifier: "File:01 Nicole Dołowy-Rybińska.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:01_Nicole_Do%C5%82owy-Rybi%C5%84ska.jpg",
    originalUrl: "https://upload.wikimedia.org/wikipedia/commons/8/8a/01_Nicole_Do%C5%82owy-Rybi%C5%84ska.jpg",
    originalFilename: "01_Nicole_Dołowy-Rybińska.jpg",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    authorOrUploader: "Kinga Capik",
    dimensions: { width: 1818, height: 1754 },
    bytes: 731_351,
    bothEyesVisible: true,
    upperLowerEyelidsVisible: true,
    bothBrowsVisible: true,
    lateralFaceMargins: "full",
    aperture: "narrow",
    expression: "smile",
    brows: "ordinary",
    blinkOrClosure: "possible",
    eyeContrast: "ambiguous",
    glasses: "clear",
    occlusion: "minor",
    pose: "frontal",
    sufficientFaceResolution: true,
    qualified: false,
    rejectionReasons: ["eye aperture is narrow with possible smile-related partial closure", "clear glasses add frame and reflection ambiguity"],
  },
  {
    candidateId: "candidate-05",
    sourceFileIdentifier: "File:Fiorenza Renda.png",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Fiorenza_Renda.png",
    originalUrl: "https://upload.wikimedia.org/wikipedia/commons/6/65/Fiorenza_Renda.png",
    originalFilename: "Fiorenza_Renda.png",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    authorOrUploader: "Mavala9911",
    dimensions: { width: 1064, height: 1356 },
    bytes: 2_009_469,
    bothEyesVisible: true,
    upperLowerEyelidsVisible: true,
    bothBrowsVisible: true,
    lateralFaceMargins: "full",
    aperture: "ambiguous",
    expression: "smile",
    brows: "ordinary",
    blinkOrClosure: "none",
    eyeContrast: "ambiguous",
    glasses: "none",
    occlusion: "none",
    pose: "frontal",
    sufficientFaceResolution: true,
    qualified: false,
    rejectionReasons: ["mascara/eyeliner and strong iris contrast make stable aperture classification ambiguous", "smile is a secondary expression confounder"],
  },
];

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function decodeSelectedSource(bytes: Uint8Array): RawImage {
  const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 16 });
  return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}

function cropForReview(image: RawImage, leftRatio: number, topRatio: number, rightRatio: number, bottomRatio: number): RawImage {
  const left = Math.max(0, Math.floor(image.width * leftRatio));
  const top = Math.max(0, Math.floor(image.height * topRatio));
  const right = Math.min(image.width, Math.ceil(image.width * rightRatio));
  const bottom = Math.min(image.height, Math.ceil(image.height * bottomRatio));
  const width = right - left;
  const height = bottom - top;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((top + row) * image.width + left) * 4;
    rgba.set(image.rgba.subarray(sourceOffset, sourceOffset + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function canvas(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([238, 240, 244, 255], offset);
  return { width, height, rgba };
}

function pasteFitted(out: RawImage, source: RawImage, x: number, width: number, height: number): void {
  const ratio = Math.min((width - 16) / source.width, (height - 16) / source.height);
  const fitted = scaleNearestNeighbor(source, Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
  const left = x + Math.floor((width - fitted.width) / 2);
  const top = Math.floor((height - fitted.height) / 2);
  for (let row = 0; row < fitted.height; row += 1) for (let column = 0; column < fitted.width; column += 1) {
    const from = (row * fitted.width + column) * 4;
    const to = ((top + row) * out.width + left + column) * 4;
    out.rgba.set(fitted.rgba.subarray(from, from + 4), to);
  }
}

async function buildAudit() {
  expect(reviews).toHaveLength(5);
  const qualified = reviews.filter((item) => item.qualified);
  expect(qualified.map((item) => item.candidateId)).toEqual(["candidate-02"]);
  const selected = qualified[0];
  const bytes = fs.readFileSync(SOURCE);
  expect(bytes.length).toBe(selected.bytes);
  expect(sha(bytes)).toBe(EXPECTED_SOURCE_SHA256);
  const decoded = decodeSelectedSource(bytes);
  expect({ width: decoded.width, height: decoded.height }).toEqual(selected.dimensions);
  const decodedRgbaSha256 = sha(decoded.rgba);

  // Display-only crops are deliberately not portraitRegion/faceBox data and are never used by production.
  const faceReviewCrop = cropForReview(decoded, 0.15, 0.20, 0.85, 0.72);
  const eyeBrowEnlargement = cropForReview(faceReviewCrop, 0.08, 0.25, 0.92, 0.62);
  const sheet = canvas(960, 400);
  pasteFitted(sheet, decoded, 0, 320, 400);
  pasteFitted(sheet, faceReviewCrop, 320, 320, 400);
  pasteFitted(sheet, eyeBrowEnlargement, 640, 320, 400);

  const payload = {
    caseId: CASE_ID,
    tier: "TIER_A_OPEN_SOURCE_CANDIDATE",
    sourceProvider: "Wikimedia Commons",
    sourceFileIdentifier: selected.sourceFileIdentifier,
    sourcePage: selected.sourcePage,
    originalImageUrl: selected.originalUrl,
    license: selected.license,
    licenseUrl: selected.licenseUrl,
    authorOrUploader: selected.authorOrUploader,
    originalFilename: selected.originalFilename,
    canonicalSourceRelativePath: "source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg",
    sourceSha256: EXPECTED_SOURCE_SHA256,
    decodedRgbaSha256,
    bytes: bytes.length,
    dimensions: { width: decoded.width, height: decoded.height },
    sourceReview: {
      bothEyesVisible: selected.bothEyesVisible,
      upperLowerEyelidsVisible: selected.upperLowerEyelidsVisible,
      bothBrowsVisible: selected.bothBrowsVisible,
      lateralFaceMargins: "FULL_FACE_MARGIN_OK",
      stableAperture: selected.aperture,
      expression: selected.expression,
      browState: selected.brows,
      blink: selected.blinkOrClosure,
      eyeContrast: selected.eyeContrast,
      glasses: selected.glasses,
      occlusion: selected.occlusion,
      pose: selected.pose,
      sufficientFaceResolution: selected.sufficientFaceResolution,
      rationale: "Both eyes show a consistently large vertical opening with clearly separated upper and lower eyelids; the aperture remains large with ordinary brows, neutral expression, no blink, no glasses, no occlusion, and full face margins.",
    },
    label: { eyeOpenness: "open" },
    labelProvenance: "manual_source_review",
    labelFrozenBeforeProvider: true,
    providerResultsConsulted: false,
    geometryResultsConsulted: false,
    renderHintsConsulted: false,
    topologyConsulted: false,
    productionLocalizationPresent: false,
  } as const;
  const payloadSha256 = sha(JSON.stringify(payload));
  const sourceSearch = {
    provider: "Wikimedia Commons",
    searchBudget: 5,
    candidateCount: reviews.length,
    exhausted: true,
    searchInputs: ["Commons file/category search", "Commons source-page license metadata", "original source bytes", "manual source-only visual review"],
    prohibitedSelectionInputs: ["primary analysis", "face geometry", "renderHints", "topology", "evaluator"],
    providerCalls: 0,
    geometryCalls: 0,
    evaluatorCalls: 0,
  };
  const selection = {
    caseId: CASE_ID,
    selectedCandidateId: selected.candidateId,
    qualifiedCandidates: qualified.map((item) => item.candidateId),
    deterministicSelectionReason: "Only candidate with frontal pose, neutral expression, no glasses/occlusion, full bilateral margins, and defensible stable_large aperture.",
    canonicalSource: "original_downloaded_bytes",
    reviewCropRole: "local_diagnostic_only",
    productionLocalizationCreated: false,
  };
  const acquisitionPlan = {
    frozenSource: CASE_ID,
    nextLiveBudget: { geminiPrimaryMax: 1, gemmaPrimaryFallbackMax: 1, retry: 0, gemmaFaceOnlyGeometryMaxAfterValidPortraitRegion: 1, otherProviders: 0 },
    executeNow: false,
    desiredHighBoundaryCondition: { existingNormal: 0.60, futureOpen: "O", condition: "O > 0.60", feasibleInterval: "(0.60, O)" },
    thresholds: { compactMax: 0.34, openMin: 0.68, lowInterval: "(0.50, 0.60)", changed: false },
    unchangedBacklogs: ["VALIDATOR_GROUP_GRANULARITY_TOO_COARSE", "PRIMARY_PROVIDER_AVAILABILITY", "TRACE_PROVENANCE_INCONSISTENCY", "bun-check invalid_response", "buzz-striped expression error"],
  };
  return { bytes, decodedRgbaSha256, faceReviewCrop, eyeBrowEnlargement, sheet, payload, payloadSha256, sourceSearch, selection, acquisitionPlan };
}

it("freezes exactly one source-only OPEN label without provider-derived selection inputs", async () => {
  const audit = await buildAudit();
  expect(audit.payload).toMatchObject({ caseId: CASE_ID, tier: "TIER_A_OPEN_SOURCE_CANDIDATE", label: { eyeOpenness: "open" },
    labelFrozenBeforeProvider: true, providerResultsConsulted: false, geometryResultsConsulted: false,
    renderHintsConsulted: false, topologyConsulted: false, productionLocalizationPresent: false });
  expect(audit.payload.sourceReview).toMatchObject({ stableAperture: "stable_large", lateralFaceMargins: "FULL_FACE_MARGIN_OK",
    expression: "neutral", browState: "ordinary", blink: "none", glasses: "none", occlusion: "none", pose: "frontal" });
  expect(audit.sourceSearch).toMatchObject({ searchBudget: 5, candidateCount: 5, providerCalls: 0, geometryCalls: 0, evaluatorCalls: 0 });
  expect(audit.payloadSha256).toHaveLength(64);
});

it.skipIf(!BUILD)("writes immutable external OPEN source artifacts", async () => {
  const audit = await buildAudit();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("source-search.json", audit.sourceSearch);
  write("candidate-review.json", { candidates: reviews, qualifiedCount: reviews.filter((item) => item.qualified).length, sourceOnly: true });
  write("selected-source.json", audit.selection);
  write("frozen-open-label.json", { payload: audit.payload, payloadSha256: audit.payloadSha256, immutable: true });
  write("acquisition-plan.json", audit.acquisitionPlan);
  write("contact-sheet-manifest.json", {
    columns: ["ORIGINAL", "FACE_REVIEW_CROP", "EYE_BROW_ENLARGEMENT"],
    faceReviewCropRatios: { left: 0.15, top: 0.20, right: 0.85, bottom: 0.72 },
    eyeBrowCropWithinFaceRatios: { left: 0.08, top: 0.25, right: 0.92, bottom: 0.62 },
    role: "local_diagnostic_only",
    canonicalSource: "original downloaded bytes",
    landmarksOrProviderLocalizationUsed: false,
  });
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(audit.sheet), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# External OPEN source freeze\n\n` +
    `- Wikimedia Commons search budget: 5/5 candidates reviewed source-only.\n` +
    `- Selected ${CASE_ID}: ${audit.payload.sourceFileIdentifier}.\n` +
    `- License: ${audit.payload.license}; source page and original file URL are preserved in the frozen payload.\n` +
    `- Original bytes: ${audit.payload.bytes}; dimensions: ${audit.payload.dimensions.width}x${audit.payload.dimensions.height}.\n` +
    `- File SHA-256: ${audit.payload.sourceSha256}; decoded RGBA SHA-256: ${audit.decodedRgbaSha256}.\n` +
    `- Source-only review: both eyes/brows and upper/lower eyelids visible, FULL_FACE_MARGIN_OK, stable_large aperture, neutral expression, ordinary brows, no blink/glasses/occlusion, frontal pose.\n` +
    `- Label eyeOpenness=open was frozen before provider use. No provider, geometry, render-hint, topology, or evaluator result was consulted.\n` +
    `- The original file is canonical. Contact-sheet crops are local diagnostics only and are not portraitRegion or production localization.\n` +
    `- No manual/synthetic production localization was created.\n` +
    `- Thresholds remain compactMax=0.34, openMin=0.68, low interval=(0.50,0.60).\n` +
    `- Next live budget: Gemini primary max1; eligible Gemma fallback max1; retry0; after valid portraitRegion, Gemma face-only geometry max1.\n` +
    `- Production runtime/source/config changes: 0. AI/provider/evaluator calls: 0.\n\nEXTERNAL_OPEN_SOURCE_FROZEN\n`, { flag: "wx" });
});

it.skipIf(!REFRESH_CONTACT)("writes the corrected display-only eye/brow contact sheet", async () => {
  const audit = await buildAudit();
  fs.writeFileSync(path.join(ROOT, "contact-sheet-manifest.json"), `${JSON.stringify({
    columns: ["ORIGINAL", "FACE_REVIEW_CROP", "EYE_BROW_ENLARGEMENT"],
    faceReviewCropRatios: { left: 0.15, top: 0.20, right: 0.85, bottom: 0.72 },
    eyeBrowCropWithinFaceRatios: { left: 0.08, top: 0.25, right: 0.92, bottom: 0.62 },
    role: "local_diagnostic_only",
    canonicalSource: "original downloaded bytes",
    landmarksOrProviderLocalizationUsed: false,
  }, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(audit.sheet), { flag: "wx" });
});

it("validates the written immutable payload and source integrity", async () => {
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, "frozen-open-label.json"), "utf8")) as {
    payload: Record<string, unknown> & { sourceSha256: string; decodedRgbaSha256: string; label: { eyeOpenness: string } };
    payloadSha256: string;
    immutable: boolean;
  };
  const bytes = fs.readFileSync(SOURCE);
  const decoded = decodeSelectedSource(bytes);
  expect(sha(bytes)).toBe(frozen.payload.sourceSha256);
  expect(sha(decoded.rgba)).toBe(frozen.payload.decodedRgbaSha256);
  expect(sha(JSON.stringify(frozen.payload))).toBe(frozen.payloadSha256);
  expect(frozen).toMatchObject({ immutable: true, payload: { label: { eyeOpenness: "open" } } });
});
