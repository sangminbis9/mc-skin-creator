import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AuditShutdownLatch, type AuditShutdownSnapshot } from "./auditShutdownLatch";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const parent = path.resolve("evaluation-artifacts/real-app-formal-suit-audit-shutdown-latch-offline-20261007-001");
function harness() {
  let alive = true, registered = false;
  const actions = { ownerAlive: () => alive, registrationProven: () => registered,
    checkpointIntent: vi.fn(async () => {}), sendQ: vi.fn(), onFailure: vi.fn() };
  const latch = new AuditShutdownLatch(actions);
  return { latch, actions, register: () => { registered = true; }, exit: () => { alive = false; } };
}
it("only drains after capture; q waits for authoritative intent and is one-shot", async () => {
  const h = harness(); h.register();
  await h.latch.tryQ(); expect(h.actions.sendQ).not.toHaveBeenCalled();
  h.latch.assertCapturing();
  let flush!: () => void;
  h.actions.checkpointIntent.mockImplementation(() => new Promise<void>(resolve => { flush = resolve; }));
  h.latch.beginShutdown(); const q = h.latch.tryQ(); const duplicate = h.latch.tryQ();
  expect(duplicate).toBe(q); await Promise.resolve();
  expect(h.actions.sendQ).not.toHaveBeenCalled();
  flush(); await q;
  expect(h.actions.checkpointIntent).toHaveBeenCalledOnce(); expect(h.actions.sendQ).toHaveBeenCalledOnce();
  expect(() => h.latch.beginShutdown()).toThrow("audit_run_consumed");
});
it.each(["checkpoint", "send"])("%s failure cannot cause q retry", async failure => {
  const h = harness(); h.register();
  if (failure === "checkpoint") h.actions.checkpointIntent.mockRejectedValue(new Error("offline_io_denied"));
  else h.actions.sendQ.mockImplementation(() => { throw new Error("offline_ipc_closed"); });
  h.latch.beginShutdown(); await h.latch.tryQ(); await h.latch.tryQ();
  expect(h.actions.onFailure).toHaveBeenCalledOnce();
  expect(h.actions.sendQ).toHaveBeenCalledTimes(failure === "checkpoint" ? 0 : 1);
  expect(h.latch.snapshot()).toMatchObject({ qClaimed: true, qDispatched: false, qFailed: true });
});
it.each(["exit", "deadline"])("%s during intent flush prevents a late q after sealing", async mode => {
  const h = harness(); h.register(); let flush!: () => void;
  h.actions.checkpointIntent.mockImplementation(() => new Promise<void>(resolve => { flush = resolve; }));
  h.latch.beginShutdown(); const pending = h.latch.tryQ(); await Promise.resolve();
  if (mode === "exit") h.exit(); else h.latch.beginFinalization();
  flush(); await pending; expect(h.actions.sendQ).not.toHaveBeenCalled();
});
it("no registration or exited owner never invents q; finalization order is enforced", async () => {
  const h = harness(); expect(() => h.latch.finalize()).toThrow("audit_finalization_order_invalid");
  h.latch.beginShutdown(); await h.latch.tryQ(); h.register(); h.exit(); await h.latch.tryQ();
  h.latch.beginFinalization(); await h.latch.tryQ(); h.latch.finalize();
  expect(h.latch.acceptsEvents).toBe(false); expect(h.actions.sendQ).not.toHaveBeenCalled();
});
it.each(["capturing", "draining", "finalizing", "finalized"] as const)("recovery of %s cannot reactivate a consumed namespace", async phase => {
  const h = harness(); h.register();
  const saved: AuditShutdownSnapshot = { phase, qClaimed: false, qDispatched: false, qFailed: false };
  const recovered = new AuditShutdownLatch(h.actions, saved);
  expect(() => recovered.assertCapturing()).toThrow("audit_run_consumed");
  await recovered.tryQ(); expect(h.actions.sendQ).not.toHaveBeenCalled();
});
it("fresh disk namespace retains capture before finalization and recovers the terminal snapshot without overwriting prior runs", async () => {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "offline-"));
  const destination = path.join(root, "summary.json");
  const h = harness(); h.register();
  const evidence = { mode: "offline_fake_only", sanitizedAnalysis: null as null | { hairLength: string },
    selectedFamily: null as null | string, planSha256: null as null | string, finalPngSha256: null as null | string,
    providerCalls: 0, remoteStartupAttempts: 0, generationPosts: 0, diskRecovery: false };
  const persist = async (stage: string) => atomicCheckpoint(destination,
    { ...evidence, shutdownLatch: h.latch.snapshot() }, stage);
  await persist("captureStarted");
  // Offline fixture fields are explicitly synthetic, never substituted for live analysis.
  evidence.sanitizedAnalysis = { hairLength: "short" }; evidence.selectedFamily = "offline_fixture";
  evidence.planSha256 = createHash("sha256").update("offline_plan").digest("hex");
  await persist("analysisPlanCaptured"); await h.latch.tryQ();
  expect(h.actions.sendQ).not.toHaveBeenCalled(); h.latch.assertCapturing();
  evidence.finalPngSha256 = createHash("sha256").update("offline_png_identity_not_image").digest("hex");
  await persist("pngCaptured");
  h.actions.checkpointIntent.mockImplementation(async () => { await persist("shutdownRequested"); });
  h.latch.beginShutdown(); await h.latch.tryQ();
  h.latch.beginFinalization(); await persist("finalCheckpoint");
  const recovered = await readLatestAuditCheckpoint(destination);
  expect(recovered?.snapshot).toMatchObject(evidence);
  evidence.diskRecovery = true; h.latch.finalize(); await persist("auditLifecycleFinalized");
  const final = await readLatestAuditCheckpoint(destination);
  expect(final?.event).toBe("auditLifecycleFinalized");
  expect(final?.snapshot).toMatchObject({ ...evidence, shutdownLatch: h.latch.snapshot() });
  expect(final?.snapshotSha256).toBe(createHash("sha256").update(JSON.stringify(final?.snapshot)).digest("hex"));
  expect(h.actions.sendQ).toHaveBeenCalledOnce();
  const old = await fs.readFile(`${destination}.checkpoint-000001.json`, "utf8");
  const snapshot = (final!.snapshot as { shutdownLatch: AuditShutdownSnapshot }).shutdownLatch;
  const sealed = new AuditShutdownLatch(h.actions, snapshot);
  expect(() => sealed.assertCapturing()).toThrow("audit_run_consumed");
  await sealed.tryQ(); expect(h.actions.sendQ).toHaveBeenCalledOnce();
  expect(await fs.readFile(`${destination}.checkpoint-000001.json`, "utf8")).toBe(old);
  const fresh = await fs.mkdtemp(path.join(parent, "offline-"));
  expect(fresh).not.toBe(root); expect(await readLatestAuditCheckpoint(path.join(fresh, "summary.json"))).toBeNull();
  new AuditShutdownLatch(h.actions).assertCapturing();
});
