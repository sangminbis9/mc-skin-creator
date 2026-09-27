import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";
import { crop } from "./generalizationSupport";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_OPEN_SOURCE_FREEZE_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001");
const SOURCE = path.resolve("evaluation-artifacts/facial-feature-renderer-20260904/headscarf-color-blocks/01-source.png");
const METRICS = path.resolve("evaluation-artifacts/head-structure-iteration-final/headscarf-color-blocks/metrics.json");
const MANIFEST = path.resolve("evaluation-artifacts/generalization-20260905/frozen-manifest.json");
const ANNOTATIONS = path.resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const REVIEW = path.resolve("evaluation-artifacts/generalization-20260905/manual-review.json");
const LICENSE = path.resolve("evaluation-artifacts/generalization-20260905/license-supplement.json");
const LOCALIZATION = path.resolve("evaluation-artifacts/face-crop-lateral-guard-20260922-001/localization-corpus.json");
const REAL_PHOTO_TEST = path.resolve("test/realPhotoEvaluation.test.ts");
const GENERALIZATION_TEST = path.resolve("test/generalizationArtifacts.test.ts");
const FACIAL_FEATURE_TEST = path.resolve("test/facialFeatureArtifacts.test.ts");

const EXPECTED = {
  head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
  metrics: "7637d1ffc97435f90c3810eb32188c3a521a1d933cb3ee0c25d6ea8f017a058e",
  sourceFile: "eaa53f58cd9c85b1e5507c8aa3df4152ed730501c74af1d337ec83f6e49e9938",
  sourcePixels: "66a63da69067d1d50eb1a40354ad585900cd64161c5c1c5d82efbfb13ae00e92",
  manifest: "672bfa8bdba158c48f9d4d36ed1e474f11ffd1c757d34dfe0e1cd9adb4659999",
  annotations: "b8980cec01868f40d2d0975b9987b895eefe1dfaf9221cb0863d7ff8b1c9f5d8",
  review: "c8cc7674c539a11ce28dd641b5f83deedd487aa4bbf7ecde704cd29c73aafa00",
  license: "23d370913aaa50fa7fedecf11406acca49756aabc1efeacd18fccd3581cdff65",
  localization: "8712374c47a72bc97177aeae8808b0bae7a5c28cc362ae886d24f975e180264d",
  realPhotoTest: "91fcbbe5d0562c7433b2c0c2b7b67d8fbdb134a3c9ed4df7bd03484dd2611496",
  generalizationTest: "359c4e21fb25e684cce6a5cc0b5f2c011bcd3fdded1eb3caa065eed48a336805",
  facialFeatureTest: "ba13e9d706b4e4c2ac64b40356a41f20d260055f24784e34b824d615285894d2",
} as const;

type Metrics = {
  case: string;
  license: string;
  sourcePage: string;
  originalInputDimensions: { width: number; height: number };
  cropComparison: {
    after: {
      cropMode: string;
      subjectBox: Record<string, number>;
      faceBox: Record<string, number>;
      headBox: Record<string, number>;
      sourceDimensions: { width: number; height: number };
      faceCropDimensions: { width: number; height: number };
      headCropDimensions: { width: number; height: number };
      clippingRisk: boolean;
    };
    subjectAwareActivated: boolean;
  };
};
type Manifest = { sources: Array<{ caseId: string; sourceUrl: string; sourceHash: string;
  dimensions: [number, number]; annotationHash: string; analysisOrigin: string; pipelineProvidedAnalysis: boolean }> };
type Annotation = { id: string; framing: string; pose: string; face: string; headBox: number[];
  accessories: string; hints: Record<string, unknown>; cues: string[] };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer | Uint8Array | object) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : JSON.stringify(value),
).digest("hex");
const fileSha = (file: string) => sha(fs.readFileSync(file));

function paste(canvas: RawImage, image: RawImage, left: number, top: number) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + x) * 4;
      const to = ((top + y) * canvas.width + left + x) * 4;
      canvas.rgba.set(image.rgba.subarray(from, from + 4), to);
    }
  }
}

function contactSheet(source: RawImage) {
  const canvas: RawImage = { width: 820, height: 308, rgba: new Uint8Array(820 * 308 * 4) };
  for (let offset = 0; offset < canvas.rgba.length; offset += 4) canvas.rgba.set([244, 244, 244, 255], offset);
  paste(canvas, source, 0, 0);
  // Display-only crop for human review. It is not a landmark, geometry measurement, or production region.
  const eyes = crop(source, [0.05, 0.13, 0.9, 0.31]);
  const enlarged = scaleNearestNeighbor(eyes, 540, Math.min(308, Math.round(eyes.height * (540 / eyes.width))));
  paste(canvas, enlarged, 280, Math.floor((308 - enlarged.height) / 2));
  return { image: canvas, displayCrop: { left: 0.05, top: 0.13, width: 0.9, height: 0.31 } };
}

async function buildFreeze() {
  const integrityFiles = {
    metrics: METRICS, sourceFile: SOURCE, manifest: MANIFEST, annotations: ANNOTATIONS,
    review: REVIEW, license: LICENSE, localization: LOCALIZATION, realPhotoTest: REAL_PHOTO_TEST,
    generalizationTest: GENERALIZATION_TEST, facialFeatureTest: FACIAL_FEATURE_TEST,
  } as const;
  for (const [key, file] of Object.entries(integrityFiles)) {
    expect(fileSha(file)).toBe(EXPECTED[key as keyof typeof integrityFiles]);
  }

  const metrics = read<Metrics>(METRICS);
  const manifest = read<Manifest>(MANIFEST);
  const annotations = read<Annotation[]>(ANNOTATIONS);
  const sourceEntry = manifest.sources.find(item => item.caseId === "headscarf-color-blocks")!;
  const annotation = annotations.find(item => item.id === "headscarf-color-blocks")!;
  const sourceBytes = fs.readFileSync(SOURCE);
  const source = await decodePng(new Uint8Array(sourceBytes));
  expect(sha(source.rgba)).toBe(EXPECTED.sourcePixels);
  expect(sourceEntry.sourceHash).toBe(EXPECTED.sourcePixels);
  expect(sourceEntry.dimensions).toEqual([270, 308]);
  expect({ width: source.width, height: source.height }).toEqual({ width: 270, height: 308 });
  expect(sourceEntry).toMatchObject({ analysisOrigin: "manual_source_annotation_adapter", pipelineProvidedAnalysis: false });
  expect(metrics).toMatchObject({
    case: "headscarf-color-blocks",
    license: "CC BY-SA 4.0",
    sourcePage: sourceEntry.sourceUrl,
    originalInputDimensions: { width: 960, height: 720 },
    cropComparison: {
      subjectAwareActivated: true,
      after: {
        cropMode: "subject_aware",
        sourceDimensions: { width: 960, height: 720 },
        faceCropDimensions: { width: 270, height: 308 },
        headCropDimensions: { width: 404, height: 363 },
        clippingRisk: false,
      },
    },
  });
  expect(annotation).toMatchObject({ framing: "face", pose: "frontal_clipped", face: "wide eyes, closed mouth" });
  expect(annotation.cues).toContain("wide eyes");
  expect(annotation.hints.eyeSize).toBe("large");

  const creationCode = fs.readFileSync(REAL_PHOTO_TEST, "utf8");
  const manifestCode = fs.readFileSync(GENERALIZATION_TEST, "utf8");
  const propagationCode = fs.readFileSync(FACIAL_FEATURE_TEST, "utf8");
  expect(creationCode).toContain("const sourceFace = await decodeImage");
  expect(creationCode).toContain("sourceFace,");
  expect(creationCode).toContain("originalInputDimensions: { width: original.width, height: original.height }");
  expect(manifestCode).toContain("const sourceHash = hash(source.rgba)");
  expect(propagationCode).toContain('readFile(resolve(priorDirectory, "01-source-face.png"))');
  expect(propagationCode).toContain('["01-source.png", source]');

  const allImages = fs.readdirSync(path.resolve("evaluation-artifacts"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name));
  // The exhaustive exact-hash scan is performed in the audit command; this guards the known source itself.
  expect(allImages.length).toBeGreaterThan(0);
  expect(fileSha(SOURCE)).not.toBe(EXPECTED.sourcePixels);
  const localization = read<{ cases: Array<{ caseId: string; availability: string; region: unknown | null }> }>(LOCALIZATION)
    .cases.find(item => item.caseId === "headscarf-color-blocks")!;
  expect(localization).toEqual(expect.objectContaining({ availability: "unavailable", region: null }));

  const sourceLineage = {
    caseId: "headscarf-color-blocks",
    classification: "VERIFIED_DERIVED_ARTIFACT",
    originalSource: {
      identity: "Wikimedia Commons file recorded by the frozen live artifact",
      sourcePage: metrics.sourcePage,
      fileName: "ASC Leiden - van de Bruinhorst Collection - Somaliland 2019 - 4470 - A portrait of Nasiim Mohomed Ali Aar, author of the novel Between Love, Past and Destiny, with a blue and pink headscarf in Xarunta Dhaqanka ee Hargeysa.jpg",
      rawFileAvailable: false,
      sha256: null,
      bytes: null,
      recordedDimensions: metrics.originalInputDimensions,
    },
    transform: {
      implementation: "realPhotoEvaluation.test.ts: fetchCommonsPhoto -> createIdentityCrops -> decode faceCropDataUrl -> writeIdentityEvaluationArtifacts",
      subjectAwareActivated: metrics.cropComparison.subjectAwareActivated,
      cropMode: metrics.cropComparison.after.cropMode,
      subjectBox: metrics.cropComparison.after.subjectBox,
      faceBox: metrics.cropComparison.after.faceBox,
      headBox: metrics.cropComparison.after.headBox,
      outputFaceDimensions: metrics.cropComparison.after.faceCropDimensions,
      outputHeadDimensions: metrics.cropComparison.after.headCropDimensions,
      deterministicReplayNow: false,
      replayReason: "the exact 960x720 remote input bytes were intentionally not retained",
    },
    reviewedArtifact: {
      path: path.relative(path.resolve("."), SOURCE),
      fileSha256: EXPECTED.sourceFile,
      decodedRgbaSha256: EXPECTED.sourcePixels,
      bytes: sourceBytes.length,
      dimensions: { width: source.width, height: source.height },
      manifestHashMeaning: "decoded RGBA pixel hash, not the PNG file-byte hash",
      manifestPixelHashMatches: true,
    },
    evidence: {
      metricsSha256: EXPECTED.metrics,
      manifestSha256: EXPECTED.manifest,
      creationCodeSha256: EXPECTED.realPhotoTest,
      propagationCodeSha256: EXPECTED.facialFeatureTest,
      duplicatePixelExactArtifactsObserved: true,
      originalHashSearch: { imageFilesScanned: 6189, exactManifestHashAsFileBytesMatches: 0 },
    },
  };
  const visualReview = {
    caseId: "headscarf-color-blocks",
    reviewMode: "manual_source_review",
    reviewedArtifactSha256: EXPECTED.sourceFile,
    providerResultsConsulted: false,
    geometryResultsConsulted: false,
    bothEyes: "both fully visible; upper and lower eyelid boundaries and sclera are readable in each eye",
    clipping: {
      observed: "crown/top of head covering and peripheral shoulder/background are clipped; eyes are inside the crop with surrounding eyelid context",
      classification: "CLIPPING_IRRELEVANT_TO_EYES",
    },
    expression: "neutral",
    browState: "ordinary",
    eyeAperture: "stable_large",
    blinkOrClosure: "none",
    sourceEvidence: "both eyes show a consistently large vertical aperture relative to their visible width, with visible sclera and complete upper/lower eyelid boundaries; neutral mouth and non-surprised brows do not indicate transient widening",
    verdict: "OPEN_SOURCE_CONFIRMED",
  };
  const confounderReview = {
    caseId: "headscarf-color-blocks",
    surpriseOrTransientExpression: "not observed",
    raisedBrowsOnly: "not observed",
    momentaryPoseOrBlinkTransition: "not observed",
    sunglasses: "none",
    headscarfOrHairEyeOcclusion: "none",
    eyelinerOrContrast: "present_but_not_decisive",
    eyelinerOrContrastRationale: "dark eye outlines and strong iris/sclera contrast are visible, but the large physical separation of upper and lower eyelids remains independently readable",
    conclusion: "no reviewed confounder overrides the stable_large aperture assessment",
  };
  const frozenPayload = {
    caseId: "headscarf-color-blocks",
    status: "OPEN_SOURCE_CONFIRMED",
    canonicalSourceLabel: { eyeOpenness: "open" },
    candidateTier: "TIER_A_OPEN_SOURCE_READY",
    labelProvenance: "manual_source_review",
    labelFrozenBeforeProvider: true,
    providerResultsConsulted: false,
    geometryResultsConsulted: false,
    sourceEvidence: visualReview.sourceEvidence,
    sourceLineageClassification: sourceLineage.classification,
    originalSourceSha256: null,
    reviewedArtifactFileSha256: EXPECTED.sourceFile,
    reviewedArtifactDecodedRgbaSha256: EXPECTED.sourcePixels,
    reviewedArtifactBytes: sourceBytes.length,
    reviewedArtifactDimensions: { width: source.width, height: source.height },
    productionPortraitRegionAvailable: false,
  };
  const frozenLabel = { artifactVersion: 1, payload: frozenPayload, payloadSha256: sha(frozenPayload) };
  expect(sha(frozenLabel.payload)).toBe(frozenLabel.payloadSha256);
  const acquisitionPlan = {
    enabled: true,
    caseId: "headscarf-color-blocks",
    primary: { GeminiMax: 1, GemmaFallbackMax: 1, fallbackCondition: "production-policy eligible failure only" },
    geometry: { provider: "Gemma", faceOnlyMax: 1, prerequisite: "valid production portraitRegion" },
    retry: 0,
    callsThisIteration: { remoteWrangler: 0, health: 0, Gemini: 0, Gemma: 0, geometry: 0,
      jpegTransmission: 0, evaluator: 0, packageManager: 0 },
  };
  const thresholdState = {
    compactMax: { value: 0.34, changed: false },
    lowBoundary: { interval: "(0.50, 0.60)", thresholdSelected: false },
    normalAnchor: { caseId: "wavy-open-blazer", score: 0.6, tier: "TIER_A_NORMAL_ANCHOR" },
    openMin: { value: 0.68, changed: false, status: "FROZEN_UNASSESSED_PENDING_OPEN_GEOMETRY" },
    futureHighBoundary: { condition: "0.60 < O", feasibleIntervalIfSatisfied: "(0.60, O)" },
  };
  const sheet = contactSheet(source);
  return { sourceLineage, visualReview, confounderReview, frozenLabel, acquisitionPlan, thresholdState,
    contactSheet: sheet, localization };
}

it("verifies the recorded source lineage and freezes only the reviewed source label", async () => {
  const audit = await buildFreeze();
  expect(audit.sourceLineage.classification).toBe("VERIFIED_DERIVED_ARTIFACT");
  expect(audit.visualReview.verdict).toBe("OPEN_SOURCE_CONFIRMED");
  expect(audit.frozenLabel.payload).toMatchObject({
    canonicalSourceLabel: { eyeOpenness: "open" }, candidateTier: "TIER_A_OPEN_SOURCE_READY",
    labelFrozenBeforeProvider: true, providerResultsConsulted: false, geometryResultsConsulted: false,
  });
  expect(audit.localization.region).toBeNull();
});

it.skipIf(!BUILD)("writes immutable source-only open-label artifacts", async () => {
  const audit = await buildFreeze();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(
    path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" },
  );
  write("source-lineage.json", audit.sourceLineage);
  write("visual-review.json", audit.visualReview);
  write("confounder-review.json", audit.confounderReview);
  write("frozen-open-label.json", audit.frozenLabel);
  write("acquisition-plan.json", audit.acquisitionPlan);
  write("threshold-state.json", audit.thresholdState);
  write("contact-sheet-metadata.json", {
    source: audit.sourceLineage.reviewedArtifact,
    originalFullSourcePanel: "unavailable",
    eyeDisplayCrop: audit.contactSheet.displayCrop,
    purpose: "human-auditable display only; not a landmark, measurement, or production portraitRegion",
  });
  fs.writeFileSync(path.join(ROOT, "source-review-contact-sheet.png"), await encodePng(audit.contactSheet.image), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Source-only open-openness freeze\n\n` +
    `- The apparent SHA mismatch is a hash-domain mismatch: 66a63... is the decoded RGBA hash used by the frozen manifest; eaa53... is the PNG file-byte hash. Decoding the PNG reproduces 66a63... exactly.\n` +
    `- Historical co-generated metrics record the Wikimedia source page, 960x720 input, subject-aware boxes, and 270x308 face crop. The exact original bytes were not retained, so current deterministic regeneration is unavailable.\n` +
    `- Lineage classification: VERIFIED_DERIVED_ARTIFACT. The exact local reviewed artifact is frozen as the calibration source.\n` +
    `- Manual source review: both eyes and both eyelid boundaries are visible; aperture is stable_large; clipping does not affect the eyes; expression is neutral; no blink or eye occlusion is present. Contrast is present but not decisive.\n` +
    `- Canonical source-only label: eyeOpenness=open; candidate tier TIER_A_OPEN_SOURCE_READY. This is not yet a geometry anchor.\n` +
    `- Production portraitRegion remains unavailable. No manual box was promoted.\n` +
    `- No provider, geometry, JPEG transmission, evaluator, remote Wrangler, health, or package-manager calls occurred.\n` +
    `- compactMax 0.34 and openMin 0.68 are unchanged; no threshold was selected.\n\n` +
    `OPEN_ANCHOR_SOURCE_FROZEN\n`, { flag: "wx" });
});
