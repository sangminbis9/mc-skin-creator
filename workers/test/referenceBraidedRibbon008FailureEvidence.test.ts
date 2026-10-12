// Offline recovery of a consumed run. Never imports a remote selector/runner.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-008";
const bytes = readFileSync(`${root}/summary.json`), summary = JSON.parse(bytes.toString());
const run = summary.currentDefaultE2E;
const old = JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-007/summary.json", "utf8")).currentDefaultE2E;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("recovers thirty immutable snapshots and the authoritative final state", () => {
  expect(sha(bytes)).toBe("d8f21d8eda3aecdb633759bea7fd3b9ac11f75ed992c08345c80285403958748");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(30);
  for (const name of names) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(summary);
  expect(run.runId).toBe("8d2dc8f477d385c77fccbb53c63984b9");
  expect(run.diskRecovery).toBe(true);
});

it("keeps the observed HTTP boundary distinct from unobserved provider/validation results", () => {
  expect(run).toMatchObject({ generationPosts: 1, providerRetry: 0, accounting: "unknown",
    httpStatus: 503, elapsedMs: 51855, gateBoundary: "unobserved",
    httpObservation: { stage: "json_parse", httpStatus: 503, jsonRootType: null,
      exception: { name: "SyntaxError" } } });
  expect(run.result).toBeNull(); expect(run.png).toBeNull();
  expect(run.propagationLink).toBeNull(); expect(run.cropReplay).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(summary.classification).toBe("BLOCKED: E2E HTTP response JSON unavailable; provider accounting unknown");
  // No fabricated zero counts or assumed Gemini/Gemma high-demand diagnosis.
  expect(run.result?.bindingAttempts).toBeUndefined();
});

it("pins the unchanged source, derivatives and contract except the reviewed Gemma prompt delta", () => {
  for (const key of ["source", "analysis", "generation", "preprocessingSourceSha256"])
    expect(run.preprocessing[key], key).toEqual(old.preprocessing[key]);
  expect(run.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(run.contract.gemmaPromptSha256).toBe("ff420622e92ba48b1bbaa1a6d02d1afeafdb12ee751d02fccf20dfa84d94bc74");
  expect({ ...run.contract, gemmaPromptSha256: null }).toEqual({ ...old.contract, gemmaPromptSha256: null });
  const changed = Object.keys(run.fixedHashes).filter(k => run.fixedHashes[k] !== old.fixedHashes[k]);
  expect(changed).toEqual(["src\\gemmaPhotoAnalysis.ts"]);
  expect(Object.keys(run.fixedHashes)).toEqual(Object.keys(old.fixedHashes));
});

it("verifies health/preflight and complete observed one-shot teardown independently of generation failure", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
    health: { status: "passed", httpStatus: 200 }, tokenBindingPreflightPassed: true,
    preflight: { selectedProfileClass: "non_default", approvedAccountIdMatch: true,
      authOverrideAbsent: true, dotenvOverrideAbsent: true },
    devServerReadyReceived: true, qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, temporaryTokenFileRemoved: true, temporaryConfigRemoved: true,
    cleanupFailed: false, productionConfigChanged: false });
  expect(summary.shutdownLatch.phase).toBe("finalized");
  expect(summary.productionConfigHashAfter).toBe(summary.productionConfigHashBefore);
});
