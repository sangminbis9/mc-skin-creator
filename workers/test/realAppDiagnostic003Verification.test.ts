// Offline recovery only. Never imports a remote runner or repeats the POST.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-003");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const summary = JSON.parse(fs.readFileSync(path.join(root, "summary.json"), "utf8"));

it("recovers the finalized checkpoint without inventing unobserved provider results", async () => {
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest?.sequence).toBe(29);
  expect(latest?.event).toBe("auditLifecycleFinalized");
  expect(latest?.snapshot).toEqual(summary);
  for (const file of fs.readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n))) {
    const record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  expect(summary.classification).toBe("BLOCKED: E2E response unobserved; provider accounting unknown");
  expect(summary.currentDefaultE2E).toMatchObject({ runId: "eede3359f10beb783096097870f53f3a",
    generationPosts: 1, providerRetry: 0, httpStatus: null, accounting: "unknown",
    result: null, png: null, propagationLink: null, e2eGateTrace: null, diskRecovery: true });
  expect(summary.providerAccounting).toBe("unknown");
  expect(summary.providerCalls).toBeNull();
  expect(fs.existsSync(path.join(root, "skin.png"))).toBe(false);
});

it("proves the single startup/health/POST budget and graceful one-shot shutdown", () => {
  expect(summary).toMatchObject({ startupAttempts: 1, healthAttempts: 1,
    health: { status: "passed", httpStatus: 200 }, qSentCount: 1, cleanupFailed: false,
    wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true,
    ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
    ownedProcessInventoryClean: true, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, wranglerGracefulTeardownPathCompleted: true,
    productionConfigChanged: false,
    shutdownLatch: { phase: "finalized", qClaimed: true, qDispatched: true, qFailed: false } });
  expect(summary.lifecycle.filter((s: { stage: string }) => s.stage === "currentDefaultE2EPostStarted")).toHaveLength(1);
  expect(summary.lifecycle.filter((s: { stage: string }) => s.stage === "qSent")).toHaveLength(1);
  expect(summary.lifecycle.some((s: { stage: string }) => s.stage === "currentDefaultE2ETransportUnobserved")).toBe(true);
  expect(Object.values(summary.prohibited).every(v => v === 0)).toBe(true);
  // Local q/process teardown does not independently prove preview deletion.
  expect(summary.serverSidePreviewDeletionIndependentlyConfirmed).toBe(false);
});

it("retains exact input provenance, production hashes and immutable prior evidence", () => {
  const run = summary.currentDefaultE2E;
  expect(run.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(run.preprocessing.source.sha256).toBe("f20d7f8ee7a7de7020077b20496e11e976abd7b0b7f31d6df04740ea2c19a273");
  expect(run.preprocessing.analysis).toMatchObject({ width: 896, height: 896, bytes: 47293,
    sha256: "bc93a462fc33595e50b21679c603bea70a35d82f2913179affd5175145eaa0fa" });
  expect(run.preprocessing.generation).toMatchObject({ width: 448, height: 448, bytes: 17732,
    sha256: "9601d8a539b7163d605056ea9cf9caa2e805b5ff2e56c9ecc0bf5295d80c327d" });
  // Preserve hashes of the consumed run; later offline fixes are not evidence
  // that those files differed during its execution. Bound current differences
  // to the separately tested categorical fringe-window propagation only.
  const changed = Object.entries(run.fixedHashes)
    .filter(([file, hash]) => sha(fs.readFileSync(file)) !== hash)
    .map(([file]) => file.replace(/\\/g, "/")).sort();
  expect(changed).toEqual(["src/headOwnership.ts", "src/identityPlans.ts",
    "src/referenceStyleRenderer.ts", "src/referenceStyleSelection.ts"]);
  expect(sha(fs.readFileSync(path.join(root, "summary.json"))))
    .toBe("083f811d9a7edb02954d80307c127856057505807f3e9a99f6d02ed5022aa767");
  expect(sha(fs.readFileSync("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002/summary.json")))
    .toBe("cba7996d6cecd232d3903575ddc4f62ec8e199b8942459972f8a8bb3037b2ffa");
});

it("keeps JSON evidence free of raw requests/responses, images, prompt bodies and credentials", () => {
  const violations = new Set<string>();
  const forbidden = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      if (/data:image\//i.test(v)) violations.add("image_data_url");
      if (/Bearer\s+[A-Za-z0-9_-]+/i.test(v)) violations.add("authorization_value");
      if (/(?:AIza|cfut_)[A-Za-z0-9_-]{20,}/.test(v)) violations.add("credential_value");
      if (/[A-Za-z0-9+/]{160,}={0,2}/.test(v)) violations.add("base64_value");
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") for (const [key, value] of Object.entries(v)) {
      if (forbidden.test(key)) violations.add("forbidden_payload_key");
      scan(value);
    }
  };
  for (const file of fs.readdirSync(root).filter(n => n.endsWith(".json")))
    scan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  expect([...violations]).toEqual([]);
});
