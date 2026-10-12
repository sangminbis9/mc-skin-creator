import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { failedE2EFaceMeasurement } from "./audit/currentDefaultE2E";
import { wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";
import { COMPACT_FACE_ORDER } from "../src/compactPhotoAnalysis";
import { validateCompactPhotoAnalysisV3, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers actual 029 failure, exact accounting and complete teardown without rerunning it", () => {
  const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-029";
  const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result;
  const history = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-offline-preflight-20260926-Ut0NWx/verification.json", "utf8"));
  for (const [file, hash] of Object.entries(history.preservedHashes)) expect(sha(readFileSync(file))).toBe(hash);
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  for (const [i, file] of files.entries()) { const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256); }
  expect(JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8")).snapshot).toEqual(s);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 }, qSentCount: 1,
    cleanupFailed: false, ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, ownerResultFlushed: true, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerExitObserved: true, ownerCloseObserved: true, wrapperExitCode: 0, ptyExitCode: 0, ownerExitCode: 0 });
  expect(e).toMatchObject({ generationPosts: 1, providerRetry: 0, httpStatus: 502, accounting: "known", diskRecovery: true, png: null });
  const changed = Object.entries(e.fixedHashes).filter(([file, hash]) => sha(readFileSync(file)) !== hash);
  expect(changed).toEqual([]);
  const prior = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-028/summary.json", "utf8")).currentDefaultE2E;
  for (const key of ["analysis", "generation"]) expect(e.preprocessing[key]).toEqual(prior.preprocessing[key]);
  expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(r.bindingAttempts.every((a: { completion: string }) => a.completion === "returned")).toBe(true);
  expect(r.diagnostics.primaryDiagnostic.providerAttempts[1]).toMatchObject({ status: 503, providerStatus: "UNAVAILABLE", fallbackEligible: true });
  expect(r.diagnostics.primaryValidation).toMatchObject({ providerShapePass: true, strictRuntimePass: false,
    strictErrors: ["faceMeasurements[3]:evidenceContract", "faceMeasurements[4]:evidenceContract"], normalizationPass: false, richValidationPass: false });
  expect(r.diagnostics.normalizedPrimary).toBeNull(); expect(r.diagnostics.geometry).toBeNull();
  expect(r.diagnostics.failedFaceMeasurement).toBeUndefined();
  expect([COMPACT_FACE_ORDER[3], COMPACT_FACE_ORDER[4]]).toEqual(["browEyeDistance", "browSlope"]);
  const out = mkdtempSync("evaluation-artifacts/current-029-failure-verification-20260928-");
  writeFileSync(`${out}/verification.json`, JSON.stringify({ summarySha256: sha(bytes), checkpointCount: files.length,
    historicalFilesPreserved: Object.keys(history.preservedHashes).length, productionChangesSinceLive: changed,
    gate: e.e2eGateTrace, primaryValidation: r.diagnostics.primaryValidation,
    liveAccounting: { startup: 1, health: 1, post: 1, gemini: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
    png: null, actualFailedCueValuesAvailable: false, networkCallsThisVerification: 0,
    limitation: "Exact value/provenance/confidence were not captured in 029. Do not infer a subtype or salvage rejected cues." }, null, 2));
  console.info(`FAILURE_029_VERIFICATION ${out}`);
});

function fixture() {
  const raw = wireFixture(makeAnalysis());
  raw.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
  return raw;
}
it.each([
  { value: "normal", provenance: "observed_categorical", confidence: 0.5 },
  { value: "unknown", provenance: "observed_categorical", confidence: 0.8 },
  { value: "normal", provenance: "unknown", confidence: 0 },
  { value: "unknown", provenance: "unknown", confidence: 0.5 },
] as const)("synthetic evidence-contract rejection stays rejected: %j", cue => {
  const raw = fixture(); raw.faceMeasurements![3] = { ...cue };
  const before = JSON.stringify(raw), errors = validateCompactPhotoAnalysisV3(raw, { imageCount: 1 });
  expect(errors).toEqual(["faceMeasurements[3]:evidenceContract"]);
  expect(failedE2EFaceMeasurement(raw, errors)).toEqual({ index: 3, cue: "browEyeDistance", ...cue,
    allowedValuesForCue: ["close", "normal", "high", "unknown"], faceVisible: true });
  expect(validateCompactPhotoAnalysisV3(raw, { imageCount: 1 })).toEqual(errors);
  expect(normalizeCompactPhotoAnalysisV3(raw, { imageCount: 1 }).ok).toBe(false);
  expect(JSON.stringify(raw)).toBe(before);
});
it("records only the first failing cue and never another cue or free-text payload", () => {
  const raw = fixture(); raw.faceMeasurements![3] = { value: "normal", provenance: "observed_categorical", confidence: 0.5 };
  raw.faceMeasurements![4] = { value: "arched", provenance: "observed_categorical", confidence: 0.5 };
  const errors = validateCompactPhotoAnalysisV3(raw, { imageCount: 1 });
  const d = failedE2EFaceMeasurement(raw, errors)!;
  expect(d.cue).toBe("browEyeDistance"); expect(JSON.stringify(d)).not.toContain("arched");
  expect(Object.keys(d).sort()).toEqual(["index", "cue", "value", "provenance", "confidence", "allowedValuesForCue", "faceVisible"].sort());
  raw.faceMeasurements![3].value = "data:image/png;base64,not-an-image";
  expect(failedE2EFaceMeasurement(raw, errors)?.value).toBe("[redacted]");
  expect(failedE2EFaceMeasurement(raw, ["faceMeasurements[x]:evidenceContract"])).toBeNull();
  expect(failedE2EFaceMeasurement(raw, ["compact.renderHints:required"])).toBeNull();
  expect(failedE2EFaceMeasurement(raw, ["faceMeasurements[99]:evidenceContract"])).toBeNull();
});
it("does not add diagnostics to valid unknown and observed cues", () => {
  for (const cue of [{ value: "unknown", provenance: "unknown", confidence: 0 },
    { value: "normal", provenance: "observed_categorical", confidence: 0.75 }] as const) {
    const raw = fixture(); raw.faceMeasurements![3] = { ...cue };
    expect(validateCompactPhotoAnalysisV3(raw, { imageCount: 1 })).toEqual([]);
    expect(failedE2EFaceMeasurement(raw, [])).toBeNull();
    expect(normalizeCompactPhotoAnalysisV3(raw, { imageCount: 1 }).ok).toBe(true);
  }
});
