import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ANALYSIS_PROMPT } from "../src/analysis";
import { COMPACT_FACE_ORDER, COMPACT_PHOTO_ANALYSIS_V2_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, GEMMA_VISION_MODEL } from "../src/gemmaPhotoAnalysis";
import { buildGeminiStructuredRequestEnvelope, workersAiStructuredInput, type GeminiStructuredRequest } from "../src/gemini";

const BUILD = process.env.BUILD_PRIMARY_EYE_PROVIDER_INSTRUCTION_PARITY === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/primary-eye-provider-instruction-parity-20260922-001");
const DUMMY_IMAGE = "data:image/jpeg;base64,/9j/";
const REFERENCE_SUFFIX = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const CLAUSES = {
  eyeSpacing: "Judge eyeSpacing as the distance between the two eyes relative to face width.",
  eyeOpenness: "Judge eyeOpenness from vertical eyelid aperture only: narrow means a visibly small vertical opening, normal means an ordinary vertical aperture, and open means a visibly large vertical aperture; do not derive it from one-eye width, inter-eye spacing, eyeSize, eyeliner, or brow position.",
  eyeFootprint: "Judge eyeFootprint as one eye's overall visible horizontal span relative to the face: compact means a visibly short one-eye span, medium means an ordinary span, and wide means a visibly long span; do not derive it from inter-eye spacing or vertical openness.",
  legacyBoundary: "Legacy renderHints are rendering choices, not evidence of observation.",
} as const;
const EYE_SIZE = "eyeSize describes the visible eye aperture relative to this person's face: small for compact or narrow openings, average for moderate openings, and large when the eyes are a dominant identity cue with clearly visible vertical iris/sclera area.";

type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: readonly unknown[];
  required?: readonly string[];
  minItems?: number;
  maxItems?: number;
};

const hash = (value: string | Buffer | object) => createHash("sha256")
  .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest("hex");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const valueSchema = (schema: unknown) => (schema as Schema).properties!.faceMeasurements.items!.properties!.value;
const measurementSchema = (schema: unknown) => (schema as Schema).properties!.faceMeasurements;

function audit() {
  const geminiPrompt = `${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}${REFERENCE_SUFFIX}`;
  const gemmaPrompt = `${GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT}${REFERENCE_SUFFIX}`;
  const request: GeminiStructuredRequest = {
    model: "gemini-3.8-flash",
    imageDataUrls: [DUMMY_IMAGE],
    prompt: geminiPrompt,
    responseSchema: COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
    workersAiResponseSchema: GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
    workersAiPrompt: gemmaPrompt,
    maxOutputTokens: 8192,
    timeoutCapMs: 45_000,
  };
  const gemini = buildGeminiStructuredRequestEnvelope(request);
  const gemma = workersAiStructuredInput(request, GEMMA_VISION_MODEL);
  const geminiParts = ((gemini.body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts ?? []);
  const geminiWirePrompt = geminiParts.at(-1)?.text as string;
  const gemmaMessages = gemma.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const gemmaTextParts = gemmaMessages[0]?.content.filter((part) => part.type === "text") ?? [];
  const gemmaWirePrompt = gemmaTextParts[0]?.text ?? "";

  expect(geminiWirePrompt).toBe(geminiPrompt);
  expect(gemmaWirePrompt).toBe(gemmaPrompt);
  expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT.startsWith(`${ANALYSIS_PROMPT}\n\n`)).toBe(true);
  expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT.startsWith(`${ANALYSIS_PROMPT}\n\n`)).toBe(true);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT.startsWith(`${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}\n\n`)).toBe(true);
  for (const clause of Object.values(CLAUSES)) {
    expect(occurrences(geminiWirePrompt, clause)).toBe(1);
    expect(occurrences(gemmaWirePrompt, clause)).toBe(1);
  }
  expect(geminiWirePrompt.indexOf(CLAUSES.eyeOpenness)).toBeLessThan(geminiWirePrompt.indexOf(EYE_SIZE));
  expect(gemmaWirePrompt.indexOf(CLAUSES.eyeOpenness)).toBeLessThan(gemmaWirePrompt.indexOf(EYE_SIZE));
  expect(geminiWirePrompt.indexOf(EYE_SIZE)).toBeLessThan(geminiWirePrompt.indexOf("COMPACT WIRE CONTRACT v3"));
  expect(gemmaWirePrompt.indexOf(EYE_SIZE)).toBeLessThan(gemmaWirePrompt.indexOf("GEMMA NAMED RENDERHINTS WIRE OVERRIDE"));

  const geminiMeasurement = measurementSchema(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
  const gemmaMeasurement = measurementSchema(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
  const compactV2Measurement = measurementSchema(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
  expect(gemmaMeasurement).toEqual(compactV2Measurement);
  expect(valueSchema(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA).enum).toEqual(valueSchema(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA).enum);
  expect(valueSchema(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA).enum).toEqual([...new Set(Object.values(FACE_MEASUREMENT_VALUES).flat())]);
  expect(geminiMeasurement.items!.properties!.provenance.enum).toEqual(gemmaMeasurement.items!.properties!.provenance.enum);
  expect(geminiMeasurement.items!.properties!.confidence.type).toBe(gemmaMeasurement.items!.properties!.confidence.type);
  expect(COMPACT_FACE_ORDER).toEqual(Object.keys(FACE_MEASUREMENT_VALUES));

  const axisRows = (["eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance", "browSlope"] as const).map((axis) => ({
    axis,
    canonicalValues: [...FACE_MEASUREMENT_VALUES[axis]],
    geminiSemanticInstruction: ["eyeSpacing", "eyeOpenness", "eyeFootprint"].includes(axis) ? "shared_exact_clause" : "shared_analysis_instruction",
    gemmaSemanticInstruction: ["eyeSpacing", "eyeOpenness", "eyeFootprint"].includes(axis) ? "shared_exact_clause" : "shared_analysis_instruction",
    geminiProviderEnum: "canonical_16_token_union",
    gemmaProviderEnum: "canonical_16_token_union",
    perSlotRuntimeVocabulary: [...FACE_MEASUREMENT_VALUES[axis]],
    parity: true,
  }));
  const sectionHashes = {
    analysisPromptSha256: hash(ANALYSIS_PROMPT),
    compactV2PromptSha256: hash(COMPACT_PHOTO_ANALYSIS_V2_PROMPT),
    compactV3PromptSha256: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
    gemmaNamedPromptSha256: hash(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT),
    geminiFinalPromptSha256: hash(geminiWirePrompt),
    gemmaFinalPromptSha256: hash(gemmaWirePrompt),
    clauseSha256: Object.fromEntries(Object.entries(CLAUSES).map(([name, clause]) => [name, hash(clause)])),
    compactV3SchemaSha256: hash(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA),
    gemmaNamedSchemaSha256: hash(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA),
  };
  const providerPaths = {
    gemini: {
      path: ["runPhotoAnalysis", "generateGeminiStructuredJson", "buildGeminiStructuredRequestEnvelope", "generateContent"],
      promptSource: "COMPACT_PHOTO_ANALYSIS_V3_PROMPT + referenceSuffix",
      requestLocation: "contents[0].parts[last].text",
      structuredSchemaLocation: "generationConfig.responseJsonSchema",
      systemInstruction: false,
      messageCount: 1,
      partCount: geminiParts.length,
      imageCount: 1,
      clarificationPresent: true,
      clarificationSection: "ANALYSIS_PROMPT / STEP 6",
      truncatedOrOverwritten: false,
    },
    gemma: {
      path: ["runPhotoAnalysis", "workersAiFallbackDecision", "runWorkersAiStructuredFallback", "workersAiStructuredInput", "AI.run"],
      promptSource: "GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + referenceSuffix",
      sharedChain: ["ANALYSIS_PROMPT", "COMPACT_PHOTO_ANALYSIS_V2_PROMPT", "COMPACT_PHOTO_ANALYSIS_V3_PROMPT", "GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT"],
      requestLocation: "messages[0].content[text].text",
      structuredSchemaLocation: "response_format.json_schema.schema",
      messageCount: gemmaMessages.length,
      textPartCount: gemmaTextParts.length,
      imageCount: 1,
      clarificationPresent: true,
      clarificationSection: "shared ANALYSIS_PROMPT / STEP 6",
      outcome: "A_exact_same_clause_included",
      truncatedOrOverwritten: false,
      adapterEffect: "post-response renderHints field-name mapping only; prompt and measurement values untouched",
    },
    syntheticInput: { actualSourceUsed: false, placeholderMime: "image/jpeg", rawBytes: 3, providerCalls: 0 },
  };
  const instructionParity = {
    sourceOfTruth: "workers/src/analysis.ts: ANALYSIS_PROMPT STEP 6",
    clauses: Object.fromEntries(Object.entries(CLAUSES).map(([name, clause]) => [name, {
      sha256: hash(clause), boundedExcerpt: clause.slice(0, 240), geminiCount: occurrences(geminiWirePrompt, clause), gemmaCount: occurrences(gemmaWirePrompt, clause),
    }])),
    propagation: providerPaths.gemma.sharedChain,
    geminiClarificationPresent: true,
    gemmaClarificationPresent: true,
    staleGemmaMeasurementPrompt: false,
    gemmaClassification: "A_exact_same_clause_included",
    intermediateLoss: false,
    ordering: {
      shared: ["faceMeasurement clarification", "generic classification", "legacy renderHints eyeSize", "compact wire contract"],
      gemmaAdditionalTail: "named renderHints representation override only",
      laterOverrideOfMeasurementMeaning: false,
    },
    eyeSizeCollision: {
      wording: EYE_SIZE,
      status: "residual_semantic_overlap_explicitly_disambiguated",
      evidence: "eyeSize still describes visible aperture, but the earlier measurement clause explicitly forbids deriving eyeOpenness from eyeSize and marks legacy renderHints as rendering choices rather than observation evidence",
      changedThisIteration: false,
    },
    liveInterpretation: "All three targeted results came from Gemma after it received the exact shared clarification. PROMPT_PATCH_NO_OBSERVED_EFFECT is therefore genuine small-set Gemma evidence, not an unpatched fallback-contract result.",
    parityBug: false,
    productionPatchRequired: false,
  };
  const schemaParity = {
    axes: axisRows,
    faceMeasurementValueEnumIdentical: true,
    faceMeasurementCoreFieldsSemanticallyIdentical: true,
    faceMeasurementItemPropertiesByteIdentical: false,
    semanticParity: true,
    exactWireSchemaIdentity: false,
    intentionalDifferences: {
      gemini: "Compact v3 provider-relaxed nested required/minimum/maximum and array bounds with critical enum retained",
      gemma: "Compact v2 strict bounds/required plus named renderHints objects",
    },
    eyeFieldDescriptions: { gemini: "enum-only provider schema", gemma: "enum-only provider schema", semanticDefinitionsSuppliedByPrompt: true },
    schemaChangedThisIteration: false,
  };
  return { providerPaths, instructionParity, schemaParity, sectionHashes };
}

it("proves Gemini and Gemma receive the same shared eye-axis clarification without a provider call", () => {
  const result = audit();
  expect(result.instructionParity).toMatchObject({ geminiClarificationPresent: true, gemmaClarificationPresent: true, intermediateLoss: false, parityBug: false });
  expect(result.schemaParity).toMatchObject({ faceMeasurementValueEnumIdentical: true, semanticParity: true, schemaChangedThisIteration: false });
  expect(result.providerPaths.syntheticInput.providerCalls).toBe(0);
});

it.skipIf(!BUILD)("writes secret-safe provider instruction parity artifacts", () => {
  const result = audit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("provider-paths.json", result.providerPaths);
  write("instruction-parity.json", result.instructionParity);
  write("schema-parity.json", result.schemaParity);
  write("prompt-section-hashes.json", result.sectionHashes);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Primary eye provider instruction parity\n\n` +
    `- External/provider calls: 0; actual JPEG/base64: 0.\n` +
    `- Gemini prompt path: ANALYSIS_PROMPT → Compact v2 → Compact v3 → generateContent text part.\n` +
    `- Gemma prompt path: the same chain → Gemma named-renderHints tail → Workers AI message text part.\n` +
    `- All four clarification clauses occur exactly once in both final request prompts.\n` +
    `- Gemma outcome: A, exact same clauses included; no intermediate adapter loss.\n` +
    `- Both provider schemas expose the same canonical 16-token faceMeasurements value union; per-cue runtime vocabularies are shared.\n` +
    `- Provider schemas intentionally differ in strict bounds/required and renderHints representation, not measurement meaning.\n` +
    `- Legacy eyeSize still overlaps aperture semantics, but explicit do-not-derive and legacy-rendering boundaries disambiguate it.\n` +
    `- Correct live interpretation: all three Gemma results tested the clarified contract and still returned normal/medium.\n` +
    `- Production changes: 0. Next step is offline observation/instruction-adherence diagnosis, not another prompt edit.\n\n` +
    `NEXT_QUALITY_TARGET: Gemma low-aperture/compact-eye observation limitation under confirmed instruction parity\n`, { flag: "wx" });
});
