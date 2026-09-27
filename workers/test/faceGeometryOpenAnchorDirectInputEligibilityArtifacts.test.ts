import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA, faceIdentityGeometryRequest } from "../src/faceIdentityGeometry";
import { createIdentityCrops } from "../src/generate";
import { base64ToBytes, bytesToBase64, decodeImage, decodePng, encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPEN_ANCHOR_DIRECT_INPUT_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-open-anchor-direct-input-eligibility-20260922-001");
const SOURCE = path.resolve("evaluation-artifacts/facial-feature-renderer-20260904/headscarf-color-blocks/01-source.png");
const FREEZE = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001/frozen-open-label.json");
const LINEAGE = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001/source-lineage.json");
const VISUAL = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001/visual-review.json");
const METRICS = path.resolve("evaluation-artifacts/head-structure-iteration-final/headscarf-color-blocks/metrics.json");
const STRIPED_SUMMARY = path.resolve("evaluation-artifacts/face-geometry-openness-contract-live-20260922-001/summary.json");
const WAVY_SUMMARY = path.resolve("evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001/summary.json");
const GENERALIZATION_SOURCES = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const PREVIOUS_RUNS = [
  path.resolve("evaluation-artifacts/face-geometry-openness-open-anchor-live-20260922-001/summary.json"),
  path.resolve("evaluation-artifacts/face-geometry-openness-open-anchor-live-20260922-002/summary.json"),
] as const;

const EXPECTED = {
  sourceFile: "eaa53f58cd9c85b1e5507c8aa3df4152ed730501c74af1d337ec83f6e49e9938",
  sourceRgba: "66a63da69067d1d50eb1a40354ad585900cd64161c5c1c5d82efbfb13ae00e92",
  sourceBytes: 197_802,
  sourceDimensions: { width: 270, height: 308 },
  frozenPayload: "5bcb431e3d7a39a0e786aa5b20426ccc3d0989fc60ab1618b153188f90be5d7b",
  prompt: "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd",
  schema: "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469",
  stripedCrop: "e954ede4ebe00deafa25f090d3ed374d56897832cb0a85d403a5a5f9ef59270f",
  wavyCrop: "7b20f61a5e64d140cbf660cc08ba3e332de47597be898078fd800d1ab809fe85",
} as const;

type GeometryResult = {
  caseId: string;
  sourceSha256: string;
  storedPortraitRegion?: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  freshPortraitRegion?: PhotoAnalysis["sourceSelection"]["portraitRegion"];
  cropContext: AdaptiveHeadCropContext;
  crop: { faceCropDimensions: { width: number; height: number } };
  faceCropSha256: string;
};
type GeometrySummary = { geometryResults: GeometryResult[] };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer | Uint8Array | object) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : JSON.stringify(value),
).digest("hex");

function fill(image: RawImage, color: [number, number, number, number]) {
  for (let offset = 0; offset < image.rgba.length; offset += 4) image.rgba.set(color, offset);
}

function pasteFitted(canvas: RawImage, source: RawImage | null, column: number, cell = 256) {
  const left = column * cell;
  if (!source) {
    for (let p = 28; p < cell - 28; p += 1) {
      canvas.rgba.set([150, 67, 67, 255], ((p * canvas.width) + left + p) * 4);
      canvas.rgba.set([150, 67, 67, 255], ((p * canvas.width) + left + cell - 1 - p) * 4);
    }
    return;
  }
  const scale = Math.min((cell - 16) / source.width, (cell - 16) / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const fitted = scaleNearestNeighbor(source, width, height);
  const x0 = left + Math.floor((cell - width) / 2);
  const y0 = Math.floor((cell - height) / 2);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const from = (y * width + x) * 4;
    const to = ((y0 + y) * canvas.width + x0 + x) * 4;
    canvas.rgba.set(fitted.rgba.subarray(from, from + 4), to);
  }
}

async function reproduceReference(
  summaryFile: string,
  caseId: string,
  sourceName: string,
  expectedCrop: string,
) {
  const summary = read<GeometrySummary>(summaryFile);
  const result = summary.geometryResults.find(item => item.caseId === caseId);
  expect(result, `${caseId}: stored geometry result`).toBeTruthy();
  if (!result) throw new Error(`${caseId}: result missing`);
  const source = fs.readFileSync(path.join(GENERALIZATION_SOURCES, sourceName));
  expect(sha(source)).toBe(result.sourceSha256);
  const region = result.storedPortraitRegion ?? result.freshPortraitRegion;
  const crops = await createIdentityCrops(`data:image/jpeg;base64,${bytesToBase64(source)}`, region, result.cropContext);
  expect(crops, `${caseId}: reproduced crop`).toBeTruthy();
  if (!crops) throw new Error(`${caseId}: crop missing`);
  const bytes = base64ToBytes(crops.faceDataUrl.slice(crops.faceDataUrl.indexOf(",") + 1));
  expect(sha(bytes)).toBe(expectedCrop);
  expect(crops.diagnostics.faceCropDimensions).toEqual(result.crop.faceCropDimensions);
  return { result, crops, image: await decodeImage(bytes), encodedBytes: bytes.length };
}

async function buildAudit() {
  expect(sha(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(EXPECTED.prompt);
  expect(sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(EXPECTED.schema);
  const request = faceIdentityGeometryRequest("data:image/png;base64,AQID");
  expect(request.imageDataUrls).toEqual(["data:image/png;base64,AQID"]);
  expect(request.prompt).toBe(FACE_IDENTITY_GEOMETRY_PROMPT);

  const sourceBytes = fs.readFileSync(SOURCE);
  const direct = await decodePng(sourceBytes);
  expect(sha(sourceBytes)).toBe(EXPECTED.sourceFile);
  expect(sha(direct.rgba)).toBe(EXPECTED.sourceRgba);
  expect(sourceBytes.length).toBe(EXPECTED.sourceBytes);
  expect({ width: direct.width, height: direct.height }).toEqual(EXPECTED.sourceDimensions);

  const freeze = read<{ payload: Record<string, unknown>; payloadSha256: string }>(FREEZE);
  const lineage = read<Record<string, unknown> & { classification: string; reviewedArtifact: Record<string, unknown> }>(LINEAGE);
  const visual = read<Record<string, unknown>>(VISUAL);
  const metrics = read<{ originalInputDimensions: { width: number; height: number }; cropComparison: { after: Record<string, unknown> & {
    cropMode: string; faceCropDimensions: { width: number; height: number }; clippingRisk: boolean } } }>(METRICS);
  expect(sha(freeze.payload)).toBe(EXPECTED.frozenPayload);
  expect(freeze.payloadSha256).toBe(EXPECTED.frozenPayload);
  expect(freeze.payload).toMatchObject({ canonicalSourceLabel: { eyeOpenness: "open" },
    labelProvenance: "manual_source_review", labelFrozenBeforeProvider: true,
    providerResultsConsulted: false, geometryResultsConsulted: false });
  expect(lineage).toMatchObject({ classification: "VERIFIED_DERIVED_ARTIFACT",
    reviewedArtifact: { fileSha256: EXPECTED.sourceFile, decodedRgbaSha256: EXPECTED.sourceRgba } });
  expect(metrics).toMatchObject({ originalInputDimensions: { width: 960, height: 720 },
    cropComparison: { after: { cropMode: "subject_aware", faceCropDimensions: EXPECTED.sourceDimensions, clippingRisk: false } } });

  const directDataUrl = `data:image/png;base64,${bytesToBase64(sourceBytes)}`;
  const fallback = await createIdentityCrops(directDataUrl, null, {});
  expect(fallback).toBeNull();

  const striped = await reproduceReference(STRIPED_SUMMARY, "striped-open-shirt", "2881786.jpg", EXPECTED.stripedCrop);
  const wavy = await reproduceReference(WAVY_SUMMARY, "wavy-open-blazer", "19908659.jpg", EXPECTED.wavyCrop);
  expect(striped.crops.diagnostics.faceCropDimensions).toEqual({ width: 150, height: 288 });
  expect(wavy.crops.diagnostics.faceCropDimensions).toEqual({ width: 352, height: 384 });

  const previousRuns = PREVIOUS_RUNS.map(file => read<Record<string, unknown> & {
    primaryResults: Array<{ providerSequence: Array<Record<string, unknown>> }>;
    calls: Record<string, number>;
  }>(file));
  for (const run of previousRuns) {
    expect(run.calls).toMatchObject({ primaryPosts: 1, geometryPosts: 0 });
    expect(run.primaryResults[0].providerSequence).toMatchObject([
      { provider: "gemini", outcome: "started" },
      { provider: "gemini", outcome: "failed", httpStatus: 503, providerStatus: "UNAVAILABLE" },
      { provider: "workers_ai", outcome: "started" },
      { provider: "workers_ai", outcome: "failed", httpStatus: 504, providerStatus: "DEADLINE_EXCEEDED" },
    ]);
  }

  const dimensions = {
    direct: { width: direct.width, height: direct.height, aspect: direct.width / direct.height },
    striped: { ...striped.crops.diagnostics.faceCropDimensions,
      aspect: striped.crops.diagnostics.faceCropDimensions.width / striped.crops.diagnostics.faceCropDimensions.height },
    wavy: { ...wavy.crops.diagnostics.faceCropDimensions,
      aspect: wavy.crops.diagnostics.faceCropDimensions.width / wavy.crops.diagnostics.faceCropDimensions.height },
  };
  expect(dimensions.direct.width).toBeGreaterThan(dimensions.striped.width);
  expect(dimensions.direct.width).toBeLessThan(dimensions.wavy.width);
  expect(dimensions.direct.height).toBeGreaterThan(dimensions.striped.height);
  expect(dimensions.direct.height).toBeLessThan(dimensions.wavy.height);

  const sheet: RawImage = { width: 256 * 4, height: 256, rgba: new Uint8Array(256 * 4 * 256 * 4) };
  fill(sheet, [238, 240, 244, 255]);
  pasteFitted(sheet, direct, 0);
  pasteFitted(sheet, null, 1);
  pasteFitted(sheet, striped.image, 2);
  pasteFitted(sheet, wavy.image, 3);

  const geometryInputContract = {
    semanticInput: "exactly one tight face crop",
    runtimeEntry: "faceIdentityGeometryRequest(faceCrop)",
    imageCount: request.imageDataUrls.length,
    requiresPhotoAnalysis: false,
    requiresPortraitRegion: false,
    productionOrchestration: "primary -> portraitRegion -> createIdentityCrops -> faceIdentityGeometryRequest",
    conclusion: "primary localization is an orchestration crop-production dependency, not a semantic geometry-input requirement",
    promptSha256: EXPECTED.prompt,
    schemaSha256: EXPECTED.schema,
  };
  const directReview = {
    contractClassification: "DIRECT_CROP_CONTRACT_PARTIAL",
    sourceClass: "frozen_reviewed_derived_artifact",
    lineage: lineage.classification,
    historicalProductionDerivation: "fetchCommonsPhoto -> createIdentityCrops -> faceCropDataUrl decode -> writeIdentityEvaluationArtifacts",
    historicalCropMode: metrics.cropComparison.after.cropMode,
    currentProductionEquivalent: false,
    exactIntegrity: { fileSha256: EXPECTED.sourceFile, decodedRgbaSha256: EXPECTED.sourceRgba,
      bytes: EXPECTED.sourceBytes, dimensions: EXPECTED.sourceDimensions },
    visibleContract: {
      faceDominant: true, bothEyesFullyIncluded: true, upperLowerEyelidsReadable: true,
      foreheadUsable: true, chinUsable: true, lateralEnvelopeUsable: false,
      noseMouthIncluded: true, eyelidOcclusionByHeadscarf: false,
      criticalClippingForEyeOpenness: false,
      viewerRightFaceEnvelopeTouchesSourceEdge: true,
      excessiveShoulderOrBackground: false,
    },
    sourceReview: visual,
    historicalClippingRisk: metrics.cropComparison.after.clippingRisk,
  };
  const fallbackReview = {
    requested: { portraitRegion: null, context: {} },
    result: null,
    classification: "CURRENT_CENTER_FALLBACK_UNAVAILABLE_FOR_THIS_INPUT",
    codePath: { tallPortrait: direct.height > direct.width * 1.15,
      maxDimension: Math.max(direct.width, direct.height), minimumNonTallDimension: 320,
      rejectedBy: "!tallPortrait && maxDimension < 320" },
    cropGenerated: false,
    resamplingApplied: false,
    providerCalls: 0,
  };
  const cropComparison = {
    displayOrder: ["A_direct_frozen_reviewed", "B_current_center_fallback_unavailable", "striped_current_crop", "wavy_current_crop"],
    sameDisplayCell: { width: 256, height: 256, fit: "aspect_preserving_letterbox" },
    dimensions,
    hashes: { directFile: EXPECTED.sourceFile, directPixels: EXPECTED.sourceRgba,
      fallback: null, striped: EXPECTED.stripedCrop, wavy: EXPECTED.wavyCrop },
    directAdditionalResampling: false,
    fallbackAdditionalResampling: null,
    doubleCropRisk: "avoided_by_selecting_direct_artifact",
    quantitativeEyeScaleComparison: "not fabricated; no landmark coordinates were created in this offline audit",
    calibrationFramingComparable: false,
    calibrationFramingDifference: "direct artifact is off-center and lacks a clean viewer-right lateral face boundary; striped/wavy current crops retain bilateral facial margins",
  };
  const comparability = {
    selectedInput: "A_exact_frozen_reviewed_artifact",
    eligibility: "DIRECT_GEOMETRY_TIER_B_ONLY",
    futureTierNameBeforeScore: "TIER_B_OPEN_DIRECTIONAL_INPUT",
    rationale: [
      "the geometry contract consumes one tight face crop and does not semantically require PhotoAnalysis or portraitRegion",
      "the exact artifact was produced by historical createIdentityCrops, not manual coordinates",
      "frozen review confirms both eyes and eyelid boundaries are fully visible without relevant occlusion",
      "historical crop diagnostics recorded subject_aware and clippingRisk=false for that historical pipeline",
      "270x308 resolution lies between the current striped 150x288 and wavy 352x384 anchor crops",
      "the prompt defines openness independently from eye width, spacing, iris size, brow position, and expression",
    ],
    limitations: [
      "historical original bytes are unavailable, so the crop cannot be replayed through the current 0.65 guard",
      "the source is historical_production_derived, not current_production_equivalent",
      "the viewer-right lateral face envelope reaches the source edge while current Tier A crops retain bilateral margins",
      "crop provenance must remain attached to the future score",
    ],
    whyNotTierA: "eye aperture is readable, but the missing viewer-right lateral boundary and historical-vs-current crop-generation mismatch are material calibration confounders for a schema that also measures the facial envelope",
    calibrationOnly: true,
    productionRuntimeFallbackCreated: false,
    futurePrimaryRequiredForDirectionalGeometry: false,
    futurePrimaryRequiredForTierAHighBoundary: true,
    productionPrimaryDependencyUnchanged: true,
    futureMinimumProviderBudget: { primary: 0, geometryGemma: 1, retry: 0, otherProviders: 0 },
    thresholds: { compactMax: 0.34, openMin: 0.68, lowFeasibleInterval: "(0.50, 0.60)", changed: false },
  };
  const backlog = {
    id: "PRIMARY_PROVIDER_AVAILABILITY",
    remainsOpen: true,
    runs: [".001", ".002"].map((id, index) => ({ id,
      sequence: previousRuns[index].primaryResults[0].providerSequence.map(step => ({
        provider: step.provider, outcome: step.outcome, httpStatus: step.httpStatus ?? null,
        providerStatus: step.providerStatus ?? null,
      })), geometryPosts: previousRuns[index].calls.geometryPosts })),
    immediateThirdPrimaryRetryRecommended: false,
    productionTransportChanged: false,
  };
  return { geometryInputContract, directReview, fallbackReview, cropComparison, comparability, backlog, sheet };
}

it("separates geometry semantic input from primary orchestration and evaluates the frozen direct crop", async () => {
  const audit = await buildAudit();
  expect(audit.geometryInputContract).toMatchObject({ imageCount: 1, requiresPhotoAnalysis: false, requiresPortraitRegion: false });
  expect(audit.directReview.contractClassification).toBe("DIRECT_CROP_CONTRACT_PARTIAL");
  expect(audit.fallbackReview.cropGenerated).toBe(false);
  expect(audit.comparability.eligibility).toBe("DIRECT_GEOMETRY_TIER_B_ONLY");
  expect(audit.comparability.futureMinimumProviderBudget).toEqual({ primary: 0, geometryGemma: 1, retry: 0, otherProviders: 0 });
});

it("validates the written directional-only eligibility artifact", () => {
  const direct = read<{ contractClassification: string; visibleContract: { lateralEnvelopeUsable: boolean } }>(path.join(ROOT, "frozen-artifact-review.json"));
  const comparison = read<{ calibrationFramingComparable: boolean }>(path.join(ROOT, "crop-comparison.json"));
  const eligibility = read<{ eligibility: string; futurePrimaryRequiredForDirectionalGeometry: boolean;
    futurePrimaryRequiredForTierAHighBoundary: boolean }>(path.join(ROOT, "calibration-comparability.json"));
  expect(direct).toMatchObject({ contractClassification: "DIRECT_CROP_CONTRACT_PARTIAL",
    visibleContract: { lateralEnvelopeUsable: false } });
  expect(comparison.calibrationFramingComparable).toBe(false);
  expect(eligibility).toMatchObject({ eligibility: "DIRECT_GEOMETRY_TIER_B_ONLY",
    futurePrimaryRequiredForDirectionalGeometry: false, futurePrimaryRequiredForTierAHighBoundary: true });
});

it.skipIf(!BUILD)("writes the offline direct-input eligibility artifact set", async () => {
  const audit = await buildAudit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("geometry-input-contract.json", audit.geometryInputContract);
  write("frozen-artifact-review.json", audit.directReview);
  write("fallback-crop.json", audit.fallbackReview);
  write("crop-comparison.json", audit.cropComparison);
  write("calibration-comparability.json", audit.comparability);
  write("provider-availability-backlog.json", audit.backlog);
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(audit.sheet), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Direct OPEN geometry input eligibility\n\n` +
    `- Geometry semantic input: exactly one tight face crop; PhotoAnalysis and portraitRegion are orchestration dependencies only.\n` +
    `- Candidate A is the exact frozen 270x308 historical createIdentityCrops artifact; file/pixel hashes and frozen open label passed.\n` +
    `- Candidate B is unavailable: current center fallback returns null for this non-tall sub-320 input. No new heuristic or region was added.\n` +
    `- Candidate A retains both eyes and eyelid borders, forehead, chin, nose and mouth, but its viewer-right lateral facial envelope reaches the source edge.\n` +
    `- Current references span 150x288 (striped) to 352x384 (wavy); the direct crop is 270x308 and adds no resampling.\n` +
    `- Selected directional input: A. Eligibility: DIRECT_GEOMETRY_TIER_B_ONLY / TIER_B_OPEN_DIRECTIONAL_INPUT before any provider score.\n` +
    `- The direct crop may test open > normal direction, but it cannot fit the numeric high threshold because its off-center historical framing is not current-crop equivalent.\n` +
    `- This is calibration-only. Production primary orchestration and fallback behavior remain unchanged.\n` +
    `- Future directional budget: primary 0, Gemma face-only geometry 1, retry 0. A Tier A high-boundary anchor still requires fresh localization or a new current-equivalent open source.\n` +
    `- PRIMARY_PROVIDER_AVAILABILITY remains open from two 503 -> 504 runs; no immediate third primary retry is recommended.\n` +
    `- Thresholds remain compactMax=0.34, openMin=0.68, low interval=(0.50,0.60).\n` +
    `- External/provider calls in this audit: 0.\n\nDIRECT_OPEN_GEOMETRY_DIRECTIONAL_ONLY\n`, { flag: "wx" });
});
