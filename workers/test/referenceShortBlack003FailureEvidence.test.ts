// Offline recovery only: never import the live runner or reconstruct raw output.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { PHOTO_ANALYSIS_SCHEMA } from "../src/analysis";
import { COMPACT_HINT_GROUPS, COMPACT_PHOTO_ANALYSIS_V2_PROMPT, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, validateCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3Provider } from "../src/compactPhotoAnalysisV3";
import { semanticFixture, wireFixture } from "./compactV3Support";
import { freshAuditOutput } from "./freshAuditOutput";

const root = "evaluation-artifacts/reference-style-v3-e2e-short-black-sweatshirt-20261010-003";
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
const e = s.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers consumed B003, distinguishing a successful HTTP transport from rejected semantics", () => {
  expect(sha(bytes)).toBe("acabc9acdf21f4d8897e580383491b3d1275ed42b372cbae043d66df52e58a94");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names.length).toBeGreaterThan(0);
  for (const [i, name] of names.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(e).toMatchObject({ runId: "19f896ef70f67f0cd625c9a1b992360f", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 502, elapsedMs: 20287, diskRecovery: true });
  expect(e.result.bindingAttempts).toEqual([expect.objectContaining({ stage: "geminiPrimary",
    completion: "returned", httpStatus: 200, elapsedMs: 17054 })]);
  expect(e.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: false, strictErrors: ["renderHints.hairLength[1]:fieldVocabulary"],
    normalizationPass: false, richValidationPass: false });
  expect(e.result.propagationTrace.primary).toBeNull();
  expect(e.result.propagationTrace.finalPng).toBeNull();
  expect(e.result.diagnostics.geometry).toBeNull();
  expect(readdirSync(root)).not.toContain("skin.png");
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(Object.values(s.prohibited).every(v => v === 0)).toBe(true);
});

it("audits per-slot hair length vocabularies without claiming the absent actual provider token", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const keys = COMPACT_HINT_GROUPS.hairLength;
    expect(keys).toEqual(["overallHairLength", "sideHairLength"]);
    const props = PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties;
    const allowed = keys.map(key => [...props[key].enum]);
    expect(allowed[1]).toEqual(["none", "short", "cheek", "jaw", "shoulder"]);
    const union = [...new Set(allowed.flat())];
    expect(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA.properties!.renderHints.properties!.hairLength.items!.enum).toEqual(union);
    for (const [i, key] of keys.entries()) {
      const exactLine = `  ${i}: ${key} = ${allowed[i].join(" | ")}`;
      expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT).toContain(exactLine);
      expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).toContain(exactLine);
    }
    // Exhaustive authored cases: these are NOT recovered provider tokens.
    const matrix = [];
    for (const [i, key] of keys.entries()) for (const value of union) {
      const wire = wireFixture(semanticFixture("plain"));
      wire.renderHints.hairLength[i] = value;
      expect(validateCompactPhotoAnalysisV3Provider(wire)).toEqual([]);
      const errors = validateCompactPhotoAnalysisV3(wire, { imageCount: 1 });
      const accepted = allowed[i].includes(value);
      expect(errors).toEqual(accepted ? [] : [`renderHints.hairLength[${i}]:fieldVocabulary`]);
      matrix.push({ index: i, cue: key, syntheticValue: value, strictAccepted: accepted });
    }
    const out = freshAuditOutput("evaluation-artifacts/reference-short-black-003-failure-review-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_consumed_live_review", runId: e.runId,
      sourceSummarySha256: sha(bytes), classification: "provider_output_slot_vocabulary_noncompliance",
      errorPath: "renderHints.hairLength[1]:fieldVocabulary", cue: keys[1], allowedValues: allowed[1],
      actualProviderToken: null, actualTokenRecoverable: false, promptRuntimeVocabularyDrift: false,
      syntheticMatrix: matrix, providerCallsInLiveRun: { gemini: 1, gemma: 0, geometry: 0, retry: 0 },
      newProviderCalls: 0, clothingLiveDeliveryVerified: false, validatorChanged: false }, null, 2), { flag: "wx" });
    console.info("B003_FAILURE_REVIEW", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
});
