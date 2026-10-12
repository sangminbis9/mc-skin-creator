// Read-only recovery of consumed B-001. No live runner imports or requests.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import Ajv from "ajv";
import { expect, it, vi } from "vitest";
import { GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA, validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { partialGemmaTupleSchema } from "./historicalGemmaTuple";

const root = "evaluation-artifacts/reference-style-v3-e2e-short-black-sweatshirt-20261010-001";
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
const e = s.currentDefaultE2E, d = e.result.diagnostics;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const paths = Array.from({ length: 8 }, (_, index) => [
  `gemma.faceMeasurements[${index}].provenance:required`,
  `gemma.faceMeasurements[${index}].confidence:required`,
]).flat();

it("recovers immutable finalized checkpoints and records actual provider failure, not a likeness result", () => {
  expect(sha(bytes)).toBe("49866e567b408bf6933de6c20a9809de06d96abfef9d599e10a473dc38866f10");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  // Snapshot counter precedes the finalization write; disk has 31 versions.
  expect(names).toHaveLength(31);
  for (const [i, name] of names.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(e).toMatchObject({ runId: "a357fdeeb1671be38a6c16602cbdf040", generationPosts: 1,
    providerRetry: 0, accounting: "known", httpStatus: 502, elapsedMs: 40854, diskRecovery: true,
    png: null, propagationLink: null, classification: "CURRENT_DEFAULT_V3_E2E_FAILED" });
  expect(e.result.bindingAttempts).toEqual([
    expect.objectContaining({ stage: "geminiPrimary", completion: "returned", httpStatus: 400 }),
    expect.objectContaining({ stage: "gemmaPrimary", completion: "returned", elapsedMs: 36826, httpStatus: null }),
  ]);
  expect(d.primaryDiagnostic.providerAttempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "gemini", outcome: "failed", status: 400,
      providerStatus: "FAILED_PRECONDITION", fallbackEligible: true, fallbackReason: "provider_failed_precondition" }),
    expect.objectContaining({ provider: "workers_ai", outcome: "completed", providerSchemaValidation: "failed",
      deadlineTimerFired: false }),
  ]));
  expect(d.primaryValidation).toEqual({ providerShapePass: false, providerErrors: paths,
    strictRuntimePass: false, strictErrors: [], normalizationPass: false, richValidationPass: false });
  expect(d.normalizedPrimary).toBeNull(); expect(d.geometry).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
});

it("proves missing evidence is invalid in the transmitted schema without reconstructing provider values", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const transmitted = partialGemmaTupleSchema();
    expect(sha(JSON.stringify(transmitted))).toBe(e.contract.gemmaSchemaSha256);
    const item = transmitted.properties!.faceMeasurements.items!;
    expect(item.required).toEqual(["value", "provenance", "confidence"]);
    const validate = new Ajv({ allErrors: true }).compile(transmitted);
    const named = namedGemmaFixture(wireFixture(semanticFixture("plain")));
    // Authored shape-only counterexample. Actual returned values were not saved.
    const modeled = { ...named, faceMeasurements: Array.from({ length: 8 }, () => ({ value: "unknown" })) };
    const before = JSON.stringify(modeled);
    expect(validate(modeled)).toBe(false);
    expect(new Ajv().compile(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)(modeled)).toBe(false);
    // Self-contained branches add anyOf diagnostics; all original missing paths
    // remain visible and the failure is not silently accepted or repaired.
    expect(validateGemmaNamedPhotoAnalysis(modeled)).toEqual(Array.from({ length: 8 }, (_, i) => [
      `gemma.faceMeasurements[${i}]:anyOf`, ...paths.slice(i * 2, i * 2 + 2),
    ]).flat());
    expect(validate.errors?.filter(error => error.keyword === "required")).toHaveLength(16);
    expect(JSON.stringify(modeled)).toBe(before);
    // These are partial conjunctive subschemas, not standalone output contracts.
    // Their isolated acceptance does not prove how the provider compiled them.
    for (const branch of item.anyOf!) {
      const branchOnly = new Ajv().compile(branch);
      expect(branchOnly({})).toBe(true);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

it("confirms bounded calls and graceful cleanup without inferring independent remote deletion", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    wrapperExitCode: 0, ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true,
    cleanupFailed: false, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true,
    productionConfigChanged: false, serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(Object.values(s.prohibited).every(value => value === 0)).toBe(true);
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
