// Offline only: every provider boundary is mocked; no live runner imported.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runPhotoAnalysis } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA,
  validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import type { Env } from "../src/types";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { GEMMA_SOURCE_EVIDENCE_REMINDER, withoutGemmaSourceEvidenceReminder } from "./gemmaSourceEvidencePromptSupport";
import { priorGemmaTupleSchema, withoutGemmaTupleSourceDelta } from "./historicalGemmaTuple";

const live = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-007/summary.json", "utf8")).currentDefaultE2E;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("changes only the exact source-independent Gemma V3 reminder relative to consumed H-007", () => {
  const previous = withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT);
  expect(hash(previous + suffix)).toBe(live.contract.gemmaPromptSha256);
  expect(hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix)).toBe(live.contract.geminiPromptSha256);
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toBe(live.contract.geminiSchemaSha256);
  expect(hash(JSON.stringify(priorGemmaTupleSchema()))).toBe(live.contract.gemmaSchemaSha256);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT).not.toContain(GEMMA_SOURCE_EVIDENCE_REMINDER);
  expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).not.toContain(GEMMA_SOURCE_EVIDENCE_REMINDER);
  // Immutable H-007/H-008 prove that historical prompt-only transition.
  // Later hair/renderer changes are not part of it; keep current freezes on
  // provider, normalization and input boundaries, reversing only reviewed deltas.
  const after = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-008/summary.json", "utf8")).currentDefaultE2E;
  expect(Object.keys(after.fixedHashes).sort()).toEqual(Object.keys(live.fixedHashes).sort());
  for (const [file, expected] of Object.entries(live.fixedHashes)) {
    const path = file.replace(/\\/g, "/");
    if (path !== "src/gemmaPhotoAnalysis.ts") expect(after.fixedHashes[file], file).toBe(expected);
    if (!/^(?:src\/(?:gemmaPhotoAnalysis|analysis|compactPhotoAnalysis(?:V[34])?|identityCrops|png)|test\/audit\/currentDefaultPreprocess)\.(?:ts|mjs)$/.test(path)) continue;
    const current = withoutGemmaTupleSourceDelta(path, readFileSync(file, "utf8"));
    const projected = path === "src/gemmaPhotoAnalysis.ts"
      ? withoutGemmaSourceEvidenceReminder(current) : current;
    expect(hash(projected), file).toBe(expected);
  }
  expect(GEMMA_SOURCE_EVIDENCE_REMINDER).toContain("Even with one image");
  expect(GEMMA_SOURCE_EVIDENCE_REMINDER).toContain("before the REGION suffix");
  expect(GEMMA_SOURCE_EVIDENCE_REMINDER).toContain("do not invent details or pad evidence");
  expect(GEMMA_SOURCE_EVIDENCE_REMINDER).not.toMatch(/braid|ribbon|29002888|image-16|20261010|runId/);
  expect(() => withoutGemmaSourceEvidenceReminder(previous)).toThrow();
  expect(() => withoutGemmaSourceEvidenceReminder(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + "\n" + GEMMA_SOURCE_EVIDENCE_REMINDER + "\n\n")).toThrow();
});

it.each(["portraitEvidence", "outfitEvidence", "generationEvidence"] as const)(
  "preserves strict %s rejection and acceptance with no input repair", key => {
    for (const evidence of ["", "ab", " ab ", "abc", "Observable view limitations"] ) {
      const compact = wireFixture(semanticFixture("plain"));
      compact.sourceSelection[key] = evidence;
      const before = JSON.stringify(compact);
      expect(validateGemmaNamedPhotoAnalysis(namedGemmaFixture(compact))).toEqual([]);
      const errors = validateCompactPhotoAnalysisV3(compact, { imageCount: 1 });
      if (evidence.trim().length < 3) expect(errors).toContain(`sourceSelection.${key}: 근거가 너무 짧음`);
      else expect(errors).toEqual([]);
      expect(normalizeCompactPhotoAnalysisV3(compact, { imageCount: 1 }).ok).toBe(evidence.trim().length >= 3);
      expect(JSON.stringify(compact)).toBe(before);
    }
  },
);

it.each([false, true])("dispatches the exact new prompt once and leaves suffix-only invalid=%s rejected", async invalid => {
  const compact = wireFixture(semanticFixture("plain"));
  compact.sourceSelection.portraitEvidence = invalid ? " | REGION:null" : "Visible face in the supplied image | REGION:null";
  const named = namedGemmaFixture(compact), before = JSON.stringify(named);
  const fetchMock = vi.fn(async () => Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);
  const run = vi.fn(async () => ({ response: named }));
  const env = { GEMINI_API_KEY: "offline-test-key", VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", AI: { run } } as unknown as Env;
  const result = await runPhotoAnalysis(env, "data:image/png;base64,AQID");
  expect(fetchMock).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  expect(result.ok).toBe(!invalid); expect(result.attempts).toBe(2);
  const args = vi.mocked(run).mock.calls[0] as unknown as [string, { messages: Array<{ content: Array<{ text?: string }> }> }];
  expect(args[0]).toBe("@cf/google/gemma-4-26b-a4b-it");
  expect(args[1].messages[0].content.at(-1)?.text).toBe(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix);
  expect(result.providerAttempts?.at(-1)).toMatchObject({ configuredDeadlineMs: 55000,
    providerSchemaValidation: "passed", strictValidation: invalid ? "failed" : "passed" });
  expect(JSON.stringify(named)).toBe(before);
});

it("stores hashes and scope only in a fresh offline artifact", () => {
  const root = mkdtempSync("evaluation-artifacts/gemma-source-evidence-offline-20261010-");
  writeFileSync(`${root}/contract.json`, JSON.stringify({
    previousGemmaPromptSha256: live.contract.gemmaPromptSha256,
    currentGemmaPromptSha256: hash(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix),
    geminiPromptSha256: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix),
    gemmaSchemaSha256: hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)),
    exactInverseDelta: true, change: "historical_Gemma_V3_source_selection_evidence_reminder_only",
    laterProviderTupleConstraint: "separately_verified", providerCalls: 0, strictRuntimeChanged: false, coercionAdded: false,
    actualRejectedProse: "not_stored_unknown", improvedModelCompliance: "not_established_offline",
  }, null, 2), { flag: "wx" });
  console.log(`GEMMA_SOURCE_EVIDENCE_OFFLINE ${root}`);
});
