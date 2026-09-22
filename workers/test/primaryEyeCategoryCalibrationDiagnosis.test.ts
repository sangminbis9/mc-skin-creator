import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { ANALYSIS_PROMPT } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA, normalizeCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { FACE_MEASUREMENT_EVIDENCE_SCHEMA, FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { encodePng, type RawImage } from "../src/png";
import { scaleNearestNeighbor } from "../src/skinRender";
import { crop } from "./generalizationSupport";
import { semanticFixture, wireFixture } from "./compactV3Support";

const BUILD = process.env.BUILD_PRIMARY_EYE_CATEGORY_DIAGNOSIS === "approved-offline";
const REFRESH_CONTACT = process.env.REFRESH_PRIMARY_EYE_CATEGORY_CONTACT === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/primary-eye-category-calibration-diagnosis-20260921-001");
const LIVE = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001/summary.json");
const WAVY = path.resolve("evaluation-artifacts/bound-profile-cli-primary-canary-live-20260921-001/summary.json");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const ANNOTATIONS = path.resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const SOURCES = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const comparisonIds = ["warm-white-tee", "striped-open-shirt", "wavy-open-blazer", "buzz-striped", "sleeveless-bag-skirt"] as const;
const colors = [[220, 38, 38], [234, 88, 12], [22, 163, 74], [37, 99, 235], [147, 51, 234]] as const;

type Cue = keyof typeof FACE_MEASUREMENT_VALUES;
type Measurement = { value: string; provenance: string; confidence: number };
type Result = {
  caseId: string;
  ok: boolean;
  faceMeasurementEvidence: { cues: Record<Cue, Measurement> } | null;
  relevantRenderHints: { eyeSpacing: string; eyeSize: string; eyeShape: string; eyeTilt: string } | null;
};
type Live = { primaryResults: Result[] };
type Wavy = { primary: { faceMeasurementEvidence: { cues: Record<Cue, Measurement> }; relevantRenderHints: Result["relevantRenderHints"] } };
type RubricCell = { kind: "expected" | "ambiguous" | "unscorable"; values?: string[]; reason?: string };
type RubricCase = { id: string; photoId: number; sourceSha256: string; sourceBytes: number; faceVisibility: string; pose: string; rubric: Record<Cue, RubricCell> };
type Annotation = { id: string; photoId: number; headBox: [number, number, number, number] };
type Schema = { properties?: Record<string, Schema>; items?: Schema; enum?: readonly unknown[] };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const schemaEnum = (schema: unknown) => (schema as Schema).properties!.faceMeasurements.items!.properties!.value.enum!;

function counts(values: string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

function makeCanvas(width: number, height: number): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([229, 231, 235, 255], index);
  return { width, height, rgba };
}

function paste(out: RawImage, image: RawImage, x: number, y: number, width: number, height: number): void {
  const ratio = Math.min(width / image.width, height / image.height);
  const scaled = scaleNearestNeighbor(image, Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
  const left = x + Math.floor((width - scaled.width) / 2);
  const top = y + Math.floor((height - scaled.height) / 2);
  for (let row = 0; row < scaled.height; row++) {
    for (let column = 0; column < scaled.width; column++) {
      const source = (row * scaled.width + column) * 4;
      out.rgba.set(scaled.rgba.subarray(source, source + 4), ((top + row) * out.width + left + column) * 4);
    }
  }
}

function stripe(image: RawImage, x: number, color: readonly number[]): void {
  for (let y = 0; y < 8; y++) for (let column = 0; column < 248; column++) {
    image.rgba.set([...color, 255], ((y * image.width) + x + column) * 4);
  }
}

function buildDiagnosis() {
  const live = read<Live>(LIVE);
  const wavy = read<Wavy>(WAVY);
  const rubricText = fs.readFileSync(RUBRIC, "utf8");
  expect(hash(rubricText)).toBe(RUBRIC_HASH);
  const rubric = (JSON.parse(rubricText) as { cases: RubricCase[] }).cases;
  const annotations = read<Annotation[]>(ANNOTATIONS);
  const results = new Map<string, Result>(live.primaryResults.map((item) => [item.caseId, item]));
  results.set("wavy-open-blazer", {
    caseId: "wavy-open-blazer", ok: true,
    faceMeasurementEvidence: wavy.primary.faceMeasurementEvidence,
    relevantRenderHints: wavy.primary.relevantRenderHints,
  });
  const validated = [...results.values()].filter((item) => item.ok && item.faceMeasurementEvidence);
  const providerValue = (id: string, cue: Cue) => results.get(id)?.faceMeasurementEvidence?.cues[cue] ?? null;

  const canonicalUnion = [...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())];
  const rich = FACE_MEASUREMENT_EVIDENCE_SCHEMA as Schema;
  const categoryVocabulary = {
    sourceOfTruth: "FACE_MEASUREMENT_VALUES",
    eyeOpenness: [...FACE_MEASUREMENT_VALUES.eyeOpenness],
    eyeFootprint: [...FACE_MEASUREMENT_VALUES.eyeFootprint],
    compactFaceOrder: [...COMPACT_FACE_ORDER],
    schemas: {
      richEyeOpenness: rich.properties!.cues.properties!.eyeOpenness.properties!.value.enum,
      richEyeFootprint: rich.properties!.cues.properties!.eyeFootprint.properties!.value.enum,
      compactV2ProviderUnion: schemaEnum(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA),
      compactV3ProviderUnion: schemaEnum(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
      gemmaNamedProviderUnion: schemaEnum(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA),
    },
    unionOrder: canonicalUnion,
    enumOrderingAssessment: "No default is declared. Cue-specific orders place the low category first and unknown last; the provider union begins with eyeSpacing vocabulary. Ordering does not explain a shared normal/medium collapse.",
  };

  const normalizedProbe = wireFixture(semanticFixture("plain"));
  normalizedProbe.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  normalizedProbe.faceMeasurements[1] = { value: "narrow", provenance: "observed_categorical", confidence: 0.9 };
  normalizedProbe.faceMeasurements[2] = { value: "compact", provenance: "observed_categorical", confidence: 0.8 };
  const normalized = normalizeCompactPhotoAnalysisV2(normalizedProbe);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error("normalization_probe_failed");
  expect(normalized.analysis.faceMeasurementEvidence?.cues.eyeOpenness.value).toBe("narrow");
  expect(normalized.analysis.faceMeasurementEvidence?.cues.eyeFootprint.value).toBe("compact");
  const normalizationChain = {
    rawProviderTokensRetainedByLiveSanitizer: false,
    rawProviderEyeOpenness: "unavailable",
    rawProviderEyeFootprint: "unavailable",
    stages: [
      "provider value must belong to the 16-token canonical union",
      "strict slot validator checks FACE_MEASUREMENT_VALUES[COMPACT_FACE_ORDER[index]]",
      "normalizeCompactPhotoAnalysisV2 assigns faceMeasurements[index] to the same cue without synonym mapping",
      "validatePhotoAnalysis/parseFaceMeasurementEvidence preserves valid values; only invalid, hidden or confidence<0.75 becomes unknown",
    ],
    synonymOrCoercionTable: [],
    deterministicProbe: { input: { eyeOpenness: "narrow", eyeFootprint: "compact" }, output: {
      eyeOpenness: normalized.analysis.faceMeasurementEvidence?.cues.eyeOpenness.value,
      eyeFootprint: normalized.analysis.faceMeasurementEvidence?.cues.eyeFootprint.value,
    }, identityPreserved: true },
    classification: "normalization_coercion_bug_rejected",
  };

  const sourceFor = (cue: "eyeOpenness" | "eyeFootprint", onlyValidated: boolean) => rubric.flatMap((item) => {
    if (onlyValidated && !results.get(item.id)?.ok) return [];
    const cell = item.rubric[cue];
    return cell.kind === "unscorable" ? [] : cell.values ?? [];
  });
  const providerFor = (cue: "eyeOpenness" | "eyeFootprint") => validated.map((item) => item.faceMeasurementEvidence!.cues[cue].value);
  const distribution = {
    calibrationSetOnly: true,
    validatedProviderOutputs: validated.length,
    sourceAllSevenScorable: {
      eyeOpenness: counts(sourceFor("eyeOpenness", false)),
      eyeFootprint: counts(sourceFor("eyeFootprint", false)),
    },
    sourceForValidatedOutputs: {
      eyeOpenness: counts(sourceFor("eyeOpenness", true)),
      eyeFootprint: counts(sourceFor("eyeFootprint", true)),
    },
    providerValidated: {
      eyeOpenness: counts(providerFor("eyeOpenness")),
      eyeFootprint: counts(providerFor("eyeFootprint")),
    },
    providerOriginObservedCounts: {
      scope: "stored validated wavy plus five validated new results; manual/synthetic fixtures excluded",
      eyeOpennessNarrow: providerFor("eyeOpenness").filter((value) => value === "narrow").length,
      eyeFootprintCompact: providerFor("eyeFootprint").filter((value) => value === "compact").length,
    },
  };

  const comparisons = comparisonIds.map((id, index) => {
    const source = rubric.find((item) => item.id === id)!;
    const annotation = annotations.find((item) => item.id === id)!;
    const result = results.get(id)!;
    return {
      column: index,
      color: colors[index],
      caseId: id,
      photoId: source.photoId,
      sourceSha256: source.sourceSha256,
      sourceBytes: source.sourceBytes,
      faceVisibility: source.faceVisibility,
      pose: source.pose,
      headBox: annotation.headBox,
      eyeBoxWithinHead: id === "sleeveless-bag-skirt" ? [0.1, 0.08, 0.8, 0.3] : [0.1, 0.27, 0.8, 0.34],
      source: {
        eyeOpenness: source.rubric.eyeOpenness,
        eyeFootprint: source.rubric.eyeFootprint,
        eyeSpacing: source.rubric.eyeSpacing,
      },
      provider: {
        eyeOpenness: providerValue(id, "eyeOpenness"),
        eyeFootprint: providerValue(id, "eyeFootprint"),
        eyeSpacing: providerValue(id, "eyeSpacing"),
      },
      legacyRenderHints: result.relevantRenderHints,
      interpretation: id === "warm-white-tee" || id === "striped-open-shirt"
        ? "frozen narrow/compact source; provider normal/medium and legacy average/almond"
        : "correct normal/medium sentinel; provider normal/medium and legacy average/almond",
    };
  });

  const priorMeasurementSentence = "Judge spacing relative to face width, aperture separately from eyeliner, brow gap relative to eye height, and mouth width independently from lip fullness.";
  const currentDefinitionsPresent = [
    "Judge eyeSpacing as the distance between the two eyes relative to face width.",
    "Judge eyeOpenness from vertical eyelid aperture only",
    "Judge eyeFootprint as one eye's overall visible horizontal span relative to the face",
  ].every((text) => ANALYSIS_PROMPT.includes(text));
  expect(currentDefinitionsPresent).toBe(true);
  expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT.startsWith(`${ANALYSIS_PROMPT}\n\n`)).toBe(true);
  const promptReview = {
    priorContract: {
      spacing: "relative to face width",
      openness: "aperture separately from eyeliner; category boundaries undefined",
      footprint: "vocabulary only; no independent semantic definition",
      overlappingLegacyInstruction: "eyeSize describes the visible eye aperture relative to this person's face",
      defaultInstructions: [],
      assessment: "eyeOpenness was underdefined and eyeFootprint undefined; legacy eyeSize reused aperture wording, weakening axis separation",
      exactPriorSentence: priorMeasurementSentence,
    },
    appliedContract: {
      currentDefinitionsPresent,
      spacing: "inter-eye distance relative to face width",
      openness: "vertical eyelid aperture only, with narrow/normal/open boundaries and explicit exclusions",
      footprint: "one-eye horizontal span relative to the face, independent of spacing/openness",
      fixtureSpecificRules: 0,
    },
    propagation: ["ANALYSIS_PROMPT", "COMPACT_PHOTO_ANALYSIS_V2_PROMPT", "COMPACT_PHOTO_ANALYSIS_V3_PROMPT", "GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT"],
  };
  const proposedPatch = {
    classification: "CASE_B_prompt_semantics_clearly_ambiguous",
    applied: true,
    file: "workers/src/analysis.ts",
    boundary: "STEP 6 faceMeasurementEvidence semantic definitions only",
    changes: ["define eyeSpacing anchor", "define vertical-only eyeOpenness", "define horizontal one-eye eyeFootprint", "state axis independence and do-not-copy exclusions"],
    schemaChanges: 0,
    vocabularyChanges: 0,
    thresholdChanges: 0,
    normalizerChanges: 0,
    rendererChanges: 0,
    liveCalls: 0,
  };
  const diagnosis = {
    rootCauseRanking: [
      { rank: 1, candidate: "A_prompt_semantic_ambiguity", strength: "strong", evidence: "footprint had no definition; openness had no category boundaries; eyeSize reused aperture semantics" },
      { rank: 2, candidate: "F_provider_middle_category_bias", strength: "supported_in_small_set", evidence: "five comparable validated cases all returned normal/medium and average/almond; stored provider-origin narrow/compact count is zero" },
      { rank: 3, candidate: "D_axis_coupling", strength: "supported_as_prompt_interaction", evidence: "both wrong cases missed openness and footprint together; prior text did not explicitly separate the axes" },
      { rank: 4, candidate: "E_pose_framing", strength: "secondary_not_sufficient", evidence: "wrong cases are turned, but buzz and sleeveless are correct three-quarter sentinels" },
      { rank: 5, candidate: "B_enum_schema_bias", strength: "weak", evidence: "no default, low category precedes middle in cue vocabularies, and strict schemas share the same union" },
      { rank: 6, candidate: "C_normalization_bug", strength: "rejected", evidence: "identity-preserving deterministic probe and no synonym/coercion code" },
      { rank: 7, candidate: "G_frozen_rubric_problem", strength: "not_supported", evidence: "local source crops visibly distinguish the target pair; rubric remains frozen" },
    ],
    strongestRootCause: "prompt semantic ambiguity, amplified by provider middle-category bias",
    bunCheckBacklog: "primary strict-runtime invalid_response",
    expressionBacklog: "buzz-striped smile to neutral at confidence 0.9",
    nextLiveRecheck: { target: ["warm-white-tee", "striped-open-shirt"], sentinel: ["sleeveless-bag-skirt"], calls: 3, retry: 0, purpose: "measure whether generic axis definitions recover narrow/compact without moving a correct three-quarter normal/medium sentinel" },
  };
  return { categoryVocabulary, normalizationChain, distribution, comparisons, promptReview, proposedPatch, diagnosis };
}

async function contactSheet(comparisons: ReturnType<typeof buildDiagnosis>["comparisons"]): Promise<RawImage> {
  const cellWidth = 248;
  const faceHeight = 248;
  const eyeHeight = 128;
  const gap = 8;
  const sheet = makeCanvas(comparisons.length * cellWidth + (comparisons.length - 1) * gap, faceHeight + gap + eyeHeight);
  for (const [index, item] of comparisons.entries()) {
    const bytes = fs.readFileSync(path.join(SOURCES, `${item.photoId}.jpg`));
    expect(hash(bytes)).toBe(item.sourceSha256);
    expect(bytes.byteLength).toBe(item.sourceBytes);
    const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
    const source: RawImage = { width: decoded.width, height: decoded.height, rgba: decoded.data };
    const head = crop(source, item.headBox);
    const eyes = crop(head, item.eyeBoxWithinHead);
    const left = index * (cellWidth + gap);
    paste(sheet, head, left, 8, cellWidth, faceHeight - 8);
    paste(sheet, eyes, left, faceHeight + gap, cellWidth, eyeHeight);
    stripe(sheet, left, item.color);
  }
  return sheet;
}

it("proves vocabulary alignment, identity normalization and prompt axis definitions offline", () => {
  const value = buildDiagnosis();
  expect(value.categoryVocabulary.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);
  expect(value.categoryVocabulary.eyeFootprint).toEqual(["compact", "medium", "wide", "unknown"]);
  expect(value.normalizationChain.deterministicProbe.identityPreserved).toBe(true);
  expect(value.distribution.providerOriginObservedCounts).toMatchObject({ eyeOpennessNarrow: 0, eyeFootprintCompact: 0 });
  expect(value.proposedPatch).toMatchObject({ schemaChanges: 0, thresholdChanges: 0, normalizerChanges: 0, liveCalls: 0 });
});

it.skipIf(!BUILD)("writes the offline diagnosis and local-only source contact sheet", async () => {
  const value = buildDiagnosis();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("category-vocabulary.json", value.categoryVocabulary);
  write("normalization-chain.json", value.normalizationChain);
  write("provider-category-distribution.json", value.distribution);
  write("case-comparison.json", { contactSheetColumnOrder: comparisonIds, rows: ["annotated head crop", "enlarged eye-region crop"], cases: value.comparisons });
  write("prompt-contract-review.json", value.promptReview);
  write("proposed-patch.json", value.proposedPatch);
  write("root-cause-ranking.json", value.diagnosis);
  fs.writeFileSync(path.join(ROOT, "source-contact-sheet.png"), await encodePng(await contactSheet(value.comparisons)), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Primary eye category calibration diagnosis\n\n` +
    `- External/provider calls: 0. Frozen rubric hash: ${RUBRIC_HASH}.\n` +
    `- Vocabulary is aligned across canonical, compact v2/v3 and Gemma named schemas.\n` +
    `- Raw compact tokens were not retained in the live sanitizer; stored values are validated rich values.\n` +
    `- A narrow/compact deterministic probe survives strict normalization unchanged.\n` +
    `- Stored provider-origin usage: narrow openness 0, compact footprint 0 across six validated outputs.\n` +
    `- Both wrong cases also used legacy eyeSize=average and eyeShape=almond; this is provider-wide middle interpretation, not a post-provider conversion.\n` +
    `- Pose is secondary: correct normal/medium three-quarter sentinels exist.\n` +
    `- Strongest root cause: prompt semantic ambiguity, amplified by provider middle-category bias.\n` +
    `- Applied patch: generic vertical-openness and horizontal-footprint definitions only; schema/vocabulary/threshold/normalizer/renderer unchanged.\n` +
    `- Next live recheck: warm-white-tee, striped-open-shirt, sentinel sleeveless-bag-skirt; one call each, retry 0.\n\n` +
    `NEXT_QUALITY_TARGET: provider-side eye openness/footprint observation calibration under the clarified axis contract\n`, { flag: "wx" });
});

it.skipIf(!REFRESH_CONTACT)("preserves the initial sheet and writes the corrected low-angle eye crop", async () => {
  const value = buildDiagnosis();
  const current = path.join(ROOT, "source-contact-sheet.png");
  const initial = path.join(ROOT, "source-contact-sheet-v1.png");
  if (!fs.existsSync(initial)) fs.copyFileSync(current, initial, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(current, await encodePng(await contactSheet(value.comparisons)));
  const comparison = path.join(ROOT, "case-comparison.json");
  const comparisonV1 = path.join(ROOT, "case-comparison-v1.json");
  if (!fs.existsSync(comparisonV1)) fs.copyFileSync(comparison, comparisonV1, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(comparison, `${JSON.stringify({ contactSheetColumnOrder: comparisonIds,
    rows: ["annotated head crop", "enlarged eye-region crop"], cases: value.comparisons }, null, 2)}\n`);
});
