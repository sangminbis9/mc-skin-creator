import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthReady } from "./primaryAuditRunnerSupport";
import { startRemoteAudit } from "./primaryAuditRemoteReadiness";

const reload = { config: { dev: { remote: true } }, proxyData: { secret: "never-store-preview-token" } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}
function fixture() {
  const dev = Object.assign(new EventEmitter(), { proxy: { runtimeMessageMutex: { drained: vi.fn(async () => {}) } } });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, runtime: {
    marker: "cloudflare_remote_worker", aiBinding: true, aiRunType: "function", aiGatewayType: "function",
  } }) }));
  return { dev, worker: { ready: Promise.resolve(), fetch } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("audit-only remote startup gate, zero network", () => {
  it("local proxy ready alone never permits health; timeout cleans listeners", async () => {
    vi.useFakeTimers();
    const { dev, worker } = fixture();
    const pending = startRemoteAudit(dev, async () => worker, 50);
    await vi.advanceTimersByTimeAsync(49);
    expect(worker.fetch).not.toHaveBeenCalled();
    dev.emit("reloadComplete", { config: { dev: { remote: false } } });
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ readiness: { status: "timeout" }, worker: null });
    for (const event of ["reloadComplete", "error", "buildFailed"]) expect(dev.listenerCount(event)).toBe(0);
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it("captures an early reload emitted inside start, waits local ready and play drain before health", async () => {
    const { dev, worker } = fixture();
    const local = deferred(); const play = deferred();
    worker.ready = local.promise;
    dev.proxy.runtimeMessageMutex.drained.mockImplementation(() => play.promise);
    const pending = startRemoteAudit(dev, async () => { dev.emit("reloadComplete", reload); return worker; });
    await Promise.resolve(); await Promise.resolve();
    expect(dev.proxy.runtimeMessageMutex.drained).not.toHaveBeenCalled();
    local.resolve();
    await vi.waitFor(() => expect(dev.proxy.runtimeMessageMutex.drained).toHaveBeenCalledTimes(1));
    expect(worker.fetch).not.toHaveBeenCalled();
    play.resolve();
    const result = await pending;
    expect(result.readiness).toEqual({ status: "ready", observed: "reloadComplete" });
    expect(JSON.stringify(result.readiness)).not.toContain("never-store");
    expect(await healthReady(result.worker!, "fake-token", async () => {})).toBe(true);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "buildFailed"])("%s wins while forwarding setup is pending and never permits health", async event => {
    const { dev, worker } = fixture();
    const play = deferred();
    dev.proxy.runtimeMessageMutex.drained.mockImplementation(() => play.promise);
    const pending = startRemoteAudit(dev, async () => worker);
    dev.emit("reloadComplete", reload);
    const cause = Object.assign(new Error("secret https://private.invalid/token"), { code: "ECONNREFUSED" });
    dev.emit(event, { cause, data: { secret: "never-store" } });
    const result = await pending;
    expect(result.readiness.status).toBe(event === "error" ? "startup_error" : "build_failed");
    expect(result.worker).toBeNull();
    expect(JSON.stringify(result.readiness)).not.toMatch(/https:|never-store|secret/);
    play.resolve(); await Promise.resolve();
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it("synchronous throw and asynchronous rejection preserve safe startup errors", async () => {
    for (const start of [() => { throw new TypeError("fetch failed secret"); }, async () => { throw new Error("secret"); }]) {
      const { dev, worker } = fixture();
      const result = await startRemoteAudit(dev, start);
      expect(result.readiness.status).toBe("startup_error");
      expect(result.worker).toBeNull();
      expect(worker.fetch).not.toHaveBeenCalled();
    }
  });
  it("drain rejection is a startup error, not remote ready", async () => {
    const { dev, worker } = fixture();
    dev.proxy.runtimeMessageMutex.drained.mockRejectedValue(new Error("secret"));
    const pending = startRemoteAudit(dev, async () => worker);
    dev.emit("reloadComplete", reload);
    expect((await pending).readiness.status).toBe("startup_error");
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it("does not execute real fetch or Wrangler startup in these tests", async () => {
    const network = vi.fn(() => { throw new Error("network_forbidden"); }); vi.stubGlobal("fetch", network);
    const { dev, worker } = fixture();
    const pending = startRemoteAudit(dev, async () => worker);
    dev.emit("buildFailed", { cause: new SyntaxError("offline mock") });
    await pending;
    expect(network).not.toHaveBeenCalled();
  });
});
