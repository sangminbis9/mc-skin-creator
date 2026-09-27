import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { atomicCheckpoint, readLatestAuditCheckpoint, type CheckpointIo } from "./primaryAuditRunnerSupport";

const artifactRoot = resolve("evaluation-artifacts/audit-checkpoint-windows-onedrive-hardening-20260924-001");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const eperm = () => Object.assign(new Error("injected filesystem denial"), { code: "EPERM" });
const realWrite = async (path: string, text: string) => {
  const file = await open(path, "wx");
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
};
const realReplace = async (temporary: string, destination: string, text: string) => {
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, destination);
};
const makeRoot = async (parent: string) => {
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "checkpoint-test-"));
};

describe("audit-only Windows/OneDrive checkpoints", () => {
  it("reproduces the old second-write replacement EPERM without touching the historical artifact", async () => {
    const root = await makeRoot(join(tmpdir(), "mc-skin-audit-checkpoint-old"));
    const destination = join(root, "summary.json");
    const oldWrite = async (value: number, replace = rename) => {
      const temporary = `${destination}.${value}.tmp`;
      await writeFile(temporary, JSON.stringify({ value }), { flag: "wx" });
      await replace(temporary, destination);
    };
    await oldWrite(1);
    await expect(oldWrite(2, async () => { throw eperm(); })).rejects.toMatchObject({ code: "EPERM" });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ value: 1 });
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual(["summary.json.2.tmp"]);
  });

  it("keeps authoritative versions through a projection EPERM and repeated OneDrive writes", async () => {
    const root = await makeRoot(artifactRoot);
    const destination = join(root, "summary.json");
    const started = performance.now();
    const first = await atomicCheckpoint(destination, { stage: "health", providerPosts: 0 }, "health");
    const io: CheckpointIo = { writeVersion: realWrite, replaceSummary: async () => { throw eperm(); } };
    const second = await atomicCheckpoint(destination, { stage: "response_headers_received", providerPosts: 1 },
      "response_headers_received", io);
    expect(first).toMatchObject({ sequence: 1, summaryProjectionFailed: false });
    expect(second).toMatchObject({ sequence: 2, summaryProjectionFailed: true });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ stage: "health", providerPosts: 0 });
    expect(await readLatestAuditCheckpoint(destination)).toMatchObject({ sequence: 2,
      event: "response_headers_received", snapshot: { stage: "response_headers_received", providerPosts: 1 } });
    for (let index = 3; index <= 8; index++) {
      const result = await atomicCheckpoint(destination, { stage: `step_${index}`, providerPosts: 1 }, `step_${index}`);
      expect(result.sequence).toBe(index);
    }
    expect((await readLatestAuditCheckpoint(destination))?.sequence).toBe(8);
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toHaveLength(0);
    const legacyDestination = join(root, "legacy-replacement.json");
    const legacyTemporary = `${legacyDestination}.tmp`;
    await writeFile(legacyDestination, "{\"step\":1}", { flag: "wx" });
    await writeFile(legacyTemporary, "{\"step\":2}", { flag: "wx" });
    let sameTargetReplacement: "passed" | "EPERM" | "EACCES" | "other_failure" = "passed";
    try { await rename(legacyTemporary, legacyDestination); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      sameTargetReplacement = code === "EPERM" || code === "EACCES" ? code : "other_failure";
    }
    await writeFile(join(root, "filesystem-integration.json"), JSON.stringify({
      filesystem: "repository_OneDrive_path", sequentialVersionWrites: 8,
      injectedProjectionEperm: true, latestValidSequence: 8, staleTemporaryFiles: 0,
      sameTargetReplacement, elapsedMs: Math.round(performance.now() - started),
    }, null, 2), { flag: "wx" });
  });

  it("retries filesystem EPERM at most twice, preserving the previous version", async () => {
    const root = await makeRoot(join(tmpdir(), "mc-skin-audit-checkpoint-retry"));
    const destination = join(root, "summary.json");
    await atomicCheckpoint(destination, { stage: "health" }, "health");
    let attempts = 0;
    const transient: CheckpointIo = { writeVersion: async (path, text) => {
      attempts++;
      if (attempts === 1) throw eperm();
      await realWrite(path, text);
    }, replaceSummary: realReplace };
    const result = await atomicCheckpoint(destination, { stage: "headers" }, "headers", transient);
    expect(result.filesystemRetryCount).toBe(1);
    expect(attempts).toBe(2);
    expect((await readLatestAuditCheckpoint(destination))?.snapshot).toEqual({ stage: "headers" });
    const denied: CheckpointIo = { writeVersion: async () => { throw eperm(); }, replaceSummary: realReplace };
    await expect(atomicCheckpoint(destination, { stage: "body" }, "body", denied)).rejects.toMatchObject({ code: "EPERM" });
    expect((await readLatestAuditCheckpoint(destination))?.snapshot).toEqual({ stage: "headers" });
  });

  it("recovers the last valid state across a truncated latest version and stale temporary file", async () => {
    const root = await makeRoot(join(tmpdir(), "mc-skin-audit-checkpoint-recovery"));
    const destination = join(root, "summary.json");
    await atomicCheckpoint(destination, { stage: "response_headers_received", httpStatus: 200,
      providerDispatch: "unknown" }, "response_headers_received");
    await writeFile(`${destination}.checkpoint-000002.json`, '{"schemaVersion":1,"sequence":2,', { flag: "wx" });
    await writeFile(`${destination}.checkpoint-000004.json`, JSON.stringify({ schemaVersion: 1, sequence: 4,
      event: "forged_valid_json", snapshotSha256: "wrong", snapshot: { stage: "forged" } }), { flag: "wx" });
    await writeFile(`${destination}.crashed.tmp`, '{', { flag: "wx" });
    const recovered = await readLatestAuditCheckpoint(destination);
    expect(recovered).toMatchObject({ sequence: 1, snapshot: { stage: "response_headers_received",
      httpStatus: 200, providerDispatch: "unknown" } });
    const next = await atomicCheckpoint(destination, { stage: "teardown_started", providerDispatch: "unknown" }, "teardown_started");
    expect(next.sequence).toBe(5);
    expect(await readFile(`${destination}.crashed.tmp`, "utf8")).toBe("{");
    expect((await readLatestAuditCheckpoint(destination))?.event).toBe("teardown_started");
  });

  it("gates the one local fake provider call on durable intent and records response/teardown stages", async () => {
    const root = await makeRoot(join(tmpdir(), "mc-skin-audit-checkpoint-lifecycle"));
    const destination = join(root, "summary.json");
    const provider = vi.fn(async () => ({ status: 200, body: { validation: "passed" } }));
    const run = async (io?: CheckpointIo) => {
      const stages: string[] = [];
      const checkpoint = async (stage: string) => {
        stages.push(stage);
        await atomicCheckpoint(destination, { stages, providerPosts: stages.includes("request_started") ? 1 : 0 }, stage, io);
      };
      await checkpoint("health_passed");
      await checkpoint("request_started");
      const response = await provider();
      await checkpoint("response_headers_received");
      await checkpoint("response_body_received");
      await checkpoint("structured_validation_completed");
      await checkpoint("portrait_region_validated");
      await checkpoint("teardown_started");
      await checkpoint("q_sent");
      await checkpoint("process_exit_confirmed");
      return response;
    };
    await run();
    expect(provider).toHaveBeenCalledTimes(1);
    const recovered = await readLatestAuditCheckpoint(destination);
    expect(recovered?.event).toBe("process_exit_confirmed");
    expect(recovered?.snapshot).toMatchObject({ providerPosts: 1 });
    const denied: CheckpointIo = { writeVersion: async () => { throw eperm(); }, replaceSummary: realReplace };
    const blockedProvider = vi.fn();
    await expect((async () => {
      await atomicCheckpoint(join(root, "blocked-summary.json"), { stage: "request_started" }, "request_started", denied);
      blockedProvider();
    })()).rejects.toMatchObject({ code: "EPERM" });
    expect(blockedProvider).not.toHaveBeenCalled();
    expect(sha256(JSON.stringify(recovered?.snapshot))).toBe(recovered?.snapshotSha256);
  });
});
