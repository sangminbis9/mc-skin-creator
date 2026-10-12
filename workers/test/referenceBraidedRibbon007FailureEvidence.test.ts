// Offline evidence recovery only. Never imports or re-enters a live runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { expect, it } from "vitest";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { adaptGemmaNamedPhotoAnalysis, validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-007";
const bytes = readFileSync(`${root}/summary.json`), summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers immutable H-007 checkpoints and one-shot provider accounting independently of test exit", () => {
  expect(sha(bytes)).toBe("f5501471114d79cb1dcabebaf3907959397b6fa5d598245a6d60e1bb7d20951e");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(31);
  for (const name of names) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run).toMatchObject({ runId: "1e24b4d8669bb98fa40b732f9a1d5a07", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 502, elapsedMs: 20230, diskRecovery: true, png: null });
  expect(run.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400, elapsedMs: 1134 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 15904 }),
  ]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    providerStatus: "FAILED_PRECONDITION", fallbackEligible: true, fallbackReason: "provider_failed_precondition",
  }));
  expect(run.result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: false, strictErrors: ["sourceSelection.portraitEvidence: 근거가 너무 짧음"],
    normalizationPass: false, richValidationPass: false });
  expect(run.result.diagnostics.normalizedPrimary).toBeNull();
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.result.propagationTrace.primary).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
});

it("retains the same derivative identities and complete observed teardown", () => {
  const previous = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-006/summary.json", "utf8"));
  expect(run.result.inputs).toEqual(previous.currentDefaultE2E.result.inputs);
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, ptyExitObserved: true,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownedProcessInventoryClean: true,
    temporaryTokenFileRemoved: true, temporaryConfigRemoved: true, cleanupFailed: false, productionConfigChanged: false });
  expect(summary.shutdownLatch.phase).toBe("finalized");
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
});

// Synthetic boundary examples, NOT recovered provider strings. Actual H-007
// rejected prose was intentionally not stored, so its exact token is unknown.
it.each(["", "ab", "  ab  ", " | REGION:null", "ab | REGION:null", " | REGION:[0,0,1,1,0,0,1,0.7,0.2,0.1,0.8,0.6,0.9]"])(
  "keeps provider shape separate from the existing post-suffix prose minimum: %s", evidence => {
    const named = namedGemmaFixture(wireFixture(semanticFixture("plain")));
    named.sourceSelection.portraitEvidence = evidence;
    expect(validateGemmaNamedPhotoAnalysis(named)).toEqual([]);
    const adapted = adaptGemmaNamedPhotoAnalysis(named);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error("fixture_adapter_failed");
    expect(validateCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 }))
      .toContain("sourceSelection.portraitEvidence: 근거가 너무 짧음");
    expect(normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 }).ok).toBe(false);
    expect(named.sourceSelection.portraitEvidence).toBe(evidence);
  },
);

it.each(["abc", "Clear face in the sole supplied image | REGION:null"])(
  "retains valid existing descriptive evidence without coercion: %s", evidence => {
    const compact = wireFixture(semanticFixture("plain"));
    compact.sourceSelection.portraitEvidence = evidence;
    expect(validateCompactPhotoAnalysisV3(compact, { imageCount: 1 })).toEqual([]);
    expect(normalizeCompactPhotoAnalysisV3(compact, { imageCount: 1 }).ok).toBe(true);
    expect(compact.sourceSelection.portraitEvidence).toBe(evidence);
  },
);
