import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";
import { crop } from "./generalizationSupport";

const BUILD = process.env.BUILD_GEMMA_EYE_OBSERVATION_DIAGNOSIS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/gemma-eye-observation-limitation-diagnosis-20260922-001");
const COMPARISON = path.resolve("evaluation-artifacts/primary-eye-category-calibration-diagnosis-20260921-001/case-comparison.json");
const TARGETED = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001/summary.json");
const SIX_CASE = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001/summary.json");
const WAVY = path.resolve("evaluation-artifacts/bound-profile-cli-primary-canary-live-20260921-001/summary.json");
const PARITY = path.resolve("evaluation-artifacts/primary-eye-provider-instruction-parity-20260922-001/instruction-parity.json");
const GEOMETRY = path.resolve("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const ANNOTATIONS = path.resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const SOURCES = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const IDS = ["warm-white-tee", "striped-open-shirt", "wavy-open-blazer", "buzz-striped", "sleeveless-bag-skirt"] as const;

type Id = typeof IDS[number];
type Box = [number, number, number, number];
type Measurement = { value: string; provenance: string; confidence: number };
type Result = {
  caseId: string;
  ok: boolean;
  sourceSelection: { portraitRegion: null | { faceBox: { left: number; top: number; right: number; bottom: number } } };
  faceMeasurementEvidence: { cues: { eyeOpenness: Measurement; eyeFootprint: Measurement } } | null;
  relevantRenderHints: { eyeSize: string; eyeShape: string } | null;
};
type Comparison = {
  caseId: Id;
  photoId: number;
  sourceSha256: string;
  sourceBytes: number;
  faceVisibility: string;
  pose: string;
  headBox: Box;
  eyeBoxWithinHead: Box;
  source: { eyeOpenness: { values?: string[] }; eyeFootprint: { values?: string[] } };
};
type Annotation = { id: string; framing: string };
type RawLive = { primaryResults: Result[] };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const boxFromLTRB = (box: { left: number; top: number; right: number; bottom: number }): Box =>
  [box.left, box.top, box.right - box.left, box.bottom - box.top];

function makeCanvas(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([238, 241, 245, 255], offset);
  return { width, height, rgba };
}

function paste(out: RawImage, image: RawImage, x: number, y: number, width: number, height: number): void {
  const ratio = Math.min(width / image.width, height / image.height);
  const scaled = scaleNearestNeighbor(image, Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
  const left = x + Math.floor((width - scaled.width) / 2);
  const top = y + Math.floor((height - scaled.height) / 2);
  for (let row = 0; row < scaled.height; row++) for (let column = 0; column < scaled.width; column++) {
    const source = (row * scaled.width + column) * 4;
    out.rgba.set(scaled.rgba.subarray(source, source + 4), ((top + row) * out.width + left + column) * 4);
  }
}

const FONT: Record<string, string[]> = {
  " ": ["000", "000", "000", "000", "000"], "-": ["000", "000", "111", "000", "000"],
  ":": ["0", "1", "0", "1", "0"], "X": ["101", "101", "010", "101", "101"],
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"],
  A: ["010", "101", "111", "101", "101"], B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"], D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"], F: ["111", "100", "110", "100", "100"],
  G: ["111", "100", "101", "101", "111"], H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"], L: ["100", "100", "100", "100", "111"],
  M: ["10001", "11011", "10101", "10001", "10001"], N: ["1001", "1101", "1011", "1001", "1001"],
  O: ["111", "101", "101", "101", "111"], P: ["110", "101", "110", "100", "100"],
  R: ["110", "101", "110", "101", "101"], S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"], U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"], W: ["10001", "10001", "10101", "11011", "10001"],
  Y: ["101", "101", "010", "010", "010"], Z: ["111", "001", "010", "100", "111"],
};

function text(image: RawImage, value: string, x: number, y: number, color = [17, 24, 39, 255]): void {
  let cursor = x;
  for (const character of value.toUpperCase()) {
    const glyph = FONT[character] ?? FONT[" "];
    const width = glyph[0].length;
    for (let row = 0; row < glyph.length; row++) for (let column = 0; column < width; column++) {
      if (glyph[row][column] === "1") image.rgba.set(color, ((y + row) * image.width + cursor + column) * 4);
    }
    cursor += width + 1;
  }
}

function sourceImage(item: Comparison): RawImage {
  const bytes = fs.readFileSync(path.join(SOURCES, `${item.photoId}.jpg`));
  expect(bytes.byteLength).toBe(item.sourceBytes);
  expect(sha256(bytes)).toBe(item.sourceSha256);
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
  return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}

function latestResults(): Map<string, Result> {
  const targeted = read<RawLive>(TARGETED).primaryResults;
  const six = read<RawLive>(SIX_CASE).primaryResults;
  const wavyRaw = read<{ primary: Omit<Result, "caseId"> }>(WAVY).primary;
  const all = [...six, ...targeted, { ...wavyRaw, caseId: "wavy-open-blazer" } as Result];
  const map = new Map<string, Result>();
  for (const item of all) map.set(item.caseId, item);
  return map;
}

function buildDiagnosis() {
  const rubricText = fs.readFileSync(RUBRIC, "utf8");
  expect(sha256(rubricText)).toBe(RUBRIC_HASH);
  const comparison = read<{ cases: Comparison[] }>(COMPARISON).cases;
  const annotations = new Map(read<Annotation[]>(ANNOTATIONS).map((item) => [item.id, item]));
  const results = latestResults();
  const parity = read<{ geminiClarificationPresent: boolean; gemmaClarificationPresent: boolean; intermediateLoss: boolean }>(PARITY);
  expect(parity).toMatchObject({ geminiClarificationPresent: true, gemmaClarificationPresent: true, intermediateLoss: false });

  const cases = comparison.map((item) => {
    const source = sourceImage(item);
    const head = crop(source, item.headBox);
    const eye = crop(head, item.eyeBoxWithinHead);
    const result = results.get(item.caseId)!;
    expect(result?.ok).toBe(true);
    const faceBox = result.sourceSelection.portraitRegion?.faceBox;
    const face = faceBox ? crop(source, boxFromLTRB(faceBox)) : null;
    const target = item.caseId === "warm-white-tee" || item.caseId === "striped-open-shirt";
    const openness = result.faceMeasurementEvidence!.cues.eyeOpenness;
    const footprint = result.faceMeasurementEvidence!.cues.eyeFootprint;
    return {
      caseId: item.caseId,
      role: target ? "target" : "correct_sentinel",
      photoId: item.photoId,
      sourceSha256: item.sourceSha256,
      sourceBytes: item.sourceBytes,
      framing: annotations.get(item.caseId)?.framing ?? "unavailable",
      sourceDimensions: { width: source.width, height: source.height, totalPixels: source.width * source.height },
      headLocalization: { source: "frozen_manual_annotation", normalizedBox: item.headBox,
        pixels: { width: head.width, height: head.height, area: head.width * head.height },
        sourcePixelFraction: (head.width * head.height) / (source.width * source.height) },
      faceLocalization: face ? { source: "historical_validated_sourceSelection", normalizedBox: boxFromLTRB(faceBox!),
        pixels: { width: face.width, height: face.height, area: face.width * face.height } }
        : { source: "unavailable", normalizedBox: null, pixels: null },
      eyeScaleProxy: { source: "manual_diagnostic_proxy_reused_from_existing_contact_sheet", normalizedWithinHead: item.eyeBoxWithinHead,
        envelopePixels: { width: eye.width, height: eye.height },
        anatomicalOneEyeSpanPixels: null, anatomicalAperturePixels: null, interEyeDistancePixels: null,
        precision: "crop envelope only; not a landmark measurement" },
      pose: item.pose,
      faceVisibility: item.faceVisibility,
      twoEyeSymmetry: item.caseId === "warm-white-tee" ? "one_side_foreshortened" : item.pose === "frontal" ? "approximately_symmetric" : "both_visible_with_turn_or_tilt",
      rubric: { eyeOpenness: item.source.eyeOpenness.values?.[0] ?? "unscorable", eyeFootprint: item.source.eyeFootprint.values?.[0] ?? "unscorable" },
      provider: { eyeOpenness: openness.value, eyeOpennessConfidence: openness.confidence,
        eyeFootprint: footprint.value, eyeFootprintConfidence: footprint.confidence },
      legacyHints: { eyeSize: result.relevantRenderHints?.eyeSize ?? "unavailable", eyeShape: result.relevantRenderHints?.eyeShape ?? "unavailable" },
      visualReview: { enlargedCropDistinction: target ? "clear_enough_for_coarse_narrow_compact_diagnosis" : "normal_medium_reference",
        precision: "manual diagnostic review; frozen rubric unchanged" },
    };
  });

  const targetCases = cases.filter((item) => item.role === "target");
  const sentinels = cases.filter((item) => item.role === "correct_sentinel");
  const smallestSentinelArea = Math.min(...sentinels.map((item) => item.headLocalization.pixels.area));
  const smallestSentinelFraction = Math.min(...sentinels.map((item) => item.headLocalization.sourcePixelFraction));
  expect(targetCases.every((item) => item.headLocalization.pixels.area < smallestSentinelArea)).toBe(true);
  expect(targetCases.every((item) => item.headLocalization.sourcePixelFraction < smallestSentinelFraction)).toBe(true);

  const auditRunner = fs.readFileSync(path.resolve("test/primaryAuditCliProtectedHealth.test.ts"), "utf8");
  const auditWorker = fs.readFileSync(path.resolve("test/primaryFaceMeasurementAuditWorker.ts"), "utf8");
  const analysisSource = fs.readFileSync(path.resolve("src/analysis.ts"), "utf8");
  const geminiSource = fs.readFileSync(path.resolve("src/gemini.ts"), "utf8");
  expect(auditRunner).toContain("`data:image/jpeg;base64,${bytesToBase64(source)}`");
  expect(auditWorker).toContain("}, body.imageDataUrl);");
  expect(analysisSource).toContain("const references = Array.isArray(imageDataUrls) ? imageDataUrls : [imageDataUrls]");
  expect(geminiSource).toContain("image_url: { url }");

  const inputPath = {
    externalCalls: { remoteWrangler: 0, health: 0, jpegRemoteTransmission: 0, gemini: 0, gemma: 0, evaluator: 0, packageManager: 0 },
    path: [
      { stage: "frozen_jpeg", operation: "read exact bytes; SHA-256, byte count and JPEG magic verified" },
      { stage: "audit_data_url", operation: "raw bytes base64-encoded once in a JPEG data-URL envelope; no image decode" },
      { stage: "primary_audit_worker", operation: "prefix validation only; same data URL passed to runPhotoAnalysis" },
      { stage: "runPhotoAnalysis", operation: "same string retained in references array" },
      { stage: "generateGeminiStructuredJson", operation: "Gemini primary receives original inline bytes; eligible failure may select Workers AI" },
      { stage: "Gemma_adapter", operation: "same data URL assigned to messages[0].content[].image_url.url" },
    ],
    localImageMutation: { jpegDecode: false, jpegReencode: false, resize: false, recompression: false, byteMutation: false },
    originalDimensionsPreservedToLocalProviderBoundary: true,
    providerInternalResize: "unknown_after_provider_boundary",
    codeEvidence: ["workers/test/primaryAuditCliProtectedHealth.test.ts", "workers/test/primaryFaceMeasurementAuditWorker.ts", "workers/src/analysis.ts:runPhotoAnalysis", "workers/src/gemini.ts:workersAiStructuredInput"],
  };

  const targetSentinelComparison = {
    invariant: { frozenRubricSha256: RUBRIC_HASH, rubricChanged: false, promptParity: true, normalizationIdentityPreserving: true },
    rows: cases,
    scaleFinding: {
      allTargetsSmallerThanEveryCorrectSentinelByAnnotatedHeadArea: true,
      allTargetsSmallerThanEveryCorrectSentinelBySourcePixelFraction: true,
      stripedIsSevereSmallFaceCase: true,
      warmIsModerateScaleGapRatherThanTinySource: true,
      cropDistinctionVisible: true,
    },
    poseFinding: "not target-exclusive: warm is foreshortened, striped is only slightly turned, while buzz and sleeveless are correct three-quarter sentinels",
    confidenceFinding: "wrong target categories retain 0.85-0.90 confidence, so confidence threshold 0.75 does not hide uncertainty",
    legacyFinding: "all five collapse to eyeSize=average and eyeShape=almond; legacy hints do not preserve the target distinction",
  };

  const geometryStored = read<{ results: Array<{ id: string; ok: boolean; measurements?: unknown }> }>(GEOMETRY).results;
  const stored = Object.fromEntries(IDS.map((id) => [id, geometryStored.find((item) => item.id === id) ?? null]));
  expect(stored["warm-white-tee"]).toBeNull();
  expect(stored["striped-open-shirt"]).toBeNull();
  expect(stored["wavy-open-blazer"]?.ok).toBe(true);
  const architectureComparison = {
    productionFlag: { FACE_GEOMETRY_ENRICHMENT_ENABLED: true },
    paths: [
      { path: "primary", crop: "full frozen JPEG", localResolutionChange: "none", provider: "Gemini 3.8 then eligible Gemma fallback", output: "categorical faceMeasurementEvidence plus full PhotoAnalysis", currentAuditUse: true },
      { path: "portrait_detail", crop: "enlarged head/upper crop PNG, max edge 512", provider: "vision primary/fallback", output: "focused face/hair/neck detail", currentProductionUse: "bypassed when face geometry enrichment flag is true" },
      { path: "face_only_geometry", crop: "tight face crop PNG, max edge 512", provider: "Gemma 4 26B", output: "continuous eyes/brows/nose/mouth geometry", currentProductionUse: true },
    ],
    storedSecondaryGeometry: {
      available: ["wavy-open-blazer"], unavailable: ["warm-white-tee", "striped-open-shirt", "buzz-striped", "sleeveless-bag-skirt"],
      wavy: { cropPixels: { width: 265, height: 296 }, eyeOpenness: 0.85, confidence: 0.98, role: "secondary reference only" },
    },
    maskingAssessment: {
      implementation: "successful faceIdentityGeometry is resolved before categorical fallback when the FacePixelPlan is quantized",
      targetsHaveUsableHistoricalPortraitLocalization: true,
      targetContinuousGeometrySuccessEvidence: false,
      classification: "categorical error is masked when face geometry succeeds, but target-specific masking is unproven and the error is exposed on any geometry failure/unavailability",
    },
    cropStrategyFeasibility: {
      sameCallFullPlusCrop: "wire supports multiple image references, but the crop is only known after primary sourceSelection unless a new pre-primary localizer is added",
      risks: ["sourceSelection index semantics", "duplicate evidence", "outfit ownership confusion", "larger multimodal request"],
      sameCallPostPrimaryRecrop: false,
      reason: "a provider call cannot inspect a crop computed from its own completed response",
    },
  };

  const causeRanking = {
    taxonomy: "RESOLUTION_LIMITED",
    strongestRootCause: "full-frame eye evidence is systematically smaller for both wrong targets; enlarged crops retain a visible low-aperture/compact distinction",
    ranking: [
      { rank: 1, cause: "RESOLUTION_LIMITED", strength: "strongest_supported", evidence: ["both wrong targets are below every correct sentinel in annotated head area and frame fraction", "striped is a severe scale outlier", "the low-category distinction becomes clear in enlarged diagnostic crops", "no local resize occurs, leaving provider-internal preprocessing unknown"] },
      { rank: 2, cause: "INSTRUCTION_ADHERENCE_LIMITED", strength: "secondary_supported", evidence: ["exact clarification reaches Gemma", "provider repeatedly returns middle categories with 0.85-0.90 confidence", "stored Gemma-origin low-category use is zero"], limitation: "the same outputs are confounded by the target-only scale gap" },
      { rank: 3, cause: "POSE_LIMITED", strength: "secondary_not_sufficient", evidence: ["warm has one-side foreshortening", "striped only has slight turn", "correct buzz and sleeveless sentinels are also three-quarter"] },
      { rank: 4, cause: "RUBRIC_DISTINCTION_WEAK", strength: "rejected", evidence: ["nearest-neighbor enlarged crops preserve a visible coarse distinction", "rubric hash remains frozen"] },
    ],
    confidenceCalibration: "overconfident middle classification is present; threshold changes are not indicated",
    caveat: "Offline evidence identifies the strongest observed boundary, not the provider's undocumented internal resize algorithm.",
  };

  const strategyComparison = {
    recommended: "first validate existing production face-only geometry success and FacePixelPlan retention on the two targets; only then consider a focused crop contract",
    options: [
      { id: "A", strategy: "accept categorical limitation because geometry masks it", qualityBenefit: "medium_if_geometry_succeeds", providerCost: "no new architecture; existing geometry call", latency: "existing geometry latency", complexity: "low", fabricationRisk: "low", verdict: "not sufficient until target geometry success is evidenced" },
      { id: "B", strategy: "full image plus deterministic crop in primary call", qualityBenefit: "potentially_high", providerCost: "same call but extra image payload", latency: "moderate", complexity: "high because pre-primary localization is currently absent", fabricationRisk: "low", verdict: "defer; sourceSelection and duplicate-evidence semantics need design" },
      { id: "C", strategy: "dedicated focused categorical crop", qualityBenefit: "high_likelihood", providerCost: "+1 provider call", latency: "high", complexity: "medium", fabricationRisk: "low", verdict: "fallback option only after geometry coverage audit" },
      { id: "D", strategy: "derive category only from actual continuous geometry", qualityBenefit: "already_realized_in_pixel_quantization", providerCost: "none beyond existing geometry", latency: "none beyond existing geometry", complexity: "low", fabricationRisk: "low", verdict: "do not duplicate; verify existing priority path" },
      { id: "E", strategy: "provider/model change", qualityBenefit: "unknown", providerCost: "unknown", latency: "unknown", complexity: "high", fabricationRisk: "unknown", verdict: "prohibited and unsupported by this diagnosis" },
    ],
  };

  return { cases, inputPath, targetSentinelComparison, architectureComparison, causeRanking, strategyComparison };
}

async function contactSheet(cases: ReturnType<typeof buildDiagnosis>["cases"]): Promise<RawImage> {
  const width = 1152;
  const rowHeight = 210;
  const header = 18;
  const imageHeight = rowHeight - header;
  const sheet = makeCanvas(width, rowHeight * cases.length);
  for (const [index, item] of cases.entries()) {
    const comparison = read<{ cases: Comparison[] }>(COMPARISON).cases.find((entry) => entry.caseId === item.caseId)!;
    const source = sourceImage(comparison);
    const head = crop(source, comparison.headBox);
    const eyes = crop(head, comparison.eyeBoxWithinHead);
    const y = index * rowHeight;
    const face = item.faceLocalization.pixels;
    const label = `${item.caseId.replaceAll("-", " ")} S${source.width}X${source.height} H${head.width}X${head.height} F${face ? `${face.width}X${face.height}` : "-"} E${eyes.width}X${eyes.height} FULL HEAD EYE`;
    text(sheet, label, 6, y + 6, item.role === "target" ? [185, 28, 28, 255] : [21, 94, 117, 255]);
    paste(sheet, source, 0, y + header, 384, imageHeight);
    paste(sheet, head, 384, y + header, 384, imageHeight);
    paste(sheet, eyes, 768, y + header, 384, imageHeight);
  }
  return sheet;
}

it("isolates the strongest offline observation boundary without provider calls", () => {
  const diagnosis = buildDiagnosis();
  expect(diagnosis.inputPath.externalCalls).toEqual({ remoteWrangler: 0, health: 0, jpegRemoteTransmission: 0, gemini: 0, gemma: 0, evaluator: 0, packageManager: 0 });
  expect(diagnosis.inputPath.localImageMutation).toEqual({ jpegDecode: false, jpegReencode: false, resize: false, recompression: false, byteMutation: false });
  expect(diagnosis.causeRanking.taxonomy).toBe("RESOLUTION_LIMITED");
  expect(diagnosis.architectureComparison.maskingAssessment.targetContinuousGeometrySuccessEvidence).toBe(false);
});

it.skipIf(!BUILD)("writes the immutable offline diagnosis artifacts", async () => {
  const diagnosis = buildDiagnosis();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("input-path.json", diagnosis.inputPath);
  write("source-scale.json", { frozenRubricSha256: RUBRIC_HASH, localizationPriority: ["frozen/manual headBox", "source rubric headBox", "historical validated sourceSelection", "unavailable"], cases: diagnosis.cases.map((item) => ({
    caseId: item.caseId, role: item.role, photoId: item.photoId, sourceSha256: item.sourceSha256,
    sourceBytes: item.sourceBytes, framing: item.framing, sourceDimensions: item.sourceDimensions,
    headLocalization: item.headLocalization, faceLocalization: item.faceLocalization,
    eyeScaleProxy: item.eyeScaleProxy, pose: item.pose, faceVisibility: item.faceVisibility,
    twoEyeSymmetry: item.twoEyeSymmetry, rubric: item.rubric,
  })) });
  write("target-sentinel-comparison.json", diagnosis.targetSentinelComparison);
  write("architecture-comparison.json", diagnosis.architectureComparison);
  write("cause-ranking.json", diagnosis.causeRanking);
  write("strategy-comparison.json", diagnosis.strategyComparison);
  fs.writeFileSync(path.join(ROOT, "source-eye-contact-sheet.png"), await encodePng(await contactSheet(diagnosis.cases)), { flag: "wx" });
  const report = `# Gemma eye observation limitation diagnosis\n\n` +
    `- Mode: offline diagnosis only. External/provider/package-manager calls: 0.\n` +
    `- Frozen rubric SHA-256: ${RUBRIC_HASH}; labels were not changed.\n` +
    `- Primary input: exact JPEG bytes become a data URL and remain unchanged through the local Gemma adapter. There is no local resize/re-encode/compression. Provider-internal preprocessing is unknown.\n` +
    `- Scale: both wrong targets have smaller annotated head area and frame fraction than every correct sentinel. Striped is the severe scale outlier; warm is a moderate, not tiny, gap.\n` +
    `- Eye proxy: the displayed crop is a frozen diagnostic envelope, not fabricated one-eye landmarks. Exact aperture/span/inter-eye pixel measurements are unavailable.\n` +
    `- Pose: insufficient as the primary cause because striped is only slightly turned and correct three-quarter sentinels exist.\n` +
    `- Confidence: wrong normal/medium values remain at 0.85-0.90, so changing the 0.75 threshold would not recover them.\n` +
    `- Legacy hints: all five use average/almond, confirming loss of the target distinction rather than a downstream token rewrite.\n` +
    `- Stored geometry: only wavy has target/sentinel face-only geometry evidence. No stored continuous geometry proves masking for warm or striped.\n` +
    `- Final taxonomy: RESOLUTION_LIMITED. Instruction adherence/middle bias is a supported secondary factor, but it is confounded by the systematic target scale gap.\n` +
    `- Production masking: successful face-only geometry takes priority in FacePixelPlan quantization, but target success is not yet evidenced; categorical error remains exposed when geometry is unavailable or fails.\n` +
    `- Recommended next strategy: validate existing production face-only geometry success and downstream retention on warm-white-tee and striped-open-shirt before adding any focused categorical call or changing provider/prompt.\n\n` +
    `NEXT_QUALITY_TARGET: existing face-only geometry coverage and FacePixelPlan retention for the two low-aperture target sources\n`;
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), report, { flag: "wx" });

  const textual = fs.readdirSync(ROOT).filter((name) => /\.(json|md)$/i.test(name)).map((name) => fs.readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  expect(textual).not.toMatch(/data:image|authorization\s*:|bearer\s+|AIza[\w-]{20,}|cfut_[\w-]+/i);
});
