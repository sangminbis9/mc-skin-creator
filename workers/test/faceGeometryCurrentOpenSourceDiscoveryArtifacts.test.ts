import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { createIdentityCrops } from "../src/generate";
import { base64ToBytes, bytesToBase64, decodeImage, encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";

const BUILD = process.env.BUILD_FACE_GEOMETRY_CURRENT_OPEN_SOURCE_DISCOVERY === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-current-open-source-discovery-20260923-001");
const SOURCES = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const TARGETED = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001/summary.json");
const NORMAL = path.resolve("evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001/summary.json");
const CONTRACT = path.resolve("evaluation-artifacts/face-geometry-openness-contract-live-20260922-001/summary.json");

type PortraitRegion = NonNullable<PhotoAnalysis["sourceSelection"]["portraitRegion"]>;
type SelectedCase = { id: string; photoId: number; expectedSha256: string; expectedBytes: number };
type PrimaryLocalization = {
  caseId: string;
  sourceSha256: string;
  sourceBytes: number;
  ok: boolean;
  quality?: string;
  sourceGlassesOrCovering?: string;
  primaryFallbackFeaturesGlasses?: string;
  visibleRegions?: { face?: boolean };
  validation?: { compactProviderSchema?: string; compactStrictRuntime?: string; richPhotoAnalysis?: string };
  sourceSelection: { portraitRegion?: PortraitRegion | null };
};
type LocalizationSummary = {
  selectedCases: SelectedCase[];
  primaryResults?: PrimaryLocalization[];
  primary?: PrimaryLocalization;
};
type GeometryResult = {
  caseId: string;
  sourceSha256: string;
  sourceBytes: number;
  storedPortraitRegion?: PortraitRegion | null;
  freshPortraitRegion?: PortraitRegion | null;
  cropContext: AdaptiveHeadCropContext;
  crop: {
    sourceDimensions: { width: number; height: number };
    faceCropDimensions: { width: number; height: number };
    faceCropLateralGuard: { applied: boolean; reason: string; originalExpandedWidthRatio: number; guardedWidthRatio: number };
    finalFaceBox: Record<string, number>;
    margins: Record<string, number>;
    cropClipping: Record<string, boolean>;
    quality: { usableForFaceGeometry: boolean };
    clippingRisk: boolean;
  };
  faceCropSha256: string;
};
type GeometrySummary = { geometryResults: GeometryResult[] };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function makeCanvas(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([238, 240, 244, 255], offset);
  return { width, height, rgba };
}

function pasteFitted(out: RawImage, image: RawImage, x: number, y: number, width: number, height: number): void {
  const ratio = Math.min((width - 16) / image.width, (height - 16) / image.height);
  const fitted = scaleNearestNeighbor(
    image,
    Math.max(1, Math.round(image.width * ratio)),
    Math.max(1, Math.round(image.height * ratio)),
  );
  const left = x + Math.floor((width - fitted.width) / 2);
  const top = y + Math.floor((height - fitted.height) / 2);
  for (let row = 0; row < fitted.height; row += 1) {
    for (let column = 0; column < fitted.width; column += 1) {
      const sourceOffset = (row * fitted.width + column) * 4;
      const targetOffset = ((top + row) * out.width + left + column) * 4;
      out.rgba.set(fitted.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
}

function cropForDisplay(image: RawImage, leftRatio: number, topRatio: number, rightRatio: number, bottomRatio: number): RawImage {
  const left = Math.max(0, Math.floor(image.width * leftRatio));
  const top = Math.max(0, Math.floor(image.height * topRatio));
  const right = Math.min(image.width, Math.ceil(image.width * rightRatio));
  const bottom = Math.min(image.height, Math.ceil(image.height * bottomRatio));
  const width = right - left;
  const height = bottom - top;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const start = ((top + row) * image.width + left) * 4;
    rgba.set(image.rgba.subarray(start, start + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function collectLocalizations(): Array<PrimaryLocalization & { photoId: number; expectedSha256: string; expectedBytes: number }> {
  const summaries = [read<LocalizationSummary>(TARGETED), read<LocalizationSummary>(NORMAL)];
  const candidates = new Map<string, PrimaryLocalization & { photoId: number; expectedSha256: string; expectedBytes: number }>();
  for (const summary of summaries) {
    const selected = new Map(summary.selectedCases.map((item) => [item.id, item]));
    const results = [...(summary.primaryResults ?? []), ...(summary.primary ? [summary.primary] : [])];
    for (const result of results) {
      const source = selected.get(result.caseId);
      const region = result.sourceSelection?.portraitRegion;
      const validationsPass = !result.validation || Object.values(result.validation).every((value) => value === "passed");
      if (!source || !result.ok || !region || result.visibleRegions?.face === false || !validationsPass) continue;
      candidates.set(result.caseId, { ...result, ...source, photoId: source.photoId });
    }
  }
  return [...candidates.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

async function buildAudit() {
  const localizations = collectLocalizations();
  const geometry = [
    ...read<GeometrySummary>(CONTRACT).geometryResults,
    ...read<GeometrySummary>(NORMAL).geometryResults,
  ];
  const geometryByCase = new Map(geometry.map((item) => [item.caseId, item]));
  expect(localizations.map((item) => item.caseId)).toEqual([
    "striped-open-shirt",
    "warm-white-tee",
    "wavy-open-blazer",
  ]);

  const rows: Array<{ source: RawImage; face: RawImage; eyes: RawImage }> = [];
  const candidatePool: Array<Record<string, unknown>> = [];
  const cropEligibility: Array<Record<string, unknown>> = [];
  for (const localization of localizations) {
    const stored = geometryByCase.get(localization.caseId);
    expect(stored, `${localization.caseId}: current crop reference`).toBeTruthy();
    if (!stored) throw new Error(`${localization.caseId}: crop reference missing`);
    const sourcePath = path.join(SOURCES, `${localization.photoId}.jpg`);
    const sourceBytes = fs.readFileSync(sourcePath);
    expect(sha(sourceBytes)).toBe(localization.expectedSha256);
    expect(sourceBytes.length).toBe(localization.expectedBytes);
    expect(stored.sourceSha256).toBe(localization.expectedSha256);
    expect(stored.sourceBytes).toBe(localization.expectedBytes);
    expect(stored.storedPortraitRegion ?? stored.freshPortraitRegion).toEqual(localization.sourceSelection.portraitRegion);
    const source = await decodeImage(sourceBytes);
    expect({ width: source.width, height: source.height }).toEqual(stored.crop.sourceDimensions);
    const crops = await createIdentityCrops(
      `data:image/jpeg;base64,${bytesToBase64(sourceBytes)}`,
      localization.sourceSelection.portraitRegion,
      stored.cropContext,
    );
    expect(crops, `${localization.caseId}: current createIdentityCrops`).toBeTruthy();
    if (!crops) throw new Error(`${localization.caseId}: crop creation failed`);
    const faceBytes = base64ToBytes(crops.faceDataUrl.slice(crops.faceDataUrl.indexOf(",") + 1));
    const face = await decodeImage(faceBytes);
    expect(sha(faceBytes)).toBe(stored.faceCropSha256);
    expect(crops.diagnostics.faceCropDimensions).toEqual(stored.crop.faceCropDimensions);
    expect(crops.diagnostics.faceCropLateralGuard).toEqual(stored.crop.faceCropLateralGuard);
    expect(crops.diagnostics.finalFaceBox).toEqual(stored.crop.finalFaceBox);

    const glassesOrCovering = localization.sourceGlassesOrCovering
      ?? localization.primaryFallbackFeaturesGlasses
      ?? "none";
    const cropClipped = Object.values(stored.crop.cropClipping).some(Boolean);
    const automaticEligible = stored.crop.quality.usableForFaceGeometry
      && !cropClipped
      && glassesOrCovering === "none"
      && face.width >= 128
      && face.height >= 160;
    const classification = automaticEligible ? "CROP_ELIGIBLE" : "CROP_INELIGIBLE";
    candidatePool.push({
      caseId: localization.caseId,
      photoId: localization.photoId,
      sourcePathClass: "local_generalization_source",
      sourceRelativePath: `generalization-20260905/sources/${localization.photoId}.jpg`,
      sourceSha256: sha(sourceBytes),
      sourceBytes: sourceBytes.length,
      sourceDimensions: { width: source.width, height: source.height },
      portraitRegionProvenance: "production_provider_output",
      portraitRegionConfidence: localization.sourceSelection.portraitRegion!.confidence,
      storedPortraitRegion: localization.sourceSelection.portraitRegion,
      localizationValidation: "validated_production_primary",
      discoveryExcludedFields: ["faceMeasurementEvidence.eyeOpenness", "geometry.eyes.openness", "renderHints.eyeSize", "topology"],
    });
    cropEligibility.push({
      caseId: localization.caseId,
      classification,
      sourceDimensions: { width: source.width, height: source.height },
      faceCropLateralGuard: stored.crop.faceCropLateralGuard,
      finalFaceBox: stored.crop.finalFaceBox,
      cropDimensions: { width: face.width, height: face.height },
      cropSha256: sha(faceBytes),
      cropClipping: stored.crop.cropClipping,
      usableForFaceGeometry: stored.crop.quality.usableForFaceGeometry,
      glassesOrCovering,
      diagnosticClippingRisk: stored.crop.clippingRisk,
      existingMargins: stored.crop.margins,
      manualMarginReviewRequired: true,
      eyeBrowReviewRequired: true,
    });
    rows.push({ source, face, eyes: cropForDisplay(face, 0.05, 0.08, 0.95, 0.58) });
  }

  const cellWidth = 320;
  const cellHeight = 280;
  const sheet = makeCanvas(cellWidth * 3, cellHeight * rows.length);
  for (const [row, images] of rows.entries()) {
    pasteFitted(sheet, images.source, 0, row * cellHeight, cellWidth, cellHeight);
    pasteFitted(sheet, images.face, cellWidth, row * cellHeight, cellWidth, cellHeight);
    pasteFitted(sheet, images.eyes, cellWidth * 2, row * cellHeight, cellWidth, cellHeight);
  }
  const manifest = {
    rowOrder: localizations.map((item) => item.caseId),
    columnOrder: ["SOURCE", "CURRENT_PRODUCTION_FACE_CROP", "ENLARGED_EYE_BROW_REGION"],
    enlargedRegion: { leftRatio: 0.05, topRatio: 0.08, rightRatio: 0.95, bottomRatio: 0.58, purpose: "display_only" },
    providerResultTextEmbedded: false,
    providerMeasurementResultsConsulted: false,
    geometryResultsConsultedForOpenness: false,
    externalCalls: 0,
  };
  return { candidatePool, cropEligibility, manifest, sheet };
}

it("discovers only sources with validated provider localization and reproduces current guarded crops offline", async () => {
  const audit = await buildAudit();
  expect(audit.candidatePool).toHaveLength(3);
  expect(audit.cropEligibility.every((item) => item.classification === "CROP_ELIGIBLE")).toBe(true);
  expect(audit.manifest).toMatchObject({ providerResultTextEmbedded: false, providerMeasurementResultsConsulted: false, externalCalls: 0 });
});

it.skipIf(!BUILD)("writes the current-equivalent source discovery inputs without provider leakage", async () => {
  const audit = await buildAudit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("candidate-pool.json", { candidates: audit.candidatePool, discovery: audit.manifest });
  write("crop-eligibility.json", { cases: audit.cropEligibility, externalCalls: 0 });
  write("contact-sheet-manifest.json", audit.manifest);
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(audit.sheet), { flag: "wx" });
});

it("keeps the source-only decision immutable and declines to fabricate an OPEN anchor", () => {
  const review = read<{ cases: Array<{ sourceOnlyReview: { openQualified: boolean } }>; qualifiedOpenCount: number; externalCalls: number }>(
    path.join(ROOT, "source-only-review.json"),
  );
  const selection = read<{ selectedSource: unknown; classification: string }>(path.join(ROOT, "selected-source.json"));
  const frozen = read<{ status: string; label: unknown; geometryResultsConsulted: boolean; providerMeasurementResultsConsulted: boolean }>(
    path.join(ROOT, "frozen-open-label.json"),
  );
  const plan = read<{ nextExactBoundary: string; executeNow: boolean; thresholds: { changed: boolean }; externalCalls: number }>(
    path.join(ROOT, "acquisition-plan.json"),
  );
  expect(review.cases.every((item) => item.sourceOnlyReview.openQualified === false)).toBe(true);
  expect(review).toMatchObject({ qualifiedOpenCount: 0, externalCalls: 0 });
  expect(selection).toMatchObject({ selectedSource: null, classification: "OPEN_CURRENT_SOURCE_NOT_FOUND" });
  expect(frozen).toMatchObject({ status: "not_frozen", label: null, geometryResultsConsulted: false, providerMeasurementResultsConsulted: false });
  expect(plan).toMatchObject({ nextExactBoundary: "new external source acquisition before provider execution", executeNow: false, thresholds: { changed: false }, externalCalls: 0 });
});
