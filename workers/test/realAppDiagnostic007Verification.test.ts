// Offline recovery of the consumed -007. Never imports a live selector.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-007");
const bytes = fs.readFileSync(path.join(root, "summary.json"));
const summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E;
const result = run.result;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers the finalized single-use -007 and every versioned checkpoint without another request", async () => {
  expect(sha(bytes)).toBe("833afd87eb395fa31dfaa3366124ce59053f235e2ebd6b3d18d51ba01ecb3bf7");
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest).toMatchObject({ sequence: 31, event: "auditLifecycleFinalized",
    snapshotSha256: "59d369fca885aab6b8a58c0ea702eb69e9967b3b87ca1d169d3c3d872b34c478" });
  expect(latest?.snapshot).toEqual(summary);
  const records = fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n));
  expect(records).toHaveLength(31);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(run).toMatchObject({ runId: "82df4022d2d71554709eff5f93fdfd40", generationPosts: 1,
    providerRetry: 0, accounting: "known", diskRecovery: true, httpStatus: 503, elapsedMs: 52811 });
});

it("uses exact approved derivatives and the current material correction, with every production file frozen", () => {
  expect(run.preprocessing).toMatchObject({ rawOriginalTransmitted: false,
    source: { bytes: 964297, sha256: "f20d7f8ee7a7de7020077b20496e11e976abd7b0b7f31d6df04740ea2c19a273" },
    analysis: { width: 896, height: 896, bytes: 47293,
      sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa" },
    generation: { width: 448, height: 448, bytes: 17732,
      sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d" } });
  expect(run.contract).toMatchObject({ version: "primary_compact_v3_legacy_suffix", primaryTimeoutMs: 45000,
    geometryTimeoutMs: 25000, geminiPromptSha256: "c0ed0cfa381dd6e94d011db62627fe18ea19e86f5bfd784836252e948e3a1e9a",
    gemmaPromptSha256: "15957760281e23f312a754d968604801d0481a36db63487662efe68294241f21",
    geminiSchemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986",
    gemmaSchemaSha256: "ef271dc3ed81f9cbb9d30144e4abb659ea3ccf601683d9952228dd70a9bdeb0e" });
  for (const [file, hash] of Object.entries(run.fixedHashes)) expect(sha(fs.readFileSync(file))).toBe(hash);
  const materialEntry = Object.entries(run.fixedHashes).find(([file]) => file.replace(/\\/g, "/") === "src/outfitIdentity.ts");
  expect(materialEntry).toBeDefined();
  expect(materialEntry?.[1]).not.toBe("d3f9826ff501ffe37f0ad8da27ee2a362573dbf5ba06c32aafef3af8048c46b6");
  expect(fs.readFileSync("src/outfitIdentity.ts", "utf8")).toContain("charcoal(?:[- ]gr[ae]y)?|dark[- ]gr[ae]y");
});

it("records exactly one eligible Gemini failure and one Gemma local deadline, not provider success", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 } });
  expect(result.bindingAttempts.map((v: { stage: string }) => v.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
  const attempts = result.diagnostics.primaryDiagnostic.providerAttempts;
  expect(attempts.filter((v: { outcome: string }) => v.outcome === "started")).toHaveLength(2);
  expect(attempts.filter((v: { outcome: string }) => v.outcome === "completed")).toHaveLength(0);
  expect(attempts).toContainEqual(expect.objectContaining({ provider: "gemini", outcome: "failed", status: 503,
    providerStatus: "UNAVAILABLE", fallbackEligible: true, elapsedMs: 4062 }));
  expect(attempts).toContainEqual(expect.objectContaining({ provider: "workers_ai", outcome: "failed", status: 504,
    providerStatus: "DEADLINE_EXCEEDED", origin: "LOCAL_DEADLINE", deadlineTimerFired: true, elapsedMs: 45000 }));
  expect(result.diagnostics.primaryDiagnostic).toMatchObject({ ok: false, attempts: 2, reason: "provider_unavailable" });
  expect(run.e2eGateTrace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
    providerDispatchObserved: true, providerAttemptIntent: 2, providerAttemptStarted: 2,
    failureStage: "handler_response", failureCode: "production_handler_http_error", responseStatus: 503 });
});

it("separates late binding inspection from production acceptance and never salvages a final PNG", () => {
  // The passive binding hook observed valid values after the local deadline.
  // Passing shape/normalization here is not proof the production handler used them.
  expect(result.bindingAttempts[1]).toMatchObject({ completion: "returned", elapsedMs: 46434, httpStatus: null });
  expect(result.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
    strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
  expect(result).toMatchObject({ ok: false, productionStatus: 503, errorCode: "provider_unavailable" });
  const trace = result.propagationTrace;
  expect(trace.parameterEvidence).toBe("unverified");
  for (const field of ["selectedFamilies", "injectedParameters", "replay", "finalPng"])
    expect(trace[field]).toBeNull();
  expect(trace.referenceStyle).toEqual({});
  expect(trace.skinPlan).toEqual({ skinPlan: null });
  expect(run.png).toBeNull(); expect(run.propagationLink).toBeNull();
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
  expect(summary.classification).toBe("CURRENT_DEFAULT_V3_E2E_FAILED");
});

it("retains actual observed cues without borrowing -006 charcoal or hair expectations", () => {
  const primary = result.diagnostics.normalizedPrimary;
  expect(primary.observed.clothing).toContain("dark, formal suit jacket");
  expect(primary.observed.clothing.toLowerCase()).not.toContain("charcoal");
  expect(primary.renderHints).toMatchObject({ hairPart: "none", fringeOpening: "center",
    overallHairLength: "ear", sideHairLength: "short" });
  expect(result.diagnostics.localization.status).toBe("INVALID_REGION");
  expect(primary.sourceSelection.portraitRegion).toBeNull();
  expect(result.diagnostics.geometry).toBeNull();
  expect(result.bindingAttempts.some((v: { stage: string }) => v.stage === "faceGeometry")).toBe(false);
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
});

it("confirms one q, clean graceful teardown and unchanged historical evidence", () => {
  expect(summary).toMatchObject({ qSentCount: 1, cleanupFailed: false, wrapperExitObserved: true,
    wrapperCloseObserved: true, wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0,
    ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, shutdownLatch: { phase: "finalized", qDispatched: true, qFailed: false } });
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-006/summary.json")))
    .toBe("7db087c1e533df73d22a6ab78ce9fd6a40320bbeeb44e0dcbc67f5503e2c9d4d");
});

it("stores no raw request/response/prompt/image or credentials in any checkpoint", () => {
  const forbidden = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const violations: string[] = [];
  const scan = (v: unknown): void => {
    if (typeof v === "string" && /data:image\/|Bearer\s+[A-Za-z0-9_-]+|(?:AIza|cfut_)[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{160,}={0,2}/.test(v))
      violations.push("forbidden_value");
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") for (const [key, value] of Object.entries(v)) {
      if (forbidden.test(key)) violations.push("forbidden_key"); scan(value);
    }
  };
  for (const name of fs.readdirSync(root).filter(n => n.endsWith(".json")))
    scan(JSON.parse(fs.readFileSync(path.join(root, name), "utf8")));
  expect(violations).toEqual([]);
});
