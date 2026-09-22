import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const requireFixture = createRequire(import.meta.url);
const support = requireFixture("./primaryAuditCliHealthSupport.cjs");
const publication = requireFixture("./fixtures/primaryAuditCliHealthPty.cjs") as {
  registerBridgeIdentity(registry: { pid: number | null }, candidatePid: unknown, terminalPid: unknown): string;
};
const installedWrapper = fs.readFileSync("node_modules/wrangler/bin/wrangler.js", "utf8");
const runner = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
const cli = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");

it("installed wrapper preserves JSON strings and silently drops without parent process.send", () => {
  const child = new EventEmitter();
  const received: unknown[] = [];
  const fakeProcess = { versions: process.versions, execPath: process.execPath, execArgv: [],
    argv: ["node", "wrapper"], send: (value: unknown) => received.push(value) };
  const context = vm.createContext({ process: fakeProcess, module: {}, require: (name: string) =>
    name === "child_process" ? { spawn: () => child } : path, __dirname: "/offline/bin", console });
  vm.runInContext(installedWrapper + "\nrunWrangler();", context);
  const message = JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 });
  child.emit("message", message);
  expect(received).toEqual([message]);
  Reflect.deleteProperty(fakeProcess, "send");
  child.emit("message", message);
  expect(received).toHaveLength(1);
});

it("installed ready emission follows registration and needs proxy resolve plus IPC", () => {
  const start = cli.indexOf("async function startDev(args)");
  const end = cli.indexOf("async function setupDevEnv", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const source = cli.slice(start, end);
  expect(source.indexOf("await setupDevEnv")).toBeLessThan(source.indexOf("unregisterHotKeys = registerDevHotKeys(devEnvs"));
  expect(source.indexOf("unregisterHotKeys = registerDevHotKeys(devEnvs")).toBeLessThan(source.indexOf("void primaryDevEnv.proxy.ready.promise.then"));
  expect(source).toContain('(args.enableIpc || !args.onReady) && process.send && typeof vitest === "undefined"');
  expect(source).toContain('event: "DEV_SERVER_READY"');
});

it("distinguishes awaited config auth from background preview auth and local proxy readiness", () => {
  const configStart = cli.indexOf("async function resolveDevConfig(");
  const configBody = cli.slice(configStart, cli.indexOf("const initialIp =", configStart));
  expect(configBody).toContain("const { accountId } = await auth2();");
  expect(configBody).toContain("await getZoneIdForPreview");
  expect(cli).toContain("port: input.dev?.server?.port ?? config5.dev.port ?? await getLocalPort(initialIpListenCheck)");
  const proxyStart = cli.indexOf("ProxyController2 = class extends Controller");
  const proxy = cli.slice(proxyStart, cli.indexOf("ProxyControllerLogger2 =", proxyStart));
  expect(proxy).toContain("proxyWorker.ready,");
  expect(proxy).toContain("this.ready.resolve(data);");
  expect(proxy).toContain("if (this.latestConfig?.dev.remote) {\n          return false;");
  expect(proxy).not.toContain("this.ready.reject(");
  expect(cli).toContain("this.localServerReady.then(() => super.logReady(message))");
  expect(cli).toContain("this.#session ??= await this.#getPreviewSession(config5, auth2, routes)");
});

// Execute the exact supervisor listener in isolation, with synthetic ancestry only.
// No live adapter or supervisor source is patched by these tests.
function supervisorReplay(messages: Record<string, unknown>[] = [], inventory?: { pid: number; parent: number }[]) {
  const owner = Object.assign(new EventEmitter(), { pid: 0 });
  const artifact: Record<string, unknown> = { lifecycle: [], outputClasses: [] };
  const observed: string[] = [];
  const context = vm.createContext({ owner, artifact, support, Number, Date, start: Date.now(),
    updateInventory: () => inventory ?? [{ pid: 20, parent: 10 }, { pid: 30, parent: 20 }, { pid: 40, parent: 30 }],
    observe: (stage: string) => observed.push(stage), resolveReady: () => {} });
  const begin = runner.indexOf('    owner.on("message", raw => {');
  const end = runner.indexOf("    const startup =", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const snippet = "let bridgePid = null; let wrapperPid = null;\n" + runner.slice(begin, end);
  vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const emit = (message: Record<string, unknown>) => {
    if (message.kind === "owner_started") owner.pid = message.ownerPid as number;
    owner.emit("message", message);
  };
  messages.forEach(emit);
  return { observed, artifact, emit };
}

const started = (pid: number) => ({ kind: "owner_started", ownerPid: 10, bridgePid: pid });
const bridge = { kind: "bridge_started", bridgePid: 20, wrapperPid: 30, stdinTTY: true, stdoutTTY: true };
const ready = { kind: "ready", bridgePid: 20, wrapperPid: 30,
  payload: { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 } };

it("publishes only the first positive matching bridge PID", () => {
  for (const invalid of [0, -1, NaN, undefined, "20"] as unknown[]) {
    expect(publication.registerBridgeIdentity({ pid: null }, invalid, 20)).toBe("reject");
    expect(publication.registerBridgeIdentity({ pid: null }, 20, invalid)).toBe("reject");
  }
  const registry = { pid: null as number | null };
  expect(publication.registerBridgeIdentity(registry, 20, 20)).toBe("publish");
  expect(registry.pid).toBe(20);
  expect(publication.registerBridgeIdentity(registry, 20, 20)).toBe("duplicate");
  expect(publication.registerBridgeIdentity(registry, 21, 21)).toBe("reject");
  expect(registry.pid).toBe(20);
});

it("reproduces supervisor dropping ready after an initial ConPTY PID=0 snapshot", () => {
  const replay = supervisorReplay([started(0), bridge, { kind: "hotkeys_registered" }, ready]);
  expect(replay.observed).toEqual(["ptyOwnerStarted", "interactiveUiRegistered"]);
  expect(replay.artifact.devServerReadyReceived).toBeUndefined();
});

it("test-only positive-PID ordering preserves sender checks and accepts ready once", () => {
  const replay = supervisorReplay([started(20), bridge, { ...ready, bridgePid: 99 }, ready, ready]);
  expect(replay.observed).toEqual(["ptyOwnerStarted", "ttyBridgeStarted", "localProxyReady"]);
  expect(replay.artifact.senderOwnedRelationshipVerified).toBe(true);
});

it("strict supervisor rejects a valid-looking ready when process ancestry mismatches", () => {
  const wrongAncestry = [{ pid: 20, parent: 999 }, { pid: 30, parent: 20 }, { pid: 40, parent: 30 }];
  const replay = supervisorReplay([started(20), bridge, ready], wrongAncestry);
  expect(replay.observed).toEqual(["ptyOwnerStarted", "ttyBridgeStarted"]);
  expect(replay.artifact.senderOwnedRelationshipVerified).toBeUndefined();
  expect(replay.artifact.devServerReadyReceived).toBeUndefined();
});

it("silence times out, malformed ready fails, and 29,999ms ready is accepted once (virtual time)", async () => {
  vi.useFakeTimers();
  try {
    const silent = supervisorReplay([started(20), bridge]);
    const almost = supervisorReplay([started(20), bridge]);
    let silentTimedOut = false;
    setTimeout(() => { silentTimedOut = !silent.artifact.devServerReadyReceived; }, 30_000);
    almost.emit({ ...ready, payload: { ...ready.payload, port: 0 } });
    expect(almost.artifact.devServerReadyReceived).toBeUndefined();
    setTimeout(() => { almost.emit(ready); almost.emit(ready); }, 29_999);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(silentTimedOut).toBe(true);
    expect(almost.observed.filter(stage => stage === "localProxyReady")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("installed ConPTY PID is zero synchronously, then positive after connection", async () => {
  const pty = requireFixture(support.discoverPty().directory);
  const terminal = pty.spawn(process.execPath,
    [path.resolve("test/fixtures/primaryAuditReadyFakeCli.cjs"), "terminal"],
    { cwd: process.cwd(), cols: 80, rows: 24, env: { ...process.env } });
  const initialPid = terminal.pid;
  terminal.onData(() => {}); // Synthetic text is discarded, never artifact data.
  const result = await new Promise<{ exitCode: number }>(resolve => terminal.onExit(resolve));
  expect(initialPid).toBe(0);
  expect(terminal.pid).toBeGreaterThan(0);
  expect(result.exitCode).toBe(0);
}, 10_000);

it.each(["ready", "silent", "malformed"])("real local IPC chain, byte-exact official wrapper and fake CLI: %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skin-ready-offline-"));
  const bin = path.join(root, "node_modules/wrangler/bin");
  const dist = path.join(root, "node_modules/wrangler/wrangler-dist");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(bin, "wrangler.js"), installedWrapper);
  fs.copyFileSync("test/fixtures/primaryAuditReadyFakeCli.cjs", path.join(dist, "cli.js"));
  const messages: Record<string, unknown>[] = [];
  let ancestry: { pid: number; parent: number }[] = [];
  const owner = spawn(process.execPath, [path.resolve("test/fixtures/primaryAuditReadyFakeCli.cjs"),
    "owner", path.join(bin, "wrangler.js"), path.resolve("test/fixtures/primaryAuditCliHealthPty.cjs")], {
    cwd: root, env: { ...process.env, AUDIT_READY_FAKE_MODE: mode },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  owner.on("message", raw => {
    const message = raw as Record<string, unknown>;
    messages.push(message);
    if (message.kind === "ready") ancestry = support.processSnapshot();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    owner.once("error", reject); owner.once("close", resolve);
  });
  // Remove only this mkdtemp-created synthetic tree, after its owned processes close.
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    || !path.basename(root).startsWith("mc-skin-ready-offline-")) throw new Error("unsafe_temporary_path");
  fs.rmSync(root, { recursive: true });
  expect(code).toBe(0);
  expect(messages.map(message => message.kind)).toEqual(mode === "ready"
    ? ["owner_started", "bridge_started", "ready"] : ["owner_started", "bridge_started"]);
  expect(messages[0].bridgePid).toBe(messages[1].bridgePid);
  expect(Number.isInteger(messages[0].bridgePid) && (messages[0].bridgePid as number) > 0).toBe(true);
  if (mode === "ready") {
    expect(messages[0].bridgePid).toBe(messages[2].bridgePid);
    const replay = supervisorReplay(messages, ancestry);
    expect(replay.observed).toEqual(["ptyOwnerStarted", "ttyBridgeStarted", "localProxyReady"]);
    expect(replay.artifact.senderOwnedRelationshipVerified).toBe(true);
    expect(replay.artifact.devServerReadyReceived).toBe(true);
  }
}, 15_000);
