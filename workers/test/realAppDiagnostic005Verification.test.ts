// Offline disk recovery only. Never imports the remote runner or sends a request.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-005");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));
const run = summary.currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";

it("recovers every versioned checkpoint and the finalized consumed run", async () => {
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest?.event).toBe("auditLifecycleFinalized");
  expect(latest?.sequence).toBe(31);
  expect(latest?.snapshot).toEqual(summary);
  expect(latest?.snapshotSha256).toBe(sha(JSON.stringify(summary)));
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n));
  expect(records).toHaveLength(31);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(run).toMatchObject({ runId: "c70bbec824c62ef61b1364cedaca3b6c", generationPosts: 1,
    providerRetry: 0, httpStatus: 503, accounting: "known", diskRecovery: true });
});

it("uses the reinforced current V3 prompts, unchanged schemas and exact production derivatives", () => {
  expect(run.contract).toMatchObject({ version: "primary_compact_v3_legacy_suffix", primaryTimeoutMs: 45000,
    geminiPromptSha256: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix),
    gemmaPromptSha256: sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix),
    geminiSchemaSha256: sha(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)),
    gemmaSchemaSha256: sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)) });
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    source: { sha256: "f20d7f8ee7a7de7020077b20496e11e976abd7b0b7f31d6df04740ea2c19a273", bytes: 964297 },
    analysis: { sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa", bytes: 47293, width: 896, height: 896 },
    generation: { sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d", bytes: 17732, width: 448, height: 448 } });
  // Later authorized material fixes do not invalidate the immutable live run.
  // Pin its pre-fix source identity, while checking every other unchanged input.
  const recordedMaterial = Object.entries(run.fixedHashes).find(([file]) => file.replace(/\\/g, "/") === "src/outfitIdentity.ts");
  expect(recordedMaterial?.[1]).toBe("d3f9826ff501ffe37f0ad8da27ee2a362573dbf5ba06c32aafef3af8048c46b6");
  for (const [file, expected] of Object.entries(run.fixedHashes))
    if (file !== recordedMaterial?.[0]) expect(sha(fs.readFileSync(file))).toBe(expected);
});

it("records one eligible fallback followed by the local Gemma deadline, not a schema rejection", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 } });
  expect(run.result.bindingAttempts.map((v: { stage: string }) => v.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "gemini", outcome: "failed", status: 400, providerStatus: "FAILED_PRECONDITION",
    fallbackEligible: true, fallbackReason: "provider_failed_precondition" }));
  expect(run.result.diagnostics.primaryDiagnostic.providerAttempts).toContainEqual(expect.objectContaining({
    provider: "workers_ai", outcome: "failed", status: 504, providerStatus: "DEADLINE_EXCEEDED",
    origin: "LOCAL_DEADLINE", elapsedMs: 45000, deadlineTimerFired: true }));
  // The binding promise was pending when the handler deadline returned. Do not
  // infer cancellation, a remote completion, or a remote HTTP response.
  expect(run.result.bindingAttempts[1].completion).toBe("pending");
  expect(run.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerAttemptIntent: 2, providerAttemptStarted: 2, failureStage: "handler_response",
    failureCode: "production_handler_http_error", responseStatus: 503 });
});

it("leaves unobserved analysis, part/opening, families, parameters and PNG unfilled", () => {
  expect(run.result.diagnostics.primaryValidation).toBeNull();
  expect(run.result.diagnostics.normalizedPrimary).toBeNull();
  expect(run.result.diagnostics.geometry).toBeNull();
  expect(run.result.propagationTrace).toMatchObject({ primary: null, selectedFamilies: null,
    sourceParameters: null, injectedParameters: null, replay: null, finalPng: null, parameterEvidence: "unverified" });
  expect(run.png).toBeNull();
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
  expect(run.classification).toBe("CURRENT_DEFAULT_V3_E2E_FAILED");
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("proves one q, complete cleanup, unchanged source/config and immutable previous runs", () => {
  expect(summary).toMatchObject({ qSentCount: 1, cleanupFailed: false, wrapperExitObserved: true,
    wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, shutdownLatch: { phase: "finalized", qDispatched: true, qFailed: false } });
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json")))
    .toBe("c47ee4e58111e816a5cd1c27150028b229724e5b9f2ecce7e0e120796a706561");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-003/summary.json")))
    .toBe("083f811d9a7edb02954d80307c127856057505807f3e9a99f6d02ed5022aa767");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002/summary.json")))
    .toBe("cba7996d6cecd232d3903575ddc4f62ec8e199b8942459972f8a8bb3037b2ffa");
});

it("stores no raw provider/request/prompt/image/base64 or credential payload", () => {
  const forbidden = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const violations = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string" && /data:image\//i.test(v)) violations.add("image_data_url");
    if (typeof v === "string" && /Bearer\s+[A-Za-z0-9_-]+|(?:AIza|cfut_)[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{160,}={0,2}/.test(v))
      violations.add("credential_or_base64_value");
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") for (const [key, value] of Object.entries(v)) {
      if (forbidden.test(key)) violations.add("forbidden_payload_key"); scan(value);
    }
  };
  for (const file of fs.readdirSync(root).filter(n => n.endsWith(".json")))
    scan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  expect([...violations]).toEqual([]);
});
