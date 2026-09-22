import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { exerciseCliAuditLifecycle, localProxyUrl, type FakeCliChild } from "./primaryAuditCliLifecycle";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const goodBody = { ok: true, runtime: { marker: "cloudflare_remote_worker", aiBinding: true,
  aiRunType: "function", aiGatewayType: "function" }, providerCalls: 0 };
const response = (body: unknown = goodBody) => ({ ok: true, status: 200, json: async () => body });
const timing = { localReadyMs: 20, healthMs: 20, shutdownMs: 20 };
function fake(startMode: "ready" | "exit" | "silent" = "ready", shutdownExits = true, inventoryGone = true) {
  let finish!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
  const close = (code = 0, signal: string | null = null) => finish({ code, signal });
  const child: FakeCliChild = { exited,
    start: vi.fn((message, stderr) => {
      stderr("Build failed: synthetic-private-secret https://private.invalid/preview");
      if (startMode === "ready") message(JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 }));
      if (startMode === "exit") close(1);
    }),
    requestShutdown: vi.fn(async () => { if (shutdownExits) close(); }),
    verifyOwnedProcessesGone: vi.fn(async () => inventoryGone),
  };
  return { child, close };
}

it("local IPC + one protected health success + fake graceful exit + inventory is ready", async () => {
  const { child } = fake(); const fetch = vi.fn(async () => response());
  const result = await exerciseCliAuditLifecycle(child, { fetch }, timing);
  expect(result.readiness).toBe("ready"); expect(result.healthPassed).toBe(true);
  expect(result.shutdownRequested).toBe(true); expect(result.cliExited).toBe(true);
  expect(result.cleanup).toBe("verified"); expect(child.verifyOwnedProcessesGone).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8787/primary-audit-health", {
    headers: { "x-primary-audit-token": "offline-fake-audit-token" },
  });
  expect(result.liveStartupAllowed).toBe(false); // fake success is not installed teardown evidence
  expect(result.providerDispatches).toBe(0); expect(result.jpegReads).toBe(0);
});
it("hanging health watchdog closes the fake child, never retries or opens dispatch", async () => {
  vi.useFakeTimers(); const { child } = fake(); const fetch = vi.fn(() => new Promise<never>(() => {}));
  const pending = exerciseCliAuditLifecycle(child, { fetch }, timing);
  await vi.advanceTimersByTimeAsync(20); const result = await pending;
  expect(result.readiness).toBe("health_timeout"); expect(result.cleanup).toBe("verified");
  expect(fetch).toHaveBeenCalledOnce(); expect(child.requestShutdown).toHaveBeenCalledOnce();
  expect(result.healthPassed).toBe(false); expect(result.jpegReads + result.providerDispatches).toBe(0);
});
it("exit before local ready sends no health", async () => {
  const { child } = fake("exit"); const fetch = vi.fn(async () => response());
  const result = await exerciseCliAuditLifecycle(child, { fetch }, timing);
  expect(result.readiness).toBe("child_exited"); expect(result.childExitedBeforeHealth).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(child.requestShutdown).not.toHaveBeenCalled();
  expect(result.cleanup).toBe("cleanup_failed");
});
it("health success followed by child crash is not clean shutdown", async () => {
  const { child, close } = fake();
  child.requestShutdown = vi.fn(async () => { close(1); });
  const result = await exerciseCliAuditLifecycle(child, { fetch: async () => response() }, timing);
  expect(result.healthPassed).toBe(true); expect(result.cleanup).toBe("cleanup_failed");
  expect(result.exitCodeClass).toBe("nonzero"); expect(result.liveStartupAllowed).toBe(false);
});
it("shutdown without exit reports cleanup_failed without hard-kill fallback", async () => {
  vi.useFakeTimers(); const { child } = fake("ready", false);
  const pending = exerciseCliAuditLifecycle(child, { fetch: async () => response() }, timing);
  await vi.advanceTimersByTimeAsync(20); const result = await pending;
  expect(result.cleanup).toBe("cleanup_failed"); expect(result.cliExited).toBe(false);
  expect(child.requestShutdown).toHaveBeenCalledOnce(); expect(child).not.toHaveProperty("kill");
});
it("remaining owned descendants prevent cleanup approval after exit", async () => {
  const { child } = fake("ready", true, false);
  const result = await exerciseCliAuditLifecycle(child, { fetch: async () => response() }, timing);
  expect(result.cliExited).toBe(true); expect(result.cleanupVerified).toBe(false);
});
it("raw stderr/address/token do not escape diagnostic whitelist", async () => {
  const { child } = fake(); const result = await exerciseCliAuditLifecycle(child, { fetch: async () => response() }, timing);
  const stored = JSON.stringify(result);
  expect(result.messageClassified).toBe("build");
  for (const privateValue of ["synthetic-private-secret", "private.invalid", "offline-fake-audit-token", "127.0.0.1"]) expect(stored).not.toContain(privateValue);
  expect(result).not.toHaveProperty("reloadComplete");
});
it.each([
  { ...goodBody, runtime: { ...goodBody.runtime, marker: "wrong" } },
  { ...goodBody, runtime: { ...goodBody.runtime, aiGatewayType: "undefined" } },
  { ...goodBody, providerCalls: 1 },
])("invalid marker/binding/accounting never opens readiness", async body => {
  const { child } = fake(); const result = await exerciseCliAuditLifecycle(child, { fetch: async () => response(body) }, timing);
  expect(result.healthPassed).toBe(false); expect(result.readiness).toBe("health_failed");
});
it("local ready silence times out before health and still awaits fake shutdown", async () => {
  vi.useFakeTimers(); const { child } = fake("silent"); const fetch = vi.fn(async () => response());
  const pending = exerciseCliAuditLifecycle(child, { fetch }, timing);
  await vi.advanceTimersByTimeAsync(20); const result = await pending;
  expect(result.readiness).toBe("local_ready_timeout"); expect(fetch).not.toHaveBeenCalled();
  expect(result.cleanup).toBe("verified");
});
it("IPC address validation accepts loopback only, never raw stdout URLs", () => {
  expect(localProxyUrl({ event: "DEV_SERVER_READY", ip: "[::1]", port: 8787 })).toBe("http://[::1]:8787");
  for (const value of ["http://localhost:8787", { event: "DEV_SERVER_READY", ip: "private.invalid", port: 80 },
    { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 0 }]) expect(localProxyUrl(value)).toBeNull();
});
it("installed CLI contract has local IPC but no inbound dev shutdown; Windows kill is abrupt", () => {
  const source = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
  const start = source.slice(source.indexOf("async function startDev(args)"), source.indexOf("async function setupDevEnv"));
  expect(start.length).toBeGreaterThan(1000);
  expect(start).toContain('event: "DEV_SERVER_READY"'); expect(start).toContain("primaryDevEnv.proxy.ready.promise.then");
  expect(start).not.toMatch(/process\.(?:on|once)\("(?:message|SIGINT|SIGTERM|SIGHUP)"/);
  const wrapper = fs.readFileSync("node_modules/wrangler/bin/wrangler.js", "utf8");
  expect(wrapper).toContain('process.on("SIGINT"'); expect(wrapper).toContain("wranglerProcess.kill()");
  expect(wrapper).not.toContain(".teardown(");
  const nodeTypes = fs.readFileSync("../node_modules/@types/node/child_process.d.ts", "utf8");
  expect(nodeTypes).toContain("the process will be killed forcefully and abruptly");
});
