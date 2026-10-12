// Offline prompt-contract verification; no claim of improved model compliance.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runPhotoAnalysis } from "../src/analysis";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, validateGemmaNamedPhotoAnalysis, adaptGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import type { Env } from "../src/types";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { GEMMA_EVIDENCE_REMINDER, withoutGemmaEvidenceReminder, withoutGemmaEvidenceSourceDelta } from "./gemmaEvidencePromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";
import { withoutGemmaSourceEvidenceReminder } from "./gemmaSourceEvidencePromptSupport";
import { priorGemmaTupleSchema, withoutGemmaTupleSourceDelta } from "./historicalGemmaTuple";

const live = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-floral-20261008-003/summary.json", "utf8"));
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
function fixture() {
  const value = wireFixture(semanticFixture("plain"));
  value.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  return value;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Preserve the historical whole-file assertions after the later confidence fix.
// Reverse only the exact reviewed delta; unrelated source edits still fail hashes.
function withoutLaterHairConfidenceDelta(file: string, source: string): string {
  source = withoutGemmaTupleSourceDelta(file, source);
  if (file === "src/analysis.ts") return withoutTiedHairObservation(source);
  function undo(before: string, after: string) {
    expect(source.split(after), `${file}: unique confidence delta`).toHaveLength(2);
    source = source.replace(after, before);
  }
  if (file === "src/headStructure.ts" || file === "src/identityPlans.ts") {
    const comment = file === "src/headStructure.ts"
      ? "  // Speculative identity text must not replace the observed texture grammar.\n"
      : "  // A low-confidence baldness claim cannot erase reliably observed hair.\n";
    undo("", comment);
    undo('features.filter(f => f.category === "hair").map(f => f.feature)',
      'features.filter(f => f.category === "hair" && f.confidence !== "low").map(f => f.feature)');
    if (file === "src/identityPlans.ts") {
      for (const categories of ['feature.category === "hair" || feature.category === "silhouette"',
        'feature.category === "hair" || feature.category === "accessory" || feature.category === "silhouette"']) {
        undo(`.filter((feature) => ${categories})`, `.filter((feature) => feature.confidence !== "low" && (${categories}))`);
      }
    }
  } else if (file === "src/headOwnership.ts") {
    undo("/** Only hair-owned evidence can affect this taxonomy (never bag/blazer adjectives). */",
      "/** Only reliable hair-owned evidence can affect this taxonomy (never bag/blazer adjectives). */");
    for (const signature of ["observedTiedHair(analysis: PhotoAnalysis): boolean", "quantizeTiedMassGeometry(analysis: PhotoAnalysis): TiedMassGeometry"]) {
      const prefix = `export function ${signature} {\n  const text = [analysis.observed.hair, ...analysis.canonicalIdentity.features.filter(f => f.category === "hair"`;
      undo(`${prefix}).map(f => f.feature)].join("; ");`, `${prefix} && f.confidence !== "low").map(f => f.feature)].join("; ");`);
    }
    undo('features.filter(f => f.category === "hair" || f.category === "accessory")',
      'features.filter(f => f.confidence !== "low" && (f.category === "hair" || f.category === "accessory"))');
  } else if (file === "src/referenceFaceFinish.ts") {
    // Later protected-mouth retention is independent of the consumed prompt run.
    undo("", [
      "  // A retained mouth must satisfy its source width, even without a P5 flag.",
      "  // Keep existing cells; never expand geometry or weaken the render contract.",
      "  // Explicit neutral omission remains an independent presentation decision.",
      '  const preserveMouthWidth = mouthPresentation === "retain_source"',
      "    && (pixels.renderContract.mouth?.minimumPerceptualWidth ?? 0) > mouthCells;", "",
    ].join("\n"));
    undo("expressionException || i < mouthCells ? lipFinish", "expressionException || preserveMouthWidth || i < mouthCells ? lipFinish");
  } else if (file === "src/identityQuantization.ts") {
    undo("", '    // Importance alone cannot turn a speculative claim into a protected contract.\n    if (feature.confidence === "low") continue;\n');
    undo('.filter((feature) => feature.priority === 5)', '.filter((feature) => feature.priority === 5 && feature.confidence !== "low")');
    undo('.filter((feature) => feature.category === "face")\n    .map((feature) => feature.feature)',
      '.filter((feature) => feature.category === "face" && feature.confidence !== "low")\n    .map((feature) => feature.feature)');
    undo('feature.priority === 5 && feature.category === "face" &&\n',
      'feature.priority === 5 && feature.category === "face" && feature.confidence !== "low" &&\n');
    undo('.filter((feature) => feature.category === "face").map((feature) => feature.confidence)',
      '.filter((feature) => feature.category === "face" && feature.confidence !== "low").map((feature) => feature.confidence)');
  } else if (file === "src/faceIdentitySalience.ts") {
    undo("", '    // A weak semantic guess cannot spend the source\'s facial pixel budget.\n    if (feature.confidence === "low") continue;\n');
    undo('feature.confidence === "high" ? 1 : feature.confidence === "medium" ? 0.72 : 0.42',
      'feature.confidence === "high" ? 1 : 0.72');
  } else if (file === "src/generate.ts") {
    // Later isolated eyewear-colour binding is not the consumed prompt-only run.
    // Reverse the exact reviewed block, not an arbitrary current-file exemption.
    undo([
      "    style.glassesColor =",
      "      recoverNamedColorNearItem(",
      "        glassesText,",
      '        "(?:glasses|spectacles|eyeglasses|frames)",',
      "        5,",
      "      ) ?? style.glassesColor;",
    ].join("\n"), String.raw`    // Do not flatten independent evidence into a new colour-to-item relation.
    // Observed clauses take precedence; speculative canonical colours cannot
    // override the structured palette. Preserve clause/field boundaries.
    const observedGlassesColorClauses = relevantClauseList(
      [analysis.observed.accessories, analysis.observed.face],
      /\b(?:glasses|spectacles|eyeglasses|frames)\b/,
    );
    const glassesColorClauses = observedGlassesColorClauses.length > 0
      ? observedGlassesColorClauses
      : relevantClauseList(
          [
            analysis.identityPrompt,
            analysis.canonicalIdentity.overallImpression,
            ...analysis.canonicalIdentity.mustPreserve,
            ...analysis.canonicalIdentity.features
              .filter(feature => feature.confidence !== "low" && feature.category === "accessory")
              .flatMap(feature => [feature.feature, feature.evidence]),
          ],
          /\b(?:glasses|spectacles|eyeglasses|frames)\b/,
        );
    style.glassesColor = glassesColorClauses
      .map(clause => recoverNamedColorNearItem(clause, "(?:glasses|spectacles|eyeglasses|frames)", 5))
      .find(color => color !== null) ?? style.glassesColor;`);
    // Later palette recovery rejects only explicitly low-confidence entries.
    undo("  const canonicalText = canonicalIdentityText(analysis);", [
      "  // Palette recovery may refine a coarse swatch, but not from speculative text.",
      "  // Keep the original analysis intact for provenance and other consumers.",
      "  const paletteFeatures = analysis.canonicalIdentity.features.filter(",
      '    (feature) => feature.confidence !== "low",',
      "  );",
      "  const canonicalText = canonicalIdentityText({",
      "    ...analysis,",
      "    canonicalIdentity: { ...analysis.canonicalIdentity, features: paletteFeatures },",
      "  });",
    ].join("\n"));
    undo("...analysis.canonicalIdentity.features.flatMap((feature) => [", "...paletteFeatures.flatMap((feature) => [");
    undo("", [
      "  // Speculative head/face claims cannot override observed appearance after planning.",
      "  // Preserve the original evidence; filter only these late style consumers.",
      "  const headFeatures = analysis.canonicalIdentity.features.filter(",
      '    (feature) => !["hair", "accessory", "face", "silhouette"].includes(feature.category) || feature.confidence !== "low",',
      "  );",
      "  const headCanonicalText = canonicalIdentityText({",
      "    ...analysis,",
      "    canonicalIdentity: {",
      "      ...analysis.canonicalIdentity,",
      "      features: headFeatures,",
      "    },",
      "  });", "",
    ].join("\n"));
    undo("    canonicalText,\n  ];\n  const hairIdentityText",
      "    headCanonicalText,\n  ];\n  const hairIdentityText");
    undo("      canonicalText,\n    )\n  ) {\n    style.faceShape",
      "      headCanonicalText,\n    )\n  ) {\n    style.faceShape");
    const headFeatureUse = "...headFeatures.flatMap(feature => [feature.feature, feature.evidence])";
    expect(source.split(headFeatureUse), "two independent clause consumers").toHaveLength(3);
    source = source.replaceAll(headFeatureUse, "...analysis.canonicalIdentity.features.flatMap(feature => [feature.feature, feature.evidence])");
  }
  return source;
}

it("adds exactly one source-independent terminal reminder to Gemma V3, retaining the frozen prior prefix", () => {
  const old = withoutGemmaEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT);
  expect(hash(withoutTiedHairObservation(old) + suffix)).toBe(live.currentDefaultE2E.contract.gemmaPromptSha256);
  expect(withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)).toBe(`${old}\n\n${GEMMA_EVIDENCE_REMINDER}`);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT.split(GEMMA_EVIDENCE_REMINDER)).toHaveLength(2);
  expect(GEMMA_EVIDENCE_REMINDER).toContain("not certainty that the cue is unavailable");
  expect(GEMMA_EVIDENCE_REMINDER).toContain('{"value":"unknown","provenance":"unknown","confidence":0}');
  expect(GEMMA_EVIDENCE_REMINDER).toContain("Do not raise confidence or invent a cue");
  expect(GEMMA_EVIDENCE_REMINDER).not.toMatch(/floral|browEyeDistance|0\.8|29002888|reference E|runId|20261008/);
  expect(() => withoutGemmaEvidenceReminder(old)).toThrow();
  expect(() => withoutGemmaEvidenceReminder(`${GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT}\n\n${GEMMA_EVIDENCE_REMINDER}`)).toThrow();
});

it("retains the provider boundary and proves the consumed 003-to-004 change was prompt-only", () => {
  expect(hash(withoutTiedHairObservation(COMPACT_PHOTO_ANALYSIS_V3_PROMPT) + suffix)).toBe(live.currentDefaultE2E.contract.geminiPromptSha256);
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(live.currentDefaultE2E.contract.geminiSchemaSha256);
  expect(hash(JSON.stringify(priorGemmaTupleSchema()))).toBe(live.currentDefaultE2E.contract.gemmaSchemaSha256);
  expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).not.toContain(GEMMA_EVIDENCE_REMINDER);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT).not.toContain(GEMMA_EVIDENCE_REMINDER);
  expect(hash(withoutGemmaEvidenceSourceDelta(withoutGemmaTupleSourceDelta("src/gemmaPhotoAnalysis.ts", readFileSync("src/gemmaPhotoAnalysis.ts", "utf8")))))
    .toBe(live.currentDefaultE2E.fixedHashes["src\\gemmaPhotoAnalysis.ts"]);
  // The historical prompt-only transition remains exact. Subsequent outfit
  // evidence work is not part of that transition; do not rewrite either run.
  const after = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-floral-20261008-004/summary.json", "utf8"));
  expect(Object.keys(after.currentDefaultE2E.fixedHashes).sort()).toEqual(Object.keys(live.currentDefaultE2E.fixedHashes).sort());
  for (const [file, expected] of Object.entries(live.currentDefaultE2E.fixedHashes)) {
    if (file.replace(/\\/g, "/") === "src/gemmaPhotoAnalysis.ts") continue;
    expect(after.currentDefaultE2E.fixedHashes[file], file).toBe(expected);
    // The immutable 003/004 snapshots above prove the historical prompt-only
    // transition for EVERY recorded file. Current renderer files have since
    // changed (including ribbon ownership); they are not that historical run.
    // Keep current-file freezes on the provider/normalization/input boundary.
    if (!/^(?:src\/(?:analysis|compactPhotoAnalysis(?:V[34])?|identityCrops|png)|test\/audit\/currentDefaultPreprocess)\.(?:ts|mjs)$/.test(file.replace(/\\/g, "/"))) continue;
    if (file.replace(/\\/g, "/") === "src/headStructure.ts") {
      // Later wave-foundation finishing is not the historical prompt change.
      // Reverse exactly that source delta; do not exempt arbitrary head edits.
      const current = withoutLaterHairConfidenceDelta("src/headStructure.ts", readFileSync(file, "utf8"));
      const projected = current
        .replace("// Straight/wavy foundations flow down the owned side/rear mask.", "// A straight foundation flows down the owned side/rear mask.")
        .replace("// interior material; crown/part and the independent curved strand\n        // groups stay intact. Curl/coil/lock material is not changed here.", "// interior material; crown/part and non-straight texture stay intact.")
        .replace('(grammar === "straight_bands" || grammar === "wavy_bands") && face !== "top"', 'grammar === "straight_bands" && face !== "top"');
      expect(projected).not.toBe(current);
      expect(hash(projected), file).toBe(expected);
      continue;
    }
    // Subsequent motif planning and sleeve placement are separate changes.
    // Provider, normalization, crop and preprocessing files remain exact.
    if (["src/outfitIdentity.ts", "src/referenceStyleTemplates.ts", "src/outfitRenderer.ts"].includes(file.replace(/\\/g, "/"))) continue;
    expect(hash(withoutLaterHairConfidenceDelta(file.replace(/\\/g, "/"), readFileSync(file, "utf8"))), file).toBe(expected);
  }
});

it("keeps all eight cue contracts strict and never mutates a rejected tuple", () => {
  const base = fixture();
  expect(validateCompactPhotoAnalysisV3(base, { imageCount: 1 })).toEqual([]);
  for (const [index, cue] of COMPACT_FACE_ORDER.entries()) {
    const invalid = structuredClone(base);
    invalid.faceMeasurements![index].confidence = 0.8;
    const before = JSON.stringify(invalid);
    expect(validateCompactPhotoAnalysisV3(invalid, { imageCount: 1 })).toEqual([`faceMeasurements[${index}]:evidenceContract`]);
    expect(normalizeCompactPhotoAnalysisV3(invalid, { imageCount: 1 }).ok).toBe(false);
    expect(JSON.stringify(invalid)).toBe(before);
    for (const value of FACE_MEASUREMENT_VALUES[cue].filter(value => value !== "unknown")) {
      const known = structuredClone(base);
      known.faceMeasurements![index] = { value, provenance: "observed_categorical", confidence: 0.75 };
      expect(validateCompactPhotoAnalysisV3(known, { imageCount: 1 }), cue).toEqual([]);
      known.faceMeasurements![index].confidence = 0.749;
      expect(validateCompactPhotoAnalysisV3(known, { imageCount: 1 })).toEqual([`faceMeasurements[${index}]:evidenceContract`]);
      known.faceMeasurements![index].confidence = 0.9;
      known.visibleRegions.face = false;
      expect(validateCompactPhotoAnalysisV3(known, { imageCount: 1 })).toEqual([`faceMeasurements[${index}]:evidenceContract`]);
    }
  }
});

it.each([false, true])("uses the real V3 fallback path once; inconsistent unknown=%s remains rejected, without data repair", async invalid => {
  const compact = fixture();
  if (invalid) compact.faceMeasurements![3].confidence = 0.8;
  const named = namedGemmaFixture(compact), frozen = JSON.stringify(named);
  expect(validateGemmaNamedPhotoAnalysis(named)).toEqual(invalid ? ["gemma.faceMeasurements[3]:anyOf"] : []);
  const adapted = adaptGemmaNamedPhotoAnalysis(named);
  expect(adapted.ok).toBe(!invalid);
  const fetchMock = vi.fn(async () => Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const run = vi.fn(async () => ({ response: named }));
  const env = { GEMINI_API_KEY: "offline-test-key", VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", AI: { run } } as unknown as Env;
  const result = await runPhotoAnalysis(env, "data:image/png;base64,AQID");
  expect(result.ok).toBe(!invalid);
  expect(result.attempts).toBe(2);
  expect(fetchMock).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  const args = vi.mocked(run).mock.calls[0] as unknown as [string, { messages: Array<{ content: Array<{ text?: string }> }> }];
  expect(args).toHaveLength(2);
  expect(args[1]).toMatchObject({ response_format: {
    type: "json_schema", json_schema: { schema: GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, strict: true },
  } });
  expect(args[1].messages[0].content.at(-1)?.text).toBe(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix);
  expect(result.providerAttempts?.at(-1)).toMatchObject({ configuredDeadlineMs: 55000,
    providerSchemaValidation: invalid ? "failed" : "passed", strictValidation: invalid ? "failed" : "passed" });
  if (!result.ok) expect(result.reason).toBe("invalid_response");
  expect(JSON.stringify(named)).toBe(frozen);
});

it("writes only safe prompt hashes and scope metadata to a fresh offline evidence root", () => {
  const root = mkdtempSync("evaluation-artifacts/gemma-evidence-reminder-offline-20261008-");
  writeFileSync(`${root}/contract.json`, JSON.stringify({
    beforePromptSha256: live.currentDefaultE2E.contract.gemmaPromptSha256,
    afterPromptSha256: hash(withoutTiedHairObservation(withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT)) + suffix),
    scope: "historical_reminder_delta_excludes_later_tied_hair_and_provider_tuple_constraint",
    prefixEquality: true, schemaSha256: hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)),
    appendedChars: GEMMA_EVIDENCE_REMINDER.length + 2,
    change: "Gemma_V3_only_terminal_evidence_consistency_reminder",
    sourceSpecificBranch: false, strictRuntimeChanged: false, coercionAdded: false,
    modelComplianceImproved: "unproven_offline", providerCalls: 0,
  }, null, 2), { flag: "wx" });
  console.log(`GEMMA_EVIDENCE_REMINDER_OFFLINE ${root}`);
});
