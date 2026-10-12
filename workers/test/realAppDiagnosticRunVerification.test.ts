// Offline disk verification only. Never imports the remote runner/selector.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261006-001");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
it("preserves immutable failed-run evidence and protects non-outfit production contracts without remote calls", async () => {
  const records = fs.readdirSync(root).filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name));
  expect(records).toHaveLength(11);
  for (const file of records) {
    const record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    expect(record.snapshotSha256).toBe(sha(JSON.stringify(record.snapshot)));
  }
  const latest = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  expect(latest?.sequence).toBe(11);
  const snapshot = latest!.snapshot as {
    startupAttempts: number; healthAttempts: number; qSentCount: number; devServerReadyReceived: boolean;
    cleanupFailed: boolean; classification: string; currentDefaultE2E: {
      runId: string; workingTree: { head: string; branch: string }; generationPosts: number; accounting: string;
      result: unknown; png: unknown; diskRecovery: boolean; fixedHashes: Record<string, string>;
      preprocessing: { source: { sha256: string }; rawOriginalTransmitted: boolean };
    };
  };
  expect(snapshot.currentDefaultE2E.workingTree).toMatchObject({ head: "94f02b19a7efb1e3205b47545ab68fe20a9420c2", branch: "main" });
  expect([snapshot.startupAttempts, snapshot.healthAttempts, snapshot.currentDefaultE2E.generationPosts,
    snapshot.qSentCount]).toEqual([1, 0, 0, 0]);
  expect(snapshot.currentDefaultE2E.accounting).toBe("not_attempted");
  expect(snapshot.currentDefaultE2E.result).toBeNull();
  expect(snapshot.currentDefaultE2E.png).toBeNull();
  expect(snapshot.currentDefaultE2E.diskRecovery).toBe(true);
  expect(snapshot.cleanupFailed).toBe(true);
  expect(snapshot.classification).toBe("BLOCKED: graceful q teardown was not confirmed");
  expect(snapshot.currentDefaultE2E.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(snapshot.currentDefaultE2E.preprocessing.source.sha256)
    .toBe("f20d7f8ee7a7de7020077b20496e11e976abd7b0b7f31d6df04740ea2c19a273");
  // Subsequent tested outfit/reference presentation fixes deliberately change
  // these files. All wire/config/other production hashes remain frozen.
  const changed = Object.entries(snapshot.currentDefaultE2E.fixedHashes)
    .filter(([file, expected]) => sha(fs.readFileSync(file)) !== expected)
    .map(([file]) => file.replace(/\\/g, "/")).sort();
  expect(changed).toEqual(["src/outfitIdentity.ts", "src/outfitRenderer.ts", "src/referenceFaceFinish.ts",
    "src/referenceStyleRenderer.ts", "src/referenceStyleSelection.ts", "src/referenceStyleTemplates.ts"]);
  const cleanup = JSON.parse(fs.readFileSync(path.join(root, "cleanup-followup.json"), "utf8"));
  expect(cleanup.runId).toBe(snapshot.currentDefaultE2E.runId);
  expect(cleanup).toMatchObject({ processTerminationPerformed: 0, ownedNodeProcessesObserved: 0,
    temporaryTokenRemoved: true, temporaryDirectoryRemoved: true, temporaryConfigRemoved: true,
    gracefulExitNotRetroactivelyClaimed: true, remotePreviewDeletionIndependentlyConfirmed: false });
  expect(sha(fs.readFileSync("wrangler.jsonc"))).toBe(cleanup.productionConfigSha256);
  expect(fs.existsSync("wrangler.primary-audit-ac72f58f-b7f4-4a34-8e08-4066ce5fcc68.tmp.jsonc")).toBe(false);
  expect(fs.readdirSync(root).filter(file => /\.(png|jpe?g)$/i.test(file))).toEqual([]);
});

it("contains no raw request/response/prompt/image or credentials in the stored failed-run JSON", () => {
  const forbiddenKeys = /^(apiKey|authorization|headers|requestHeaders|responseHeaders|rawResponse|rawRequest|rawPrompt|image|analysisImage|skinPngBase64|payload)$/i;
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      expect(value).not.toMatch(/data:image\//i);
      expect(value).not.toMatch(/Bearer\s+[A-Za-z0-9_-]+/i);
      expect(value).not.toMatch(/(?:AIza|cfut_)[A-Za-z0-9_-]{20,}/);
      expect(value).not.toMatch(/[A-Za-z0-9+/]{160,}={0,2}/);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      expect(key).not.toMatch(forbiddenKeys); scan(item);
    }
  };
  for (const file of fs.readdirSync(root).filter(name => name.endsWith(".json")))
    scan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
});
